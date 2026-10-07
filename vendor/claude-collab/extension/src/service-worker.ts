/**
 * Claude Collab Extension — Service Worker
 *
 * Connects to the MCP server via WebSocket, routes commands
 * to content scripts, and manages tab lifecycle.
 */

/** Strip file paths and limit length in error messages. */
function sanitizeError(msg: string): string {
  return msg
    .replace(/[A-Z]:\\[^\s'"]+/gi, '[path]')
    .replace(/\/(?:home|Users|tmp|var|etc|usr|opt)[^\s'"]+/g, '[path]')
    .slice(0, 500);
}

/**
 * A handled, expected condition — not a bug. Unsupported tab (chrome://, file://),
 * CSP-blocked eval, etc. Still surfaced to the user as guidance, but logged quietly
 * (console.debug) so the console stays calm and real errors actually stand out.
 */
class ExpectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectedError';
  }
}

let ws: WebSocket | null = null;
let wsPort: number = 0;
let wsToken: string = '';
const managedTabs = new Set<number>();
const followedTabs = new Set<number>(); // tabs added by follow-tabs (not originally browsed)
const hiddenTabs = new Set<number>(); // tabs where collab UI is hidden
let followTabs = false; // when true, widget auto-injects into any tab the user switches to
// Set when the user explicitly disconnects from the popup. Suppresses
// auto-reconnect (which would silently undo the disconnect while the MCP
// server is still running). Persisted so MV3 service-worker restarts honor it.
let userDisconnected = false;

// ==================== Chat History Sync ====================
// Central store for chat messages — synced across all managed tabs
interface ChatMsg { text: string; role: string; time: number; }
const chatHistory: ChatMsg[] = [];
const MAX_CHAT_HISTORY = 200;

function addToChatHistory(msg: ChatMsg, sourceTabId?: number): void {
  chatHistory.push(msg);
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
  }
  // Broadcast to all OTHER managed tabs
  broadcastMessage(msg, sourceTabId);
}

function broadcastMessage(msg: ChatMsg, excludeTabId?: number): void {
  for (const tabId of managedTabs) {
    if (tabId === excludeTabId) continue;
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (text: string, role: string) => {
        const dc = (window as any).__dc;
        if (!dc) return;
        // Set syncing flag to prevent echo back to service worker
        dc._syncing = true;
        try {
          if (dc.api && dc.api.addMessage) {
            dc.api.addMessage(text, role);
          }
        } finally {
          dc._syncing = false;
        }
      },
      args: [msg.text, msg.role],
    }).catch((err) => {
      // Tab closed or restricted page — drop it from the managed set so we
      // stop broadcasting into the void, and leave a trace for debugging.
      console.warn(`[collab-sw] broadcast to tab ${tabId} failed, unmanaging:`, err?.message ?? err);
      managedTabs.delete(tabId);
    });
  }
}

// Fixed port range — must match the MCP server's ws-server.ts
const DEFAULT_PORT = 19876;
const MAX_PORT_ATTEMPTS = 5;

// ==================== WebSocket Connection ====================

