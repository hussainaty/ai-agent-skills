import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerResponsiveAuditTool(server: McpServer): void {
  server.tool(
    'collab_responsive_audit',
    'Audit responsive design across breakpoints. Resizes viewport, runs layout checks, captures screenshots per breakpoint.',
    {
      breakpoints: z.array(z.object({
        name: z.string(),
        width: z.number().min(100).max(5000),
        height: z.number().min(100).max(5000),
      })).default([
        { name: 'mobile-portrait', width: 390, height: 844 },
        { name: 'mobile-landscape', width: 844, height: 390 },
        { name: 'tablet-portrait', width: 768, height: 1024 },
        { name: 'tablet-landscape', width: 1024, height: 768 },
        { name: 'desktop', width: 1280, height: 800 },
      ]).describe('Breakpoints to test (includes portrait and landscape)'),
      includeScreenshots: z.boolean().default(true).describe('Capture screenshots per breakpoint'),
    },
    async ({ breakpoints, includeScreenshots }) => {
      const t = getTransport();
      const originalViewport = await t.getViewportSize();
      const mode = t.getMode();

      const results: Array<{
        breakpoint: string;
        width: number;
        height: number;
        issues: Array<{ type: string; selector: string; message: string }>;
      }> = [];
      const screenshots: Array<{ name: string; data: string }> = [];

      // In single/extension mode, hide widget elements during resize
      if (mode === 'single' || mode === 'extension') {
        await t.evalWidget(() => {
          document.querySelectorAll('.dc-chat, .dc-preview, .dc-status-console').forEach((el: any) => {
            el.dataset.dcHidden = el.style.display || '';
            el.style.display = 'none';
          });
        });
      }

      try {
      for (const bp of breakpoints) {
        await t.setViewportSize({ width: bp.width, height: bp.height });
        // Wait for layout settle
        await new Promise(r => setTimeout(r, 500));

        // Run layout checks
        const issues = await t.evalFrame(
          (vpWidth: number) => {
            const problems: Array<{ type: string; selector: string; message: string }> = [];

            const uniqueSel = (el: Element): string => {
              if (el.id) return `#${el.id}`;
              let sel = el.tagName.toLowerCase();
              if (el.className && typeof el.className === 'string') {
                const cls = [...el.classList].filter(c => !c.startsWith('dc-')).slice(0, 2);
                if (cls.length) sel += '.' + cls.join('.');
              }
              return sel;
            };

            // Horizontal overflow
            if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
              problems.push({
                type: 'overflow',
                selector: 'html',
                message: `Page has horizontal overflow: ${document.documentElement.scrollWidth}px > ${document.documentElement.clientWidth}px viewport`,
              });
            }

            const els = document.querySelectorAll('body *');
            for (const el of els) {
              const cs = window.getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;

              // Off-screen elements
              if (rect.right < 0 || rect.left > vpWidth) {
                problems.push({
                  type: 'off-screen',
                  selector: uniqueSel(el),
                  message: `Element is off-screen (left: ${Math.round(rect.left)}px, right: ${Math.round(rect.right)}px)`,
                });
              }

              // Tiny text
              const fontSize = parseFloat(cs.fontSize);
              if (el.childNodes.length > 0 && fontSize < 12) {
                const hasDirectText = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim());
                if (hasDirectText) {
                  problems.push({
                    type: 'tiny-text',
                    selector: uniqueSel(el),
                    message: `Text size ${fontSize}px is below 12px minimum`,
                  });
                }
              }

              // Small touch targets
              const isInteractive = el.matches('a, button, [role="button"], input, select, textarea, [onclick], [tabindex]');
              if (isInteractive && (rect.width < 44 || rect.height < 44)) {
                problems.push({
                  type: 'small-target',
                  selector: uniqueSel(el),
                  message: `Touch target ${Math.round(rect.width)}x${Math.round(rect.height)}px (minimum 44x44)`,
                });
              }
            }

            return problems.slice(0, 30); // cap per breakpoint
          },
          bp.width,
        );

        results.push({
          breakpoint: bp.name,
          width: bp.width,
          height: bp.height,
          issues,
        });

        // Capture screenshot
        if (includeScreenshots) {
          try {
            const buffer = await t.screenshot();
            screenshots.push({ name: bp.name, data: buffer.toString('base64') });
          } catch (err) {
            console.error(`[collab] Screenshot failed for ${bp.name}:`, err);
          }
        }
      }

      } finally {
      // Restore original viewport (runs even on error)
      if (originalViewport) {
        try { await t.setViewportSize(originalViewport); } catch { /* best effort */ }
      }

      // Restore widget elements in single/extension mode
      if (mode === 'single' || mode === 'extension') {
        try {
        await t.evalWidget(() => {
          document.querySelectorAll('.dc-chat, .dc-preview, .dc-status-console').forEach((el: any) => {
            el.style.display = el.dataset.dcHidden || '';
            delete el.dataset.dcHidden;
          });
        });
        } catch { /* best effort */ }
      }
      }

      // Build summary
      const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
      const summary = {
        breakpointsTested: breakpoints.length,
        totalIssues,
        byBreakpoint: results.map(r => ({ name: r.breakpoint, width: r.width, issues: r.issues.length })),
      };

      // Build content blocks
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
      content.push({
        type: 'text' as const,
        text: JSON.stringify({ results, summary }, null, 2),
      });

      for (const ss of screenshots) {
        content.push({
          type: 'image' as const,
          data: ss.data,
          mimeType: 'image/png',
        });
      }

      return { content };
    },
  );
}
