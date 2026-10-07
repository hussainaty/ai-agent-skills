/**
 * Shared HTTP handler for GET /pending and GET /cancel endpoints.
 *
 * Both the Playwright notify server (browser.ts) and the extension WS server
 * (ws-server.ts) mount these handlers so hooks/listener can query pending
 * messages regardless of transport mode.
 *
 * All message state lives in the widget's window.__dc object — no event files,
 * no cursor files. The widget's lastReadIndex is the single cursor.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { hasTransport, getTransport } from './transport.js';
import { consumeMessages, peekMessages, peekAndCheckCancel, setIdle, isIdle } from './message-store.js';

/**
 * Validate Bearer token from the Authorization header.
 * Returns true if valid, sends 401 and returns false otherwise.
 */
function checkAuth(req: IncomingMessage, res: ServerResponse, expectedToken: string): boolean {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${expectedToken}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"unauthorized"}');
    return false;
  }
  return true;
}

/**
 * Handle GET /pending — return unread user messages and advance the cursor.
 *
 * Response: { messages: [{ text, selections? }...] }
 */
export async function handlePending(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  if (!checkAuth(req, res, token)) return;

  const headers = { 'Content-Type': 'application/json' };
  const empty = JSON.stringify({ messages: [] });

  // Fast path: read from server-side store (populated by extension push events).
  // No evalWidget round-trip needed — completes in <1ms.
  // parkImages: this endpoint feeds hooks/the listener, which deliver text only —
  // attachments are parked for collab_inbox and stripped from the response.
  const stored = consumeMessages(true);
  if (stored.length > 0) {
    console.error(`[pending] Delivering ${stored.length} message(s) from store`);
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      messages: stored.map(({ imageData, mimeType, ...rest }) => rest),
    }));
    return;
  }

  // Slow path fallback: evalWidget (for Playwright mode where extension push isn't available)
  if (!hasTransport()) {
    res.writeHead(200, headers);
    res.end(empty);
    return;
  }

  try {
    const t = getTransport();
    // Only use evalWidget in non-extension mode (Playwright)
    if (t.getMode() === 'extension') {
      // Extension mode uses the store above — if empty, nothing to deliver
      res.writeHead(200, headers);
      res.end(empty);
      return;
    }

    const result = await t.evalWidget(`(() => {
      const dc = window.__dc;
      if (!dc || !dc.messages) return null;
      const unread = [];
      for (let i = dc.lastReadIndex; i < dc.messages.length; i++) {
        const m = dc.messages[i];
        if (m.type === 'user' && m.text) {
          const entry = { text: m.text };
          if (m.selections && m.selections.length > 0) entry.selections = m.selections;
          unread.push(entry);
        }
      }
      if (unread.length === 0) return null;
      dc.lastReadIndex = dc.messages.length;
      return unread;
    })()`);

    if (result && result.length > 0) {
      console.error(`[pending] Delivering ${result.length} message(s) via evalWidget`);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ messages: result }));
    } else {
      res.writeHead(200, headers);
      res.end(empty);
    }
  } catch (err) {
    console.error('[pending] evalWidget FAILED:', err);
    res.writeHead(200, headers);
    res.end(empty);
  }
}

/**
 * Handle GET /peek — return unread user messages WITHOUT advancing the cursor.
 *
 * Used by the background listener to check for messages without consuming them.
 * The listener defers to the event-hook (which uses /pending to consume) for 2s
 * before consuming itself, so the event-hook gets priority during tool calls.
 *
 * Response: { messages: [{ text, selections? }...] }
 */
export async function handlePeek(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  if (!checkAuth(req, res, token)) return;

  const headers = { 'Content-Type': 'application/json' };
  const empty = JSON.stringify({ messages: [] });

  // Fast path: peek at server-side store (extension mode)
  const stored = peekMessages();
  if (stored.length > 0) {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ messages: stored }));
    return;
  }

  // Slow path fallback: evalWidget peek (Playwright mode)
  if (!hasTransport()) {
    res.writeHead(200, headers);
    res.end(empty);
    return;
  }

  try {
    const t = getTransport();
    if (t.getMode() === 'extension') {
      res.writeHead(200, headers);
      res.end(empty);
      return;
    }

    // Peek only — does NOT advance lastReadIndex
    const result = await t.evalWidget(`(() => {
      const dc = window.__dc;
      if (!dc || !dc.messages) return null;
      const unread = [];
      for (let i = dc.lastReadIndex; i < dc.messages.length; i++) {
        const m = dc.messages[i];
        if (m.type === 'user' && m.text) {
          const entry = { text: m.text };
          if (m.selections && m.selections.length > 0) entry.selections = m.selections;
          unread.push(entry);
        }
      }
      return unread.length > 0 ? unread : null;
    })()`);

    if (result && result.length > 0) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ messages: result }));
    } else {
      res.writeHead(200, headers);
      res.end(empty);
    }
  } catch {
    res.writeHead(200, headers);
    res.end(empty);
  }
}

/**
 * Handle GET /cancel — check cancel flag and peek at unread messages.
 *
 * Clears the cancelRequested flag but does NOT advance lastReadIndex,
 * so the event-hook can still deliver the messages on the next PostToolUse.
 *
 * Response: { cancel: true/false, messages: ["text"...] }
 */
export async function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  if (!checkAuth(req, res, token)) return;

  const headers = { 'Content-Type': 'application/json' };
  const nope = JSON.stringify({ cancel: false });

  // Fast path: check server-side store (extension mode)
  const storeResult = peekAndCheckCancel();
  if (storeResult.cancel || storeResult.messages.length > 0) {
    res.writeHead(200, headers);
    res.end(JSON.stringify(storeResult));
    return;
  }

  // Slow path fallback: evalWidget (Playwright mode)
  if (!hasTransport()) {
    res.writeHead(200, headers);
    res.end(nope);
    return;
  }

  try {
    const t = getTransport();
    if (t.getMode() === 'extension') {
      res.writeHead(200, headers);
      res.end(nope);
      return;
    }

    const result = await t.evalWidget(`(() => {
      const dc = window.__dc;
      if (!dc) return { cancel: false, messages: [] };
      const wasCancelled = !!dc.cancelRequested;
      dc.cancelRequested = false;
      const msgs = [];
      for (let i = dc.lastReadIndex; i < dc.messages.length; i++) {
        const m = dc.messages[i];
        if (m.type === 'user' && m.text) msgs.push(m.text);
      }
      return { cancel: wasCancelled, messages: msgs };
    })()`);

    res.writeHead(200, headers);
    res.end(JSON.stringify(result || { cancel: false, messages: [] }));
  } catch {
    res.writeHead(200, headers);
    res.end(nope);
  }
}

/**
 * Handle POST /idle — set the idle flag (called by Stop hook).
 */
export function handleSetIdle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): void {
  if (!checkAuth(req, res, token)) return;
  setIdle();
  console.error('[idle] Claude is now idle');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

/**
 * Handle GET /idle — check whether Claude is idle.
 */
export function handleGetIdle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): void {
  if (!checkAuth(req, res, token)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ idle: isIdle() }));
}
