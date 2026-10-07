import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerEvaluateTool(server: McpServer): void {
  server.tool(
    'collab_evaluate',
    'Execute arbitrary JavaScript in the target site\'s iframe. Use for DOM inspection, style queries, design token extraction, or any custom page interaction. The code runs in the iframe context (target site), not the parent frame.',
    {
      expression: z.string().max(500000).describe('JavaScript expression to evaluate in the target iframe. Must be a valid expression that returns a serializable value.'),
    },
    async ({ expression }) => {
      const t = getTransport();
      const mode = t.getMode();
      const needsProtection = mode === 'single' || mode === 'extension';

      try {
        // In single/extension mode, detach widget elements before eval to protect them from DOM manipulation
        if (needsProtection) {
          await t.evalFrame(() => {
            const selectors = ['.dc-chat', '.dc-preview', '.dc-status-console', '[id^="dc-panel-"]'];
            const saved: Element[] = [];
            for (const sel of selectors) {
              document.querySelectorAll(sel).forEach(el => saved.push(el));
            }
            saved.forEach(el => el.parentNode?.removeChild(el));
            (window as any).__dcSavedEls = saved;
          });
        }

        const result = await t.evalFrame((expr: string) => {
          // SECURITY BOUNDARY: This eval is the tool's primary purpose — it lets Claude
          // inspect/manipulate the target page's DOM. The code runs in the iframe context
          // (target site), isolated from the parent frame. The trust boundary is Claude itself.
          return (0, eval)(expr);
        }, expression);

        // Re-append widget elements after eval and restore scroll positions
        if (needsProtection) {
          await t.evalFrame(() => {
            const saved = (window as any).__dcSavedEls as Element[] | undefined;
            if (saved) {
              saved.forEach(el => document.body.appendChild(el));
              delete (window as any).__dcSavedEls;
              // Restore chat scroll to bottom — detach/reattach resets scrollTop to 0
              const msgContainer = document.querySelector('.dc-messages') as HTMLElement;
              if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
            }
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ result }, null, 2),
          }],
        };
      } catch (err) {
        // Still try to restore widget on error
        if (needsProtection) {
          try {
            await t.evalFrame(() => {
              const saved = (window as any).__dcSavedEls as Element[] | undefined;
              if (saved) {
                saved.forEach(el => document.body.appendChild(el));
                delete (window as any).__dcSavedEls;
                const msgContainer = document.querySelector('.dc-messages') as HTMLElement;
                if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
              }
            });
          } catch { /* best effort */ }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    },
  );
}