function connect(port: number): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  wsPort = port;
  console.log(`[collab] Connecting to ws://127.0.0.1:${port}/ext`);

  // Token is sent in the first message, NOT in the URL (avoids token leaking in logs)
  ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);

  ws.onopen = () => {
    console.log('[collab] Connected to MCP server, authenticating...');
    ws!.send(JSON.stringify({ type: 'connected', version: '0.1.0', token: wsToken }));
  };

  ws.onmessage = async (event) => {
    console.log('[collab] WS message received:', typeof event.data, String(event.data).slice(0, 200));
    let cmdType = 'unknown';
    try {
      const msg = JSON.parse(event.data as string);
      cmdType = msg.type ?? 'unknown';
      console.log('[collab] Parsed command:', msg.type, msg.id);
      const result = await handleCommand(msg);
      console.log('[collab] Command result:', msg.type, JSON.stringify(result).slice(0, 200));
      if (msg.id && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: msg.id, type: 'result', data: result }));
        console.log('[collab] Response sent for:', msg.id);
      } else {
        console.warn('[collab] Cannot send response — ws closed or no id', msg.id, ws?.readyState);
      }
    } catch (err: any) {
      if (err instanceof ExpectedError) {
        // Handled condition (unsupported tab, blocked eval) — quiet, not a red error.
        console.debug(`[collab] ${cmdType} unavailable: ${err.message}`);
      } else {
        // Print message + stack inline so the real origin (widget-bundle.js:NNNN, etc.)
        // is visible without expanding — the bare err only shows this call site.
        console.error(`[collab] Command error (${cmdType}): ${err?.message ?? err}\n${err?.stack ?? ''}`);
      }
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.id && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msg.id, type: 'error', message: sanitizeError(err.message || String(err)) }));
        }
      } catch (innerErr) {
        console.error('[collab] Failed to send error response:', innerErr);
      }
    }
  };

  ws.onclose = () => {
    console.log('[collab] Disconnected from MCP server');
    ws = null;
    if (userDisconnected) return; // user chose to disconnect — stay disconnected
    // Auto-reconnect: scan the port range after 3 seconds
    setTimeout(() => {
      if (!ws && !userDisconnected) {
        console.log('[collab] Attempting reconnect...');
        autoConnect();
      }
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('[collab] WebSocket error:', err);
  };
}

function disconnect(): void {
  userDisconnected = true;
  chrome.storage.local.set({ userDisconnected: true });
  wsPort = 0;
  if (ws) {
    ws.close();
    ws = null;
  }
  // Disconnect means the session is over everywhere — remove the widget
  // from every tab, not just the one the user is looking at.
  void removeAllWidgets();
}

/** Remove the collab widget from ALL managed tabs (created and followed)
 *  without closing any tabs. Used on explicit user disconnect. */
async function removeAllWidgets(): Promise<void> {
  const allTabs = new Set([...managedTabs, ...followedTabs]);
  for (const tabId of allTabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const selectors = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
          document.querySelectorAll(selectors).forEach(el => el.remove());
          delete (window as any).__dcRelayInjected;
          delete (window as any).__dc;
          delete (window as any).__dcHiddenState;
        },
      });
    } catch { /* tab may be closed or restricted */ }
    managedTabs.delete(tabId);
    followedTabs.delete(tabId);
  }
  hiddenTabs.clear();
  console.log('[collab] Removed widgets from all tabs');
}

// ==================== Command Handler ====================

async function handleCommand(msg: any): Promise<any> {
  switch (msg.type) {
    case 'eval-widget':
    case 'eval-frame':
      return await handleEval(msg);

    case 'tab-action':
      return await handleTabAction(msg);

    case 'inject-widget':
      return await handleInjectWidget(msg);

    case 'screenshot':
      return await handleScreenshot(msg);

    case 'set-viewport':
      return await handleSetViewport(msg);

    case 'chat-deliver': {
      // AI chat message from the MCP server — store in history and render in
      // EVERY widget tab via executeScript({func}), which page CSP can't block
      const chatMsg = { text: String(msg.text || ''), role: 'ai', time: Date.now() };
      addToChatHistory(chatMsg); // no exclude — broadcast renders it everywhere
      return { delivered: true };
    }

    case 'notify':
      // Fire-and-forget: eval notification code in the active tab's widget
      return await handleEval({ type: 'eval-widget', code: msg.code });

    case 'cleanup':
      return await handleCleanup();

    default:
      throw new Error(`Unknown command type: ${String(msg.type).slice(0, 50)}`);
  }
}

// ==================== Eval ====================

const MAX_EVAL_RESULT_SIZE = 500_000; // 500KB limit to prevent pipeline freeze

async function handleEval(msg: { type: string; code: string; tabId?: number }): Promise<any> {
  const tabId = msg.tabId || getActiveManagedTab();
  if (!tabId) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (code: string, maxSize: number) => {
      try {
        const result = (0, eval)(code);
        // Guard against huge results that would freeze the transport
        const json = JSON.stringify(result);
        if (json && json.length > maxSize) {
          return { __truncated: true, __size: json.length, __preview: json.slice(0, 1000) + '...[TRUNCATED]' };
        }
        return result;
      } catch (e: any) {
        return { __error: e.message || String(e) };
      }
    },
    args: [msg.code, MAX_EVAL_RESULT_SIZE],
  });

  if (results && results[0]) {
    const result = results[0].result;
    if (result && typeof result === 'object' && '__error' in result) {
      // Strict page CSP (no 'unsafe-eval') blocks the indirect eval in the MAIN
      // world — executeScript itself is exempt, the eval inside it is not
      if (/unsafe-eval|Content Security Policy/i.test(result.__error)) {
        throw new ExpectedError(
          'This site\'s Content Security Policy blocks script evaluation in extension mode — ' +
          'scan/evaluate/act are unavailable on this tab. Screenshots, tab switching, and the ' +
          'chat widget still work. Known limitation; see README.'
        );
      }
      throw new Error(result.__error);
    }
    if (result && typeof result === 'object' && '__truncated' in result) {
      return { error: `Result too large (${result.__size} bytes). Use more targeted queries instead of dumping the entire page.`, preview: result.__preview };
    }
    return result;
  }
  return null;
}

