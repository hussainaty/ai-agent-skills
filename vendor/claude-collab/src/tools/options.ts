import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerOptionsTool(server: McpServer): void {
  server.tool(
    'collab_options',
    'Present clickable design options in the preview panel. When the user clicks an option, it replaces the target element in the iframe via the bridge. Includes a revert button. Use for A/B comparisons.',
    {
      selector: z.string().describe('CSS selector for the element to replace (e.g. ".hero-title", "#logo", "nav")'),
      options: z.array(z.object({
        label: z.string().describe('Name for this option (e.g. "Option A", "Rounded corners")'),
        html: z.string().max(100000).describe('HTML that will replace the target element when clicked'),
      })).min(2).describe('Design options to present (minimum 2)'),
    },
    async ({ selector, options }) => {
      const t = getTransport();

      // Verify the element exists in the target page
      const found = await t.evalFrame(
        (sel: string) => !!document.querySelector(sel),
        selector,
      );

      if (!found) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Element not found in target site: ${selector}` }),
          }],
        };
      }

      // Show option cards in the widget's preview panel (parent frame).
      // renderOptions sends dc-init-options to iframe bridge to store
      // the target reference, then shows clickable cards that send
      // dc-apply-option / dc-revert-option on user interaction.
      await t.evalWidget(
        ({ sel, opts }: { sel: string; opts: { label: string; html: string }[] }) => {
          window.__dc.api.renderOptions(sel, opts);
        },
        { sel: selector, opts: options },
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            presented: true,
            selector,
            optionCount: options.length,
            hint: 'Options are showing in the preview panel. The user can click to apply, and revert to undo.',
          }),
        }],
      };
    },
  );
}
