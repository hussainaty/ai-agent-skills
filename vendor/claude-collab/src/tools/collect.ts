import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerCollectTool(server: McpServer): void {
  server.tool(
    'collab_collect',
    'Collect a design inspiration from the current page. Captures the selected element\'s styles, component HTML, a screenshot thumbnail, and the source URL. Tag it with a category (header, colors, layout, typography, spacing, component, etc.) and an optional note. Items accumulate across tabs for later synthesis.',
    {
      selector: z.string().describe('CSS selector of the element to collect'),
      category: z.enum(['header', 'nav', 'hero', 'layout', 'colors', 'typography', 'spacing', 'component', 'footer', 'card', 'button', 'form', 'animation', 'other']).describe('What aspect of this element you\'re collecting'),
      note: z.string().max(2000).optional().describe('User note — e.g. "love the gradient", "clean spacing"'),
    },
    async ({ selector, category, note }) => {
      const t = getTransport();

      // Extract styles
      const styles = await t.evalFrame(
        (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 200),
            rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
            styles: {
              color: cs.color,
              backgroundColor: cs.backgroundColor,
              fontFamily: cs.fontFamily,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              lineHeight: cs.lineHeight,
              letterSpacing: cs.letterSpacing,
              textAlign: cs.textAlign,
              textTransform: cs.textTransform,
              padding: cs.padding,
              margin: cs.margin,
              gap: cs.gap,
              display: cs.display,
              flexDirection: cs.flexDirection,
              alignItems: cs.alignItems,
              justifyContent: cs.justifyContent,
              borderRadius: cs.borderRadius,
              border: cs.border,
              boxShadow: cs.boxShadow,
              backgroundImage: cs.backgroundImage,
              opacity: cs.opacity,
              transition: cs.transition,
            },
          };
        },
        selector,
      );

      if (!styles) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Element not found: ${selector}` }) }],
        };
      }

      // Extract component HTML+CSS
      const component = await t.evalFrame(
        (sel: string) => {
          const root = document.querySelector(sel);
          if (!root) return null;

          const baseline = document.createElement('div');
          baseline.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
          document.body.appendChild(baseline);
          const defaultStyles = window.getComputedStyle(baseline);

          const inheritedProps = new Set([
            'color', 'font-family', 'font-size', 'font-weight', 'font-style',
            'line-height', 'letter-spacing', 'text-align', 'text-transform',
            'visibility', 'cursor',
          ]);

          const clone = root.cloneNode(true) as Element;
          const rules: Array<{ className: string; properties: string }> = [];
          let classCounter = 0;

          const origWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);

          const processNode = (origNode: Element, cloneNode: Element, parentNode: Element | null) => {
            const cs = window.getComputedStyle(origNode);
            const parentCs = parentNode ? window.getComputedStyle(parentNode) : null;
            const props: string[] = [];
            for (let i = 0; i < cs.length; i++) {
              const prop = cs[i];
              const val = cs.getPropertyValue(prop);
              const defaultVal = defaultStyles.getPropertyValue(prop);
              if (val === defaultVal) continue;
              if (parentCs && inheritedProps.has(prop) && val === parentCs.getPropertyValue(prop)) continue;
              if (prop.startsWith('-webkit-') || prop.startsWith('-moz-')) continue;
              props.push(`${prop}: ${val}`);
            }
            if (props.length === 0) return;
            const className = `dc-ins-${classCounter++}`;
            cloneNode.classList.add(className);
            rules.push({ className, properties: props.join(';\n  ') });
          };

          processNode(root, clone, root.parentElement);
          let origCurrent = origWalker.nextNode() as Element | null;
          let cloneCurrent = cloneWalker.nextNode() as Element | null;
          while (origCurrent && cloneCurrent) {
            processNode(origCurrent, cloneCurrent, origCurrent.parentElement);
            origCurrent = origWalker.nextNode() as Element | null;
            cloneCurrent = cloneWalker.nextNode() as Element | null;
          }

          // Resolve relative URLs
          clone.querySelectorAll('[src], [href]').forEach(el => {
            ['src', 'href'].forEach(attr => {
              const val = el.getAttribute(attr);
              if (val && !val.startsWith('http') && !val.startsWith('data:') && !val.startsWith('#')) {
                try { el.setAttribute(attr, new URL(val, location.href).href); } catch { /* skip */ }
              }
            });
          });

          // Clean dc- classes
          clone.querySelectorAll('.dc-highlight, .dc-hover-highlight').forEach(el => {
            el.classList.remove('dc-highlight', 'dc-hover-highlight');
          });
          clone.classList.remove('dc-highlight', 'dc-hover-highlight');

          const css = rules.map(r => `.${r.className} {\n  ${r.properties};\n}`).join('\n\n');
          document.body.removeChild(baseline);
          return { html: clone.outerHTML, css };
        },
        selector,
      );

      // Take element screenshot via transport
      let screenshotB64: string | null = null;
      try {
        const buf = await t.screenshot({ selector });
        screenshotB64 = buf.toString('base64');
      } catch { /* screenshot failed, continue without it */ }

      // Get source URL and tab info
      const sourceUrl = await t.evalFrame(() => location.href);
      const sourceTitle = await t.evalFrame(() => document.title);

      // Store in the widget's inspiration collection
      const itemId = await t.evalWidget(
        (item: any) => {
          if (!window.__dc._inspirations) window.__dc._inspirations = [];
          if (window.__dc._inspirations.length >= 50) {
            return '__FULL__';
          }
          const id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
          window.__dc._inspirations.push({ id, ...item });
          return id;
        },
        {
          category,
          note: note || null,
          selector,
          sourceUrl,
          sourceTitle,
          styles: styles.styles,
          dimensions: styles.rect,
          tag: styles.tag,
          text: styles.text,
          componentHtml: component?.html || null,
          componentCss: component?.css || null,
          screenshotB64,
          collectedAt: new Date().toISOString(),
        },
      );

      if (itemId === '__FULL__') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Collection full (50 items max). Use collab_synthesize to process current items, then clear.' }),
          }],
        };
      }

      // Notify via chat
      const label = note ? `${category}: "${note}"` : category;
      await t.evalWidget(
        (msg: string) => window.__dc.api.system(msg),
        `✨ Collected inspiration: ${label} (from ${sourceTitle})`,
      );

      const count = await t.evalWidget(() => (window.__dc._inspirations || []).length);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            collected: true,
            id: itemId,
            category,
            note: note || null,
            sourceUrl,
            sourceTitle,
            dimensions: styles.rect,
            totalCollected: count,
          }, null, 2),
        }],
      };
    },
  );
}