// ==================== Tab Actions ====================

async function handleTabAction(msg: any): Promise<any> {
  switch (msg.action) {
    case 'create': {
      const tab = await chrome.tabs.create({ url: msg.url, active: true });
      if (tab.id) {
        managedTabs.add(tab.id);
        // Wait for the page to load
        await waitForTabLoad(tab.id);
      }
      return { tabId: tab.id };
    }

    case 'attach': {
      // Join the user's currently active tab instead of opening a new one.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab to attach to');
      const url = tab.url || '';
      if (!/^https?:/i.test(url)) {
        throw new ExpectedError(
          `Cannot attach to the current tab (${url.split(':')[0] || 'unknown'}: page). ` +
          'Ask the user to switch to a normal webpage, then attach again.',
        );
      }
      managedTabs.add(tab.id);
      // Mark as user-owned: cleanup removes the widget but never closes the tab.
      followedTabs.add(tab.id);
      return { tabId: tab.id, url, title: tab.title || '' };
    }

    case 'navigate': {
      if (!msg.tabId) throw new Error('tabId required');
      await chrome.tabs.update(msg.tabId, { url: msg.url });
      await waitForTabLoad(msg.tabId);
      const tab = await chrome.tabs.get(msg.tabId);
      return { url: tab.url };
    }

    case 'list': {
      const tabIds = msg.managedTabIds || [...managedTabs];
      const tabs = await Promise.all(
        tabIds.filter((id: number) => managedTabs.has(id)).map(async (id: number) => {
          try {
            const tab = await chrome.tabs.get(id);
            return {
              id: tab.id,
              url: tab.url || '',
              title: tab.title || '',
              active: tab.active,
              frameName: `ext-tab-${tab.id}`,
            };
          } catch {
            managedTabs.delete(id);
            return null;
          }
        })
      );
      return { tabs: tabs.filter(Boolean) };
    }

    case 'switch': {
      if (!msg.tabId) throw new Error('tabId required');
      await chrome.tabs.update(msg.tabId, { active: true });
      return {};
    }

    case 'close': {
      if (!msg.tabId) throw new Error('tabId required');
      await chrome.tabs.remove(msg.tabId);
      managedTabs.delete(msg.tabId);
      return {};
    }

    default:
      throw new Error(`Unknown tab action: ${msg.action}`);
  }
}

// ==================== Session Cleanup ====================

async function handleCleanup(): Promise<any> {
  console.log('[collab] Cleanup: removing widgets from followed tabs, closing created tabs');

  // 1. Remove widgets from followed tabs (user's own tabs — don't close them)
  await removeFollowedWidgets();

  // 2. Close only originally-created tabs (not followed ones)
  const createdTabs = [...managedTabs]; // after removeFollowedWidgets, only created tabs remain
  for (const tabId of createdTabs) {
    try {
      await chrome.tabs.remove(tabId);
    } catch { /* tab may already be closed */ }
    managedTabs.delete(tabId);
  }

  // 3. Reset state
  followTabs = false;
  chrome.storage.local.set({ followTabs: false });
  chatHistory.length = 0;
  hiddenTabs.clear();

  return { cleaned: true };
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout fallback
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// ==================== Widget Injection ====================

async function handleInjectWidget(msg: { tabId: number }): Promise<any> {
  const tabId = msg.tabId;

  // Inject fresh content script (ISOLATED world) — ensures relay chain works
  // even if the manifest-injected content script is stale after extension reload
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-script.js'],
  });

  // Inject the relay bridge (MAIN world — content script → service worker messaging)
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['relay-inject.js'],
  });

  // Inject the widget bundle
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['widget-bundle.js'],
  });

  await hydrateWidget(tabId);

  return { injected: true };
}

