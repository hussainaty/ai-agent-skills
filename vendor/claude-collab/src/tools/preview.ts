import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerPreviewTool(server: McpServer): void {
  server.tool(
    'collab_preview',
    'Render HTML into the collab widget\'s draggable preview panel. Use for showing design mockups, component variations, or CSS experiments directly on the page. Call with no html to hide the panel.',
    {
      html: z.string().optional().describe('HTML to render in the preview panel. Omit to hide the panel.'),
    },
    async ({ html }) => {
      const t = getTransport();

      if (!html) {
        await t.evalWidget(() => window.__dc.api.hidePreview());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ hidden: true }) }],
        };
      }

      await t.evalWidget((h: string) => window.__dc.api.renderPreview(h), html);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ rendered: true }) }],
      };
    },
  );
}
