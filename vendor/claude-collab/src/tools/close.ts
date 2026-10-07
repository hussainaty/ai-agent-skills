import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport, clearTransport } from '../transport.js';

export function registerCloseTool(server: McpServer): void {
  server.tool(
    'collab_close',
    'Close the design browser window and clean up. Call this when the design session is over.',
    {},
    async () => {
      try {
        const t = getTransport();
        await t.cleanup();
      } catch { /* no transport active */ }
      clearTransport();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ closed: true }),
        }],
      };
    },
  );
}