/** Push the canonical chat history into a freshly injected widget. */
async function hydrateWidget(tabId: number): Promise<void> {
  if (chatHistory.length === 0) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (history: ChatMsg[]) => {
        const dc = (window as any).__dc;
        if (dc?.api?.hydrate) dc.api.hydrate(history);
      },
      args: [chatHistory],
    });
  } catch (err) {
    console.warn(`[collab] Hydration failed for tab ${tabId}:`, err);
  }
}

// ==================== Screenshot ====================

/**
 * Full-page screenshot via Chrome Debugger Protocol.
 * Attaches debugger briefly, captures with captureBeyondViewport, detaches.
 */
async function captureFullPage(tabId: number): Promise<string> {
  const debugTarget = { tabId };
  try {
    await chrome.debugger.attach(debugTarget, '1.3');

    // Get full page dimensions and current viewport
    const layoutMetrics: any = await chrome.debugger.sendCommand(debugTarget, 'Page.getLayoutMetrics');
    const contentSize = layoutMetrics.cssContentSize || layoutMetrics.contentSize;
    const viewport = layoutMetrics.cssLayoutViewport || layoutMetrics.layoutViewport;

    // Override viewport to full content size so the entire page is rendered
    await chrome.debugger.sendCommand(debugTarget, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: Math.ceil(contentSize.width),
      height: Math.ceil(contentSize.height),
      deviceScaleFactor: 0, // 0 = use default
    });

    // Brief pause for re-render at the new viewport size
    await new Promise(r => setTimeout(r, 150));

    // Capture the full page
    const result: any = await chrome.debugger.sendCommand(debugTarget, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 },
    });

    // Restore original viewport
    await chrome.debugger.sendCommand(debugTarget, 'Emulation.clearDeviceMetricsOverride');

    return result.data; // already base64
  } finally {
    try { await chrome.debugger.detach(debugTarget); } catch { /* may already be detached */ }
  }
}

async function handleScreenshot(msg: { tabId?: number; opts: any }): Promise<any> {
  const tabId = msg.tabId || getActiveManagedTab();
  if (!tabId) throw new Error('No active tab');

  // Make sure the tab is active (captureVisibleTab needs it)
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(r => setTimeout(r, 200)); // Wait for tab to become visible
  }

  // Full page via CDP
  if (msg.opts?.fullPage) {
    const base64 = await captureFullPage(tabId);
    return { data: base64 };
  }

  // Capture the visible tab
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });

  // Determine crop region — from selector, clip rect, or none (full viewport)
  let cropRect: { x: number; y: number; width: number; height: number } | null = null;

  if (msg.opts?.selector) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x * window.devicePixelRatio),
          y: Math.round(rect.y * window.devicePixelRatio),
          width: Math.round(rect.width * window.devicePixelRatio),
          height: Math.round(rect.height * window.devicePixelRatio),
        };
      },
      args: [msg.opts.selector],
    });
    if (results && results[0]?.result) {
      cropRect = results[0].result;
    }
  } else if (msg.opts?.clip && msg.opts.clip.w > 0 && msg.opts.clip.h > 0) {
    // Clip rects arrive in page coordinates (Playwright clip semantics) but
    // captureVisibleTab only captures the viewport — translate by scroll offset
    const metricsResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        dpr: window.devicePixelRatio || 1,
        sx: window.scrollX || 0,
        sy: window.scrollY || 0,
      }),
    });
    const { dpr = 1, sx = 0, sy = 0 } = metricsResults?.[0]?.result || {};
    cropRect = {
      x: Math.round((msg.opts.clip.x - sx) * dpr),
      y: Math.round((msg.opts.clip.y - sy) * dpr),
      width: Math.round(msg.opts.clip.w * dpr),
      height: Math.round(msg.opts.clip.h * dpr),
    };
  }

  // Crop if we have a region, otherwise return full viewport
  if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    // Clamp to the captured bitmap — a rect drawn near the viewport edge (or with
    // rounding drift) must not sample outside the image, which yields blank pixels
    const cx = Math.max(0, Math.min(cropRect.x, bitmap.width - 1));
    const cy = Math.max(0, Math.min(cropRect.y, bitmap.height - 1));
    const cw = Math.max(1, Math.min(cropRect.width, bitmap.width - cx));
    const ch = Math.max(1, Math.min(cropRect.height, bitmap.height - cy));
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, cx, cy, cw, ch, 0, 0, cw, ch);
    bitmap.close();
    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const arrayBuf = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { data: btoa(binary) };
  }

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return { data: base64 };
}

