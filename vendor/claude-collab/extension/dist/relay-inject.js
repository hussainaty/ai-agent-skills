"use strict";
(() => {
  // extension/src/relay-inject.ts
  if (!window.__dcRelayInjected) {
    let onPort1Message = function(event) {
      const { action, text, selections, imageData, mimeType, optsJson, requestId: widgetRequestId } = event.data || {};
      if (action === "message" && text) {
        window.postMessage({
          __dcRelay: true,
          action: "message",
          text,
          selections: selections || null,
          imageData: imageData || null,
          mimeType: mimeType || null
        }, origin);
      } else if (action === "cancel") {
        window.postMessage({ __dcRelay: true, action: "cancel" }, origin);
      } else if (action === "screenshot") {
        const internalId = "ss-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        const replyId = widgetRequestId || internalId;
        const handler = (ev) => {
          if (ev.source !== window) return;
          if (ev.data?.__dcScreenshotResult && ev.data.requestId === internalId) {
            window.removeEventListener("message", handler);
            if (activePort1) activePort1.postMessage({ action: "screenshot-result", requestId: replyId, data: ev.data.data });
          }
        };
        window.addEventListener("message", handler);
        setTimeout(() => {
          window.removeEventListener("message", handler);
          if (activePort1) activePort1.postMessage({ action: "screenshot-result", requestId: replyId, data: null });
        }, 1e4);
        window.postMessage({ __dcRelay: true, action: "screenshot", requestId: internalId, opts: optsJson }, origin);
      }
    }, makeChannel = function() {
      const ch = new MessageChannel();
      ch.port1.onmessage = onPort1Message;
      if (activePort1) {
        try {
          activePort1.close();
        } catch {
        }
      }
      activePort1 = ch.port1;
      return ch;
    };
    onPort1Message2 = onPort1Message, makeChannel2 = makeChannel;
    window.__dcRelayInjected = true;
    const origin = /^https?:/.test(window.location.origin) ? window.location.origin : "*";
    let activePort1 = null;
    let portDelivered = false;
    const ackHandler = (ev) => {
      if (ev.data && ev.data.__dcRelayAck) {
        portDelivered = true;
        window.removeEventListener("message", ackHandler);
      }
    };
    window.addEventListener("message", ackHandler);
    let currentChannel = makeChannel();
    setTimeout(() => {
      if (portDelivered) return;
      try {
        window.postMessage({ __dcRelayPort: true }, origin, [currentChannel.port2]);
      } catch {
      }
    }, 30);
    let retryCount = 0;
    const retryInterval = setInterval(() => {
      if (portDelivered || retryCount > 100) {
        clearInterval(retryInterval);
        return;
      }
      retryCount++;
      currentChannel = makeChannel();
      try {
        window.postMessage({ __dcRelayPort: true }, origin, [currentChannel.port2]);
      } catch {
      }
    }, 50);
    if (!window.name || !window.name.startsWith("dc-frame-")) {
      window.name = "dc-frame-extension";
    }
  }
  var onPort1Message2;
  var makeChannel2;
})();
