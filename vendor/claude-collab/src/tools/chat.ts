import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';
import { fulfillCaptureRects } from '../capture.js';
import { getPage } from '../browser.js';

const __dirname_chat = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname_chat, '..', '..');
const LISTENER_PATH = join(PROJECT_ROOT, 'scripts', 'listener.cjs');
const LISTENER_PID_FILE = join(PROJECT_ROOT, '.listener-pid');

/** True if the background listener process is currently alive. */
function isListenerAlive(): boolean {
  try {
    const pid = parseInt(readFileSync(LISTENER_PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0); // signal 0 — existence check only
    return true;
  } catch {
    return false;
  }
}

export function registerChatTool(server: McpServer): void {
  server.tool(
    'collab_chat',
    'Send a message to the user via the collab widget chat. IMPORTANT: Do NOT use waitForReply: true — it blocks hook-based message delivery and causes you to miss user messages. Always leave waitForReply as false (default) and use the background listener to receive replies.',
    {
      message: z.string().max(50000).describe('Message to send to the user'),
      waitForReply: z.boolean().default(false).describe('If true, block until the user replies (up to timeout)'),
      timeout: z.number().max(300000).default(120000).describe('Max wait time in ms when waitForReply is true (default 120s)'),
    },
    async ({ message, waitForReply, timeout }) => {
      const t = getTransport();

      // Send the AI message. Extension mode uses a structured command that the
      // service worker fans out to every widget tab with executeScript({func}) —
      // immune to page CSP, which blocks the eval-based evalWidget path on
      // strict sites (and reaches ALL tabs, not just the active one).
      if (t.getMode() === 'extension' && typeof (t as any).deliverChat === 'function') {
        await (t as any).deliverChat(message);
      } else {
        await t.evalWidget((msg: string) => {
          window.__dc.api.say(msg);
        }, message);
      }

      if (!waitForReply) {
        const reminder = isListenerAlive()
          ? ''
          : `\n⚠️ LISTENER IS DOWN — start it NOW: run node "${LISTENER_PATH}" with run_in_background: true. Without it you CANNOT hear the user while idle.`;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ sent: true, message }) + reminder,
          }],
        };
      }

      // Wait for user reply (Playwright-only, deprecated — use background listener instead)
      const mode = t.getMode();
      if (mode === 'extension') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ sent: true, error: 'waitForReply is not supported in extension mode. Use the background listener instead.' }),
          }],
        };
      }
      console.error(`[collab_chat] Waiting for user reply (timeout: ${timeout}ms)...`);
      try {
        const page = getPage(); // waitForFunction is Playwright-specific
        await page.waitForFunction(
          () => {
            const dc = window.__dc;
            return dc && dc.messages.some(
              (m, i) => i >= dc.lastReadIndex && m.type === 'user'
            );
          },
          undefined,
          { timeout },
        );
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ sent: true, reply: null, timedOut: true }),
          }],
        };
      }

      // Read new messages (may include image captures from camera button)
      const replies: Array<{ text: string; imageData?: string; mimeType?: string; captureRect?: { x: number; y: number; w: number; h: number; selector?: string } }> =
        await t.evalWidget(() => window.__dc.api.readNew() as any);

      // Build content blocks
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
      const textReplies = replies.map(r => r.text).filter(Boolean);

      content.push({
        type: 'text' as const,
        text: JSON.stringify({ sent: true, replies: textReplies }),
      });

      // Fulfill image and capture rect requests
      await fulfillCaptureRects(replies, content);

      return { content };
    },
  );
}