// ==================== Viewport ====================

async function handleSetViewport(msg: { tabId?: number; width: number; height: number }): Promise<any> {
  const tabId = msg.tabId || getActiveManagedTab();
  if (!tabId) throw new Error('No active tab');

  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, {
      width: msg.width,
      height: msg.height,
    });
  }
  return {};
}

// ==================== Helpers ====================

function getActiveManagedTab(): number | null {
  const tabs = [...managedTabs];
  return tabs.length > 0 ? tabs[tabs.length - 1] : null;
}

/** Remove widget from all tabs that were added by follow-tabs (not originally browsed). */
async function removeFollowedWidgets(): Promise<void> {
  const tabsToClean = [...followedTabs];
  for (const tabId of tabsToClean) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          // Remove all collab widget elements
          const selectors = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
          document.querySelectorAll(selectors).forEach(el => el.remove());
          // Clean up relay state so re-injection works fresh if re-enabled
          delete (window as any).__dcRelayInjected;
          delete (window as any).__dc;
        },
      });
      managedTabs.delete(tabId);
      followedTabs.delete(tabId);
      console.log(`[collab] Removed widget from followed tab ${tabId}`);
    } catch (err) {
      // Tab may have been closed
      managedTabs.delete(tabId);
      followedTabs.delete(tabId);
    }
  }
}

// Load follow-tabs setting from storage
chrome.storage.local.get(['followTabs']).then(stored => {
  if (stored.followTabs !== undefined) followTabs = !!stored.followTabs;
});

// Clean up when managed tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  managedTabs.delete(tabId);
  followedTabs.delete(tabId);
});

// Follow tabs: track active tab and auto-inject widget into new tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!followTabs) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabId = activeInfo.tabId;

  try {
    const tab = await chrome.tabs.get(tabId);
    // Skip chrome:// and extension pages
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    // Always notify server of active tab change (so responses go to the right tab)
    ws.send(JSON.stringify({ type: 'event', eventType: 'tab-switch', data: { tabId, url: tab.url } }));

    // If already managed, just update active — no need to re-inject
    if (managedTabs.has(tabId)) {
      console.log(`[collab] Follow-tabs: switched to managed tab ${tabId}`);
      return;
    }

    console.log(`[collab] Follow-tabs: injecting widget into tab ${tabId} (${tab.url?.slice(0, 60)})`);
    managedTabs.add(tabId);
    followedTabs.add(tabId);

    // Inject fresh content script (ISOLATED world) — the manifest-injected one
    // may be stale after extension reload, so we need a fresh copy for the relay chain
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['relay-inject.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['widget-bundle.js'],
    });

    // Hydrate the new widget with existing chat history
    if (chatHistory.length > 0) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (messages: Array<{ text: string; role: string; time: number }>) => {
          // Wait for widget to be ready, then hydrate
          const tryHydrate = () => {
            const dc = (window as any).__dc;
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
        args: [chatHistory],
      });
    }

    console.log(`[collab] Follow-tabs: widget injected into tab ${tabId}`);
  } catch (err) {
    console.error(`[collab] Follow-tabs: failed to inject into tab ${tabId}:`, err);
    managedTabs.delete(tabId);
    followedTabs.delete(tabId);
  }
});

// Re-inject widget when managed tabs navigate to a new page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!managedTabs.has(tabId)) return;
  if (changeInfo.status !== 'complete') return;

  console.log(`[collab] Tab ${tabId} navigated, re-injecting widget...`);
  try {
    // Fresh content script for relay chain (manifest one may be stale)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['relay-inject.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['widget-bundle.js'],
    });
    await hydrateWidget(tabId);
    console.log(`[collab] Widget re-injected into tab ${tabId}`);
  } catch (err) {
    // Expected on error pages / chrome:// / restricted frames — can't inject there. Quiet.
    console.debug(`[collab] Skipped re-inject into tab ${tabId} (restricted or error page):`, (err as any)?.message ?? err);
  }
});

