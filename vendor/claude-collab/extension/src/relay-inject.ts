/**
 * Relay injection script — runs in the MAIN world of the page.
 *
 * Creates a private MessageChannel between the relay and the collab widget.
 * Only the widget (which receives the port via postMessage) can send relay
 * commands. Page scripts cannot access the port or forge messages.
 *
 * The content script (ISOLATED world) listens for postMessages tagged with
 * __dcRelay and forwards them to the service worker.
 *
 * Port transfer uses a retry handshake: we keep posting fresh ports every
 * 50ms until the widget sends back __dcRelayAck. This eliminates the race
 * condition where the old 100ms fire-once timeout could miss the widget.
 */

// Guard against double injection
if (!(window as any).__dcRelayInjected) {
  (window as any).__dcRelayInjected = true;

  // Non-http(s) pages have unusable origins as postMessage targets: file://
  // pages report the literal string "file://" (silently dropped — no error),
  // sandboxed/about: pages report "null" (throws). Only trust http(s) origins;
  // fall back to '*' otherwise: same-window postMessage is readable by page
  // scripts regardless of targetOrigin, and channel security comes from the
  // MessagePort transfer, not the origin.
  const origin = /^https?:/.test(window.location.origin) ? window.location.origin : '*';

  // The active channel — may be replaced during retry handshake
  let activePort1: MessagePort | null = null;

  // Handler for commands arriving on port1 (widget sends via port2)
  function onPort1Message(event: MessageEvent) {
    const { action, text, selections, imageData, mimeType, optsJson, requestId: widgetRequestId } = event.data || {};

    if (action === 'message' && text) {
      window.postMessage({
        __dcRelay: true, action: 'message', text, selections: selections || null,
        imageData: imageData || null, mimeType: mimeType || null,
      }, origin);
    } else if (action === 'cancel') {
      window.postMessage({ __dcRelay: true, action: 'cancel' }, origin);
    } else if (action === 'screenshot') {
      // Internal requestId for the window postMessage round-trip to content script
      const internalId = 'ss-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      // Widget's requestId to echo back through the port so the callback matches
      const replyId = widgetRequestId || internalId;

      const handler = (ev: MessageEvent) => {
        if (ev.source !== window) return;
        if (ev.data?.__dcScreenshotResult && ev.data.requestId === internalId) {
          window.removeEventListener('message', handler);
          // Send result back through the private channel using the widget's requestId
          if (activePort1) activePort1.postMessage({ action: 'screenshot-result', requestId: replyId, data: ev.data.data });
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => {
        window.removeEventListener('message', handler);
        if (activePort1) activePort1.postMessage({ action: 'screenshot-result', requestId: replyId, data: null });
      }, 10000);

      window.postMessage({ __dcRelay: true, action: 'screenshot', requestId: internalId, opts: optsJson }, origin);
    }
  }

  // Create initial channel
  function makeChannel(): MessageChannel {
    const ch = new MessageChannel();
    ch.port1.onmessage = onPort1Message;
    // Close previous port1 to avoid leaks
    if (activePort1) {
      try { activePort1.close(); } catch {}
    }
    activePort1 = ch.port1;
    return ch;
  }

  // === Port transfer with retry handshake ===
  // The widget sends __dcRelayAck when it receives the port.
  // We retry with fresh channels every 50ms until ack is received.
  let portDelivered = false;

  const ackHandler = (ev: MessageEvent) => {
    if (ev.data && ev.data.__dcRelayAck) {
      portDelivered = true;
      window.removeEventListener('message', ackHandler);
    }
  };
  window.addEventListener('message', ackHandler);

  // First attempt after a short delay
  let currentChannel = makeChannel();
  setTimeout(() => {
    if (portDelivered) return;
    try {
      window.postMessage({ __dcRelayPort: true }, origin, [currentChannel.port2]);
    } catch {}
  }, 30);

  // Retry with fresh channels until ack received (max 5s)
  let retryCount = 0;
  const retryInterval = setInterval(() => {
    if (portDelivered || retryCount > 100) {
      clearInterval(retryInterval);
      return;
    }
    retryCount++;
    // Previous port2 was neutered by transfer — create a fresh channel
    currentChannel = makeChannel();
    try {
      window.postMessage({ __dcRelayPort: true }, origin, [currentChannel.port2]);
    } catch {}
  }, 50);

  // NOTE: no __dcRelayMessage/__dcRelayCancel/__dcTakeScreenshot stubs here.
  // Earlier versions defined resolve-silently no-ops "to prevent errors", but
  // they made delivery failures invisible — voice messages and pre-handshake
  // sends vanished without a trace. The widget's relay functions reject when
  // no channel exists, and callers surface that to the user.

  // Set window name so the iframe bridge activates
  if (!window.name || !window.name.startsWith('dc-frame-')) {
    window.name = 'dc-frame-extension';
  }
}
