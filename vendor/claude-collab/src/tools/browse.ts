import { z } from 'zod';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport, setTransport, hasTransport, type DesignTransport } from '../transport.js';
import { PlaywrightTransport } from '../playwright-transport.js';
import { ExtensionTransport } from '../extension-transport.js';
import { isExtensionConnected, getWSPort, getWSToken } from '../ws-server.js';

const __dirname_browse = dirname(fileURLToPath(import.meta.url));
const LISTENER_PATH = join(__dirname_browse, '..', '..', 'scripts', 'listener.cjs');
const PLAYBOOK_PATH = join(__dirname_browse, '..', '..', 'docs', 'PLAYBOOK.md');

const LISTENER_INSTRUCTIONS = `
⚠️ REQUIRED — Do these steps NOW, before responding to the user:

1. Start the background listener using Bash with run_in_background: true:
   node "${LISTENER_PATH}"
   ↑ Copy this command EXACTLY. Do NOT change the path.

2. Send your first message with collab_chat (waitForReply: false).

3. NEVER use waitForReply: true — it blocks message delivery.

4. When the listener completes with a message, respond via collab_chat, then start a NEW listener with the same command.

Before complex work, Read the playbook (workflows, per-tool gotchas, limits):
${PLAYBOOK_PATH}
`;

export function registerBrowseTool(server: McpServer): void {
  server.tool(
    'collab_browse',
    'Open a URL in a new tab, or — in extension mode with no url — join the page the user is currently on. Each call with a url creates a new tab; the chat widget persists across all tabs. When the user says "join me" or wants to work on their current page, use extension mode and omit url.',
    {
      url: z.string().url().optional().describe('The URL to navigate to. Omit in extension mode to attach to the user\'s currently active tab ("join me here").'),
      mode: z.enum(['tabs', 'single', 'extension']).default('tabs').describe('Session mode: "tabs" (default) uses iframe tabs for multi-page browsing. "single" opens the page directly without iframes. "extension" uses the Chrome extension in the user\'s real browser.'),
    },
    async ({ url, mode: browseMode }) => {
      if (!url && browseMode !== 'extension') {
        return {
          content: [{
            type: 'text' as const,
            text: 'url is required in tabs/single mode — only extension mode can join the user\'s current tab. Provide a url, or use mode: "extension".',
          }],
        };
      }
      let t: DesignTransport;

      const tokenResponse = (port: number, token: string) => ({
        content: [{
          type: 'text' as const,
          text: [
            `Extension mode: WS server ready on port ${port}.`,
            `The extension needs the auth token to connect.`,
            ``,
            `AUTH TOKEN: ${token}`,
            ``,
            `Tell the user: "I've started the extension server. Please open the Claude Collab extension popup in Chrome, paste this auth token, and click Connect. Then I'll continue."`,
            ``,
            `After they confirm, call collab_browse with mode: "extension" again — it will connect instantly.`,
          ].join('\n'),
        }],
      });

      if (browseMode === 'extension') {
        // Extension mode — use Chrome extension transport.
        // CRITICAL: only ever ONE ExtensionTransport instance per session. Each
        // instance registers a persistent reconnect hook that attaches a message
        // handler to the socket — a second instance means a second handler and
        // every user message delivered twice.
        if (hasTransport() && getTransport().getMode() === 'extension') {
          t = getTransport();
          if (!t.isReady()) {
            if (isExtensionConnected()) {
              // Extension connected while we weren't looking (e.g. token pasted
              // between calls) — attach to it. Idempotent: per-connection guard.
              (t as ExtensionTransport).connectExisting();
            } else {
              // Still waiting for the user to paste the token
              return tokenResponse(getWSPort(), getWSToken());
            }
          }
        } else if (isExtensionConnected()) {
          const ext = new ExtensionTransport();
          ext.connectExisting();
          setTransport(ext);
          t = ext;
        } else {
          // Two-phase flow: start WS server → return token → user pastes → extension connects
          const ext = new ExtensionTransport();
          const { port, token } = await ext.initServer();
          // Register the transport NOW — its reconnect hook will wire the message
          // handler when the extension connects, and the next collab_browse call
          // must reuse this instance instead of creating a duplicate
          setTransport(ext);

          // Check if extension connects quickly (already has stored token)
          try {
            await ext.waitForConnection(5000); // 5s grace period
            t = ext;
          } catch {
            // Extension didn't connect yet — return token for user to paste
            return tokenResponse(port, token);
          }
        }
      } else {
        // Playwright mode
        let pw: PlaywrightTransport;
        if (hasTransport() && getTransport().getMode() !== 'extension') {
          pw = getTransport() as PlaywrightTransport;
        } else {
          pw = new PlaywrightTransport();
          setTransport(pw);
        }
        pw.setBrowseMode(browseMode);
        t = pw;
      }

      // No url in extension mode → join the user's currently active tab
      let tabId: number;
      let joined = false;
      if (!url) {
        if (!t.attach) {
          return {
            content: [{
              type: 'text' as const,
              text: 'This transport cannot attach to the user\'s tab. Provide a url instead.',
            }],
          };
        }
        ({ tabId } = await t.attach());
        joined = true;
      } else {
        ({ tabId } = await t.browse(url));
      }

      // Extract page info from the target frame
      const info = await t.evalFrame(() => {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({
          level: parseInt(h.tagName[1]),
          text: (h.textContent || '').trim().slice(0, 80),
        }));

        const links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 30)
          .map(a => ({
            text: (a.textContent || '').trim().slice(0, 50),
            href: (a as HTMLAnchorElement).href,
          }))
          .filter(l => l.text);

        return {
          title: document.title,
          url: location.href,
          headings,
          links,
        };
      });

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ...info, tabId, mode: browseMode, joined }, null, 2) },
          { type: 'text' as const, text: LISTENER_INSTRUCTIONS },
        ],
      };
    },
  );
}
