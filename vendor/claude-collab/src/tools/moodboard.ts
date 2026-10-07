import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerMoodboardTool(server: McpServer): void {
  server.tool(
    'collab_moodboard',
    'Show all collected design inspirations as a visual moodboard in the preview panel. Displays screenshot thumbnails, categories, notes, and source info in a grid. Use after collecting several inspirations to review before synthesis.',
    {
      filter: z.enum(['all', 'header', 'nav', 'hero', 'layout', 'colors', 'typography', 'spacing', 'component', 'footer', 'card', 'button', 'form', 'animation', 'other']).default('all').describe('Filter by category, or show all'),
    },
    async ({ filter }) => {
      const t = getTransport();

      const items = await t.evalWidget(
        (cat: string) => {
          const all = (window as any).__dc._inspirations || [];
          if (cat === 'all') return all;
          return all.filter((i: any) => i.category === cat);
        },
        filter,
      );

      if (items.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              items: [],
              hint: 'No inspirations collected yet. Use collab_collect to capture elements from sites you\'re browsing.',
            }),
          }],
        };
      }

      // Build moodboard HTML for the preview panel
      const cards = items.map((item: any, i: number) => {
        const thumb = item.screenshotB64
          ? `<img src="data:image/png;base64,${item.screenshotB64}" style="width:100%;height:140px;object-fit:cover;border-radius:6px 6px 0 0;" />`
          : `<div style="width:100%;height:140px;background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:center;color:#555;font-size:12px;">No preview</div>`;

        const badge = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${getCategoryColor(item.category)};color:#fff;text-transform:uppercase;letter-spacing:0.5px;">${item.category}</span>`;

        const noteHtml = item.note ? `<div style="font-size:11px;color:#a0a0b0;margin-top:4px;font-style:italic;">"${escapeHtml(item.note)}"</div>` : '';

        const source = item.sourceTitle
          ? `<div style="font-size:10px;color:#666;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(item.sourceUrl)}">${escapeHtml(item.sourceTitle)}</div>`
          : '';

        const dims = item.dimensions
          ? `<span style="font-size:10px;color:#555;">${item.dimensions.width}×${item.dimensions.height}</span>`
          : '';

        return `
          <div style="background:#1a1a2e;border-radius:8px;overflow:hidden;border:1px solid #2a2a4a;transition:transform 0.15s;cursor:default;" data-inspiration-id="${item.id}">
            ${thumb}
            <div style="padding:8px 10px 10px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                ${badge} ${dims}
              </div>
              ${noteHtml}
              ${source}
            </div>
          </div>`;
      }).join('');

      const categoryCount = items.reduce((acc: Record<string, number>, item: any) => {
        acc[item.category] = (acc[item.category] || 0) + 1;
        return acc;
      }, {});

      const filterChips = Object.entries(categoryCount).map(([cat, count]) =>
        `<span style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;background:${getCategoryColor(cat as string)};color:#fff;opacity:0.8;">${cat} (${count})</span>`
      ).join(' ');

      const totalItems = await t.evalWidget(() => ((window as any).__dc._inspirations || []).length);

      const moodboardHtml = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e0e0e0;padding:16px;max-height:70vh;overflow-y:auto;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div>
              <h2 style="margin:0;font-size:16px;font-weight:600;color:#fff;">Inspiration Board</h2>
              <p style="margin:2px 0 0;font-size:12px;color:#888;">${items.length} item${items.length !== 1 ? 's' : ''}${filter !== 'all' ? ` (filtered: ${filter})` : ''} of ${totalItems} total</p>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">
            ${filterChips}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;">
            ${cards}
          </div>
        </div>`;

      await t.evalWidget((h: string) => window.__dc.api.renderPreview(h), moodboardHtml);

      // Return structured data for Claude's context
      const summary = items.map((item: any) => ({
        id: item.id,
        category: item.category,
        note: item.note,
        sourceUrl: item.sourceUrl,
        sourceTitle: item.sourceTitle,
        dimensions: item.dimensions,
        tag: item.tag,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            moodboard: true,
            showing: items.length,
            total: totalItems,
            filter,
            categories: categoryCount,
            items: summary,
          }, null, 2),
        }],
      };
    },
  );
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    header: '#6366f1',
    nav: '#8b5cf6',
    hero: '#ec4899',
    layout: '#14b8a6',
    colors: '#f59e0b',
    typography: '#3b82f6',
    spacing: '#10b981',
    component: '#6366f1',
    footer: '#64748b',
    card: '#a855f7',
    button: '#ef4444',
    form: '#06b6d4',
    animation: '#f97316',
    other: '#71717a',
  };
  return colors[category] || '#71717a';
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
