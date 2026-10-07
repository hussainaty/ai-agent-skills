import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerA11yAuditTool(server: McpServer): void {
  server.tool(
    'collab_a11y_audit',
    'Run an accessibility audit. Checks contrast ratios, missing alt text, form labels, heading hierarchy, touch targets, and link text. Highlights issues on the page with severity-coded overlays.',
    {
      scope: z.string().max(500).default('body').describe('CSS selector to limit audit scope'),
      showOverlays: z.boolean().default(true).describe('Show severity-coded overlays on the page'),
    },
    async ({ scope, showOverlays }) => {
      const t = getTransport();

      // Use string-based eval to avoid tsx __name decorator issue in extension mode
      const auditCode = `((scopeSel) => {
          var scopeRoot = document.querySelector(scopeSel);
          if (!scopeRoot) return { error: 'Scope element not found: ' + scopeSel };

          var luminance = function(r, g, b) {
            var vals = [r, g, b].map(function(c) {
              c /= 255;
              return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * vals[0] + 0.7152 * vals[1] + 0.0722 * vals[2];
          };

          var contrastRatio = function(l1, l2) {
            var lighter = Math.max(l1, l2);
            var darker = Math.min(l1, l2);
            return (lighter + 0.05) / (darker + 0.05);
          };

          var canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          var ctx = canvas.getContext('2d');

          var parseColor = function(str) {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = '#000';
            ctx.fillStyle = str;
            ctx.fillRect(0, 0, 1, 1);
            var d = ctx.getImageData(0, 0, 1, 1).data;
            return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
          };

          var getEffectiveBg = function(el) {
            var current = el;
            while (current) {
              var bg = window.getComputedStyle(current).backgroundColor;
              var parsed = parseColor(bg);
              if (parsed.a > 0.5) return parsed;
              current = current.parentElement;
            }
            return { r: 255, g: 255, b: 255 };
          };

          var uniqueSelector = function(el) {
            if (el.id) return '#' + CSS.escape(el.id);
            var parts = [];
            var current = el;
            while (current && current !== document.body && parts.length < 4) {
              var sel = current.tagName.toLowerCase();
              if (current.id) {
                parts.unshift('#' + CSS.escape(current.id));
                break;
              }
              if (current.className && typeof current.className === 'string') {
                var cls = [].slice.call(current.classList).filter(function(c) { return !c.startsWith('dc-'); }).slice(0, 2);
                if (cls.length) sel += '.' + cls.map(function(c) { return CSS.escape(c); }).join('.');
              }
              if (current.parentElement) {
                var siblings = [].slice.call(current.parentElement.children).filter(function(c) { return c.tagName === current.tagName; });
                if (siblings.length > 1) {
                  sel += ':nth-child(' + ([].slice.call(current.parentElement.children).indexOf(current) + 1) + ')';
                }
              }
              parts.unshift(sel);
              current = current.parentElement;
            }
            return parts.join(' > ');
          };

          var isVisible = function(el) {
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          var hasText = function(el) {
            for (var i = 0; i < el.childNodes.length; i++) {
              var node = el.childNodes[i];
              if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0) return true;
            }
            return false;
          };

          var issues = [];
          var allEls = [].slice.call(scopeRoot.querySelectorAll('*')).slice(0, 2000);

          // 1. Contrast check
          for (var ei = 0; ei < allEls.length; ei++) {
            var el = allEls[ei];
            if (!isVisible(el) || !hasText(el)) continue;
            var cs = window.getComputedStyle(el);
            var fg = parseColor(cs.color);
            var bg = getEffectiveBg(el);
            var ratio = contrastRatio(luminance(fg.r, fg.g, fg.b), luminance(bg.r, bg.g, bg.b));
            var fontSize = parseFloat(cs.fontSize);
            var isBold = parseInt(cs.fontWeight) >= 700;
            var isLarge = fontSize >= 18 || (fontSize >= 14 && isBold);
            var threshold = isLarge ? 3 : 4.5;
            if (ratio < threshold) {
              issues.push({
                check: 'contrast',
                severity: ratio < 2 ? 'error' : 'warning',
                selector: uniqueSelector(el),
                message: 'Contrast ' + ratio.toFixed(1) + ':1 (needs ' + threshold + ':1) — fg: ' + cs.color + ', bg: rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
              });
            }
          }

          // 2. Alt text
          var altEls = scopeRoot.querySelectorAll('img:not([alt]), svg:not([aria-label]):not([aria-labelledby]), [role="img"]:not([aria-label]):not([aria-labelledby])');
          for (var ai = 0; ai < altEls.length; ai++) {
            if (!isVisible(altEls[ai])) continue;
            issues.push({
              check: 'alt-text',
              severity: 'error',
              selector: uniqueSelector(altEls[ai]),
              message: altEls[ai].tagName.toLowerCase() + ' missing alt text / aria-label',
            });
          }

          // 3. Form labels
          var formEls = scopeRoot.querySelectorAll('input, select, textarea');
          for (var fi = 0; fi < formEls.length; fi++) {
            var input = formEls[fi];
            if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') continue;
            if (!isVisible(input)) continue;
            var hasLabel = input.id && document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
            var hasAria = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
            var wrappedInLabel = input.closest('label');
            if (!hasLabel && !hasAria && !wrappedInLabel) {
              issues.push({
                check: 'form-label',
                severity: 'error',
                selector: uniqueSelector(input),
                message: input.tagName.toLowerCase() + '[type=' + (input.type || 'text') + '] has no associated label',
              });
            }
          }

          // 4. Heading hierarchy
          var headings = [].slice.call(scopeRoot.querySelectorAll('h1, h2, h3, h4, h5, h6'));
          var h1s = headings.filter(function(h) { return h.tagName === 'H1'; });
          if (h1s.length === 0 && headings.length > 0) {
            issues.push({ check: 'headings', severity: 'warning', selector: 'body', message: 'No h1 found on page' });
          }
          if (h1s.length > 1) {
            issues.push({ check: 'headings', severity: 'warning', selector: uniqueSelector(h1s[1]), message: 'Multiple h1 elements found (' + h1s.length + ')' });
          }
          for (var hi = 1; hi < headings.length; hi++) {
            var prev = parseInt(headings[hi - 1].tagName[1]);
            var curr = parseInt(headings[hi].tagName[1]);
            if (curr > prev + 1) {
              issues.push({
                check: 'headings',
                severity: 'warning',
                selector: uniqueSelector(headings[hi]),
                message: 'Heading level skipped: h' + prev + ' → h' + curr,
              });
            }
          }

          // 5. Touch targets
          var touchEls = scopeRoot.querySelectorAll('a, button, [role="button"], [onclick], input[type="submit"], input[type="button"]');
          for (var ti = 0; ti < touchEls.length; ti++) {
            if (!isVisible(touchEls[ti])) continue;
            var rect = touchEls[ti].getBoundingClientRect();
            if (rect.width < 44 || rect.height < 44) {
              issues.push({
                check: 'touch-target',
                severity: 'warning',
                selector: uniqueSelector(touchEls[ti]),
                message: 'Touch target ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + 'px (minimum 44x44)',
              });
            }
          }

          // 6. Link text
          var linkTexts = {};
          var linkEls = scopeRoot.querySelectorAll('a[href]');
          for (var li = 0; li < linkEls.length; li++) {
            var linkEl = linkEls[li];
            if (!isVisible(linkEl)) continue;
            var text = (linkEl.textContent || '').trim().toLowerCase();
            var href = linkEl.href;
            if (!text || text.length === 0) {
              var ariaLabel = linkEl.getAttribute('aria-label');
              var imgEl = linkEl.querySelector('img[alt]');
              var imgAlt = imgEl ? imgEl.getAttribute('alt') : null;
              if (!ariaLabel && !imgAlt) {
                issues.push({ check: 'link-text', severity: 'error', selector: uniqueSelector(linkEl), message: 'Empty link text' });
              }
            } else if (['click here', 'read more', 'learn more', 'here', 'more'].indexOf(text) >= 0) {
              issues.push({ check: 'link-text', severity: 'warning', selector: uniqueSelector(linkEl), message: 'Generic link text: "' + text + '"' });
            } else if (linkTexts[text] && linkTexts[text] !== href) {
              issues.push({ check: 'link-text', severity: 'info', selector: uniqueSelector(linkEl), message: 'Same text "' + text + '" links to different URL' });
            }
            linkTexts[text] = href;
          }

          // Score
          var errors = issues.filter(function(i) { return i.severity === 'error'; }).length;
          var warnings = issues.filter(function(i) { return i.severity === 'warning'; }).length;
          var infos = issues.filter(function(i) { return i.severity === 'info'; }).length;
          var score = Math.max(0, Math.min(100, 100 - (errors * 8) - (warnings * 3) - (infos * 1)));

          return {
            issues: issues,
            summary: { errors: errors, warnings: warnings, info: infos },
            score: score,
            elementCount: allEls.length,
          };
        })(${JSON.stringify(scope)})`;

      const result = await t.evalFrame(auditCode);

      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }

      // Show overlays on the page
      if (showOverlays && result.issues.length > 0) {
        const overlays = result.issues.slice(0, 50).map((issue: any, idx: number) => ({
          selector: issue.selector,
          level: issue.severity,
          label: issue.check.toUpperCase().slice(0, 3),
          tooltip: issue.message,
          id: idx,
        }));

        const mode = t.getMode();
        if (mode === 'single' || mode === 'extension') {
          await t.evalFrame((ovs: any) => {
            window.postMessage({ type: 'dc-show-overlays', overlays: ovs }, location.origin || '*');
          }, overlays);
        } else {
          await t.evalWidget((ovs: any) => {
            const iframe = window.__dcTabs
              ? document.getElementById(window.__dcTabs.getActiveFrameName())
              : document.getElementById('dc-frame');
            if (iframe && (iframe as HTMLIFrameElement).contentWindow) {
              const origin = (window.__dc && window.__dc._iframeOrigin) || '*';
              (iframe as HTMLIFrameElement).contentWindow!.postMessage({ type: 'dc-show-overlays', overlays: ovs }, origin);
            }
          }, overlays);
        }
      }

      // Render HTML report in preview panel
      const scoreColor = result.score >= 80 ? '#22c55e' : result.score >= 50 ? '#f59e0b' : '#ef4444';

      // Group issues by check type for filter counts
      const checkCounts: Record<string, number> = {};
      for (const issue of result.issues) {
        const key = (issue as any).check.toUpperCase().slice(0, 3);
        checkCounts[key] = (checkCounts[key] || 0) + 1;
      }

      const issueRows = result.issues.map((issue: any) => {
        const severityIcon = issue.severity === 'error' ? '\u2716' : issue.severity === 'warning' ? '\u26A0' : '\u2139';
        const severityColor = issue.severity === 'error' ? '#ef4444' : issue.severity === 'warning' ? '#f59e0b' : '#3b82f6';
        const escapedSelector = issue.selector.replace(/"/g, '&quot;');
        const escapedMessage = issue.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div data-selector="${escapedSelector}" data-severity="${issue.severity}" data-check="${issue.check}" class="dc-audit-row" style="padding:8px 12px;border-bottom:1px solid #333;cursor:pointer;display:flex;align-items:center;gap:8px;" onmouseover="this.style.background='#2a2a3e'" onmouseout="this.style.background='transparent'">
          <span style="color:${severityColor};font-size:14px;flex-shrink:0;">${severityIcon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:#888;text-transform:uppercase;">${issue.check}</div>
            <div style="font-size:13px;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapedMessage}</div>
          </div>
        </div>`;
      }).join('');

      // Build filter buttons
      const filterBtnStyle = 'all:unset;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;transition:background .15s;';
      const severityFilters = `
        <button data-filter="all" style="${filterBtnStyle}background:rgba(255,255,255,.12);color:#e0e0e0;" onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='transparent');this.style.background='rgba(255,255,255,.12)';document.querySelectorAll('.dc-audit-row').forEach(r=>r.style.display='');window.parent.postMessage({type:'dc-filter-overlays'},location.origin||'*')">All</button>
        <button data-filter="error" style="${filterBtnStyle}color:#ef4444;" onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='transparent');this.style.background='rgba(239,68,68,.15)';document.querySelectorAll('.dc-audit-row').forEach(r=>r.style.display=r.dataset.severity==='error'?'':'none');window.parent.postMessage({type:'dc-filter-overlays',level:'error'},location.origin||'*')">${result.summary.errors} Errors</button>
        <button data-filter="warning" style="${filterBtnStyle}color:#f59e0b;" onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='transparent');this.style.background='rgba(245,158,11,.15)';document.querySelectorAll('.dc-audit-row').forEach(r=>r.style.display=r.dataset.severity==='warning'?'':'none');window.parent.postMessage({type:'dc-filter-overlays',level:'warning'},location.origin||'*')">${result.summary.warnings} Warnings</button>
        <button data-filter="info" style="${filterBtnStyle}color:#3b82f6;" onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='transparent');this.style.background='rgba(59,130,246,.15)';document.querySelectorAll('.dc-audit-row').forEach(r=>r.style.display=r.dataset.severity==='info'?'':'none');window.parent.postMessage({type:'dc-filter-overlays',level:'info'},location.origin||'*')">${result.summary.info} Info</button>`;

      // Check type filter chips
      const checkChips = Object.entries(checkCounts).map(([key, count]) =>
        `<button style="${filterBtnStyle}color:#c4c4d4;border:1px solid #333;" onclick="var active=this.style.background!=='transparent'&&this.style.background;this.parentNode.querySelectorAll('button').forEach(b=>b.style.background='transparent');if(!active){this.style.background='rgba(99,102,241,.15)';document.querySelectorAll('.dc-audit-row').forEach(r=>r.style.display=r.dataset.check.toUpperCase().startsWith('${key}')?'':'none');}else{document.querySelectorAll('.dc-audit-row').forEach(r=>r.style.display='');}">${key} (${count})</button>`
      ).join('');

      const reportHTML = `<div style="font-family:-apple-system,sans-serif;background:#1a1a2e;color:#e0e0e0;padding:16px;overflow-y:auto;height:100%;">
        <div style="text-align:center;margin-bottom:12px;">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;border:3px solid ${scoreColor};font-size:22px;font-weight:700;color:${scoreColor};">${result.score}</div>
          <div style="margin-top:4px;font-size:11px;color:#888;">Accessibility Score</div>
        </div>
        <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:8px;">
          ${severityFilters}
        </div>
        <div style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap;margin-bottom:12px;">
          ${checkChips}
        </div>
        <div style="border:1px solid #333;border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto;">
          ${issueRows || '<div style="padding:16px;text-align:center;color:#4ade80;">No issues found!</div>'}
        </div>
        <div style="margin-top:8px;font-size:11px;color:#666;text-align:center;">${result.elementCount} elements scanned \u2022 Hover over overlay badges in the page to see issues</div>
      </div>`;

      await t.evalWidget((html: string) => {
        if (window.__dc?.api) window.__dc.api.renderPreview(html);
      }, reportHTML);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            issues: result.issues,
            summary: result.summary,
            score: result.score,
            elementCount: result.elementCount,
          }, null, 2),
        }],
      };
    },
  );
}
