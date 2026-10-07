import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerExtractTokensTool(server: McpServer): void {
  server.tool(
    'collab_extract_tokens',
    'Scan the page and extract its design system: colors, typography scales, spacing values, border radii, and shadows. Clusters similar values and outputs structured tokens.',
    {
      scope: z.string().default('body').describe('CSS selector to limit scan'),
      maxElements: z.number().max(5000).default(500).describe('Max elements to scan (performance cap)'),
    },
    async ({ scope, maxElements }) => {
      const t = getTransport();

      const result = await t.evalFrame(
        ({ scopeSel, maxEls }: { scopeSel: string; maxEls: number }) => {
          const scopeRoot = document.querySelector(scopeSel);
          if (!scopeRoot) return { error: `Scope element not found: ${scopeSel}` };

          const els = [...scopeRoot.querySelectorAll('*')].slice(0, maxEls);

          // Parse color to {r,g,b,a} using canvas trick
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d')!;

          const parseColor = (str: string): { r: number; g: number; b: number; a: number } | null => {
            if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = '#000';
            ctx.fillStyle = str;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
          };

          const rgbToHex = (r: number, g: number, b: number): string => {
            return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
          };

          const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h = 0, s = 0;
            const l = (max + min) / 2;
            if (max !== min) {
              const d = max - min;
              s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
              if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
              else if (max === g) h = ((b - r) / d + 2) / 6;
              else h = ((r - g) / d + 4) / 6;
            }
            return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
          };

          // Color distance (CIE76 approximation via HSL)
          const colorDist = (a: { h: number; s: number; l: number }, b: { h: number; s: number; l: number }): number => {
            const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)) / 180;
            const ds = (a.s - b.s) / 100;
            const dl = (a.l - b.l) / 100;
            return Math.sqrt(dh * dh + ds * ds + dl * dl) * 100;
          };

          // Frequency maps
          const colorMap = new Map<string, { r: number; g: number; b: number; a: number; count: number; usage: Set<string> }>();
          const typoMap = new Map<string, { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; count: number }>();
          const spacingSet = new Map<number, number>();
          const radiusMap = new Map<string, number>();
          const shadowMap = new Map<string, number>();

          const colorProps = ['color', 'backgroundColor', 'borderTopColor', 'outlineColor'] as const;
          const spacingProps = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
            'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap'] as const;

          for (const el of els) {
            const cs = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            // Skip invisible elements
            if (cs.display === 'none' || cs.visibility === 'hidden' || (rect.width === 0 && rect.height === 0)) continue;

            // Colors
            for (const prop of colorProps) {
              const val = cs[prop as any] as string;
              const parsed = parseColor(val);
              if (!parsed || (parsed.r === 0 && parsed.g === 0 && parsed.b === 0 && parsed.a === 0)) continue;
              const key = `${parsed.r},${parsed.g},${parsed.b},${parsed.a}`;
              const existing = colorMap.get(key);
              if (existing) {
                existing.count++;
                existing.usage.add(prop);
              } else {
                colorMap.set(key, { ...parsed, count: 1, usage: new Set([prop]) });
              }
            }

            // Typography
            const typoKey = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.lineHeight}`;
            const existingTypo = typoMap.get(typoKey);
            if (existingTypo) {
              existingTypo.count++;
            } else {
              typoMap.set(typoKey, {
                fontFamily: cs.fontFamily,
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                lineHeight: cs.lineHeight,
                count: 1,
              });
            }

            // Spacing
            for (const prop of spacingProps) {
              const val = parseFloat(cs[prop as any] as string);
              if (val > 0 && isFinite(val)) {
                const snapped = Math.round(val / 4) * 4 || val;
                spacingSet.set(snapped, (spacingSet.get(snapped) || 0) + 1);
              }
            }

            // Border radius
            const br = cs.borderRadius;
            if (br && br !== '0px') {
              radiusMap.set(br, (radiusMap.get(br) || 0) + 1);
            }

            // Box shadow
            const bs = cs.boxShadow;
            if (bs && bs !== 'none') {
              shadowMap.set(bs, (shadowMap.get(bs) || 0) + 1);
            }
          }

          // Cluster similar colors
          type ColorEntry = { hex: string; rgb: string; hsl: { h: number; s: number; l: number }; count: number; usage: string[] };
          const colorEntries: ColorEntry[] = [...colorMap.values()].map(c => ({
            hex: rgbToHex(c.r, c.g, c.b) + (c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0') : ''),
            rgb: c.a < 1
              ? `rgba(${c.r},${c.g},${c.b},${c.a.toFixed(2)})`
              : `rgb(${c.r},${c.g},${c.b})`,
            hsl: rgbToHsl(c.r, c.g, c.b),
            count: c.count,
            usage: [...c.usage],
          }));

          // Cluster: merge colors within distance < 5
          // Cap entries before O(n²) clustering to prevent frame freezing
          colorEntries.sort((a, b) => b.count - a.count);
          if (colorEntries.length > 100) colorEntries.splice(100);
          const clustered: ColorEntry[] = [];
          const used = new Set<number>();
          for (let i = 0; i < colorEntries.length; i++) {
            if (used.has(i)) continue;
            const rep = { ...colorEntries[i] };
            for (let j = i + 1; j < colorEntries.length; j++) {
              if (used.has(j)) continue;
              if (colorDist(rep.hsl, colorEntries[j].hsl) < 5) {
                rep.count += colorEntries[j].count;
                colorEntries[j].usage.forEach(u => { if (!rep.usage.includes(u)) rep.usage.push(u); });
                used.add(j);
              }
            }
            clustered.push(rep);
          }

          // Sort and format output
          const colors = clustered.sort((a, b) => b.count - a.count).slice(0, 30).map(({ hsl, ...rest }) => rest);
          const typography = [...typoMap.values()].sort((a, b) => b.count - a.count).slice(0, 20);
          const spacing = [...spacingSet.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 15);
          const radii = [...radiusMap.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 10);
          const shadows = [...shadowMap.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 10);

          return { colors, typography, spacing, radii, shadows, elementsScanned: els.length };
        },
        { scopeSel: scope, maxEls: maxElements },
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
