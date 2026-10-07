import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerScreenshotTool(server: McpServer): void {
  server.tool(
    'collab_screenshot',
    'Take a screenshot of the target site (iframe content) or a specific element within it. Returns the image as base64.',
    {
      selector: z.string().max(500).optional().describe('CSS selector to screenshot a specific element in the target site. If omitted, captures the iframe viewport.'),
      fullPage: z.boolean().default(false).describe('Capture the full scrollable page of the target site'),
    },
    async ({ selector, fullPage }) => {
      const t = getTransport();

      if (selector) {
        // Check element exists first
        const exists = await t.evalFrame(
          (sel: string) => { try { return !!document.querySelector(sel); } catch { return false; } },
          selector,
        );
        if (!exists) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Element not found in target site: ${selector}` }),
            }],
          };
        }
      }

      const buffer = await t.screenshot({
        selector: selector || undefined,
        fullPage: fullPage || undefined,
      });

      return {
        content: [{
          type: 'image' as const,
          data: buffer.toString('base64'),
          mimeType: 'image/png',
        }],
      };
    },
  );
}
