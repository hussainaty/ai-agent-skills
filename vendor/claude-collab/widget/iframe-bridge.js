/**
 * Claude Collab — Iframe Bridge
 * Injected into the target iframe via Playwright's addInitScript.
 * Handles click capture, hover highlights, parent climbing,
 * and element replacement — all communicating with the parent
 * frame's widget via postMessage.
 *
 * Guard: Only runs when window.name starts with 'dc-frame-'.
 *
 * Security notes:
 * - Element replacement (dc-apply-option, dc-revert-option) uses DOM manipulation
 *   with trusted AI-generated HTML only. This is a developer design tool — the AI
 *   controls what gets rendered. No user input reaches these paths.
 * - Same security model as the widget's setTrustedPreviewHTML().
 */
(() => {
  if (!window.name.startsWith('dc-frame-')) return;
  if (window.__dcBridge) return;
  window.__dcBridge = true;

  // ==================== FREEZE DIAGNOSTIC ====================
  // Small indicator dot that flashes green on every click event.
  // If page freezes and dot doesn't flash → events not reaching document (GPU/compositor issue).
  // If dot flashes but page doesn't respond → JS handler is eating events.
  var diag = document.createElement('div');
  diag.id = 'dc-diag';
  diag.style.cssText = 'position:fixed;top:4px;left:4px;width:10px;height:10px;border-radius:50%;background:#555;z-index:2147483647;pointer-events:none;transition:background 0.1s;opacity:0.7;display:' + (window.__dcDebug ? 'block' : 'none') + ';';
  document.documentElement.appendChild(diag);
  window.__dcDiag = { clicks: 0, lastClickTime: 0, blocked: 0 };
  document.addEventListener('click', function(e) {
    window.__dcDiag.clicks++;
    window.__dcDiag.lastClickTime = Date.now();
    diag.style.background = '#4ade80';
    setTimeout(function() { diag.style.background = '#555'; }, 200);
  }, true);  // Capture phase — fires FIRST, before any other handler
  // Also track if mousedown fires (lower level than click)
  document.addEventListener('mousedown', function() {
    diag.style.background = '#facc15'; // Yellow on mousedown
  }, true);

  // ==================== ORIGIN VALIDATION ====================
  // Determine parent origin for secure postMessage targeting
  var parentOrigin = null;
  try { parentOrigin = window.parent.location.origin; } catch (_) { /* cross-origin parent — allow all (MCP mode) */ }
  // file:// and null origins are opaque — postMessage with these silently fails or throws, so fall back to '*'
  if (!parentOrigin || parentOrigin === 'null' || parentOrigin === 'file://') parentOrigin = null;

  // ==================== THEME DETECTION ====================
  // Continuously detect page background luminance and notify parent.
  // Tracks last known theme to avoid redundant postMessages.
  var lastThemeIsDark = null;

  function detectAndSendTheme() {
    try {
      // Sample both body and html backgrounds — use the darkest non-transparent one
      var els = [document.body, document.documentElement];
      var bestLuminance = -1;
      var found = false;
      for (var i = 0; i < els.length; i++) {
        if (!els[i]) continue;
        var bg = getComputedStyle(els[i]).backgroundColor;
        var match = bg.match(/\d+/g);
        if (match && match.length >= 3) {
          var a = match.length >= 4 ? parseFloat(match[3]) : 1;
          if (a < 0.1) continue; // Skip transparent backgrounds
          var r = parseInt(match[0]);
          var g = parseInt(match[1]);
          var b = parseInt(match[2]);
          var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          if (found === false || luminance < bestLuminance) {
            bestLuminance = luminance;
            found = true;
          }
        }
      }
      if (found) {
        var isDark = bestLuminance < 0.5;
        // Only send if theme actually changed
        if (isDark !== lastThemeIsDark) {
          lastThemeIsDark = isDark;
          window.parent.postMessage({ type: 'dc-page-theme', isDark: isDark }, parentOrigin || '*');
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Detect after a short delay to let page styles settle
  setTimeout(detectAndSendTheme, 500);

  // Watch attribute changes on both <html> and <body> (sites use either)
  if (window.MutationObserver) {
    var themeAttrs = ['class', 'style', 'data-theme', 'data-color-scheme', 'data-mode', 'data-bs-theme'];
    var _themeDebounce = null;
    var themeObserver = new MutationObserver(function() {
      clearTimeout(_themeDebounce);
      _themeDebounce = setTimeout(detectAndSendTheme, 100);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: themeAttrs
    });
    // Observe body once it exists (might not exist yet in addInitScript)
    function observeBody() {
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: themeAttrs
        });
      }
    }
    if (document.body) { observeBody(); }
    else { document.addEventListener('DOMContentLoaded', observeBody); }
  }

  // Listen for OS-level color scheme changes (prefers-color-scheme)
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', function() { detectAndSendTheme(); });
  } catch (e) { /* matchMedia not supported */ }

  // No periodic polling — MutationObserver + matchMedia cover all theme changes.
  // JS-driven transitions that don't touch attributes are rare and not worth 20+ msgs/min.

  // ==================== STATE ====================
  let captureMode = false;      // Capture mode (camera button) — reuses click UI, Enter captures
  let prevClickMode = false;    // Click mode state before capture mode was entered
  let clickMode = false;
  let hoverEl = null;
  let ancestorChain = [];
  let chainIndex = 0;
  let optionsTarget = null;    // Current element targeted by renderOptions
  let optionsOriginal = null;  // Original outerHTML for revert

  // Inspector state
  let inspectedEl = null;      // Currently inspected element (for style editing)
  let inspectedOriginalStyles = {};  // Original inline styles for reset
  let multiSelectedEls = new Set();  // Multi-select via Ctrl+click

  // Undo/redo stacks (capped at 50 to prevent memory leaks)
  // Each entry: { type: 'style', el, prop, oldVal, newVal } or { type: 'replace', el, oldHTML, newHTML }
  const UNDO_LIMIT = 50;
  let undoStack = [];
  let redoStack = [];

  // Drag handle
  let dragHandleEl = null;     // The grab handle overlay element

  // Drag state
  let dragEl = null;           // Element being dragged
  let dragDelta = { x: 0, y: 0 };
  let dragMouseDown = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragHint = null;

  // Pending drag state — tracks mousedown on selected element, enters drag after 5px movement
  let pendingDragEl = null;
  let pendingDragStartX = 0;
  let pendingDragStartY = 0;
  const DRAG_THRESHOLD = 5;

  // ==================== STYLES ====================
  const style = document.createElement('style');
  style.id = 'dc-bridge-styles';
  style.textContent = `
    .dc-highlight {
      outline: 3px solid #818cf8 !important;
      outline-offset: 2px !important;
      cursor: pointer !important;
    }
    .dc-hover-highlight {
      outline: 2px dashed rgba(129,140,248,0.5) !important;
      outline-offset: 1px !important;
    }
    .dc-draggable {
      outline: 2px dashed #f59e0b !important;
      outline-offset: 4px !important;
      cursor: grab !important;
    }
    .dc-dragging {
      cursor: grabbing !important;
      opacity: 0.9 !important;
    }
    .dc-drag-hint {
      position: fixed;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 16px;
      background: rgba(245,158,11,0.95);
      color: #000;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 600;
      border-radius: 20px;
      z-index: 2147483647;
      pointer-events: none;
      white-space: nowrap;
    }
    .dc-drag-handle {
      position: absolute;
      width: 24px;
      height: 24px;
      background: rgba(245,158,11,0.9);
      border-radius: 6px;
      cursor: grab;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: #000;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      user-select: none;
      transition: background 0.1s;
    }
    .dc-drag-handle:hover { background: rgba(245,158,11,1); }
    .dc-drag-handle:active { cursor: grabbing; background: #d97706; }

    /* Audit overlay badges */
    .dc-audit-badge {
      position: fixed; z-index: 2147483646;
      padding: 3px 8px; border-radius: 6px;
      font: 600 11px/1.2 -apple-system, system-ui, sans-serif;
      pointer-events: auto; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
      transition: opacity .15s, transform .1s;
      white-space: nowrap;
      display: flex; align-items: center; gap: 4px;
    }
    .dc-audit-badge:hover { transform: scale(1.08); }
    .dc-audit-badge .dc-audit-num {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; border-radius: 50%;
      background: rgba(0,0,0,.25); font-size: 9px; font-weight: 700;
    }
    .dc-audit-error   { background: #ef4444; color: #fff; }
    .dc-audit-warning { background: #f59e0b; color: #fff; }
    .dc-audit-info    { background: #3b82f6; color: #fff; }

    .dc-audit-outline-error   { outline: 3px solid rgba(239,68,68,.7) !important; outline-offset: 2px !important; }
    .dc-audit-outline-warning { outline: 2px solid rgba(245,158,11,.7) !important; outline-offset: 2px !important; }
    .dc-audit-outline-info    { outline: 2px dashed rgba(59,130,246,.5) !important; outline-offset: 2px !important; }

    /* Audit tooltip (shown on badge click) */
    .dc-audit-tooltip {
      position: fixed; z-index: 2147483647;
      background: #1a1a2e; color: #e0e0e0; border: 1px solid #333;
      border-radius: 10px; padding: 12px 14px; max-width: 320px;
      font: 13px/1.5 -apple-system, system-ui, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
      pointer-events: auto;
    }
    .dc-audit-tooltip-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    }
    .dc-audit-tooltip-severity {
      padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase;
    }
    .dc-audit-tooltip-check {
      font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .dc-audit-tooltip-msg { font-size: 13px; color: #d0d0e8; line-height: 1.5; }
    .dc-audit-tooltip-sel {
      font-size: 11px; color: #666; margin-top: 8px; padding-top: 8px;
      border-top: 1px solid #333; word-break: break-all; font-family: monospace;
    }
    .dc-audit-tooltip-close {
      position: absolute; top: 8px; right: 10px; background: none; border: none;
      color: #666; font-size: 16px; cursor: pointer; line-height: 1;
    }
    .dc-audit-tooltip-close:hover { color: #e0e0e0; }
  `;
  document.head.appendChild(style);

  // ==================== HELPERS ====================
  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].filter(c => !c.startsWith('dc-')).slice(0, 3).join('.');
    const clsStr = cls ? '.' + cls : '';
    const size = el.getBoundingClientRect();
    const sizeStr = Math.round(size.width) + 'x' + Math.round(size.height);
    const text = (el.textContent || '').trim().slice(0, 30);
    return '<' + tag + id + clsStr + '> (' + sizeStr + ')' + (text ? ' "' + text + '"' : '');
  }

  function isWidgetElement(el) {
    return el && el.closest && el.closest('.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay');
  }

  function briefInfo(el) {
    if (!el || el === document.documentElement) return null;
    var cs = window.getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].filter(function(c) { return !c.startsWith('dc-'); }).slice(0, 3),
      display: cs.display, position: cs.position,
      flexDirection: cs.flexDirection, gap: cs.gap
    };
  }

  function getComputedInfo(el) {
    var cs = window.getComputedStyle(el);
    var parent = el.parentElement;
    var siblings = parent ? parent.children.length : 0;
    var childCount = el.children.length;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].filter(function(c) { return !c.startsWith('dc-'); }),
      text: (el.textContent || '').trim().slice(0, 120),
      rect: el.getBoundingClientRect().toJSON(),
      parent: briefInfo(parent),
      siblingCount: siblings,
      childCount: childCount,
      childIndex: parent ? Array.prototype.indexOf.call(parent.children, el) : 0,
      aria: {
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        label: el.getAttribute('aria-label') || null,
        describedBy: el.getAttribute('aria-describedby') || null,
        alt: el.getAttribute('alt') || null,
        tabIndex: el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : null
      },
      styles: {
        padding: cs.padding, margin: cs.margin,
        borderRadius: cs.borderRadius, backgroundColor: cs.backgroundColor,
        color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily, lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing, boxShadow: cs.boxShadow,
        border: cs.border, display: cs.display, gap: cs.gap,
        width: cs.width, height: cs.height
      }
    };
  }

  function getPseudoStyles(el) {
    var result = {};
    var pseudos = [':hover', ':focus', ':active'];
    try {
      var sheets = document.styleSheets;
      for (var s = 0; s < sheets.length; s++) {
        var rules;
        try { rules = sheets[s].cssRules || sheets[s].rules; } catch (_) { continue; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (!rule.selectorText) continue;
          for (var p = 0; p < pseudos.length; p++) {
            var pseudo = pseudos[p];
            if (rule.selectorText.indexOf(pseudo) === -1) continue;
            // Check if the base selector (without pseudo) matches our element
            var baseSel = rule.selectorText.replace(new RegExp(pseudo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
            try {
              if (el.matches(baseSel.trim())) {
                var key = pseudo.slice(1); // remove ':'
                if (!result[key]) result[key] = {};
                for (var i = 0; i < rule.style.length; i++) {
                  var prop = rule.style[i];
                  result[key][prop] = rule.style.getPropertyValue(prop);
                }
              }
            } catch (_) { /* invalid selector */ }
          }
        }
      }
    } catch (_) { /* cross-origin sheets */ }
    return Object.keys(result).length ? result : null;
  }

  function getAncestorChain(el, maxDepth) {
    maxDepth = maxDepth || 6;
    const chain = [];
    let current = el;
    while (current && current !== document.body && chain.length < maxDepth) {
      chain.push(current);
      current = current.parentElement;
    }
    return chain;
  }

  function clearHighlights() {
    document.querySelectorAll('.dc-highlight, .dc-hover-highlight')
      .forEach(function(x) { x.classList.remove('dc-highlight', 'dc-hover-highlight'); });
  }

  function highlightChainEl(index) {
    document.querySelectorAll('.dc-highlight').forEach(function(x) { x.classList.remove('dc-highlight'); });
    if (ancestorChain[index]) {
      ancestorChain[index].classList.add('dc-highlight');
      sendToParent('dc-system-message', {
        text: 'Level ' + index + ': ' + describeEl(ancestorChain[index]) +
          ' \u2014 press \u2191/\u2193 to navigate, Enter to confirm'
      });
    }
  }

  function sendToParent(type, data) {
    // Use parent origin when available. Falls back to '*' only when parent is about:blank
    // (Playwright mode — our own controlled page) or cross-origin extension host.
    // This is safe because no untrusted code runs in our parent frame.
    window.parent.postMessage({ type: type, ...data }, parentOrigin || '*');
  }

  function cleanupClickMode() {
    if (hoverEl) { hoverEl.classList.remove('dc-hover-highlight'); hoverEl = null; }
    clearHighlights();
    multiSelectedEls.clear();
    removeDragHandle();
    exitDragMode(false);
    ancestorChain = [];
    chainIndex = 0;
    document.body.style.cursor = '';
  }

  // ==================== DRAG HANDLE ====================
  function showDragHandle(el) {
    removeDragHandle();
    var rect = el.getBoundingClientRect();
    var handle = document.createElement('div');
    handle.className = 'dc-drag-handle';
    handle.textContent = '\u2630'; // ☰ hamburger/grab icon
    handle.style.left = (rect.right - 28 + window.scrollX) + 'px';
    handle.style.top = (rect.top - 28 + window.scrollY) + 'px';
    document.documentElement.appendChild(handle);
    dragHandleEl = handle;

    // Drag handle starts drag mode on mousedown
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
      removeDragHandle();
      enterDragMode(el);
      // Simulate mousedown on the drag element
      dragMouseDown = true;
      dragStartX = e.clientX - dragDelta.x;
      dragStartY = e.clientY - dragDelta.y;
      dragEl.classList.add('dc-dragging');
    });
  }

  function removeDragHandle() {
    if (dragHandleEl) { dragHandleEl.remove(); dragHandleEl = null; }
  }

  // ==================== DRAG HELPERS ====================
  function enterDragMode(el) {
    dragEl = el;
    // Read existing transform offset so re-drags continue from current position
    var existing = el.style.transform.match(/translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\)/);
    dragDelta = existing ? { x: parseFloat(existing[1]), y: parseFloat(existing[2]) } : { x: 0, y: 0 };
    el.classList.remove('dc-highlight');
    el.classList.add('dc-draggable');

    // Show hint bar
    dragHint = document.createElement('div');
    dragHint.className = 'dc-drag-hint';
    dragHint.textContent = 'Drag to reposition \u2014 Enter to confirm, Escape to cancel';
    document.documentElement.appendChild(dragHint);

    sendToParent('dc-system-message', {
      text: 'Drag mode \u2014 drag the element, Enter to confirm, Escape to cancel'
    });
  }

  function exitDragMode(confirmed) {
    if (!dragEl) return;

    dragEl.classList.remove('dc-draggable', 'dc-dragging');

    if (confirmed) {
      // Send element info + delta before reverting visual transform
      var info = getComputedInfo(dragEl);
      sendToParent('dc-drag-complete', {
        element: info,
        delta: { x: Math.round(dragDelta.x), y: Math.round(dragDelta.y) }
      });
      sendToParent('dc-system-message', {
        text: 'Moved: dx=' + Math.round(dragDelta.x) + 'px, dy=' + Math.round(dragDelta.y) + 'px'
      });
    } else {
      // Revert position
      dragEl.style.transform = '';
    }

    if (dragHint) { dragHint.remove(); dragHint = null; }
    dragEl = null;
    dragDelta = { x: 0, y: 0 };
    dragMouseDown = false;
  }

  // ==================== CANVAS CAPTURE ====================
  function captureCanvasToBase64(canvas) {
    var maxW = 600;
    var scale = canvas.width > maxW ? maxW / canvas.width : 1;
    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = Math.round(canvas.width * scale);
    tmpCanvas.height = Math.round(canvas.height * scale);
    var tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);
    // Check for blank (WebGL buffer may be cleared)
    var sample = tmpCtx.getImageData(0, 0, Math.min(tmpCanvas.width, 20), Math.min(tmpCanvas.height, 20)).data;
    var allZero = true;
    for (var si = 3; si < sample.length; si += 4) {
      if (sample[si] !== 0) { allZero = false; break; }
    }
    if (allZero) return null;
    var dataUrl = tmpCanvas.toDataURL('image/jpeg', 0.85);
    return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
  }

  /** Try capture immediately, if blank retry on next animation frame (WebGL buffer timing). */
  function captureCanvasWithRetry(canvas, callback) {
    try {
      var result = captureCanvasToBase64(canvas);
      if (result) { callback(result, null); return; }
    } catch (err) {
      callback(null, 'Canvas tainted or capture failed');
      return;
    }
    // Blank — retry after next render when WebGL buffer is fresh
    requestAnimationFrame(function() {
      try {
        var retry = captureCanvasToBase64(canvas);
        if (retry) callback(retry, null);
        else callback(null, 'Canvas blank (WebGL buffer cleared)');
      } catch (err) {
        callback(null, 'Canvas tainted or capture failed');
      }
    });
  }

  function captureSelectedElement() {
    if (!inspectedEl) return;
    if (inspectedEl.tagName === 'CANVAS') {
      captureCanvasWithRetry(inspectedEl, function(result, error) {
        if (result) {
          sendToParent('dc-capture-result', { imageData: result.base64, mimeType: result.mimeType });
        } else {
          sendToParent('dc-capture-result', { imageData: null, error: error });
        }
      });
    } else {
      // Non-canvas: send bounding rect so caller knows what was selected
      var rect = inspectedEl.getBoundingClientRect();
      sendToParent('dc-capture-result', {
        imageData: null,
        elementRect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      });
    }
    // Exit capture mode
    captureMode = false;
    clickMode = prevClickMode;
    if (!clickMode) cleanupClickMode();
    else document.body.style.cursor = 'crosshair';
  }

  // ==================== DRAW-TO-CAPTURE ====================
  function startDrawCapture() {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483646;cursor:crosshair;';
    var selRect = document.createElement('div');
    selRect.style.cssText = 'position:fixed;border:2px solid #818cf8;background:rgba(99,102,241,0.1);border-radius:2px;pointer-events:none;display:none;';
    overlay.appendChild(selRect);
    document.documentElement.appendChild(overlay);

    var startX = 0, startY = 0, dragging = false;

    function onDown(ev) {
      ev.preventDefault();
      startX = ev.clientX;
      startY = ev.clientY;
      dragging = true;
      selRect.style.display = 'block';
      selRect.style.left = startX + 'px';
      selRect.style.top = startY + 'px';
      selRect.style.width = '0';
      selRect.style.height = '0';
    }

    function onMove(ev) {
      if (!dragging) return;
      var x = Math.min(ev.clientX, startX);
      var y = Math.min(ev.clientY, startY);
      var w = Math.abs(ev.clientX - startX);
      var h = Math.abs(ev.clientY - startY);
      selRect.style.left = x + 'px';
      selRect.style.top = y + 'px';
      selRect.style.width = w + 'px';
      selRect.style.height = h + 'px';
    }

    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      cleanup();
      var x = Math.min(ev.clientX, startX);
      var y = Math.min(ev.clientY, startY);
      var w = Math.abs(ev.clientX - startX);
      var h = Math.abs(ev.clientY - startY);
      if (w < 5 || h < 5) {
        // Too small — cancelled
        sendToParent('dc-system-message', { text: 'Draw cancelled — area too small' });
        return;
      }
      var scrollX = window.scrollX || 0;
      var scrollY = window.scrollY || 0;
      sendToParent('dc-capture-result', {
        captureRect: {
          x: Math.round(x + scrollX),
          y: Math.round(y + scrollY),
          w: Math.round(w),
          h: Math.round(h),
          selector: null
        }
      });
    }

    function onKey(ev) {
      if (ev.key === 'Escape') { dragging = false; cleanup(); sendToParent('dc-system-message', { text: 'Draw capture cancelled' }); }
    }

    function cleanup() {
      overlay.removeEventListener('mousedown', onDown);
      overlay.removeEventListener('mousemove', onMove);
      overlay.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    overlay.addEventListener('mousedown', onDown);
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey, true);
  }

  /** Lightweight sanitizer for AI-generated design HTML — defense-in-depth. */
  function sanitizeDesignHTML(html) {
    if (!html) return '';
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
      .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '')
      .replace(/<embed\b[^>]*\/?>/gi, '')
      .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, 'blocked:')
      .replace(/@import\b/gi, '/*blocked*/');
  }

  /** Apply sanitized AI-generated HTML to a DOM element. Defense-in-depth. */
  function setTrustedHTML(el, html) {
    el.innerHTML = sanitizeDesignHTML(html); // eslint-disable-line no-unsanitized/property -- sanitized above
  }

  // ==================== UNDO/REDO HELPERS ====================
  function notifyUndoState() {
    sendToParent('dc-undo-state', {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoCount: undoStack.length,
      redoCount: redoStack.length
    });
  }

  function pushUndo(entry) {
    // Coalesce: if the last undo entry is for the same element + property, merge
    if (entry.type === 'style' && undoStack.length > 0) {
      var last = undoStack[undoStack.length - 1];
      if (last.type === 'style' && last.el === entry.el && last.prop === entry.prop) {
        // Keep the original oldVal, update the newVal
        last.newVal = entry.newVal;
        redoStack = [];
        notifyUndoState();
        return;
      }
    }
    undoStack.push(entry);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift(); // Cap at limit
    redoStack = []; // Clear redo on new action
    notifyUndoState();
  }

  function performUndo() {
    if (undoStack.length === 0) return;
    const entry = undoStack.pop();
    if (entry.type === 'style' && entry.el) {
      const camelProp = entry.prop.replace(/-([a-z])/g, function(_, c) { return c.toUpperCase(); });
      entry.el.style[camelProp] = entry.oldVal;
      redoStack.push(entry);
      sendToParent('dc-system-message', { text: 'Undo: ' + entry.prop });
    }
    notifyUndoState();
  }

  function performRedo() {
    if (redoStack.length === 0) return;
    const entry = redoStack.pop();
    if (entry.type === 'style' && entry.el) {
      const camelProp = entry.prop.replace(/-([a-z])/g, function(_, c) { return c.toUpperCase(); });
      entry.el.style[camelProp] = entry.newVal;
      undoStack.push(entry);
      sendToParent('dc-system-message', { text: 'Redo: ' + entry.prop });
    }
    notifyUndoState();
  }

  // ==================== RULER OVERLAY ====================
  let rulerMode = false;
  let rulerContainer = null;
  let rulerHLine = null;
  let rulerVLine = null;
  let rulerCoords = null;
  let rulerHBar = null;
  let rulerVBar = null;
  let pinnedGuides = [];

  function createRulerOverlay() {
    if (rulerContainer) return;

    rulerContainer = document.createElement('div');
    rulerContainer.id = 'dc-ruler-overlay';
    rulerContainer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483640;';

    // Horizontal ruler bar (top)
    rulerHBar = document.createElement('canvas');
    rulerHBar.id = 'dc-ruler-h';
    rulerHBar.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:24px;opacity:0.85;pointer-events:none;';
    rulerContainer.appendChild(rulerHBar);

    // Vertical ruler bar (left)
    rulerVBar = document.createElement('canvas');
    rulerVBar.id = 'dc-ruler-v';
    rulerVBar.style.cssText = 'position:fixed;top:0;left:0;width:24px;height:100%;opacity:0.85;pointer-events:none;';
    rulerContainer.appendChild(rulerVBar);

    // Crosshair lines
    rulerHLine = document.createElement('div');
    rulerHLine.style.cssText = 'position:fixed;left:0;width:100%;height:1px;background:rgba(99,102,241,0.5);pointer-events:none;display:none;';
    rulerContainer.appendChild(rulerHLine);

    rulerVLine = document.createElement('div');
    rulerVLine.style.cssText = 'position:fixed;top:0;height:100%;width:1px;background:rgba(99,102,241,0.5);pointer-events:none;display:none;';
    rulerContainer.appendChild(rulerVLine);

    // Coordinate label
    rulerCoords = document.createElement('div');
    rulerCoords.style.cssText = 'position:fixed;padding:2px 6px;font:11px/1.3 monospace;border-radius:4px;pointer-events:none;display:none;white-space:nowrap;z-index:2147483641;';
    // Theme-aware colors applied dynamically in drawRulerBars
    rulerContainer.appendChild(rulerCoords);

    document.documentElement.appendChild(rulerContainer);
    drawRulerBars();
  }

  function drawRulerBars() {
    if (!rulerHBar || !rulerVBar) return;
    const dpr = window.devicePixelRatio || 1;
    const light = lastThemeIsDark === false;
    const bgFill = light ? 'rgba(240,240,244,0.9)' : 'rgba(20,20,40,0.75)';
    const tickStroke = light ? 'rgba(80,80,120,0.5)' : 'rgba(165,180,252,0.5)';
    const tickFill = light ? 'rgba(80,80,120,0.7)' : 'rgba(165,180,252,0.7)';
    // Update coords label theme
    if (rulerCoords) {
      rulerCoords.style.background = light ? 'rgba(240,240,244,0.95)' : 'rgba(30,30,60,0.9)';
      rulerCoords.style.color = light ? '#4338ca' : '#a5b4fc';
    }

    // Horizontal ruler
    const hW = window.innerWidth;
    rulerHBar.width = hW * dpr;
    rulerHBar.height = 24 * dpr;
    rulerHBar.style.width = hW + 'px';
    const hCtx = rulerHBar.getContext('2d');
    hCtx.scale(dpr, dpr);
    hCtx.fillStyle = bgFill;
    hCtx.fillRect(0, 0, hW, 24);
    hCtx.strokeStyle = tickStroke;
    hCtx.fillStyle = tickFill;
    hCtx.font = '9px monospace';
    hCtx.textAlign = 'center';
    const scrollX = window.scrollX || 0;
    for (let px = 0; px < hW + 100; px++) {
      const absX = px + scrollX;
      if (absX % 100 === 0) {
        hCtx.beginPath(); hCtx.moveTo(px, 0); hCtx.lineTo(px, 18); hCtx.lineWidth = 1; hCtx.stroke();
        hCtx.fillText(absX + '', px, 22);
      } else if (absX % 50 === 0) {
        hCtx.beginPath(); hCtx.moveTo(px, 8); hCtx.lineTo(px, 18); hCtx.lineWidth = 0.7; hCtx.stroke();
      } else if (absX % 10 === 0) {
        hCtx.beginPath(); hCtx.moveTo(px, 14); hCtx.lineTo(px, 18); hCtx.lineWidth = 0.5; hCtx.stroke();
      }
    }

    // Vertical ruler
    const vH = window.innerHeight;
    rulerVBar.width = 24 * dpr;
    rulerVBar.height = vH * dpr;
    rulerVBar.style.height = vH + 'px';
    const vCtx = rulerVBar.getContext('2d');
    vCtx.scale(dpr, dpr);
    vCtx.fillStyle = bgFill;
    vCtx.fillRect(0, 0, 24, vH);
    vCtx.strokeStyle = tickStroke;
    vCtx.fillStyle = tickFill;
    vCtx.font = '9px monospace';
    vCtx.textAlign = 'right';
    const scrollY = window.scrollY || 0;
    for (let py = 0; py < vH + 100; py++) {
      const absY = py + scrollY;
      if (absY % 100 === 0) {
        vCtx.beginPath(); vCtx.moveTo(0, py); vCtx.lineTo(18, py); vCtx.lineWidth = 1; vCtx.stroke();
        vCtx.save(); vCtx.translate(22, py + 3); vCtx.rotate(-Math.PI / 2); vCtx.textAlign = 'center'; vCtx.fillText(absY + '', 0, 0); vCtx.restore();
      } else if (absY % 50 === 0) {
        vCtx.beginPath(); vCtx.moveTo(8, py); vCtx.lineTo(18, py); vCtx.lineWidth = 0.7; vCtx.stroke();
      } else if (absY % 10 === 0) {
        vCtx.beginPath(); vCtx.moveTo(14, py); vCtx.lineTo(18, py); vCtx.lineWidth = 0.5; vCtx.stroke();
      }
    }
  }

  function removeRulerOverlay() {
    if (rulerContainer) {
      rulerContainer.remove();
      rulerContainer = null;
      rulerHBar = null;
      rulerVBar = null;
      rulerHLine = null;
      rulerVLine = null;
      rulerCoords = null;
    }
    pinnedGuides.forEach(g => g.el.remove());
    pinnedGuides = [];
  }

  // Mouse tracking for ruler — throttled to rAF to avoid per-event reflows
  var _rulerRafPending = false;
  document.addEventListener('mousemove', function(e) {
    if (!rulerMode || !rulerHLine) return;
    if (isWidgetElement(e.target)) return;
    if (_rulerRafPending) return;
    _rulerRafPending = true;
    var cx = e.clientX, cy = e.clientY;
    requestAnimationFrame(function() {
      _rulerRafPending = false;
      if (!rulerMode || !rulerHLine) return;
      var scrollX = window.scrollX || 0;
      var scrollY = window.scrollY || 0;
      var absX = Math.round(cx + scrollX);
      var absY = Math.round(cy + scrollY);

      rulerHLine.style.top = cy + 'px';
      rulerHLine.style.display = 'block';
      rulerVLine.style.left = cx + 'px';
      rulerVLine.style.display = 'block';

      rulerCoords.style.left = (cx + 12) + 'px';
      rulerCoords.style.top = (cy + 12) + 'px';
      rulerCoords.textContent = absX + ', ' + absY;
      rulerCoords.style.display = 'block';
    });
  }, true);

  // Click to pin a guide
  document.addEventListener('click', function(e) {
    if (!rulerMode) return;
    if (isWidgetElement(e.target)) return;
    // Don't intercept if click capture is also active
    if (clickMode) return;

    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const absX = Math.round(e.clientX + scrollX);
    const absY = Math.round(e.clientY + scrollY);

    // Pin horizontal guide
    const hGuide = document.createElement('div');
    hGuide.style.cssText = 'position:fixed;left:0;width:100%;height:1px;background:rgba(248,113,113,0.6);pointer-events:none;z-index:2147483639;';
    hGuide.style.top = e.clientY + 'px';
    document.documentElement.appendChild(hGuide);

    // Pin vertical guide
    const vGuide = document.createElement('div');
    vGuide.style.cssText = 'position:fixed;top:0;height:100%;width:1px;background:rgba(248,113,113,0.6);pointer-events:none;z-index:2147483639;';
    vGuide.style.left = e.clientX + 'px';
    document.documentElement.appendChild(vGuide);

    // Label
    const label = document.createElement('div');
    label.style.cssText = 'position:fixed;padding:1px 5px;background:rgba(220,38,38,0.85);color:#fff;font:10px/1.3 monospace;border-radius:3px;pointer-events:none;z-index:2147483641;';
    label.style.left = (e.clientX + 4) + 'px';
    label.style.top = (e.clientY - 14) + 'px';
    label.textContent = absX + ', ' + absY;
    document.documentElement.appendChild(label);

    pinnedGuides.push({ el: hGuide }, { el: vGuide }, { el: label });

    sendToParent('dc-system-message', { text: 'Pinned guide at ' + absX + ', ' + absY });
  }, true);

  // Redraw rulers on scroll/resize
  window.addEventListener('scroll', function() { if (rulerMode) drawRulerBars(); }, { passive: true });
  window.addEventListener('resize', function() { if (rulerMode) drawRulerBars(); });

  // ==================== MESSAGE HANDLER ====================
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    // Validate origin when we can determine parent origin
    // In single mode (no iframe), messages come from self — always trust those
    if (e.source !== window && parentOrigin && e.origin !== parentOrigin && e.origin !== window.location.origin) return;

    switch (e.data.type) {
      case 'dc-click-mode':
        clickMode = e.data.enabled;
        document.body.style.cursor = clickMode ? 'crosshair' : '';
        if (!clickMode) cleanupClickMode();
        break;

      case 'dc-ruler-mode':
        rulerMode = e.data.enabled;
        if (rulerMode) {
          createRulerOverlay();
        } else {
          removeRulerOverlay();
        }
        break;

      case 'dc-init-options':
        optionsTarget = document.querySelector(e.data.selector);
        if (optionsTarget) {
          optionsOriginal = optionsTarget.outerHTML;
          sendToParent('dc-options-ready', {
            found: true,
            originalHTML: optionsOriginal
          });
        } else {
          sendToParent('dc-options-ready', { found: false });
        }
        break;

      case 'dc-apply-option': {
        if (optionsTarget) {
          const wrapper = document.createElement('div');
          setTrustedHTML(wrapper, e.data.html);
          const replacement = wrapper.firstElementChild || wrapper;
          optionsTarget.replaceWith(replacement);
          optionsTarget = replacement;
        }
        break;
      }

      case 'dc-revert-option': {
        if (optionsTarget && optionsOriginal) {
          const wrapper = document.createElement('div');
          setTrustedHTML(wrapper, optionsOriginal);
          const original = wrapper.firstElementChild || wrapper;
          optionsTarget.replaceWith(original);
          optionsTarget = original;
        }
        break;
      }

      // ---- Inspector messages ----
      case 'dc-get-full-styles': {
        // Return full computed styles for the last selected/inspected element
        if (inspectedEl) {
          const cs = window.getComputedStyle(inspectedEl);
          const styles = {
            // Layout
            margin: cs.margin, padding: cs.padding,
            width: cs.width, height: cs.height,
            display: cs.display, gap: cs.gap,
            flexDirection: cs.flexDirection, justifyContent: cs.justifyContent,
            alignItems: cs.alignItems, overflow: cs.overflow,
            position: cs.position, zIndex: cs.zIndex,
            // Typography
            fontSize: cs.fontSize, fontWeight: cs.fontWeight,
            fontFamily: cs.fontFamily, textAlign: cs.textAlign,
            color: cs.color, lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing, textTransform: cs.textTransform,
            // Appearance
            backgroundColor: cs.backgroundColor,
            borderRadius: cs.borderRadius,
            borderWidth: cs.borderWidth, borderStyle: cs.borderStyle,
            borderColor: cs.borderColor, border: cs.border,
            opacity: cs.opacity, boxShadow: cs.boxShadow,
          };
          // Extract pseudo-class styles from stylesheets
          var pseudoStyles = getPseudoStyles(inspectedEl);
          sendToParent('dc-full-styles', { styles: styles, pseudoStyles: pseudoStyles });
        }
        break;
      }

      case 'dc-apply-style': {
        if (inspectedEl) {
          const prop = e.data.property;
          const val = e.data.value;
          const camelProp = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          const oldVal = inspectedEl.style[camelProp] || '';
          // Save original if not yet saved
          if (!(camelProp in inspectedOriginalStyles)) {
            inspectedOriginalStyles[camelProp] = oldVal;
          }
          inspectedEl.style[camelProp] = val;
          // Push to undo stack
          pushUndo({ type: 'style', el: inspectedEl, prop: prop, oldVal: oldVal, newVal: val });
        }
        break;
      }

      case 'dc-reset-styles': {
        if (inspectedEl) {
          // Restore all original inline styles
          Object.entries(inspectedOriginalStyles).forEach(function(entry) {
            inspectedEl.style[entry[0]] = entry[1];
          });
          inspectedOriginalStyles = {};
          undoStack = [];
          redoStack = [];
          notifyUndoState();
          sendToParent('dc-system-message', { text: 'Styles reset to original' });
        }
        break;
      }

      case 'dc-capture-request': {
        // Send bounding rect back to widget — Playwright takes the actual screenshot
        // (JS canvas capture fails for WebGL because the buffer is cleared after compositing)
        var captureRect;
        if (inspectedEl) {
          var r = inspectedEl.getBoundingClientRect();
          captureRect = {
            x: Math.round(r.x + window.scrollX),
            y: Math.round(r.y + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
            selector: inspectedEl.id ? '#' + inspectedEl.id : inspectedEl.tagName.toLowerCase()
          };
        } else {
          // Viewport capture
          captureRect = {
            x: Math.round(window.scrollX),
            y: Math.round(window.scrollY),
            w: Math.round(window.innerWidth),
            h: Math.round(window.innerHeight),
            selector: null
          };
        }
        sendToParent('dc-capture-result', { captureRect: captureRect });
        break;
      }

      case 'dc-capture-mode':
        captureMode = e.data.enabled;
        if (captureMode) {
          prevClickMode = clickMode;
          clickMode = true;
          document.body.style.cursor = 'crosshair';
        } else {
          captureMode = false;
          clickMode = prevClickMode;
          if (!clickMode) { cleanupClickMode(); document.body.style.cursor = ''; }
        }
        break;

      case 'dc-draw-capture-start':
        startDrawCapture();
        break;

      case 'dc-show-overlays': {
        // Clear previous overlays synchronously (not via postMessage which is async and would wipe new badges)
        var prevBadges = window.__dcOverlayBadges || [];
        for (var pi = 0; pi < prevBadges.length; pi++) {
          if (prevBadges[pi].badge && prevBadges[pi].badge.parentNode) prevBadges[pi].badge.parentNode.removeChild(prevBadges[pi].badge);
          if (prevBadges[pi].el) prevBadges[pi].el.classList.remove('dc-audit-outline-error', 'dc-audit-outline-warning', 'dc-audit-outline-info');
        }
        window.__dcOverlayBadges = [];
        if (window.__dcOverlayCleanup) { window.__dcOverlayCleanup(); window.__dcOverlayCleanup = null; }
        var overlays = e.data.overlays || [];
        var badges = [];
        var activeTooltip = null;

        function closeTooltip() {
          if (activeTooltip && activeTooltip.parentNode) activeTooltip.parentNode.removeChild(activeTooltip);
          activeTooltip = null;
        }

        function showTooltip(ov, badgeEl) {
          closeTooltip();
          var sevColors = { error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
          // Build tooltip with safe DOM methods (no innerHTML — this is a security-conscious dev tool)
          var tt = document.createElement('div');
          tt.className = 'dc-audit-tooltip';

          var closeBtn = document.createElement('button');
          closeBtn.className = 'dc-audit-tooltip-close';
          closeBtn.textContent = '\u2715';
          closeBtn.addEventListener('click', closeTooltip);
          tt.appendChild(closeBtn);

          var header = document.createElement('div');
          header.className = 'dc-audit-tooltip-header';
          var sevSpan = document.createElement('span');
          sevSpan.className = 'dc-audit-tooltip-severity';
          sevSpan.style.background = sevColors[ov.level] || '#666';
          sevSpan.textContent = ov.level;
          var checkSpan = document.createElement('span');
          checkSpan.className = 'dc-audit-tooltip-check';
          checkSpan.textContent = ov.label || '';
          header.appendChild(sevSpan);
          header.appendChild(checkSpan);
          tt.appendChild(header);

          var msg = document.createElement('div');
          msg.className = 'dc-audit-tooltip-msg';
          msg.textContent = ov.tooltip || '';
          tt.appendChild(msg);

          var sel = document.createElement('div');
          sel.className = 'dc-audit-tooltip-sel';
          sel.textContent = ov.selector || '';
          tt.appendChild(sel);

          // Position near the badge
          var br = badgeEl.getBoundingClientRect();
          tt.style.top = Math.min(br.bottom + 6, window.innerHeight - 200) + 'px';
          tt.style.left = Math.max(8, Math.min(br.left, window.innerWidth - 340)) + 'px';
          document.body.appendChild(tt);
          activeTooltip = tt;

          // Scroll element into view
          try {
            var targetEl = document.querySelector(ov.selector);
            if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } catch (ex) { /* invalid selector */ }
        }

        // Close tooltip on click outside
        document.addEventListener('click', function tooltipOutside(ev) {
          if (activeTooltip && !activeTooltip.contains(ev.target) && !ev.target.closest('.dc-audit-badge')) {
            closeTooltip();
          }
        });

        function repositionBadges() {
          for (var i = 0; i < badges.length; i++) {
            var b = badges[i];
            if (!b.el || !b.badge) continue;
            var r = b.el.getBoundingClientRect();
            b.badge.style.top = Math.max(0, r.top - 2) + 'px';
            b.badge.style.left = Math.max(0, r.right - b.badge.offsetWidth) + 'px';
          }
        }
        var reposThrottle = null;
        function throttledRepos() {
          if (reposThrottle) return;
          reposThrottle = setTimeout(function() { reposThrottle = null; repositionBadges(); }, 100);
        }
        for (var oi = 0; oi < overlays.length; oi++) {
          var ov = overlays[oi];
          try {
            var ovEl = document.querySelector(ov.selector);
            if (!ovEl) continue;
            ovEl.classList.add('dc-audit-outline-' + ov.level);
            var badge = document.createElement('div');
            badge.className = 'dc-audit-badge dc-audit-' + ov.level;
            badge.setAttribute('data-dc-audit-id', String(ov.id));
            badge.setAttribute('data-dc-audit-level', ov.level);
            badge.setAttribute('data-dc-audit-check', ov.label || '');
            // Badge content: number + check type
            var numSpan = document.createElement('span');
            numSpan.className = 'dc-audit-num';
            numSpan.textContent = String(oi + 1);
            badge.appendChild(numSpan);
            badge.appendChild(document.createTextNode(ov.label || ''));
            var ovRect = ovEl.getBoundingClientRect();
            badge.style.top = Math.max(0, ovRect.top - 2) + 'px';
            badge.style.left = Math.max(0, ovRect.right - badge.offsetWidth - 4) + 'px';
            document.body.appendChild(badge);
            badges.push({ el: ovEl, badge: badge, data: ov });
            (function(badgeEl, overlay) {
              badgeEl.addEventListener('click', function(ev) {
                ev.stopPropagation();
                showTooltip(overlay, badgeEl);
                sendToParent('dc-audit-badge-click', { id: overlay.id });
              });
            })(badge, ov);
          } catch (ex) { /* skip invalid selector */ }
        }
        // Reposition after rendering to account for badge widths
        setTimeout(repositionBadges, 50);
        window.__dcOverlayBadges = badges;
        window.__dcOverlayCloseTooltip = closeTooltip;
        window.addEventListener('scroll', throttledRepos);
        window.addEventListener('resize', throttledRepos);
        window.__dcOverlayCleanup = function() {
          closeTooltip();
          window.removeEventListener('scroll', throttledRepos);
          window.removeEventListener('resize', throttledRepos);
        };
        break;
      }

      case 'dc-filter-overlays': {
        // Show/hide badges by severity or check type
        var filterLevel = e.data.level || null;   // 'error', 'warning', 'info', or null for all
        var filterCheck = e.data.check || null;    // 'CON', 'ALT', 'TOU', etc., or null for all
        var allBadges = window.__dcOverlayBadges || [];
        for (var fi = 0; fi < allBadges.length; fi++) {
          var fb = allBadges[fi];
          if (!fb.badge) continue;
          var matchLevel = !filterLevel || fb.badge.getAttribute('data-dc-audit-level') === filterLevel;
          var matchCheck = !filterCheck || fb.badge.getAttribute('data-dc-audit-check') === filterCheck;
          var show = matchLevel && matchCheck;
          fb.badge.style.display = show ? '' : 'none';
          if (fb.el) {
            if (show) {
              fb.el.classList.add('dc-audit-outline-' + fb.badge.getAttribute('data-dc-audit-level'));
            } else {
              fb.el.classList.remove('dc-audit-outline-error', 'dc-audit-outline-warning', 'dc-audit-outline-info');
            }
          }
        }
        break;
      }

      case 'dc-clear-overlays': {
        var oldBadges = window.__dcOverlayBadges || [];
        for (var ci = 0; ci < oldBadges.length; ci++) {
          if (oldBadges[ci].badge && oldBadges[ci].badge.parentNode) {
            oldBadges[ci].badge.parentNode.removeChild(oldBadges[ci].badge);
          }
          if (oldBadges[ci].el) {
            oldBadges[ci].el.classList.remove('dc-audit-outline-error', 'dc-audit-outline-warning', 'dc-audit-outline-info');
          }
        }
        window.__dcOverlayBadges = [];
        if (window.__dcOverlayCleanup) { window.__dcOverlayCleanup(); window.__dcOverlayCleanup = null; }
        break;
      }

      case 'dc-scroll-to': {
        var scrollSel = e.data.selector;
        try {
          var scrollEl = document.querySelector(scrollSel);
          if (scrollEl) {
            scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            scrollEl.classList.add('dc-highlight');
            setTimeout(function() { scrollEl.classList.remove('dc-highlight'); }, 1500);
          }
        } catch (ex) { /* invalid selector */ }
        break;
      }

      case 'dc-snap-grid': {
        window.__dcSnapGrid = e.data.enabled ? e.data.size : 0;
        break;
      }

      case 'dc-responsive-resize': {
        // Handled in parent widget — bridge just acknowledges
        break;
      }

      case 'dc-undo':
        performUndo();
        break;

      case 'dc-redo':
        performRedo();
        break;
    }
  });

  // ==================== HOVER HANDLING ====================
  document.addEventListener('mouseover', function(e) {
    if (!clickMode || dragEl) return;  // No hover highlight during drag
    if (isWidgetElement(e.target)) return;
    if (hoverEl) hoverEl.classList.remove('dc-hover-highlight');
    hoverEl = e.target;
    hoverEl.classList.add('dc-hover-highlight');
  }, true);

  // ==================== CLICK CAPTURE ====================
  function selectElement(el) {
    var info = getComputedInfo(el);
    inspectedEl = el;
    inspectedOriginalStyles = {};
    el.classList.add('dc-highlight');
    showDragHandle(el);
    sendToParent('dc-element-selected', { element: info });
    sendToParent('dc-system-message', {
      text: 'Selected: ' + describeEl(el) + ' \u2014 grab \u2630 to move, \u2191/\u2193 to change scope, Esc to deselect'
    });
  }

  document.addEventListener('click', function(e) {
    if (!clickMode) return;
    if (isWidgetElement(e.target)) return;
    if (dragEl) { e.preventDefault(); e.stopPropagation(); return; }  // Ignore clicks during drag
    // If a pending drag was active (mousedown but not enough movement), cancel it
    if (pendingDragEl) { pendingDragEl = null; }
    e.preventDefault();
    e.stopPropagation();

    // Click on body/html = deselect all
    var isBackground = (e.target === document.body || e.target === document.documentElement);

    // Ctrl+click = multi-select toggle
    if (e.ctrlKey && !isBackground && !captureMode) {
      var target = e.target;
      if (multiSelectedEls.has(target)) {
        // Deselect this element
        multiSelectedEls.delete(target);
        target.classList.remove('dc-highlight');
        sendToParent('dc-element-deselected', { element: getComputedInfo(target) });
        sendToParent('dc-system-message', {
          text: 'Deselected: ' + describeEl(target) + ' (' + multiSelectedEls.size + ' selected)'
        });
      } else {
        // Add to multi-selection
        multiSelectedEls.add(target);
        target.classList.add('dc-highlight');
        sendToParent('dc-element-selected', { element: getComputedInfo(target) });
        sendToParent('dc-system-message', {
          text: 'Added: ' + describeEl(target) + ' (' + multiSelectedEls.size + ' selected)'
        });
      }
      // Set as current inspected for inspector panel
      if (multiSelectedEls.size > 0) {
        inspectedEl = target;
        inspectedOriginalStyles = {};
      } else {
        inspectedEl = null;
        inspectedOriginalStyles = {};
      }
      return;
    }

    // Regular click — clear multi-selection first
    if (multiSelectedEls.size > 0) {
      multiSelectedEls.forEach(function(el) { el.classList.remove('dc-highlight'); });
      multiSelectedEls.clear();
    }

    // If an element is already selected and user clicks elsewhere → deselect
    if (inspectedEl && (isBackground || (!inspectedEl.contains(e.target) && e.target !== inspectedEl))) {
      if (captureMode) {
        captureSelectedElement();
        return;
      }
      // Deselect current
      sendToParent('dc-selection-confirmed', { element: getComputedInfo(inspectedEl) });
      clearHighlights();
      removeDragHandle();
      inspectedEl = null;
      inspectedOriginalStyles = {};
      ancestorChain = [];
      chainIndex = 0;
      // If clicked on background, just deselect — don't select body
      if (isBackground) return;
    }

    clearHighlights();
    removeDragHandle();

    ancestorChain = getAncestorChain(e.target);
    chainIndex = 0;
    // Immediately select the clicked element
    selectElement(ancestorChain[0]);
  }, true);

  // ==================== DRAG LISTENERS ====================
  document.addEventListener('mousedown', function(e) {
    // If already in drag mode, handle drag start
    if (dragEl) {
      if (!dragEl.contains(e.target) && e.target !== dragEl) return;
      e.preventDefault();
      e.stopPropagation();
      dragMouseDown = true;
      dragStartX = e.clientX - dragDelta.x;
      dragStartY = e.clientY - dragDelta.y;
      dragEl.classList.add('dc-dragging');
      document.documentElement.focus();
      return;
    }

    // Widget elements should not trigger drag
    if (isWidgetElement(e.target)) return;

    // If clicking on the currently selected element, prepare for potential drag
    // Actual drag starts only after moving 5px (threshold-based)
    if (inspectedEl && clickMode && !captureMode &&
        (inspectedEl === e.target || inspectedEl.contains(e.target))) {
      pendingDragEl = inspectedEl;
      pendingDragStartX = e.clientX;
      pendingDragStartY = e.clientY;
    }
  }, true);

  document.addEventListener('mousemove', function(e) {
    // Check pending drag threshold
    if (pendingDragEl && !dragEl) {
      var dx = Math.abs(e.clientX - pendingDragStartX);
      var dy = Math.abs(e.clientY - pendingDragStartY);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        // Threshold exceeded — enter drag mode
        var el = pendingDragEl;
        pendingDragEl = null;
        enterDragMode(el);
        dragMouseDown = true;
        dragStartX = pendingDragStartX - dragDelta.x;
        dragStartY = pendingDragStartY - dragDelta.y;
        dragEl.classList.add('dc-dragging');
        // Process this mousemove as a drag move
        dragDelta.x = e.clientX - dragStartX;
        dragDelta.y = e.clientY - dragStartY;
        dragEl.style.transform = 'translate(' + dragDelta.x + 'px, ' + dragDelta.y + 'px)';
        if (dragHint) {
          dragHint.textContent = 'dx: ' + Math.round(dragDelta.x) + 'px, dy: ' + Math.round(dragDelta.y) + 'px \u2014 Enter to confirm';
        }
        return;
      }
    }

    if (!dragMouseDown || !dragEl) return;
    dragDelta.x = e.clientX - dragStartX;
    dragDelta.y = e.clientY - dragStartY;
    // Snap to grid if enabled
    var snap = window.__dcSnapGrid || 0;
    if (snap > 0) {
      dragDelta.x = Math.round(dragDelta.x / snap) * snap;
      dragDelta.y = Math.round(dragDelta.y / snap) * snap;
    }
    dragEl.style.transform = 'translate(' + dragDelta.x + 'px, ' + dragDelta.y + 'px)';
    if (dragHint) {
      dragHint.textContent = 'dx: ' + Math.round(dragDelta.x) + 'px, dy: ' + Math.round(dragDelta.y) + 'px \u2014 Enter to confirm';
    }
  }, true);

  document.addEventListener('mouseup', function(e) {
    // Cancel pending drag if threshold wasn't reached
    if (pendingDragEl) { pendingDragEl = null; }
    if (!dragMouseDown) return;
    dragMouseDown = false;
    if (dragEl) {
      dragEl.classList.remove('dc-dragging');
      // Stay in drag mode — go back to selected state with drag handle
      // The transform stays applied; user can grab again to keep tweaking
      var el = dragEl;
      var delta = { x: Math.round(dragDelta.x), y: Math.round(dragDelta.y) };
      // Send position update (for tracking) but don't exit
      if (Math.abs(delta.x) > 2 || Math.abs(delta.y) > 2) {
        var info = getComputedInfo(el);
        sendToParent('dc-drag-complete', { element: info, delta: delta });
      }
      // Exit drag mode visually but keep element selected
      el.classList.remove('dc-draggable');
      if (dragHint) { dragHint.remove(); dragHint = null; }
      dragEl = null;
      dragMouseDown = false;
      // Reset ancestor chain so next click can select freely
      ancestorChain = [];
      chainIndex = 0;
      // Re-select the element properly (sends dc-element-selected so inspector updates)
      selectElement(el);
      sendToParent('dc-system-message', {
        text: 'Moved: dx=' + delta.x + ', dy=' + delta.y + ' — grab ☰ to continue, click elsewhere to select another'
      });
    }
  }, true);

  // ==================== KEYBOARD NAVIGATION ====================
  document.addEventListener('keydown', function(e) {
    // Handle drag mode keys first
    if (dragEl) {
      if (e.key === 'Enter') {
        e.preventDefault();
        exitDragMode(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitDragMode(false);
      }
      return;
    }

    if (!clickMode || ancestorChain.length === 0) return;

    if (e.key === 'ArrowUp' && chainIndex < ancestorChain.length - 1) {
      e.preventDefault();
      chainIndex++;
      clearHighlights();
      selectElement(ancestorChain[chainIndex]);
    } else if (e.key === 'ArrowDown' && chainIndex > 0) {
      e.preventDefault();
      chainIndex--;
      clearHighlights();
      selectElement(ancestorChain[chainIndex]);
    } else if (e.key === 'Enter' && inspectedEl && captureMode) {
      e.preventDefault();
      captureSelectedElement();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (captureMode) {
        // Exit capture mode, notify parent
        captureMode = false;
        clickMode = prevClickMode;
        if (!clickMode) { cleanupClickMode(); document.body.style.cursor = ''; }
        sendToParent('dc-capture-cancelled');
      }
      clearHighlights();
      multiSelectedEls.clear();
      removeDragHandle();
      inspectedEl = null;
      inspectedOriginalStyles = {};
      ancestorChain = [];
      chainIndex = 0;
      sendToParent('dc-system-message', { text: 'Selection cleared' });
    }
  }, true);
})();
