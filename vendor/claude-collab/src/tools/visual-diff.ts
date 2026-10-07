import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerVisualDiffTool(server: McpServer): void {
  server.tool(
    'collab_visual_diff',
    'Show a before/after comparison slider in the preview panel. Pass two screenshots (from collab_screenshot) to compare changes.',
    {
      before: z.string().max(10000000).describe('Base64 PNG of the "before" state'),
      after: z.string().max(10000000).describe('Base64 PNG of the "after" state'),
      labelBefore: z.string().default('Before').describe('Label for the before image'),
      labelAfter: z.string().default('After').describe('Label for the after image'),
    },
    async ({ before, after, labelBefore, labelAfter }) => {
      const sliderHTML = `<div style="position:relative;width:100%;max-width:800px;margin:0 auto;font-family:-apple-system,sans-serif;background:#1a1a2e;padding:8px;border-radius:8px;">
  <div style="position:relative;overflow:hidden;border-radius:6px;">
    <img src="data:image/png;base64,${after}" style="display:block;width:100%;height:auto;" />
    <div id="dc-diff-clip" style="position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;width:50%;">
      <img src="data:image/png;base64,${before}" style="display:block;width:100%;height:auto;min-width:0;" id="dc-diff-before-img" />
    </div>
    <div id="dc-diff-line" style="position:absolute;top:0;bottom:0;left:50%;width:2px;background:#fff;box-shadow:0 0 4px rgba(0,0,0,.5);pointer-events:none;z-index:1;"></div>
    <div id="dc-diff-handle" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:36px;height:36px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2;">
      <span style="color:#333;font-size:16px;font-weight:700;">&#x2194;</span>
    </div>
    <span style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.6);color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${labelBefore}</span>
    <span style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;">${labelAfter}</span>
  </div>
  <input type="range" min="0" max="100" value="50" style="width:100%;margin-top:8px;cursor:pointer;" oninput="
    var pct = this.value + '%';
    document.getElementById('dc-diff-clip').style.width = pct;
    document.getElementById('dc-diff-line').style.left = pct;
    document.getElementById('dc-diff-handle').style.left = pct;
    var img = document.getElementById('dc-diff-before-img');
    if (img && this.value > 0) {
      var container = document.getElementById('dc-diff-clip');
      var parent = container.parentElement;
      img.style.width = parent.offsetWidth + 'px';
      img.style.minWidth = parent.offsetWidth + 'px';
    }
  " />
</div>`;

      const t = getTransport();
      await t.evalWidget((html: string) => {
        if (window.__dc?.api) window.__dc.api.renderPreview(html);
      }, sliderHTML);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ rendered: true, hint: 'Comparison slider showing in preview panel. Drag the slider to compare before/after.' }),
        }],
      };
    },
  );
}
