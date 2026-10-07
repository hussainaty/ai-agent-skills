import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerSynthesizeTool(server: McpServer): void {
  server.tool(
    'collab_synthesize',
    'Analyze all collected inspirations and produce a unified design specification. Extracts color palettes, typography scales, spacing systems, and layout patterns from the collected items. Returns structured data that can be used to build a page combining the best elements from each source. Optionally clears the collection after synthesis.',
    {
      clear: z.boolean().default(false).describe('Clear the inspiration collection after synthesis'),
    },
    async ({ clear }) => {
      const t = getTransport();

      const items = await t.evalWidget(() => {
        return (window as any).__dc._inspirations || [];
      });

      if (items.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No inspirations collected. Use collab_collect to capture elements first.',
            }),
          }],
        };
      }

      // Analyze colors across all items
      const allColors = new Map<string, { count: number; sources: string[]; categories: string[] }>();
      const allFonts = new Map<string, { count: number; sources: string[]; sizes: string[] }>();
      const allSpacing = new Map<string, number>();
      const allRadii = new Map<string, number>();
      const allShadows = new Map<string, number>();

      // Components by category
      const componentsByCategory: Record<string, any[]> = {};

      for (const item of items) {
        const s = item.styles;
        if (!s) continue;

        const source = item.sourceTitle || item.sourceUrl || 'unknown';
        const cat = item.category;

        // Collect colors
        for (const prop of ['color', 'backgroundColor']) {
          const val = s[prop];
          if (val && val !== 'rgba(0, 0, 0, 0)' && val !== 'transparent') {
            const existing = allColors.get(val) || { count: 0, sources: [], categories: [] };
            existing.count++;
            if (!existing.sources.includes(source)) existing.sources.push(source);
            if (!existing.categories.includes(cat)) existing.categories.push(cat);
            allColors.set(val, existing);
          }
        }

        // Collect fonts
        if (s.fontFamily) {
          const font = s.fontFamily.split(',')[0].trim().replace(/['"]/g, '');
          const existing = allFonts.get(font) || { count: 0, sources: [], sizes: [] };
          existing.count++;
          if (!existing.sources.includes(source)) existing.sources.push(source);
          if (s.fontSize && !existing.sizes.includes(s.fontSize)) existing.sizes.push(s.fontSize);
          allFonts.set(font, existing);
        }

        // Collect spacing values
        for (const prop of ['padding', 'margin', 'gap']) {
          const val = s[prop];
          if (val && val !== '0px') {
            allSpacing.set(val, (allSpacing.get(val) || 0) + 1);
          }
        }

        // Collect border radii
        if (s.borderRadius && s.borderRadius !== '0px') {
          allRadii.set(s.borderRadius, (allRadii.get(s.borderRadius) || 0) + 1);
        }

        // Collect shadows
        if (s.boxShadow && s.boxShadow !== 'none') {
          allShadows.set(s.boxShadow, (allShadows.get(s.boxShadow) || 0) + 1);
        }

        // Group components by category
        if (!componentsByCategory[cat]) componentsByCategory[cat] = [];
        componentsByCategory[cat].push({
          id: item.id,
          sourceUrl: item.sourceUrl,
          sourceTitle: item.sourceTitle,
          note: item.note,
          tag: item.tag,
          dimensions: item.dimensions,
          html: item.componentHtml,
          css: item.componentCss,
          hasScreenshot: !!item.screenshotB64,
        });
      }

      // Sort by frequency
      const sortByCount = (map: Map<string, any>) =>
        [...map.entries()].sort((a, b) => {
          const countA = typeof a[1] === 'number' ? a[1] : a[1].count;
          const countB = typeof b[1] === 'number' ? b[1] : b[1].count;
          return countB - countA;
        });

      const colorPalette = sortByCount(allColors).map(([color, info]) => ({
        value: color,
        count: info.count,
        sources: info.sources,
        usedFor: info.categories,
      }));

      const typographyScale = sortByCount(allFonts).map(([font, info]) => ({
        family: font,
        count: info.count,
        sizes: info.sizes.sort(),
        sources: info.sources,
      }));

      const spacingScale = sortByCount(allSpacing).map(([val, count]) => ({
        value: val,
        count,
      }));

      const borderRadii = sortByCount(allRadii).map(([val, count]) => ({
        value: val,
        count,
      }));

      const shadows = sortByCount(allShadows).map(([val, count]) => ({
        value: val,
        count,
      }));

      // Clear if requested
      if (clear) {
        await t.evalWidget(() => {
          (window as any).__dc._inspirations = [];
        });
      }

      // Build synthesis result
      const synthesis = {
        totalItems: items.length,
        categories: Object.keys(componentsByCategory),
        designTokens: {
          colors: colorPalette,
          typography: typographyScale,
          spacing: spacingScale.slice(0, 15),
          borderRadii: borderRadii.slice(0, 10),
          shadows: shadows.slice(0, 10),
        },
        components: componentsByCategory,
        cleared: clear,
      };

      // Show summary in chat
      await t.evalWidget(
        (msg: string) => window.__dc.api.system(msg),
        `🎨 Synthesis complete: ${items.length} inspirations → ${colorPalette.length} colors, ${typographyScale.length} fonts, ${Object.keys(componentsByCategory).length} component categories`,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(synthesis, null, 2),
        }],
      };
    },
  );
}
