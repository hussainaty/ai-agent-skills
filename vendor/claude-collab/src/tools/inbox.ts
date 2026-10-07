import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';
import { fulfillCaptureRects } from '../capture.js';
import { getPage } from '../browser.js';
import { consumeMessages, peekMessages, takeParkedImages } from '../message-store.js';

export function registerInboxTool(server: McpServer): void {
  server.tool(
    'collab_inbox',
    'Check for new user messages in the collab widget without blocking. Returns immediately (or waits up to timeout ms). Use this to poll for replies while doing other work.',
    {
      timeout: z.number().default(0).describe('Max wait time in ms. 0 = instant check, >0 = short poll (e.g. 5000 = wait up to 5s)'),
    },
    async ({ timeout }) => {
      const t = getTransport();

      // Extension mode: the server-side store is the single source of truth.
      // No evalWidget — widget state is per-tab and unreliable across tabs.
      if (t.getMode() === 'extension') {
        return readFromStore(timeout);
      }

      // Check if there are unread user messages right now
      const hasUnread = await t.evalWidget(() => {
        const dc = window.__dc;
        if (!dc) return false;
        return dc.messages.some(
          (m: any, i: number) => i >= dc.lastReadIndex && m.type === 'user'
        );
      });

      // If there are messages or no wait requested, read immediately
      if (hasUnread || timeout <= 0) {
        return readAndReturn(t, hasUnread);
      }

      // Short poll — wait up to timeout for a user message (Playwright-only)
      // Reads lastReadIndex atomically inside the polled function to avoid race conditions
      try {
        const page = getPage(); // waitForFunction is Playwright-specific
        await page.waitForFunction(
          () => {
            const dc = window.__dc;
            return dc && dc.messages.some(
              (m: any, i: number) => i >= dc.lastReadIndex && m.type === 'user'
            );
          },
          undefined,
          { timeout },
        );
        return readAndReturn(t, true);
      } catch {
        // Timeout — no new messages
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ hasMessages: false, replies: [] }),
          }],
        };
      }
    },
  );
}

/** Extension mode: read from the server store — messages, attachments, parked images. */
async function readFromStore(timeout: number) {
  let msgs = consumeMessages();
  let parked = takeParkedImages();

  // Short poll if nothing yet and a timeout was requested
  if (msgs.length === 0 && parked.length === 0 && timeout > 0) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      if (peekMessages().length > 0) {
        msgs = consumeMessages();
        parked = takeParkedImages();
        break;
      }
    }
  }

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  content.push({
    type: 'text' as const,
    text: JSON.stringify({
      hasMessages: msgs.length > 0 || parked.length > 0,
      replies: msgs.map(m => m.text).filter(Boolean),
    }),
  });
  for (const img of parked) {
    content.push({ type: 'image' as const, data: img.imageData, mimeType: img.mimeType });
  }
  for (const m of msgs) {
    if (m.imageData) {
      content.push({ type: 'image' as const, data: m.imageData, mimeType: m.mimeType || 'image/png' });
    }
  }
  return { content };
}

async function readAndReturn(t: any, hasMessages: boolean) {
  if (!hasMessages) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ hasMessages: false, replies: [] }),
      }],
    };
  }

  // Read messages — in extension mode, large image data can cause truncation,
  // so we read text-only first, then fetch images separately if needed.
  let replies: Array<{ text: string; imageData?: string; mimeType?: string; captureRect?: { x: number; y: number; w: number; h: number; selector?: string } }>;

  const raw = await t.evalWidget(() => window.__dc.api.readNew() as any);

  if (!Array.isArray(raw)) {
    // Truncated or malformed result — fall back to text-only readNew
    const textOnly = await t.evalWidget(`(() => {
      const dc = window.__dc;
      if (!dc) return [];
      const start = dc.lastReadIndex;
      const msgs = dc.messages;
      const out = [];
      for (let i = start; i < msgs.length; i++) {
        if (msgs[i].type === 'user') {
          out.push({ text: msgs[i].text || '', hasImage: !!msgs[i].imageData, mimeType: msgs[i].mimeType });
        }
      }
      dc.lastReadIndex = msgs.length;
      return out;
    })()`);
    replies = Array.isArray(textOnly) ? textOnly : [];

    // Fetch images individually for messages that have them
    for (const r of replies) {
      if ((r as any).hasImage) {
        try {
          const imgData = await t.evalWidget(`(() => {
            const msgs = window.__dc.messages;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].type === 'user' && msgs[i].text === ${JSON.stringify((r as any).text)} && msgs[i].imageData) {
                return { imageData: msgs[i].imageData, mimeType: msgs[i].mimeType };
              }
            }
            return null;
          })()`);
          if (imgData && imgData.imageData) {
            r.imageData = imgData.imageData;
            r.mimeType = imgData.mimeType;
          }
        } catch { /* image too large for transport — skip */ }
      }
    }
  } else {
    replies = raw;
  }

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  const textReplies = replies.map(r => r.text).filter(Boolean);

  content.push({
    type: 'text' as const,
    text: JSON.stringify({ hasMessages: true, replies: textReplies }),
  });

  // Fulfill image and capture rect requests
  await fulfillCaptureRects(replies, content);

  return { content };
}
