import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerResizeTool(server: McpServer): void {
  server.tool(
    'collab_resize',
    'Resize the browser viewport for responsive design testing. Common breakpoints: mobile (390x844), tablet (768x1024), desktop (1280x800), wide (1440x900).',
    {
      width: z.number().min(320).max(2560).describe('Viewport width in pixels'),
      height: z.number().min(480).max(1600).describe('Viewport height in pixels'),
    },
    async ({ width, height }) => {
      const t = getTransport();

      await t.setViewportSize({ width, height });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ resized: true, width, height }),
        }],
      };
    },
  );
}
