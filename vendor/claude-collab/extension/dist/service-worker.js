"use strict";
(() => {
  // extension/src/service-worker.ts
  function sanitizeError(msg) {
    return msg.replace(/[A-Z]:\\[^\s'"]+/gi, "[path]").replace(/\/(?:home|Users|tmp|var|etc|usr|opt)[^\s'"]+/g, "[path]").slice(0, 500);
  }
  var ExpectedError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ExpectedError";
    }
  };
  var ws = null;
  var wsPort = 0;
  var wsToken = "";
  var managedTabs = /* @__PURE__ */ new Set();
  var followedTabs = /* @__PURE__ */ new Set();
  var hiddenTabs = /* @__PURE__ */ new Set();
  var followTabs = false;
  var userDisconnected = false;
  var chatHistory = [];
  var MAX_CHAT_HISTORY = 200;
  function addToChatHistory(msg, sourceTabId) {
    chatHistory.push(msg);
    if (chatHistory.length > MAX_CHAT_HISTORY) {
      chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
    }
    broadcastMessage(msg, sourceTabId);
  }
  function broadcastMessage(msg, excludeTabId) {
    for (const tabId of managedTabs) {
      if (tabId === excludeTabId) continue;
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (text, role) => {
          const dc = window.__dc;
          if (!dc) return;
          dc._syncing = true;
          try {
            if (dc.api && dc.api.addMessage) {
              dc.api.addMessage(text, role);
            }
          } finally {
            dc._syncing = false;
          }
        },
        args: [msg.text, msg.role]
      }).catch((err) => {
        console.warn(`[collab-sw] broadcast to tab ${tabId} failed, unmanaging:`, err?.message ?? err);
        managedTabs.delete(tabId);
      });
    }
  }
  var DEFAULT_PORT = 19876;
  var MAX_PORT_ATTEMPTS = 5;
  function connect(port) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    wsPort = port;
    console.log(`[collab] Connecting to ws://127.0.0.1:${port}/ext`);
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    ws.onopen = () => {
      console.log("[collab] Connected to MCP server, authenticating...");
      ws.send(JSON.stringify({ type: "connected", version: "0.1.0", token: wsToken }));
    };
    ws.onmessage = async (event) => {
      console.log("[collab] WS message received:", typeof event.data, String(event.data).slice(0, 200));
      let cmdType = "unknown";
      try {
        const msg = JSON.parse(event.data);
        cmdType = msg.type ?? "unknown";
        console.log("[collab] Parsed command:", msg.type, msg.id);
        const result = await handleCommand(msg);
        console.log("[collab] Command result:", msg.type, JSON.stringify(result).slice(0, 200));
        if (msg.id && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msg.id, type: "result", data: result }));
          console.log("[collab] Response sent for:", msg.id);
        } else {
          console.warn("[collab] Cannot send response \u2014 ws closed or no id", msg.id, ws?.readyState);
        }
      } catch (err) {
        if (err instanceof ExpectedError) {
          console.debug(`[collab] ${cmdType} unavailable: ${err.message}`);
        } else {
          console.error(`[collab] Command error (${cmdType}): ${err?.message ?? err}
${err?.stack ?? ""}`);
        }
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: msg.id, type: "error", message: sanitizeError(err.message || String(err)) }));
          }
        } catch (innerErr) {
          console.error("[collab] Failed to send error response:", innerErr);
        }
      }
    };
    ws.onclose = () => {
      console.log("[collab] Disconnected from MCP server");
      ws = null;
      if (userDisconnected) return;
      setTimeout(() => {
        if (!ws && !userDisconnected) {
          console.log("[collab] Attempting reconnect...");
          autoConnect();
        }
      }, 3e3);
    };
    ws.onerror = (err) => {
      console.error("[collab] WebSocket error:", err);
    };
  }
  function disconnect() {
    userDisconnected = true;
    chrome.storage.local.set({ userDisconnected: true });
    wsPort = 0;
    if (ws) {
      ws.close();
      ws = null;
    }
    void removeAllWidgets();
  }
  async function removeAllWidgets() {
    const allTabs = /* @__PURE__ */ new Set([...managedTabs, ...followedTabs]);
    for (const tabId of allTabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const selectors = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
            document.querySelectorAll(selectors).forEach((el) => el.remove());
            delete window.__dcRelayInjected;
            delete window.__dc;
            delete window.__dcHiddenState;
          }
        });
      } catch {
      }
      managedTabs.delete(tabId);
      followedTabs.delete(tabId);
    }
    hiddenTabs.clear();
    console.log("[collab] Removed widgets from all tabs");
  }
  async function handleCommand(msg) {
    switch (msg.type) {
      case "eval-widget":
      case "eval-frame":
        return await handleEval(msg);
      case "tab-action":
        return await handleTabAction(msg);
      case "inject-widget":
        return await handleInjectWidget(msg);
      case "screenshot":
        return await handleScreenshot(msg);
      case "set-viewport":
        return await handleSetViewport(msg);
      case "chat-deliver": {
        const chatMsg = { text: String(msg.text || ""), role: "ai", time: Date.now() };
        addToChatHistory(chatMsg);
        return { delivered: true };
      }
      case "notify":
        return await handleEval({ type: "eval-widget", code: msg.code });
      case "cleanup":
        return await handleCleanup();
      default:
        throw new Error(`Unknown command type: ${String(msg.type).slice(0, 50)}`);
    }
  }
  var MAX_EVAL_RESULT_SIZE = 5e5;
  async function handleEval(msg) {
    const tabId = msg.tabId || getActiveManagedTab();
    if (!tabId) throw new Error("No active tab");
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (code, maxSize) => {
        try {
          const result = (0, eval)(code);
          const json = JSON.stringify(result);
          if (json && json.length > maxSize) {
            return { __truncated: true, __size: json.length, __preview: json.slice(0, 1e3) + "...[TRUNCATED]" };
          }
          return result;
        } catch (e) {
          return { __error: e.message || String(e) };
        }
      },
      args: [msg.code, MAX_EVAL_RESULT_SIZE]
    });
    if (results && results[0]) {
      const result = results[0].result;
      if (result && typeof result === "object" && "__error" in result) {
        if (/unsafe-eval|Content Security Policy/i.test(result.__error)) {
          throw new ExpectedError(
            "This site's Content Security Policy blocks script evaluation in extension mode \u2014 scan/evaluate/act are unavailable on this tab. Screenshots, tab switching, and the chat widget still work. Known limitation; see README."
          );
        }
        throw new Error(result.__error);
      }
      if (result && typeof result === "object" && "__truncated" in result) {
        return { error: `Result too large (${result.__size} bytes). Use more targeted queries instead of dumping the entire page.`, preview: result.__preview };
      }
      return result;
    }
    return null;
  }
  async function handleTabAction(msg) {
    switch (msg.action) {
      case "create": {
        const tab = await chrome.tabs.create({ url: msg.url, active: true });
        if (tab.id) {
          managedTabs.add(tab.id);
          await waitForTabLoad(tab.id);
        }
        return { tabId: tab.id };
      }
      case "attach": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab to attach to");
        const url = tab.url || "";
        if (!/^https?:/i.test(url)) {
          throw new ExpectedError(
            `Cannot attach to the current tab (${url.split(":")[0] || "unknown"}: page). Ask the user to switch to a normal webpage, then attach again.`
          );
        }
        managedTabs.add(tab.id);
        followedTabs.add(tab.id);
        return { tabId: tab.id, url, title: tab.title || "" };
      }
      case "navigate": {
        if (!msg.tabId) throw new Error("tabId required");
        await chrome.tabs.update(msg.tabId, { url: msg.url });
        await waitForTabLoad(msg.tabId);
        const tab = await chrome.tabs.get(msg.tabId);
        return { url: tab.url };
      }
      case "list": {
        const tabIds = msg.managedTabIds || [...managedTabs];
        const tabs = await Promise.all(
          tabIds.filter((id) => managedTabs.has(id)).map(async (id) => {
            try {
              const tab = await chrome.tabs.get(id);
              return {
                id: tab.id,
                url: tab.url || "",
                title: tab.title || "",
                active: tab.active,
                frameName: `ext-tab-${tab.id}`
              };
            } catch {
              managedTabs.delete(id);
              return null;
            }
          })
        );
        return { tabs: tabs.filter(Boolean) };
      }
      case "switch": {
        if (!msg.tabId) throw new Error("tabId required");
        await chrome.tabs.update(msg.tabId, { active: true });
        return {};
      }
      case "close": {
        if (!msg.tabId) throw new Error("tabId required");
        await chrome.tabs.remove(msg.tabId);
        managedTabs.delete(msg.tabId);
        return {};
      }
      default:
        throw new Error(`Unknown tab action: ${msg.action}`);
    }
  }
  async function handleCleanup() {
    console.log("[collab] Cleanup: removing widgets from followed tabs, closing created tabs");
    await removeFollowedWidgets();
    const createdTabs = [...managedTabs];
    for (const tabId of createdTabs) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
      }
      managedTabs.delete(tabId);
    }
    followTabs = false;
    chrome.storage.local.set({ followTabs: false });
    chatHistory.length = 0;
    hiddenTabs.clear();
    return { cleaned: true };
  }
  function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 3e4);
    });
  }
  async function handleInjectWidget(msg) {
    const tabId = msg.tabId;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["relay-inject.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["widget-bundle.js"]
    });
    await hydrateWidget(tabId);
    return { injected: true };
  }
  async function hydrateWidget(tabId) {
    if (chatHistory.length === 0) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (history) => {
          const dc = window.__dc;
          if (dc?.api?.hydrate) dc.api.hydrate(history);
        },
        args: [chatHistory]
      });
    } catch (err) {
      console.warn(`[collab] Hydration failed for tab ${tabId}:`, err);
    }
  }
  async function captureFullPage(tabId) {
    const debugTarget = { tabId };
    try {
      await chrome.debugger.attach(debugTarget, "1.3");
      const layoutMetrics = await chrome.debugger.sendCommand(debugTarget, "Page.getLayoutMetrics");
      const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize;
      const viewport = layoutMetrics.cssLayoutViewport || layoutMetrics.layoutViewport;
      await chrome.debugger.sendCommand(debugTarget, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: Math.ceil(contentSize.width),
        height: Math.ceil(contentSize.height),
        deviceScaleFactor: 0
        // 0 = use default
      });
      await new Promise((r) => setTimeout(r, 150));
      const result = await chrome.debugger.sendCommand(debugTarget, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 }
      });
      await chrome.debugger.sendCommand(debugTarget, "Emulation.clearDeviceMetricsOverride");
      return result.data;
    } finally {
      try {
        await chrome.debugger.detach(debugTarget);
      } catch {
      }
    }
  }
  async function handleScreenshot(msg) {
    const tabId = msg.tabId || getActiveManagedTab();
    if (!tabId) throw new Error("No active tab");
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 200));
    }
    if (msg.opts?.fullPage) {
      const base642 = await captureFullPage(tabId);
      return { data: base642 };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    let cropRect = null;
    if (msg.opts?.selector) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: Math.round(rect.x * window.devicePixelRatio),
            y: Math.round(rect.y * window.devicePixelRatio),
            width: Math.round(rect.width * window.devicePixelRatio),
            height: Math.round(rect.height * window.devicePixelRatio)
          };
        },
        args: [msg.opts.selector]
      });
      if (results && results[0]?.result) {
        cropRect = results[0].result;
      }
    } else if (msg.opts?.clip && msg.opts.clip.w > 0 && msg.opts.clip.h > 0) {
      const metricsResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          dpr: window.devicePixelRatio || 1,
          sx: window.scrollX || 0,
          sy: window.scrollY || 0
        })
      });
      const { dpr = 1, sx = 0, sy = 0 } = metricsResults?.[0]?.result || {};
      cropRect = {
        x: Math.round((msg.opts.clip.x - sx) * dpr),
        y: Math.round((msg.opts.clip.y - sy) * dpr),
        width: Math.round(msg.opts.clip.w * dpr),
        height: Math.round(msg.opts.clip.h * dpr)
      };
    }
    if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const cx = Math.max(0, Math.min(cropRect.x, bitmap.width - 1));
      const cy = Math.max(0, Math.min(cropRect.y, bitmap.height - 1));
      const cw = Math.max(1, Math.min(cropRect.width, bitmap.width - cx));
      const ch = Math.max(1, Math.min(cropRect.height, bitmap.height - cy));
      const canvas = new OffscreenCanvas(cw, ch);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, cx, cy, cw, ch, 0, 0, cw, ch);
      bitmap.close();
      const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
      const arrayBuf = await croppedBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return { data: btoa(binary) };
    }
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    return { data: base64 };
  }
  async function handleSetViewport(msg) {
    const tabId = msg.tabId || getActiveManagedTab();
    if (!tabId) throw new Error("No active tab");
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, {
        width: msg.width,
        height: msg.height
      });
    }
    return {};
  }
  function getActiveManagedTab() {
    const tabs = [...managedTabs];
    return tabs.length > 0 ? tabs[tabs.length - 1] : null;
  }
  async function removeFollowedWidgets() {
    const tabsToClean = [...followedTabs];
    for (const tabId of tabsToClean) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const selectors = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
            document.querySelectorAll(selectors).forEach((el) => el.remove());
            delete window.__dcRelayInjected;
            delete window.__dc;
          }
        });
        managedTabs.delete(tabId);
        followedTabs.delete(tabId);
        console.log(`[collab] Removed widget from followed tab ${tabId}`);
      } catch (err) {
        managedTabs.delete(tabId);
        followedTabs.delete(tabId);
      }
    }
  }
  chrome.storage.local.get(["followTabs"]).then((stored) => {
    if (stored.followTabs !== void 0) followTabs = !!stored.followTabs;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    managedTabs.delete(tabId);
    followedTabs.delete(tabId);
  });
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!followTabs) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const tabId = activeInfo.tabId;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;
      ws.send(JSON.stringify({ type: "event", eventType: "tab-switch", data: { tabId, url: tab.url } }));
      if (managedTabs.has(tabId)) {
        console.log(`[collab] Follow-tabs: switched to managed tab ${tabId}`);
        return;
      }
      console.log(`[collab] Follow-tabs: injecting widget into tab ${tabId} (${tab.url?.slice(0, 60)})`);
      managedTabs.add(tabId);
      followedTabs.add(tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-script.js"]
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["relay-inject.js"]
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["widget-bundle.js"]
      });
      if (chatHistory.length > 0) {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (messages) => {
            const tryHydrate = () => {
              const dc = window.__dc;
              if (dc && dc.api && dc.api.addMessage) {
                dc._syncing = true;
                try {
                  for (const msg of messages) {
                    dc.api.addMessage(msg.text, msg.role);
                  }
                } finally {
                  dc._syncing = false;
                }
              } else {
                setTimeout(tryHydrate, 100);
              }
            };
            setTimeout(tryHydrate, 200);
          },
          args: [chatHistory]
        });
      }
      console.log(`[collab] Follow-tabs: widget injected into tab ${tabId}`);
    } catch (err) {
      console.error(`[collab] Follow-tabs: failed to inject into tab ${tabId}:`, err);
      managedTabs.delete(tabId);
      followedTabs.delete(tabId);
    }
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!managedTabs.has(tabId)) return;
    if (changeInfo.status !== "complete") return;
    console.log(`[collab] Tab ${tabId} navigated, re-injecting widget...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-script.js"]
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["relay-inject.js"]
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["widget-bundle.js"]
      });
      await hydrateWidget(tabId);
      console.log(`[collab] Widget re-injected into tab ${tabId}`);
    } catch (err) {
      console.debug(`[collab] Skipped re-inject into tab ${tabId} (restricted or error page):`, err?.message ?? err);
    }
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get-state") {
      (async () => {
        let hidden = false;
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) hidden = hiddenTabs.has(tab.id);
        } catch {
        }
        sendResponse({
          state: ws && ws.readyState === WebSocket.OPEN ? "connected" : ws ? "connecting" : "disconnected",
          port: wsPort,
          managedTabs: managedTabs.size,
          hidden,
          hasToken: !!wsToken,
          followTabs
        });
      })();
      return true;
    }
    if (msg.type === "connect") {
      userDisconnected = false;
      chrome.storage.local.set({ userDisconnected: false });
      const port = msg.port || wsPort;
      const token = msg.token || "";
      if (token) {
        wsToken = token.replace(/[^0-9a-fA-F]/g, "");
        chrome.storage.local.set({ wsAuthToken: wsToken });
      }
      if (port > 0 && wsToken) {
        connect(port);
        sendResponse({ ok: true });
      } else if (port > 0 && !wsToken) {
        sendResponse({ ok: false, error: "Auth token required \u2014 paste from terminal output" });
      } else {
        sendResponse({ ok: false, error: "No port specified" });
      }
      return;
    }
    if (msg.type === "disconnect") {
      disconnect();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "toggle-widget") {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const activeTabId = tab?.id;
          const isHidden = activeTabId ? hiddenTabs.has(activeTabId) : hiddenTabs.size > 0;
          const allTabs = /* @__PURE__ */ new Set([...managedTabs, ...followedTabs]);
          if (allTabs.size === 0) {
            sendResponse({ ok: false });
            return;
          }
          for (const tabId of allTabs) {
            try {
              if (isHidden) {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  world: "MAIN",
                  func: () => {
                    const saved = window.__dcHiddenState;
                    if (saved) {
                      for (const { el, display } of saved) {
                        try {
                          el.style.display = display;
                        } catch {
                        }
                      }
                      delete window.__dcHiddenState;
                    }
                  }
                });
                hiddenTabs.delete(tabId);
              } else {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  world: "MAIN",
                  func: () => {
                    const selectors = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
                    const elements = document.querySelectorAll(selectors);
                    const state = [];
                    elements.forEach((el) => {
                      state.push({ el, display: el.style.display || "" });
                      el.style.display = "none";
                    });
                    window.__dcHiddenState = state;
                  }
                });
                hiddenTabs.add(tabId);
              }
            } catch {
            }
          }
          sendResponse({ ok: true, hidden: !isHidden });
        } catch (err) {
          console.error("[collab] Toggle failed:", err);
          sendResponse({ ok: false });
        }
      })();
      return true;
    }
    if (msg.type === "toggle-follow") {
      followTabs = !followTabs;
      chrome.storage.local.set({ followTabs });
      if (!followTabs) {
        removeFollowedWidgets();
      }
      sendResponse({ ok: true, followTabs });
      return;
    }
    if (msg.type === "set-follow") {
      followTabs = !!msg.value;
      chrome.storage.local.set({ followTabs });
      if (!followTabs) {
        removeFollowedWidgets();
      }
      sendResponse({ ok: true, followTabs });
      return;
    }
    if (msg.type === "dc-relay-message") {
      const data = { text: msg.text };
      if (msg.selections) data.selections = msg.selections;
      if (msg.imageData) {
        data.imageData = msg.imageData;
        data.mimeType = msg.mimeType || "image/png";
      }
      const payload = JSON.stringify({ type: "event", eventType: "message", data });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        sendResponse({ ok: true });
      } else {
        console.warn("[collab] WS not open for relay message, queuing retry...");
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
            console.log("[collab] Queued relay message sent after retry");
          } else {
            console.error("[collab] Relay message DROPPED \u2014 WS still not open after retry");
          }
        }, 2e3);
        sendResponse({ ok: false, error: "WS not connected, message queued for retry" });
      }
      return;
    }
    if (msg.type === "dc-chat-sync") {
      const senderTabId = sender?.tab?.id;
      addToChatHistory({ text: msg.text, role: msg.role, time: msg.time || Date.now() }, senderTabId);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "dc-voice-active") {
      const claimingTabId = sender?.tab?.id;
      for (const tabId of managedTabs) {
        if (tabId === claimingTabId) continue;
        chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const dc = window.__dc;
            if (dc?.voice?.release) dc.voice.release();
          }
        }).catch(() => {
        });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "dc-relay-cancel") {
      const payload = JSON.stringify({ type: "event", eventType: "cancel", data: {} });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        console.warn("[collab] WS not open for cancel relay, queuing retry...");
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
        }, 2e3);
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "dc-relay-screenshot") {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.windowId || !tab.id) {
            sendResponse({ data: null });
            return;
          }
          let opts = {};
          try {
            opts = JSON.parse(msg.opts || "{}");
          } catch {
          }
          if (opts.fullPage) {
            const base64 = await captureFullPage(tab.id);
            sendResponse({ data: base64 });
            return;
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          if (opts.x !== void 0 && opts.w > 0 && opts.h > 0) {
            const metricsResults = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => ({
                dpr: window.devicePixelRatio || 1,
                sx: window.scrollX || 0,
                sy: window.scrollY || 0
              })
            });
            const { dpr = 1, sx = 0, sy = 0 } = metricsResults?.[0]?.result || {};
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            const cx = Math.max(0, Math.min(Math.round((opts.x - sx) * dpr), bitmap.width - 1));
            const cy = Math.max(0, Math.min(Math.round((opts.y - sy) * dpr), bitmap.height - 1));
            const cw = Math.max(1, Math.min(Math.round(opts.w * dpr), bitmap.width - cx));
            const ch = Math.max(1, Math.min(Math.round(opts.h * dpr), bitmap.height - cy));
            const canvas = new OffscreenCanvas(cw, ch);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(bitmap, cx, cy, cw, ch, 0, 0, cw, ch);
            bitmap.close();
            const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
            const arrayBuf = await croppedBlob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            sendResponse({ data: btoa(binary) });
          } else {
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
            sendResponse({ data: base64 });
          }
        } catch (err) {
          console.error("[collab] Screenshot relay failed:", err);
          sendResponse({ data: null });
        }
      })();
      return true;
    }
  });
  async function autoConnect(attempt = 0) {
    if (attempt >= MAX_PORT_ATTEMPTS) {
      console.log("[collab] No MCP server found on ports " + DEFAULT_PORT + "-" + (DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1));
      return;
    }
    if (attempt === 0) {
      try {
        const stored = await chrome.storage.local.get(["wsAuthToken", "userDisconnected"]);
        if (stored.userDisconnected) userDisconnected = true;
        if (!wsToken && stored.wsAuthToken) wsToken = stored.wsAuthToken;
      } catch {
      }
    }
    if (userDisconnected) {
      console.log("[collab] User disconnected \u2014 not auto-connecting");
      return;
    }
    const port = DEFAULT_PORT + attempt;
    console.log(`[collab] Scanning port ${port}...`);
    fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).then((data) => {
      if (data.ok) {
        if (wsToken) {
          console.log(`[collab] Found MCP server on port ${port}, connecting with stored token`);
          connect(port);
        } else {
          console.log(`[collab] Found MCP server on port ${port}, but no auth token \u2014 paste in popup.`);
        }
      } else {
        autoConnect(attempt + 1);
      }
    }).catch(() => {
      autoConnect(attempt + 1);
    });
  }
  autoConnect();
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      } else if (!userDisconnected && (!ws || ws.readyState === WebSocket.CLOSED)) {
        console.log("[collab] Keepalive: WS down, attempting reconnect...");
        autoConnect();
      }
    }
  });
  console.log("[collab] Service worker loaded");
})();
