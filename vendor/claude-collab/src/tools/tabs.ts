import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerTabsTool(server: McpServer): void {
  server.tool(
    'collab_tabs',
    'Manage browser tabs. List all open tabs, switch to a specific tab, or close a tab. The chat widget persists across all tabs.',
    {
      action: z.enum(['list', 'switch', 'close']).describe('Action: "list" shows all tabs, "switch" activates a tab, "close" removes a tab'),
      tabId: z.number().optional().describe('Tab ID (required for switch and close actions)'),
    },
    async ({ action, tabId }) => {
      const t = getTransport();
      const mode = t.getMode();

      if (mode === 'single') {
        if (action === 'list') {
          const url = await t.evalFrame(() => location.href);
          const title = await t.evalFrame(() => document.title);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                mode: 'single',
                tabs: [{ id: 0, url, title, active: true }],
              }, null, 2),
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Tab management not available in single-page mode. Use collab_navigate to change pages.' }),
          }],
        };
      }

      switch (action) {
        case 'list': {
          const tabs = await t.listTabs();
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ tabs }, null, 2),
            }],
          };
        }

        case 'switch': {
          if (!tabId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: 'tabId is required for switch action' }),
              }],
            };
          }
          await t.switchTab(tabId);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ switched: true, activeTabId: tabId }),
            }],
          };
        }

        case 'close': {
          if (!tabId) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: 'tabId is required for close action' }),
              }],
            };
          }
          await t.closeTab(tabId);
          const remainingTabs = await t.listTabs();
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ closed: true, closedTabId: tabId, remainingTabs }),
            }],
          };
        }
      }
    },
  );
}
