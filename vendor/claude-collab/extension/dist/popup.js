"use strict";
(() => {
  // extension/src/popup.ts
  var statusDot = document.getElementById("statusDot");
  var statusLabel = document.getElementById("statusLabel");
  var portInput = document.getElementById("portInput");
  var tokenInput = document.getElementById("tokenInput");
  var actionBtn = document.getElementById("actionBtn");
  var toggleBtn = document.getElementById("toggleBtn");
  var followBtn = document.getElementById("followBtn");
  var tabsInfo = document.getElementById("tabsInfo");
  var errorMsg = document.getElementById("errorMsg");
  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = "block";
  }
  function clearError() {
    errorMsg.textContent = "";
    errorMsg.style.display = "none";
  }
  function updateUI(state, info) {
    statusDot.className = "dot " + state;
    statusLabel.textContent = state === "connected" ? `Connected (port ${info?.port || "?"})` : state === "connecting" ? "Connecting..." : info?.hasToken === false ? "Needs auth token" : "Disconnected";
    if (state === "connected") {
      actionBtn.textContent = "Disconnect";
      actionBtn.className = "btn-disconnect";
      toggleBtn.style.display = "block";
      toggleBtn.textContent = info?.hidden ? "Show Widget" : "Hide Widget";
      toggleBtn.className = info?.hidden ? "btn-connect" : "btn-toggle";
      followBtn.style.display = "block";
      followBtn.textContent = info?.followTabs ? "Follow Tabs: ON" : "Follow Tabs: OFF";
      followBtn.className = info?.followTabs ? "btn-follow active" : "btn-follow";
      if (info?.managedTabs !== void 0) {
        tabsInfo.textContent = `Managing ${info.managedTabs} tab${info.managedTabs !== 1 ? "s" : ""}`;
      }
      clearError();
    } else {
      actionBtn.textContent = "Connect";
      actionBtn.className = "btn-connect";
      toggleBtn.style.display = "none";
      followBtn.style.display = "none";
      tabsInfo.textContent = "";
    }
  }
  async function refreshState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "get-state" });
      if (response) {
        updateUI(response.state, { port: response.port, managedTabs: response.managedTabs, hidden: response.hidden, hasToken: response.hasToken, followTabs: response.followTabs });
        if (response.port) {
          portInput.value = String(response.port);
        }
        const stored = await chrome.storage.local.get(["wsAuthToken"]);
        if (stored.wsAuthToken) {
          tokenInput.value = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
          tokenInput.dataset.masked = "true";
        }
      }
    } catch {
      updateUI("disconnected");
    }
  }
  actionBtn.addEventListener("click", async () => {
    const currentState = statusDot.className.includes("connected") && !statusDot.className.includes("dis") ? "connected" : "disconnected";
    if (currentState === "connected") {
      clearError();
      await chrome.runtime.sendMessage({ type: "disconnect" });
    } else {
      const port = parseInt(portInput.value) || 0;
      const rawToken = tokenInput.dataset.masked === "true" ? "" : tokenInput.value;
      const token = rawToken.replace(/[^0-9a-fA-F]/g, "");
      if (port > 0) {
        chrome.storage.local.set({ wsPort: port });
      }
      clearError();
      updateUI("connecting");
      const response = await chrome.runtime.sendMessage({ type: "connect", port, token });
      if (response && !response.ok && response.error) {
        showError(response.error);
        updateUI("disconnected");
      }
    }
    setTimeout(refreshState, 500);
  });
  toggleBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "toggle-widget" });
    setTimeout(refreshState, 300);
  });
  followBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "toggle-follow" });
    setTimeout(refreshState, 300);
  });
  tokenInput.addEventListener("focus", () => {
    if (tokenInput.dataset.masked === "true") {
      tokenInput.value = "";
      delete tokenInput.dataset.masked;
    }
  });
  tokenInput.addEventListener("paste", () => {
    setTimeout(() => {
      tokenInput.value = tokenInput.value.replace(/[^0-9a-fA-F]/g, "");
    }, 0);
  });
  portInput.placeholder = "19876";
  portInput.value = "19876";
  refreshState();
})();
