/**
 * Server-side message store for user messages pushed from the extension.
 *
 * Replaces evalWidget polling for /pending — messages are stored here
 * when the extension relays them, so /pending can read instantly without
 * a round-trip through the browser.
 */

interface UserMessage {
  text: string;
  selections?: any[];
  imageData?: string;   // base64 attachment relayed from the widget
  mimeType?: string;
}

const messages: UserMessage[] = [];
let lastReadIndex = 0;
let cancelRequested = false;
let idleFlag = false;

// Attachments whose TEXT was already delivered through a hook/listener (which
// can only carry text). Parked here until collab_inbox picks them up.
let parkedImages: Array<{ imageData: string; mimeType: string }> = [];

// Mirror the widget's cap (1000 → trim to 500) so long sessions don't grow
// the server process. Only already-read messages are trimmed.
const MAX_MESSAGES = 1000;
const TRIM_TO = 500;

/** Push a user message (called when extension sends eventType: 'message'). */
export function pushMessage(text: string, selections?: any[], imageData?: string, mimeType?: string): void {
  const entry: UserMessage = { text };
  if (selections && selections.length > 0) entry.selections = selections;
  if (imageData) {
    entry.imageData = imageData;
    entry.mimeType = mimeType || 'image/png';
  }
  messages.push(entry);
  if (messages.length > MAX_MESSAGES) {
    const drop = Math.min(messages.length - TRIM_TO, lastReadIndex);
    if (drop > 0) {
      messages.splice(0, drop);
      lastReadIndex -= drop;
    }
  }
}

/** Set the cancel flag (called when extension sends eventType: 'cancel'). */
export function requestCancel(): void {
  cancelRequested = true;
}

/**
 * Read unread messages and advance the cursor.
 * Also clears the idle flag (consuming means Claude is waking up).
 * Returns the unread messages (empty array if none).
 *
 * Text-only consumers (hooks, listener — they deliver via stderr) must pass
 * parkImages=true: attachments are parked for a later collab_inbox call
 * instead of being dropped with the cursor advance.
 */
export function consumeMessages(parkImages = false): UserMessage[] {
  const unread: UserMessage[] = [];
  for (let i = lastReadIndex; i < messages.length; i++) {
    unread.push(messages[i]);
  }
  if (unread.length > 0) {
    lastReadIndex = messages.length;
    idleFlag = false;
    if (parkImages) {
      for (const m of unread) {
        if (m.imageData) {
          parkedImages.push({ imageData: m.imageData, mimeType: m.mimeType || 'image/png' });
        }
      }
    }
  }
  return unread;
}

/** Drain attachments parked by text-only consumers (collab_inbox calls this). */
export function takeParkedImages(): Array<{ imageData: string; mimeType: string }> {
  const taken = parkedImages;
  parkedImages = [];
  return taken;
}

/** Set the idle flag (called by Stop hook via POST /idle). */
export function setIdle(): void {
  idleFlag = true;
}

/** Check whether Claude is idle. */
export function isIdle(): boolean {
  return idleFlag;
}

/**
 * Peek at unread messages without advancing the cursor.
 * Also returns and clears the cancel flag.
 */
export function peekAndCheckCancel(): { cancel: boolean; messages: string[] } {
  const wasCancelled = cancelRequested;
  cancelRequested = false;
  const msgs: string[] = [];
  for (let i = lastReadIndex; i < messages.length; i++) {
    msgs.push(messages[i].text);
  }
  return { cancel: wasCancelled, messages: msgs };
}

/**
 * Peek at unread messages without advancing the cursor.
 * Returns full message objects (text + selections).
 */
export function peekMessages(): UserMessage[] {
  const unread: UserMessage[] = [];
  for (let i = lastReadIndex; i < messages.length; i++) {
    unread.push(messages[i]);
  }
  return unread;
}

/** Check if the store has any messages (used to decide whether to use store vs evalWidget). */
export function isActive(): boolean {
  return messages.length > 0;
}

/** Reset the store (call on session close). */
export function reset(): void {
  messages.length = 0;
  lastReadIndex = 0;
  cancelRequested = false;
  idleFlag = false;
  parkedImages = [];
}
