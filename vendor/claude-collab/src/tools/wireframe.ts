import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';
import { getPage, getActiveFrame, isSingleMode, openNewTab } from '../browser.js';
import { getWidgetScript, getVoiceModuleScript, getInspectorScript, getIframeBridgeInitScript } from '../widget.js';

export function registerWireframeTool(server: McpServer): void {
  server.tool(
    'collab_wireframe',
    'Open a blank wireframing canvas with optional grid overlay. Use collab_evaluate to add sections, the inspector to refine.',
    {
      html: z.string().max(500000).optional().describe('Initial wireframe HTML to render'),
      grid: z.boolean().default(true).describe('Show alignment grid'),
      gridSize: z.number().min(1).max(200).default(8).describe('Grid size in pixels'),
    },
    async ({ html, grid, gridSize }) => {
      const gridBg = grid
        ? `background-image:
            repeating-linear-gradient(0deg, rgba(129,140,248,0.06) 0px, transparent 1px, transparent ${gridSize}px),
            repeating-linear-gradient(90deg, rgba(129,140,248,0.06) 0px, transparent 1px, transparent ${gridSize}px);
          background-size: ${gridSize}px ${gridSize}px;`
        : '';

      const canvasHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; min-height: 100vh; background: #fff; ${gridBg} }

  /* Wireframe utility classes */
  .wf-section {
    padding: 32px 24px;
    border: 2px dashed #d1d5db;
    margin: 16px;
    border-radius: 8px;
    min-height: 80px;
  }
  .wf-text {
    background: #e5e7eb;
    border-radius: 4px;
    padding: 8px 12px;
    color: #6b7280;
    font: 14px/1.5 -apple-system, sans-serif;
  }
  .wf-box {
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 16px;
    min-height: 48px;
  }
  .wf-img {
    background: #e5e7eb;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #9ca3af;
    font: 13px -apple-system, sans-serif;
    min-height: 120px;
  }
  .wf-img::before { content: '\\1F5BC  Image'; }
  .wf-btn {
    display: inline-block;
    padding: 10px 20px;
    background: #374151;
    color: #fff;
    border-radius: 6px;
    font: 600 14px -apple-system, sans-serif;
    cursor: pointer;
  }
  .wf-nav {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 12px 24px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
  }
  .wf-grid {
    display: grid;
    gap: 16px;
    padding: 16px;
  }
  .wf-flex {
    display: flex;
    gap: 16px;
    align-items: center;
  }
</style>
</head>
<body>
${html || '<!-- Empty wireframe canvas. Use collab_evaluate to add content. -->'}
</body>
</html>`;

      const t = getTransport();
      const mode = t.getMode();

      // Wireframe uses Playwright-specific APIs (setContent, goto)
      // TODO: Add extension mode support
      if (mode === 'extension') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Wireframe tool is not yet supported in extension mode.' }),
          }],
        };
      }

      const page = getPage();

      if (isSingleMode()) {
        // Navigate to blank, set content, re-inject widget + bridge
        await page.goto('about:blank', { waitUntil: 'load', timeout: 5000 });
        await page.setContent(canvasHTML, { waitUntil: 'load' });
        // setContent() destroys all document event listeners from the previous bridge.
        // Reset the bridge guard so it re-initializes with fresh listeners.
        await page.evaluate(() => {
          window.name = 'dc-frame-single';
          (window as any).__dcBridge = false;
        });
        await page.evaluate(getIframeBridgeInitScript());
        await page.evaluate(getWidgetScript());
        await page.evaluate(getVoiceModuleScript());
        await page.evaluate(getInspectorScript());
      } else {
        // Open new tab with blank page, then set content
        const { frame } = await openNewTab('about:blank');
        await frame.setContent(canvasHTML, { waitUntil: 'load' });
        // Inject bridge so click-capture and selection work on wireframe elements
        await frame.evaluate(getIframeBridgeInitScript());
      }

      // Enable snap-to-grid if grid is on
      if (grid) {
        await t.evalFrame(({ enabled, size }: { enabled: boolean; size: number }) => {
          window.postMessage({ type: 'dc-snap-grid', enabled, size }, '*');
        }, { enabled: true, size: gridSize });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            canvasReady: true,
            grid,
            gridSize,
            hint: 'Wireframe canvas ready. Use collab_evaluate to inject HTML sections. Inspector available for editing. Utility classes: .wf-section, .wf-text, .wf-box, .wf-img, .wf-btn, .wf-nav, .wf-grid, .wf-flex',
          }),
        }],
      };
    },
  );
}