// ==================== Message Handling (from popup + content scripts) ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-state') {
    (async () => {
      let hidden = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) hidden = hiddenTabs.has(tab.id);
      } catch {}
      sendResponse({
        state: ws && ws.readyState === WebSocket.OPEN ? 'connected' : ws ? 'connecting' : 'disconnected',
        port: wsPort,
        managedTabs: managedTabs.size,
        hidden,
        hasToken: !!wsToken,
        followTabs,
      });
    })();
    return true; // async
  }

  if (msg.type === 'connect') {
    // Explicit user action — clear the sticky disconnect state
    userDisconnected = false;
    chrome.storage.local.set({ userDisconnected: false });
    const port = msg.port || wsPort;
    const token = msg.token || '';
    if (token) {
      // Strip non-hex characters (handles accidental whitespace/quotes from paste)
      wsToken = token.replace(/[^0-9a-fA-F]/g, '');
      chrome.storage.local.set({ wsAuthToken: wsToken });
    }
    if (port > 0 && wsToken) {
      connect(port);
      sendResponse({ ok: true });
    } else if (port > 0 && !wsToken) {
      sendResponse({ ok: false, error: 'Auth token required — paste from terminal output' });
    } else {
      sendResponse({ ok: false, error: 'No port specified' });
    }
    return;
  }

  if (msg.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'toggle-widget') {
    (async () => {
      try {
        // Hide/show applies to ALL managed tabs — hiding in one tab and
        // finding the widget alive in the next is confusing.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeTabId = tab?.id;
        const isHidden = activeTabId ? hiddenTabs.has(activeTabId) : hiddenTabs.size > 0;
        const allTabs = new Set([...managedTabs, ...followedTabs]);
        if (allTabs.size === 0) { sendResponse({ ok: false }); return; }

        for (const tabId of allTabs) {
          try {
            if (isHidden) {
              // Show — restore elements
              await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                  const saved = (window as any).__dcHiddenState;
                  if (saved) {
                    for (const { el, display } of saved) {
                      try { el.style.display = display; } catch {}
                    }
                    delete (window as any).__dcHiddenState;
                  }
                },
              });
              hiddenTabs.delete(tabId);
            } else {
              // Hide — save display state and hide all collab elements
              await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                  const selectors = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
                  const elements = document.querySelectorAll(selectors);
                  const state: Array<{ el: Element; display: string }> = [];
                  elements.forEach((el: any) => {
                    state.push({ el, display: el.style.display || '' });
                    el.style.display = 'none';
                  });
                  (window as any).__dcHiddenState = state;
                },
              });
              hiddenTabs.add(tabId);
            }
          } catch { /* tab closed or restricted — skip */ }
        }
        sendResponse({ ok: true, hidden: !isHidden });
      } catch (err) {
        console.error('[collab] Toggle failed:', err);
        sendResponse({ ok: false });
      }
    })();
    return true; // async
  }

  if (msg.type === 'toggle-follow') {
    followTabs = !followTabs;
    chrome.storage.local.set({ followTabs });
    if (!followTabs) {
      removeFollowedWidgets();
    }
    sendResponse({ ok: true, followTabs });
    return;
  }

  if (msg.type === 'set-follow') {
    followTabs = !!msg.value;
    chrome.storage.local.set({ followTabs });
    if (!followTabs) {
      removeFollowedWidgets();
    }
    sendResponse({ ok: true, followTabs });
    return;
  }

  // Relay message from content script (widget → MCP server)
  if (msg.type === 'dc-relay-message') {
    const data: any = { text: msg.text };
    if (msg.selections) data.selections = msg.selections;
    if (msg.imageData) {
      data.imageData = msg.imageData;
      data.mimeType = msg.mimeType || 'image/png';
    }
    const payload = JSON.stringify({ type: 'event', eventType: 'message', data });

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      sendResponse({ ok: true });
    } else {
      // WS not ready — queue the message and retry after a short delay.
      // This handles the startup race where the service worker restarts
      // and autoConnect hasn't completed yet.
      console.warn('[collab] WS not open for relay message, queuing retry...');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
          console.log('[collab] Queued relay message sent after retry');
        } else {
          console.error('[collab] Relay message DROPPED — WS still not open after retry');
        }
      }, 2000);
      sendResponse({ ok: false, error: 'WS not connected, message queued for retry' });
    }
    return;
  }

  if (msg.type === 'dc-chat-sync') {
    // Chat message from a widget — store and broadcast to other tabs
    const senderTabId = sender?.tab?.id;
    addToChatHistory({ text: msg.text, role: msg.role, time: msg.time || Date.now() }, senderTabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'dc-voice-active') {
    // A tab claimed the mic — release it everywhere else (Chrome allows one
    // speech-recognition session per browser; competing tabs abort each other)
    const claimingTabId = sender?.tab?.id;
    for (const tabId of managedTabs) {
      if (tabId === claimingTabId) continue;
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const dc = (window as any).__dc;
          if (dc?.voice?.release) dc.voice.release();
        },
      }).catch(() => { /* tab closed or restricted — nothing to release */ });
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'dc-relay-cancel') {
    const payload = JSON.stringify({ type: 'event', eventType: 'cancel', data: {} });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      console.warn('[collab] WS not open for cancel relay, queuing retry...');
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
      }, 2000);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'dc-relay-screenshot') {
    // Capture visible tab, optionally crop to region or capture full page
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.windowId || !tab.id) {
          sendResponse({ data: null });
          return;
        }

        // Parse opts
        let opts: any = {};
        try { opts = JSON.parse(msg.opts || '{}'); } catch { /* use defaults */ }

        // Full page via CDP
        if (opts.fullPage) {
          const base64 = await captureFullPage(tab.id);
          sendResponse({ data: base64 });
          return;
        }

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

        // If clip coordinates provided, crop using OffscreenCanvas
        if (opts.x !== undefined && opts.w > 0 && opts.h > 0) {
          // Rects arrive in page coordinates but captureVisibleTab only captures
          // the viewport — translate by scroll offset before cropping
          const metricsResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({
              dpr: window.devicePixelRatio || 1,
              sx: window.scrollX || 0,
              sy: window.scrollY || 0,
            }),
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
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(bitmap, cx, cy, cw, ch, 0, 0, cw, ch);
          bitmap.close();

          const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
          const arrayBuf = await croppedBlob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          sendResponse({ data: btoa(binary) });
        } else {
          // Full viewport
          const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
          sendResponse({ data: base64 });
        }
      } catch (err) {
        console.error('[collab] Screenshot relay failed:', err);
        sendResponse({ data: null });
      }
    })();
    return true; // keep sendResponse channel open for async
  }
});

