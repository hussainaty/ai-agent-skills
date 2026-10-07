import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerExtractComponentTool(server: McpServer): void {
  server.tool(
    'collab_extract_component',
    'Extract a DOM element as a self-contained HTML+CSS component. Captures the full subtree with computed styles, resolves relative URLs, and returns portable code ready to use elsewhere.',
    {
      selector: z.string().describe('CSS selector for the root element'),
      mode: z.enum(['inline', 'stylesheet']).default('stylesheet').describe('inline = styles as attributes, stylesheet = scoped style block'),
      pseudoStates: z.boolean().default(false).describe('Also extract :hover/:focus rules from stylesheets'),
    },
    async ({ selector, mode, pseudoStates }) => {
      const t = getTransport();

      const result = await t.evalFrame(
        ({ sel, extractMode, extractPseudo }: { sel: string; extractMode: string; extractPseudo: boolean }) => {
          let root: Element | null;
          try { root = document.querySelector(sel); } catch { return { error: `Invalid CSS selector: ${sel}` }; }
          if (!root) return { error: `Element not found: ${sel}` };

          // Create baseline div to get browser defaults
          const baseline = document.createElement('div');
          baseline.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
          document.body.appendChild(baseline);
          const defaultStyles = window.getComputedStyle(baseline);

          // Properties that are inherited by default
          const inheritedProps = new Set([
            'color', 'font-family', 'font-size', 'font-weight', 'font-style',
            'line-height', 'letter-spacing', 'text-align', 'text-transform',
            'text-indent', 'word-spacing', 'white-space', 'direction',
            'visibility', 'cursor', 'list-style-type', 'list-style-position',
          ]);

          const clone = root.cloneNode(true) as Element;
          const rules: Array<{ className: string; properties: string }> = [];
          const fonts = new Set<string>();
          const assets = new Set<string>();
          let classCounter = 0;

          // Walk both original and clone subtrees in parallel
          const origWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);

          const processNode = (origNode: Element, cloneNode: Element, parentNode: Element | null) => {
            const cs = window.getComputedStyle(origNode);
            const parentCs = parentNode ? window.getComputedStyle(parentNode) : null;

            // Track fonts
            const ff = cs.fontFamily;
            if (ff) ff.split(',').forEach(f => fonts.add(f.trim().replace(/['"]/g, '')));

            const props: string[] = [];
            for (let i = 0; i < cs.length; i++) {
              const prop = cs[i];
              const val = cs.getPropertyValue(prop);
              const defaultVal = defaultStyles.getPropertyValue(prop);

              // Skip browser defaults
              if (val === defaultVal) continue;
              // Skip inherited values that match parent
              if (parentCs && inheritedProps.has(prop) && val === parentCs.getPropertyValue(prop)) continue;
              // Skip shorthand duplication noise
              if (prop.startsWith('-webkit-') || prop.startsWith('-moz-')) continue;

              props.push(`${prop}: ${val}`);
            }

            if (props.length === 0) return;

            if (extractMode === 'inline') {
              cloneNode.setAttribute('style', props.join('; '));
            } else {
              const className = `dc-ext-${classCounter++}`;
              cloneNode.classList.add(className);
              rules.push({ className, properties: props.join(';\n  ') });
            }
          };

          // Process root
          processNode(root, clone, root.parentElement);

          // Process children
          let origCurrent = origWalker.nextNode() as Element | null;
          let cloneCurrent = cloneWalker.nextNode() as Element | null;
          while (origCurrent && cloneCurrent) {
            processNode(origCurrent, cloneCurrent, origCurrent.parentElement);
            origCurrent = origWalker.nextNode() as Element | null;
            cloneCurrent = cloneWalker.nextNode() as Element | null;
          }

          // Resolve relative URLs in clone
          clone.querySelectorAll('[src], [href]').forEach(el => {
            ['src', 'href'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && !val.startsWith('http') && !val.startsWith('data:') && !val.startsWith('#')) {
                try {
                  const abs = new URL(val, location.href).href;
                  el.setAttribute(attr, abs);
                  assets.add(abs);
                } catch { /* skip */ }
              }
            });
          });

          // Check background-image URLs
          clone.querySelectorAll('*').forEach(el => {
            const style = (el as HTMLElement).style?.backgroundImage;
            if (style && style.includes('url(')) {
              const match = style.match(/url\(["']?([^"')]+)["']?\)/);
              if (match && match[1] && !match[1].startsWith('data:')) {
                try {
                  assets.add(new URL(match[1], location.href).href);
                } catch { /* skip */ }
              }
            }
          });

          // Extract pseudo-state rules
          let pseudoRules = '';
          if (extractPseudo) {
            try {
              for (const sheet of document.styleSheets) {
                try {
                  for (const rule of sheet.cssRules) {
                    if (rule instanceof CSSStyleRule) {
                      const sel = rule.selectorText;
                      if (sel && (sel.includes(':hover') || sel.includes(':focus') || sel.includes(':active'))) {
                        // Check if rule matches any element in our subtree
                        try {
                          if (root.querySelector(sel.replace(/:(hover|focus|active)/g, '')) || root.matches(sel.replace(/:(hover|focus|active)/g, ''))) {
                            pseudoRules += rule.cssText + '\n';
                          }
                        } catch { /* invalid selector */ }
                      }
                    }
                  }
                } catch { /* cross-origin stylesheet */ }
              }
            } catch { /* no access */ }
          }

          const rect = root.getBoundingClientRect();
          document.body.removeChild(baseline);

          // Remove dc-highlight/dc-hover-highlight classes from clone
          clone.querySelectorAll('.dc-highlight, .dc-hover-highlight').forEach(el => {
            el.classList.remove('dc-highlight', 'dc-hover-highlight');
          });
          clone.classList.remove('dc-highlight', 'dc-hover-highlight');

          const css = rules.map(r => `.${r.className} {\n  ${r.properties};\n}`).join('\n\n');
          const html = clone.outerHTML;

          return {
            html,
            css: extractMode === 'stylesheet' ? css : '',
            fonts: [...fonts],
            assets: [...assets],
            dimensions: { width: Math.round(rect.width), height: Math.round(rect.height) },
            pseudoRules: pseudoRules || undefined,
          };
        },
        { sel: selector, extractMode: mode, extractPseudo: pseudoStates },
      );

      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }

      // Build self-contained HTML document
      const fullDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; padding: 24px; }
${result.css}
${result.pseudoRules || ''}
</style>
</head>
<body>
${result.html}
</body>
</html>`;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            fullDocument: fullDoc,
          }, null, 2),
        }],
      };
    },
  );
}
