import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerSelectionsTool(server: McpServer): void {
  server.tool(
    'collab_selections',
    'Get elements the user has selected via click capture in the collab widget. Returns element data with computed styles. Clears the selection buffer after reading.',
    {},
    async () => {
      const t = getTransport();

      const selections = await t.evalWidget(() => window.__dc.api.getSelections());

      if (selections.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ selections: [], hint: 'No elements selected. The user needs to enable click capture (⊕ button) and click elements first.' }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ selections }, null, 2),
        }],
      };
    },
  );
}
