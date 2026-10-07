import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerExtractStylesTool(server: McpServer): void {
  server.tool(
    'collab_extract_styles',
    'Extract computed styles and design tokens from an element in the target site. Returns colors, typography, spacing, borders, shadows — everything needed to replicate the element\'s appearance.',
    {
      selector: z.string().max(500).describe('CSS selector for the element to extract styles from'),
      includeChildren: z.boolean().default(false).describe('Also extract styles from direct children'),
    },
    async ({ selector, includeChildren }) => {
      const t = getTransport();

      const result = await t.evalFrame(
        ({ sel, children }: { sel: string; children: boolean }) => {
          function extractStyles(el: Element) {
            const cs = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              classes: [...el.classList].filter(c => !c.startsWith('dc-')),
              text: (el.textContent || '').trim().slice(0, 120),
              rect: { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) },
              styles: {
                // Colors
                color: cs.color,
                backgroundColor: cs.backgroundColor,
                // Typography
                fontFamily: cs.fontFamily,
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                lineHeight: cs.lineHeight,
                letterSpacing: cs.letterSpacing,
                textAlign: cs.textAlign,
                textTransform: cs.textTransform,
                // Spacing
                padding: cs.padding,
                margin: cs.margin,
                gap: cs.gap,
                // Layout
                display: cs.display,
                flexDirection: cs.flexDirection,
                alignItems: cs.alignItems,
                justifyContent: cs.justifyContent,
                // Size
                width: cs.width,
                height: cs.height,
                maxWidth: cs.maxWidth,
                // Borders
                border: cs.border,
                borderRadius: cs.borderRadius,
                // Effects
                boxShadow: cs.boxShadow,
                opacity: cs.opacity,
                // Transitions
                transition: cs.transition,
              },
            };
          }

          let el: Element | null;
          try { el = document.querySelector(sel); } catch { return { error: `Invalid CSS selector: ${sel}` }; }
          if (!el) return { error: `Element not found: ${sel}` };

          const main = extractStyles(el);
          if (!children) return { element: main };

          const childElements = [...el.children]
            .slice(0, 10)
            .map(c => extractStyles(c));

          return { element: main, children: childElements };
        },
        { sel: selector, children: includeChildren },
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );
}
