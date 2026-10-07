import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerScanTool(server: McpServer): void {
  server.tool(
    'collab_scan',
    'Instantly read a web page as structured text — 100x faster and cheaper than a screenshot. Returns an accessibility-tree-like snapshot of interactive elements (with clickable [ref=eN] indices for collab_act), page content as markdown, or both. Use "snapshot" mode to understand page structure and interact, "content" mode to read articles/docs, "full" for first visits.',
    {
      mode: z.enum(['snapshot', 'content', 'full']).default('snapshot').describe('"snapshot" = interactive element tree with refs, "content" = main content as markdown, "full" = both'),
      scope: z.string().max(500).default('body').describe('CSS selector to limit scan area (e.g. "main", "#content")'),
      maxTokens: z.number().default(4000).describe('Approximate token budget — output is truncated to fit'),
    },
    async ({ mode: scanMode, scope, maxTokens }) => {
      const t = getTransport();

      const parts: string[] = [];

      // ── SNAPSHOT MODE ──
      if (scanMode === 'snapshot' || scanMode === 'full') {
        const snapshotBudget = scanMode === 'full' ? Math.floor(maxTokens * 0.4) : maxTokens;

        const snapshotCode = `((scopeSel, budget) => {
  var scopeRoot;
  try { scopeRoot = document.querySelector(scopeSel); } catch(e) { return { error: 'Invalid CSS selector: ' + scopeSel }; }
  if (!scopeRoot) return { error: 'Scope element not found: ' + scopeSel };

  // ── Role mapping ──
  var TAG_ROLES = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textarea', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary',
    HEADER: 'banner', FOOTER: 'contentinfo', SECTION: 'section', ARTICLE: 'article',
    FORM: 'form', DETAILS: 'group', SUMMARY: 'button', DIALOG: 'dialog',
    TABLE: 'table', THEAD: 'rowgroup', TBODY: 'rowgroup', TR: 'row',
    TH: 'columnheader', TD: 'cell', UL: 'list', OL: 'list', LI: 'listitem',
    IMG: 'img', FIGURE: 'figure', FIGCAPTION: 'caption',
    FIELDSET: 'group', LEGEND: 'legend', LABEL: 'label',
    PROGRESS: 'progressbar', METER: 'meter', OUTPUT: 'status',
    VIDEO: 'video', AUDIO: 'audio',
  };
  var INPUT_ROLES = {
    text: 'textbox', email: 'textbox', password: 'textbox', search: 'searchbox',
    url: 'textbox', tel: 'textbox', number: 'spinbutton',
    checkbox: 'checkbox', radio: 'radio', range: 'slider',
    submit: 'button', button: 'button', reset: 'button', file: 'button',
    date: 'textbox', time: 'textbox', 'datetime-local': 'textbox',
  };

  function getRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName;
    if (tag === 'INPUT') return INPUT_ROLES[el.type || 'text'] || 'textbox';
    if (tag === 'A' && !el.hasAttribute('href')) return null;
    return TAG_ROLES[tag] || null;
  }

  function getLabel(el) {
    // aria-label
    var al = el.getAttribute('aria-label');
    if (al) return al.trim().slice(0, 80);
    // aria-labelledby
    var alby = el.getAttribute('aria-labelledby');
    if (alby) {
      var parts = alby.split(/\\s+/).map(function(id) {
        var ref = document.getElementById(id);
        return ref ? (ref.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ').slice(0, 80);
    }
    // label[for]
    if (el.id) {
      var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return (lbl.textContent || '').trim().slice(0, 80);
    }
    // wrapping label
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      var wrapLabel = el.closest('label');
      if (wrapLabel) {
        var txt = '';
        for (var i = 0; i < wrapLabel.childNodes.length; i++) {
          var cn = wrapLabel.childNodes[i];
          if (cn.nodeType === 3) txt += cn.textContent;
        }
        txt = txt.trim();
        if (txt) return txt.slice(0, 80);
      }
    }
    // alt
    var alt = el.getAttribute('alt');
    if (alt) return alt.trim().slice(0, 80);
    // placeholder
    var ph = el.getAttribute('placeholder');
    if (ph) return ph.trim().slice(0, 80);
    // title
    var ti = el.getAttribute('title');
    if (ti) return ti.trim().slice(0, 80);
    // visible text (direct text nodes only for non-container elements)
    var tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'LABEL' ||
        tag === 'TH' || tag === 'TD' || tag === 'LEGEND' || tag === 'OPTION' ||
        tag.match(/^H[1-6]$/)) {
      var t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t) return t.slice(0, 80);
    }
    return null;
  }

  function isVisible(el) {
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isDCWidget(el) {
    if (!el || !el.classList) return false;
    var cls = el.className || '';
    if (typeof cls === 'string' && (cls.indexOf('dc-chat') >= 0 || cls.indexOf('dc-preview') >= 0 || cls.indexOf('dc-status') >= 0 || cls.indexOf('dci-') >= 0)) return true;
    var id = el.id || '';
    if (id.indexOf('dc-') === 0) return true;
    return false;
  }

  var INTERACTIVE_TAGS = { A:1, BUTTON:1, INPUT:1, SELECT:1, TEXTAREA:1, SUMMARY:1 };
  var INTERACTIVE_ROLES = { button:1, link:1, textbox:1, searchbox:1, combobox:1, checkbox:1, radio:1, slider:1, spinbutton:1, 'switch':1, tab:1, menuitem:1, option:1, treeitem:1 };
  var LANDMARK_TAGS = { NAV:1, MAIN:1, ASIDE:1, HEADER:1, FOOTER:1, SECTION:1, ARTICLE:1, FORM:1, DIALOG:1, DETAILS:1, TABLE:1, FIGURE:1, FIELDSET:1 };

  function isInteractive(el) {
    if (INTERACTIVE_TAGS[el.tagName]) return true;
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES[role]) return true;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti) >= 0 && !LANDMARK_TAGS[el.tagName]) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('onkeydown')) return true;
    return false;
  }

  function isRelevant(el) {
    var tag = el.tagName;
    if (INTERACTIVE_TAGS[tag]) return true;
    if (LANDMARK_TAGS[tag]) return true;
    if (tag.match(/^H[1-6]$/)) return true;
    if (tag === 'IMG' && el.getAttribute('alt')) return true;
    if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'LI' || tag === 'UL' || tag === 'OL') return true;
    if (tag === 'LABEL' || tag === 'LEGEND') return true;
    if (tag === 'VIDEO' || tag === 'AUDIO') return true;
    var role = el.getAttribute('role');
    if (role) return true;
    return false;
  }

  // ── Build snapshot ──
  var refCounter = 0;
  var refMap = {};
  var lines = [];
  var depthCache = new WeakMap();

  function getLogicalDepth(el) {
    if (depthCache.has(el)) return depthCache.get(el);
    var depth = 0;
    var current = el.parentElement;
    while (current && current !== scopeRoot && current !== document.body) {
      if (isRelevant(current) && !isDCWidget(current)) depth++;
      current = current.parentElement;
    }
    depthCache.set(el, depth);
    return depth;
  }

  var walker = document.createTreeWalker(
    scopeRoot,
    NodeFilter.SHOW_ELEMENT,
    { acceptNode: function(node) {
      var el = node;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT' || el.tagName === 'SVG' || el.tagName === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
      if (isDCWidget(el)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
      if (isRelevant(el)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    }}
  );

  var node;
  while (node = walker.nextNode()) {
    var el = node;
    var depth = getLogicalDepth(el);
    var indent = '';
    for (var d = 0; d < depth; d++) indent += '  ';

    var role = getRole(el);
    var tag = el.tagName;

    // Build display role
    var display = role || tag.toLowerCase();
    if (tag.match(/^H[1-6]$/)) display = 'heading[' + tag[1] + ']';

    var label = getLabel(el);
    var ref = null;

    if (isInteractive(el)) {
      ref = 'e' + (++refCounter);
      refMap[ref] = el;
    }

    var line = indent + display;
    if (label) line += ' "' + label.replace(/"/g, '\\\\"') + '"';
    if (ref) line += ' [ref=' + ref + ']';

    // State annotations
    var states = [];
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.value) states.push('value="' + el.value.slice(0, 40) + '"');
      if (el.placeholder && !label) states.push('placeholder="' + el.placeholder.slice(0, 40) + '"');
      if (el.type === 'checkbox' || el.type === 'radio') states.push(el.checked ? 'checked' : 'unchecked');
      if (el.disabled) states.push('disabled');
      if (el.readOnly) states.push('readonly');
    }
    if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
      var opt = el.options[el.selectedIndex];
      if (opt) states.push('selected="' + (opt.textContent || '').trim().slice(0, 40) + '"');
    }
    if (el.tagName === 'DETAILS') states.push(el.open ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-expanded')) states.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') states.push('selected');
    if (el.getAttribute('aria-checked')) states.push(el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
    if (el.getAttribute('aria-disabled') === 'true') states.push('disabled');
    if (el.tagName === 'A' && el.href) {
      var href = el.getAttribute('href') || '';
      if (href && href !== '#' && !href.startsWith('javascript:')) {
        // Show path for same-origin, full URL for external
        try {
          var u = new URL(el.href);
          if (u.origin === location.origin) {
            states.push('href="' + u.pathname + u.search + u.hash + '"');
          } else {
            states.push('href="' + el.href.slice(0, 60) + '"');
          }
        } catch(e) {
          states.push('href="' + href.slice(0, 60) + '"');
        }
      }
    }

    if (states.length) line += ' ' + states.join(' ');
    lines.push(line);
  }

  // Store ref map on the window for collab_act
  window.__dcRefs = refMap;
  window.__dcRefsUrl = location.href;
  window.__dcRefsTimestamp = Date.now();

  // ── Token budget enforcement ──
  var output = lines.join('\\n');
  var charBudget = budget * 4;

  if (output.length > charBudget) {
    // Pass 1: collapse paragraph/listitem text to summaries
    var trimmed = [];
    var skippedText = 0;
    for (var li = 0; li < lines.length; li++) {
      var l = lines[li].trimStart();
      if ((l.startsWith('paragraph') || l.startsWith('listitem') || l.startsWith('cell')) && l.indexOf('[ref=') < 0) {
        skippedText++;
      } else {
        if (skippedText > 0) {
          trimmed.push(lines[li].match(/^(\\s*)/)[0] + '[' + skippedText + ' text elements]');
          skippedText = 0;
        }
        trimmed.push(lines[li]);
      }
    }
    if (skippedText > 0) trimmed.push('[' + skippedText + ' text elements]');
    output = trimmed.join('\\n');
  }

  if (output.length > charBudget) {
    // Pass 2: hard truncate
    output = output.slice(0, charBudget);
    var lastNl = output.lastIndexOf('\\n');
    if (lastNl > charBudget * 0.8) output = output.slice(0, lastNl);
    output += '\\n[...truncated, page has ' + refCounter + ' interactive elements total]';
  }

  return {
    snapshot: output,
    url: location.href,
    title: document.title,
    refCount: refCounter,
  };
})(${JSON.stringify(scope)}, ${snapshotBudget})`;

        const result = await t.evalFrame(snapshotCode);

        if (result && result.error) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }

        let header = `Page: ${result.title}\nURL: ${result.url}\nInteractive elements: ${result.refCount}\n\n`;
        parts.push(header + result.snapshot);
      }

      // ── CONTENT MODE ──
      if (scanMode === 'content' || scanMode === 'full') {
        const contentBudget = scanMode === 'full' ? Math.floor(maxTokens * 0.6) : maxTokens;

        const contentCode = `((scopeSel, budget) => {
  var scopeRoot;
  try { scopeRoot = document.querySelector(scopeSel); } catch(e) { return { error: 'Invalid CSS selector: ' + scopeSel }; }
  if (!scopeRoot) return { error: 'Scope element not found: ' + scopeSel };

  // ── Find main content area ──
  function findContentRoot(root) {
    var candidates = root.querySelectorAll('main, [role="main"], article, .post-content, .article-content, .entry-content, .post-body, .article-body, #content, #main-content');
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].textContent && candidates[i].textContent.trim().length > 200) return candidates[i];
    }
    // Score divs/sections by text density
    var best = null;
    var bestScore = 0;
    var containers = root.querySelectorAll('div, section');
    for (var ci = 0; ci < containers.length; ci++) {
      var c = containers[ci];
      var text = (c.textContent || '').trim();
      if (text.length < 200) continue;
      var ps = c.querySelectorAll('p').length;
      var links = c.querySelectorAll('a').length;
      var linkDensity = links / Math.max(1, text.split(/\\s+/).length);
      var score = ps * 10 + text.length * 0.1 - linkDensity * 500;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best || root;
  }

  var contentRoot = findContentRoot(scopeRoot);

  // ── Convert to markdown ──
  var SKIP_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, SVG:1, NAV:1, IFRAME:1 };
  var SKIP_SELECTORS = 'nav, footer, aside, .ad, .ads, .advertisement, .sidebar, .nav, .menu, .popup, .modal, .cookie, [aria-hidden="true"]';

  function shouldSkip(el) {
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.id && (el.id.indexOf('dc-') === 0)) return true;
    var cls = el.className || '';
    if (typeof cls === 'string' && (cls.indexOf('dc-chat') >= 0 || cls.indexOf('dc-preview') >= 0)) return true;
    try { if (el.matches(SKIP_SELECTORS)) return true; } catch(e) {}
    return false;
  }

  function toMarkdown(el, listDepth) {
    if (el.nodeType === 3) return (el.textContent || '').replace(/[ \\t]+/g, ' ');
    if (el.nodeType !== 1) return '';
    if (shouldSkip(el)) return '';

    var tag = el.tagName;
    var children = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      children += toMarkdown(el.childNodes[i], listDepth);
    }
    children = children.trim();
    if (!children && tag !== 'IMG' && tag !== 'HR' && tag !== 'BR' && tag !== 'INPUT') return '';

    switch (tag) {
      case 'H1': return '\\n\\n# ' + children + '\\n\\n';
      case 'H2': return '\\n\\n## ' + children + '\\n\\n';
      case 'H3': return '\\n\\n### ' + children + '\\n\\n';
      case 'H4': return '\\n\\n#### ' + children + '\\n\\n';
      case 'H5': return '\\n\\n##### ' + children + '\\n\\n';
      case 'H6': return '\\n\\n###### ' + children + '\\n\\n';
      case 'P': return '\\n\\n' + children + '\\n\\n';
      case 'BR': return '\\n';
      case 'HR': return '\\n\\n---\\n\\n';
      case 'STRONG': case 'B': return '**' + children + '**';
      case 'EM': case 'I': return '*' + children + '*';
      case 'CODE':
        if (el.parentElement && el.parentElement.tagName === 'PRE') return children;
        return '\\x60' + children + '\\x60';
      case 'PRE':
        var code = el.querySelector('code');
        var lang = '';
        if (code) {
          var cls = code.className || '';
          var m = cls.match(/language-(\\w+)/);
          if (m) lang = m[1];
        }
        return '\\n\\n\\x60\\x60\\x60' + lang + '\\n' + (el.textContent || '') + '\\n\\x60\\x60\\x60\\n\\n';
      case 'BLOCKQUOTE': return '\\n\\n> ' + children.replace(/\\n/g, '\\n> ') + '\\n\\n';
      case 'A':
        var href = el.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return children;
        try { href = new URL(href, location.href).href; } catch(e) {}
        return '[' + children + '](' + href + ')';
      case 'IMG':
        var alt = el.getAttribute('alt') || '';
        var src = el.getAttribute('src') || '';
        if (!src) return '';
        try { src = new URL(src, location.href).href; } catch(e) {}
        return '![' + alt + '](' + src + ')';
      case 'UL':
        var items = '';
        for (var ui = 0; ui < el.children.length; ui++) {
          if (el.children[ui].tagName === 'LI') {
            var indent = '';
            for (var d = 0; d < listDepth; d++) indent += '  ';
            items += indent + '- ' + toMarkdown(el.children[ui], listDepth + 1).trim() + '\\n';
          }
        }
        return '\\n' + items + '\\n';
      case 'OL':
        var items2 = '';
        var num = 1;
        for (var oi = 0; oi < el.children.length; oi++) {
          if (el.children[oi].tagName === 'LI') {
            var indent2 = '';
            for (var d2 = 0; d2 < listDepth; d2++) indent2 += '  ';
            items2 += indent2 + (num++) + '. ' + toMarkdown(el.children[oi], listDepth + 1).trim() + '\\n';
          }
        }
        return '\\n' + items2 + '\\n';
      case 'LI': return children;
      case 'TABLE':
        var rows = el.querySelectorAll('tr');
        if (!rows.length) return children;
        var mdTable = '\\n\\n';
        for (var ri = 0; ri < rows.length; ri++) {
          var cells = rows[ri].querySelectorAll('th, td');
          var row = '|';
          for (var ci = 0; ci < cells.length; ci++) {
            row += ' ' + (cells[ci].textContent || '').trim().replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ').slice(0, 60) + ' |';
          }
          mdTable += row + '\\n';
          if (ri === 0 && rows[ri].querySelector('th')) {
            mdTable += '|';
            for (var si = 0; si < cells.length; si++) mdTable += ' --- |';
            mdTable += '\\n';
          }
        }
        return mdTable + '\\n';
      case 'FIGURE':
        return '\\n\\n' + children + '\\n\\n';
      case 'FIGCAPTION':
        return '\\n*' + children + '*\\n';
      case 'DL':
        var dlText = '\\n';
        for (var di = 0; di < el.children.length; di++) {
          var dc = el.children[di];
          if (dc.tagName === 'DT') dlText += '\\n**' + (dc.textContent || '').trim() + '**\\n';
          else if (dc.tagName === 'DD') dlText += ': ' + (dc.textContent || '').trim() + '\\n';
        }
        return dlText;
      default:
        return children;
    }
  }

  var md = toMarkdown(contentRoot, 0);
  // Clean up whitespace
  md = md.replace(/\\n{3,}/g, '\\n\\n').trim();

  // Token budget
  var charBudget = budget * 4;
  if (md.length > charBudget) {
    md = md.slice(0, charBudget);
    var lastNl = md.lastIndexOf('\\n');
    if (lastNl > charBudget * 0.8) md = md.slice(0, lastNl);
    md += '\\n\\n[...truncated]';
  }

  return {
    content: md,
    url: location.href,
    title: document.title,
    contentRoot: contentRoot.tagName.toLowerCase() + (contentRoot.id ? '#' + contentRoot.id : '') + (contentRoot.className && typeof contentRoot.className === 'string' ? '.' + contentRoot.className.split(' ')[0] : ''),
  };
})(${JSON.stringify(scope)}, ${contentBudget})`;

        const result = await t.evalFrame(contentCode);

        if (result && result.error) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }

        if (scanMode === 'full') {
          parts.push('\n---\n\n## Page Content\n(extracted from <' + result.contentRoot + '>)\n\n' + result.content);
        } else {
          let header = `Page: ${result.title}\nURL: ${result.url}\nContent from: <${result.contentRoot}>\n\n`;
          parts.push(header + result.content);
        }
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('') }],
      };
    },
  );
}