// Auto-connect on startup: try the fixed port range (19876-19880)
async function autoConnect(attempt = 0): Promise<void> {
  if (attempt >= MAX_PORT_ATTEMPTS) {
    console.log('[collab] No MCP server found on ports ' + DEFAULT_PORT + '-' + (DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1));
    return;
  }

  // Read persisted state on first attempt (token + sticky disconnect)
  if (attempt === 0) {
    try {
      const stored = await chrome.storage.local.get(['wsAuthToken', 'userDisconnected']);
      if (stored.userDisconnected) userDisconnected = true;
      if (!wsToken && stored.wsAuthToken) wsToken = stored.wsAuthToken;
    } catch {}
  }
  if (userDisconnected) {
    console.log('[collab] User disconnected — not auto-connecting');
    return;
  }

  const port = DEFAULT_PORT + attempt;
  console.log(`[collab] Scanning port ${port}...`);

  // Health check — token is NOT in /health (security). Use stored token from
  // chrome.storage (saved when user pastes it in the popup).
  fetch(`http://127.0.0.1:${port}/health`)
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        if (wsToken) {
          console.log(`[collab] Found MCP server on port ${port}, connecting with stored token`);
          connect(port);
        } else {
          console.log(`[collab] Found MCP server on port ${port}, but no auth token — paste in popup.`);
        }
      } else {
        autoConnect(attempt + 1);
      }
    })
    .catch(() => {
      autoConnect(attempt + 1);
    });
}

autoConnect();

// Keepalive: MV3 service workers die after ~30s of inactivity.
// Use chrome.alarms to wake up periodically and maintain the WebSocket.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // ~24 seconds
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Just accessing ws state is enough to keep the service worker alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send a ping to keep the connection alive
      ws.send(JSON.stringify({ type: 'ping' }));
    } else if (!userDisconnected && (!ws || ws.readyState === WebSocket.CLOSED)) {
      // Connection dropped (server restart, SW killed mid-session) — reconnect
      console.log('[collab] Keepalive: WS down, attempting reconnect...');
      autoConnect();
    }
  }
});

console.log('[collab] Service worker loaded');
