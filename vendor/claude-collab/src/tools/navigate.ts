import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerNavigateTool(server: McpServer): void {
  server.tool(
    'collab_navigate',
    'Navigate to a URL within the active tab. Lighter than collab_browse — does not open a new tab or return page info.',
    {
      url: z.string().describe('URL or path to navigate to (e.g. "/about", "https://example.com")').refine(u => {
        if (u.startsWith('/')) return true; // relative path
        try { const p = new URL(u); return ['http:', 'https:'].includes(p.protocol); } catch { return false; }
      }, 'URL must be http/https or a relative path starting with /'),
    },
    async ({ url }) => {
      const t = getTransport();

      // If it's a relative path, resolve against current page/frame URL
      let targetUrl = url;
      if (url.startsWith('/')) {
        try {
          const currentUrl = await t.evalFrame(() => location.href);
          const parsed = new URL(currentUrl);
          targetUrl = `${parsed.origin}${url}`;
        } catch {
          targetUrl = url;
        }
      }

      const finalUrl = await t.navigate(targetUrl);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ navigated: true, url: finalUrl }),
        }],
      };
    },
  );
}
