// Claude Collab Widget Bundle — auto-generated

// === collab-widget.js ===
/**
 * Claude Collab Widget v5 (iframe architecture)
 * Lives in the parent frame (wrapper page). Target sites load in an iframe.
 * Click capture runs in the iframe via iframe-bridge.js, communicating via postMessage.
 * AI communicates via window.__dc.api methods through the MCP server.
 *
 * v5 changes (over v4):
 * - Iframe architecture: widget never re-injects on navigation
 * - Click capture moved to iframe-bridge.js (postMessage communication)
 * - renderOptions uses postMessage to replace elements in iframe
 * - Removed describeEl/getComputedInfo (now in iframe-bridge.js)
 *
 * Retained from v4:
 * - localStorage chat persistence + auto-restore
 * - api.exportChat() for context window recovery
 * - Message timestamps, resize handle, error handling
 *
 * Features:
 * - Two-way chat (AI <-> user) entirely in the browser
 * - Click capture via iframe bridge (postMessage)
 * - Design preview panel (draggable, minimizable)
 * - Clickable design options via iframe bridge
 * - Cross-tab sync via localStorage (same-origin tabs stay in sync)
 * - Chat history persists permanently (widget never re-injects)
 *
 * Security notes:
 * - User chat messages always use textContent (no HTML injection)
 * - The preview panel accepts trusted AI-generated HTML only (design mockups)
 *   This is intentional — the preview panel is a developer design tool, not user-facing.
 *   The AI controls what gets rendered there; no user input reaches innerHTML.
 */
(() => {
  if (window.__dc) return 'Already active';

  // Private MessageChannel relay port (received from relay-inject.ts)
  var _relayPort = null;
  var _screenshotCallbacks = {};

  window.addEventListener('message', function(e) {
    // Receive the private relay port via MessageChannel transfer
    if (e.data && e.data.__dcRelayPort && e.ports && e.ports[0]) {
      _relayPort = e.ports[0];
      _relayPort.onmessage = function(ev) {
        // Handle screenshot results coming back through the private channel
        if (ev.data && ev.data.action === 'screenshot-result' && ev.data.requestId) {
          var cb = _screenshotCallbacks[ev.data.requestId];
          if (cb) {
            delete _screenshotCallbacks[ev.data.requestId];
            cb(ev.data.data);
          }
        }
      };
      // Acknowledge receipt so relay-inject stops retrying.
      // Non-http(s) origins fail as postMessage targets ("file://" is silently
      // dropped, "null" throws) — ack lost, relay retries forever. Use '*' there.
      window.postMessage({ __dcRelayAck: true }, /^https?:/.test(e.origin || '') ? e.origin : '*');
    }
  });

  // Relay functions — use private MessageChannel when available, fall back to window globals
  function relayMessage(text, selections, imageData, mimeType) {
    if (_relayPort) {
      _relayPort.postMessage({
        action: 'message', text: text, selections: selections || null,
        imageData: imageData || null, mimeType: mimeType || null
      });
      return Promise.resolve();
    }
    // Playwright binding fallback (tabs/single mode) — text only; attachments
    // are read from widget state via evalWidget there
    if (window.__dcRelayMessage) return window.__dcRelayMessage(text, selections ? JSON.stringify(selections) : null);
    return Promise.reject('no relay');
  }
  function relayCancel() {
    if (_relayPort) {
      _relayPort.postMessage({ action: 'cancel' });
      return Promise.resolve();
    }
    if (window.__dcRelayCancel) return window.__dcRelayCancel();
    return Promise.reject('no relay');
  }
  function relayScreenshot(optsJson) {
    if (_relayPort) {
      return new Promise(function(resolve) {
        var requestId = 'ss-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        _screenshotCallbacks[requestId] = resolve;
        _relayPort.postMessage({ action: 'screenshot', optsJson: optsJson, requestId: requestId });
        setTimeout(function() {
          if (_screenshotCallbacks[requestId]) {
            delete _screenshotCallbacks[requestId];
            resolve(null);
          }
        }, 10000);
      });
    }
    if (window.__dcTakeScreenshot) return window.__dcTakeScreenshot(optsJson);
    return Promise.resolve(null);
  }

  // ==================== CONSTANTS ====================
  const STORAGE_KEY = 'dc-chat-history';
  const INPUT_KEY = 'dc-input-draft';
  const PREVIEW_KEY = 'dc-preview-html';
  const TAB_ID = 'tab_' + Math.random().toString(36).slice(2, 8);

  // ==================== HELPERS ====================
  function tryLocalStorage(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }

  function createEl(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  // Full-page overlay to capture mouse events during drag/resize (prevents iframe/content stealing events)
  const _dcOverlay = createEl('div', 'dc-interaction-overlay');
  document.body.appendChild(_dcOverlay);

  function _startInteraction(cursor) {
    _dcOverlay.style.display = 'block';
    _dcOverlay.style.cursor = cursor || 'default';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
  }
  function _endInteraction() {
    _dcOverlay.style.display = 'none';
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
  }

  function makeDraggable(el, handle, onDrag) {
    let sx, sy, sl, st;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.dc-btn, .dc-edge')) return;
      e.preventDefault();
      _normalizePosition(el);
      sx = e.clientX; sy = e.clientY; sl = parseFloat(el.style.left); st = parseFloat(el.style.top);
      _startInteraction('move');
      const onMove = (e) => {
        const x = Math.max(0, Math.min(window.innerWidth - 60, sl + e.clientX - sx));
        const y = Math.max(0, Math.min(window.innerHeight - 44, st + e.clientY - sy));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        if (onDrag) onDrag();
      };
      const onUp = () => {
        _endInteraction();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /** Normalize a panel's position from right/bottom to explicit left/top/width/height */
  function _normalizePosition(el) {
    var rect = el.getBoundingClientRect();
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  /** Add 4 edge + 4 corner resize zones to a panel. minW/minH set minimums. */
  function makeResizable(el, minW, minH) {
    minW = minW || 200; minH = minH || 120;
    var edges = ['n','s','e','w','ne','nw','se','sw'];
    var cursors = { n:'ns-resize', s:'ns-resize', e:'ew-resize', w:'ew-resize',
                    ne:'nesw-resize', nw:'nwse-resize', se:'nwse-resize', sw:'nesw-resize' };
    edges.forEach(function(dir) {
      var zone = createEl('div', 'dc-edge dc-edge-' + dir);
      zone.style.cursor = cursors[dir];
      el.appendChild(zone);
      zone.addEventListener('mousedown', function(e) {
        e.preventDefault(); e.stopPropagation();
        // Normalize to left/top before starting so there's no jump
        _normalizePosition(el);
        var startX = e.clientX, startY = e.clientY;
        var startW = parseFloat(el.style.width), startH = parseFloat(el.style.height);
        var startL = parseFloat(el.style.left), startT = parseFloat(el.style.top);
        _startInteraction(cursors[dir]);
        var onMove = function(e) {
          var dx = e.clientX - startX, dy = e.clientY - startY;
          var newW = startW, newH = startH, newL = startL, newT = startT;
          if (dir.includes('e')) newW = Math.max(minW, startW + dx);
          if (dir.includes('w')) { newW = Math.max(minW, startW - dx); newL = startL + (startW - newW); }
          if (dir.includes('s')) newH = Math.max(minH, startH + dy);
          if (dir.includes('n')) { newH = Math.max(minH, startH - dy); newT = startT + (startH - newH); }
          el.style.width = newW + 'px'; el.style.height = newH + 'px';
          el.style.left = newL + 'px'; el.style.top = newT + 'px';
        };
        var onUp = function() {
          _endInteraction();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  /** Lightweight sanitizer for AI-generated design HTML.
   *  Strips scripts, iframes, and event handler attributes while preserving
   *  styles, layout, and images for design preview. Defense-in-depth measure. */
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

  /** Set sanitized AI-generated HTML on a design preview element.
   *  This is intentional — the preview panel is a developer tool where
   *  the AI renders design mockups. Sanitized as defense-in-depth. */
  function setTrustedPreviewHTML(el, html) {
    el.innerHTML = sanitizeDesignHTML(html); // eslint-disable-line no-unsanitized/property
  }

  // ==================== IFRAME HELPERS ====================
  function getIframe() {
    // Multi-tab: use the tab manager's active frame if available
    if (window.__dcTabs && window.__dcTabs.getActiveFrameName) {
      return document.getElementById(window.__dcTabs.getActiveFrameName());
    }
    // Fallback for single-frame mode
    return document.getElementById('dc-frame');
  }

  // Cache iframe origin when we receive messages from it (for targeted postMessage)
  var _iframeOrigin = null;
  // Queue messages until iframe origin is known (prevents wildcard postMessage)
  var _iframeMessageQueue = [];

  function postToIframe(type, data) {
    const iframe = getIframe();
    const target = (iframe && iframe.contentWindow) ? iframe.contentWindow : window;
    const msg = Object.assign({ type: type }, data || {});
    if (_iframeOrigin) {
      target.postMessage(msg, _iframeOrigin);
    } else if (target === window) {
      // Self-message (no iframe) — safe to use own origin
      target.postMessage(msg, location.origin || '*');
    } else {
      // Queue until we learn the iframe origin from an incoming message
      _iframeMessageQueue.push({ target: target, msg: msg });
    }
  }

  function _flushIframeQueue() {
    if (!_iframeOrigin) return;
    for (var i = 0; i < _iframeMessageQueue.length; i++) {
      _iframeMessageQueue[i].target.postMessage(_iframeMessageQueue[i].msg, _iframeOrigin);
    }
    _iframeMessageQueue = [];
  }

  // ==================== STATE ====================
  // Element key for deduplication: "tag#id.cls1.cls2"
  function elementKey(info) {
    var key = info.tag || '?';
    if (info.id) key += '#' + info.id;
    if (info.classes && info.classes.length) key += '.' + info.classes.slice(0, 3).join('.');
    return key;
  }

  const state = window.__dc = {
    messages: [],
    lastReadIndex: 0,
    cancelRequested: false,
    clickMode: false,
    selectedElements: [],       // Derived from modifiedElements when needed
    modifiedElements: {},       // Key → { element, dragDelta, styles }
    sentSelectionKeys: {},      // Keys already delivered with a chat message — not re-attached
    _currentElementKey: null,   // Key of currently inspected element
    _tabId: TAB_ID,
    api: null
  };

  // ==================== PERSISTENCE ====================
  // Extension mode: chat history is owned by the service worker (single source
  // of truth) and pushed via api.hydrate — per-tab sessionStorage copies are
  // what caused cross-tab inconsistency, so persistence is disabled there
  const IS_EXTENSION = !!(window.name && window.name.startsWith('dc-frame-extension'));

  function persistMessages() {
    if (IS_EXTENSION) return;
    try {
      const data = state.messages.map(m => ({
        text: m.imageData ? (m.text || '\ud83d\udcf8 Captured frame') : m.text,
        type: m.type,
        time: m.time,
        ...(m.source ? { source: m.source } : {})
        // imageData intentionally omitted — too large for storage
      }));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }

  function loadPersistedMessages() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  // ==================== BUILD UI ====================

  // ---- Chat Window ----
  const chat = createEl('div', 'dc-reset dc-chat');

  const chatHeader = createEl('div', 'dc-header');
  const chatTitle = createEl('span', 'dc-header-title');
  chatTitle.textContent = 'Collab';
  const chatActions = createEl('div', 'dc-header-actions');

  const clickToggle = createEl('button', 'dc-btn dc-click-toggle');
  clickToggle.title = 'Click capture (select elements)';
  clickToggle.textContent = '\u2295'; // target

  const inspectorToggle = createEl('button', 'dc-btn dc-inspector-toggle');
  inspectorToggle.title = 'Toggle inspector panel';
  inspectorToggle.textContent = '\u2630'; // ☰ hamburger/panel icon

  const sendSelectionsBtn = createEl('button', 'dc-btn dc-send-selections');
  sendSelectionsBtn.title = 'Send selections to AI';
  sendSelectionsBtn.textContent = '\u2191'; // up arrow
  sendSelectionsBtn.style.display = 'none'; // hidden until there are selections

  const undoBtn = createEl('button', 'dc-btn dc-undo-btn dc-disabled');
  undoBtn.title = 'Undo';
  undoBtn.textContent = '\u21B6'; // ↶

  const redoBtn = createEl('button', 'dc-btn dc-redo-btn dc-disabled');
  redoBtn.title = 'Redo';
  redoBtn.textContent = '\u21B7'; // ↷

  const rulerToggle = createEl('button', 'dc-btn dc-ruler-toggle');
  rulerToggle.title = 'Ruler overlay (pixel measurements)';
  rulerToggle.textContent = '\u25F0'; // white square with upper left quadrant

  // Responsive resize button with dropdown
  const responsiveBtn = createEl('button', 'dc-btn dc-responsive-toggle');
  responsiveBtn.title = 'Responsive resize';
  responsiveBtn.textContent = '\u25A3'; // ▣ square with inner square (device icon)
  const responsiveDropdown = createEl('div', 'dc-responsive-dropdown');
  responsiveDropdown.style.display = 'none';
  const RESPONSIVE_PRESETS = [
    { label: 'Mobile', icon: '\u25AF', w: 390, h: 844 },
    { label: 'Tablet', icon: '\u25AD', w: 768, h: 1024 },
    { label: 'Desktop', icon: '\u25A1', w: 1280, h: 800 },
    { label: 'Wide', icon: '\u25A3', w: 1440, h: 900 },
    { label: 'Reset', icon: '\u21ba', w: 0, h: 0 },
  ];
  let responsiveOverlay = null; // current responsive iframe overlay

  function showResponsivePreview(w, h, label) {
    // Remove previous overlay
    removeResponsivePreview();

    const currentUrl = window.location.href;

    // Create fullscreen backdrop
    const backdrop = createEl('div', 'dc-responsive-backdrop');
    backdrop.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:2147483640;display:flex;flex-direction:column;align-items:center;justify-content:center;';

    // Label bar
    const labelBar = createEl('div', 'dc-responsive-label');
    labelBar.style.cssText = 'color:rgba(200,200,210,0.6);font:600 13px -apple-system,system-ui,sans-serif;margin-bottom:12px;display:flex;align-items:center;gap:12px;';
    labelBar.textContent = label + ' \u2014 ' + w + '\u00d7' + h;
    const closeBtn = createEl('button', 'dc-responsive-close');
    closeBtn.textContent = '\u2715 Close';
    closeBtn.style.cssText = 'all:unset;padding:4px 12px;background:rgba(255,255,255,0.1);color:#e0e0e0;border-radius:6px;cursor:pointer;font-size:12px;';
    closeBtn.addEventListener('click', removeResponsivePreview);
    labelBar.appendChild(closeBtn);

    // Iframe at exact target dimensions
    const frame = document.createElement('iframe');
    frame.src = currentUrl;
    frame.style.cssText = 'width:' + w + 'px;height:' + h + 'px;border:1px solid rgba(99,102,241,0.4);border-radius:8px;background:#fff;box-shadow:0 0 60px rgba(0,0,0,0.5);';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');

    backdrop.appendChild(labelBar);
    backdrop.appendChild(frame);
    document.body.appendChild(backdrop);
    responsiveOverlay = backdrop;
  }

  function removeResponsivePreview() {
    if (responsiveOverlay) {
      responsiveOverlay.remove();
      responsiveOverlay = null;
    }
  }

  RESPONSIVE_PRESETS.forEach(preset => {
    const item = createEl('div', 'dc-responsive-item');
    item.textContent = preset.icon + ' ' + preset.label + (preset.w ? ' (' + preset.w + '\u00d7' + preset.h + ')' : '');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      responsiveDropdown.style.display = 'none';
      responsiveBtn.classList.remove('dc-active');
      if (preset.w > 0) {
        showResponsivePreview(preset.w, preset.h, preset.label);
        addMessage('Responsive preview: ' + preset.label + ' (' + preset.w + '\u00d7' + preset.h + ')', 'system');
      } else {
        removeResponsivePreview();
        addMessage('Responsive preview closed', 'system');
      }
    });
    responsiveDropdown.appendChild(item);
  });
  responsiveBtn.addEventListener('click', () => {
    const isOpen = responsiveDropdown.style.display !== 'none';
    responsiveDropdown.style.display = isOpen ? 'none' : 'block';
    responsiveBtn.classList.toggle('dc-active', !isOpen);
  });
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!responsiveBtn.contains(e.target) && !responsiveDropdown.contains(e.target)) {
      responsiveDropdown.style.display = 'none';
      responsiveBtn.classList.remove('dc-active');
    }
  });

  const captureBtn = createEl('button', 'dc-btn dc-capture');
  captureBtn.title = 'Screenshot selected element';
  captureBtn.textContent = '\u25CE'; // ◎ bullseye/lens

  // Follow-tabs toggle (extension mode only)
  const followTabsBtn = createEl('button', 'dc-btn dc-follow-tabs');
  followTabsBtn.title = 'Follow tabs — widget follows you across tabs';
  followTabsBtn.textContent = '\u21C4'; // ⇄ arrows
  followTabsBtn.style.display = 'none'; // shown only in extension mode
  if (window.name && window.name.startsWith('dc-frame-extension')) {
    followTabsBtn.style.display = '';
    // Load initial state
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'get-state' }, function(resp) {
          if (resp && resp.followTabs) {
            followTabsBtn.classList.add('dc-active');
            followTabsBtn.title = 'Follow tabs: ON';
          }
        });
      } catch(e) {}
    }
  }
  followTabsBtn.onclick = function() {
    // Toggle via relay to content script → service worker
    window.postMessage({ __dcRelay: true, action: 'toggle-follow' }, window.location.origin !== 'null' ? window.location.origin : '*');
    var isActive = followTabsBtn.classList.toggle('dc-active');
    followTabsBtn.title = isActive ? 'Follow tabs: ON' : 'Follow tabs: OFF';
    addMessage(isActive ? 'Follow tabs ON — widget will appear on any tab you switch to.' : 'Follow tabs OFF — widget stays on this tab only.', 'system');
  };

  const minBtn = createEl('button', 'dc-btn dc-minimize');
  minBtn.title = 'Minimize';
  minBtn.textContent = '\u2014'; // em dash

  chatActions.appendChild(clickToggle);
  chatActions.appendChild(inspectorToggle);
  chatActions.appendChild(sendSelectionsBtn);
  chatActions.appendChild(undoBtn);
  chatActions.appendChild(redoBtn);
  chatActions.appendChild(rulerToggle);
  chatActions.appendChild(responsiveBtn);
  chatActions.appendChild(captureBtn);  // 📷 in header
  chatActions.appendChild(followTabsBtn);
  chatActions.appendChild(minBtn);
  chatHeader.appendChild(chatTitle);
  chatHeader.appendChild(chatActions);

  // ---- Status Console (floats above chat window for system messages) ----
  const statusConsole = createEl('div', 'dc-status-console');

  function showStatus(text) {
    statusConsole.textContent = text;
    positionStatusConsole();
    statusConsole.classList.add('dc-status-visible');
  }

  function hideStatus() {
    statusConsole.classList.remove('dc-status-visible');
  }

  const msgContainer = createEl('div', 'dc-messages');

  // Attachment state (pending screenshot)
  let pendingAttachment = null; // { imageData, mimeType }

  const attachmentBar = createEl('div', 'dc-attachment-bar');
  attachmentBar.style.display = 'none';
  const attachThumb = createEl('img', 'dc-attach-thumb');
  const attachRemove = createEl('button', 'dc-attach-remove');
  attachRemove.textContent = '\u2715';
  attachRemove.title = 'Remove attachment';
  attachRemove.addEventListener('click', () => {
    pendingAttachment = null;
    attachmentBar.style.display = 'none';
  });
  attachmentBar.appendChild(attachThumb);
  attachmentBar.appendChild(attachRemove);

  const inputArea = createEl('div', 'dc-input-area');
  const input = createEl('textarea', 'dc-input');
  input.placeholder = 'Type here...';
  input.rows = 1;
  // Restore draft input text after page reload
  try { const draft = sessionStorage.getItem(INPUT_KEY); if (draft) input.value = draft; } catch {}
  // Persist input text on every keystroke
  input.addEventListener('input', () => {
    try { sessionStorage.setItem(INPUT_KEY, input.value); } catch {}
  });
  const sendBtn = createEl('button', 'dc-send');
  sendBtn.textContent = 'Send';
  inputArea.appendChild(attachmentBar);
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);

  // Resize handles (old single handle removed — now using edge+corner zones)

  // ---- Thinking indicator ----
  const thinking = createEl('div', 'dc-thinking');
  const thinkingDots = createEl('div', 'dc-thinking-dots');
  for (let i = 0; i < 3; i++) thinkingDots.appendChild(createEl('span', 'dc-dot'));
  thinking.appendChild(thinkingDots);

  chat.appendChild(chatHeader);
  chat.appendChild(responsiveDropdown);
  chat.appendChild(msgContainer);
  chat.appendChild(inputArea);
  document.body.appendChild(chat);
  document.body.appendChild(statusConsole);
  makeDraggable(chat, chatHeader, positionStatusConsole);
  makeResizable(chat, 280, 200);

  // Position status console above the chat window (called on demand, no observer)
  function positionStatusConsole() {
    const chatRect = chat.getBoundingClientRect();
    statusConsole.style.right = (window.innerWidth - chatRect.right) + 'px';
    statusConsole.style.bottom = (window.innerHeight - chatRect.top + 6) + 'px';
    statusConsole.style.maxWidth = chatRect.width + 'px';
  }

  // Reposition status console when chat resizes
  new ResizeObserver(positionStatusConsole).observe(chat);

  // ---- Preview Panel ----
  const preview = createEl('div', 'dc-reset dc-preview dc-hidden');

  const prevHeader = createEl('div', 'dc-header');
  const prevTitle = createEl('span', 'dc-header-title');
  prevTitle.textContent = 'Preview';
  const prevActions = createEl('div', 'dc-header-actions');
  const prevMinBtn = createEl('button', 'dc-btn dc-preview-min');
  prevMinBtn.title = 'Minimize';
  prevMinBtn.textContent = '\u2014';
  const prevCloseBtn = createEl('button', 'dc-btn dc-preview-close');
  prevCloseBtn.title = 'Close';
  prevCloseBtn.textContent = '\u2715';
  prevCloseBtn.addEventListener('click', () => { preview.classList.add('dc-hidden'); postToIframe('dc-clear-overlays'); try { sessionStorage.removeItem(PREVIEW_KEY); } catch {} });
  prevActions.appendChild(prevMinBtn);
  prevActions.appendChild(prevCloseBtn);
  prevHeader.appendChild(prevTitle);
  prevHeader.appendChild(prevActions);

  const previewContent = createEl('div', 'dc-preview-content');

  preview.appendChild(prevHeader);
  preview.appendChild(previewContent);
  document.body.appendChild(preview);
  makeDraggable(preview, prevHeader);
  makeResizable(preview, 200, 120);

  // Detect page theme so the widget matches on first render
  // Tries background color detection, falls back to prefers-color-scheme, retries after delay
  function applyDetectedTheme() {
    try {
      var els = [document.body, document.documentElement];
      for (var i = 0; i < els.length; i++) {
        if (!els[i]) continue;
        var bg = getComputedStyle(els[i]).backgroundColor;
        var m = bg.match(/\d+/g);
        if (m && m.length >= 3) {
          var a = m.length >= 4 ? parseFloat(m[3]) : 1;
          if (a < 0.1) continue;
          var lum = (0.299 * parseInt(m[0]) + 0.587 * parseInt(m[1]) + 0.114 * parseInt(m[2])) / 255;
          var useLight = lum >= 0.5;
          chat.classList.toggle('dc-light', useLight);
          preview.classList.toggle('dc-light', useLight);
          statusConsole.classList.toggle('dc-status-light', useLight);
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  // In tabs/extension mode, the wrapper bg is misleading — rely on iframe-bridge for theme.
  // In single mode (no iframe), detect from the page directly.
  var hasIframeBridge = window.__dcTabs || (window.name && window.name.startsWith('dc-frame-'));
  if (hasIframeBridge) {
    // Use prefers-color-scheme as a sane default until iframe-bridge reports real theme
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      chat.classList.add('dc-light');
      preview.classList.add('dc-light');
      statusConsole.classList.add('dc-status-light');
    }
  } else {
    // Single mode — detect from page background
    if (!applyDetectedTheme()) {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        chat.classList.add('dc-light');
        preview.classList.add('dc-light');
        statusConsole.classList.add('dc-status-light');
      }
      setTimeout(applyDetectedTheme, 500);
      setTimeout(applyDetectedTheme, 1500);
    }
  }

  // Prevent link navigation inside preview panel (options thumbnails contain <a> tags)
  previewContent.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (link) { e.preventDefault(); e.stopPropagation(); }

    // Delegated click handler for audit issue rows with data-selector
    const issueEl = e.target.closest('[data-selector]');
    if (issueEl) {
      postToIframe('dc-scroll-to', { selector: issueEl.dataset.selector });
    }
  });

  // ==================== PANEL FACTORY ====================
  /** Create a reusable draggable panel. Returns { panel, content, show, hide, toggle, setHTML }. */
  function createPanel(id, title, opts) {
    opts = opts || {};
    const p = createEl('div', 'dc-reset dc-preview dc-hidden');
    p.id = 'dc-panel-' + id;
    if (opts.width) p.style.width = opts.width;

    const hdr = createEl('div', 'dc-header');
    const titleEl = createEl('span', 'dc-header-title');
    titleEl.textContent = title;
    const actions = createEl('div', 'dc-header-actions');
    const minBtn = createEl('button', 'dc-btn dc-preview-min');
    minBtn.title = 'Minimize';
    minBtn.textContent = '\u2014';
    const clsBtn = createEl('button', 'dc-btn dc-preview-close');
    clsBtn.title = 'Close';
    clsBtn.textContent = '\u2715';
    clsBtn.addEventListener('click', () => { p.classList.add('dc-hidden'); postToIframe('dc-clear-overlays'); });
    actions.appendChild(minBtn);
    actions.appendChild(clsBtn);
    hdr.appendChild(titleEl);
    hdr.appendChild(actions);

    const content = createEl('div', 'dc-preview-content');
    p.appendChild(hdr);
    p.appendChild(content);
    document.body.appendChild(p);
    makeDraggable(p, hdr);
    makeResizable(p, 200, 120);

    minBtn.addEventListener('click', () => {
      p.classList.toggle('dc-minimized');
      minBtn.textContent = p.classList.contains('dc-minimized') ? '+' : '\u2014';
    });

    return {
      panel: p,
      content: content,
      show() { p.classList.remove('dc-hidden', 'dc-minimized'); minBtn.textContent = '\u2014'; },
      hide() { p.classList.add('dc-hidden'); },
      toggle() { p.classList.toggle('dc-hidden'); },
      setHTML(html) { setTrustedPreviewHTML(content, html); this.show(); },
    };
  }

  // ==================== STYLES ====================
  const styleEl = document.createElement('style');
  styleEl.id = 'dc-styles';
  styleEl.textContent = `
    .dc-reset {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      color: rgba(210,210,220,0.85);
      box-sizing: border-box;
    }
    .dc-reset *, .dc-reset *::before, .dc-reset *::after {
      box-sizing: border-box;
    }
    .dc-chat {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 340px;
      height: 440px;
      background: rgba(14,14,22,0.95);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border: 1px solid rgba(180,180,200,0.08);
      border-radius: 14px;
      display: flex;
      flex-direction: column;
      z-index: 2147483647;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05);
      overflow: hidden;
      direction: ltr;
      text-align: left;
    }
    .dc-chat.dc-minimized {
      height: 44px !important;
    }
    .dc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: linear-gradient(135deg, rgba(140,130,180,0.04), rgba(120,170,180,0.03));
      cursor: move;
      user-select: none;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(180,180,200,0.07);
    }
    .dc-header-title {
      font-weight: 600;
      font-size: 13px;
      background: linear-gradient(135deg, #b0a8c8, #90b8c0);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: 0.4px;
    }
    .dc-header-actions { display: flex; gap: 3px; flex-shrink: 0; }
    .dc-btn {
      all: unset;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      color: rgba(200,200,210,0.28);
      transition: background 0.15s, color 0.15s;
    }
    .dc-btn:hover { background: rgba(180,180,200,0.1); color: rgba(220,220,230,0.55); }
    .dc-btn.dc-active { background: rgba(140,130,180,0.18); color: rgba(180,175,210,0.7); }
    .dc-send-selections.dc-active { animation: dc-pulse 1.5s ease-in-out infinite; }
    @keyframes dc-pulse { 0%,100% { background: rgba(140,130,180,0.18); } 50% { background: rgba(140,130,180,0.35); } }
    .dc-btn.dc-disabled { opacity: 0.3; cursor: default; pointer-events: none; }
    .dc-status-console {
      position: fixed;
      right: 20px;
      bottom: 470px;
      max-width: 340px;
      padding: 0;
      margin: 0;
      max-height: 0;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      color: rgba(200,180,100,0.8);
      background: rgba(14,14,22,0.95);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border: 1px solid transparent;
      border-radius: 10px;
      z-index: 2147483647;
      box-shadow: none;
      transition: max-height 0.2s ease, padding 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease;
      opacity: 0;
      pointer-events: none;
      box-sizing: border-box;
    }
    .dc-status-console.dc-status-visible {
      max-height: 120px;
      padding: 8px 12px;
      opacity: 1;
      pointer-events: none;
      border-color: rgba(200,180,100,0.15);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    .dc-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .dc-chat.dc-minimized .dc-messages,
    .dc-chat.dc-minimized .dc-input-area,
    .dc-chat.dc-minimized .dc-edge { display: none; }
    .dc-msg {
      padding: 9px 13px;
      border-radius: 12px;
      font-size: 13px;
      max-width: 85%;
      word-wrap: break-word;
      line-height: 1.5;
      position: relative;
    }
    .dc-msg-ai {
      background: rgba(180,180,200,0.06);
      color: rgba(210,210,220,0.78);
      align-self: flex-start;
      border-bottom-left-radius: 3px;
    }
    .dc-msg-user {
      background: rgba(120,115,170,0.45);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgba(255,255,255,0.92);
      align-self: flex-end;
      border-bottom-right-radius: 3px;
    }
    .dc-msg-system {
      background: rgba(200,180,100,0.08);
      color: rgba(200,180,100,0.7);
      align-self: center;
      font-size: 11px;
      text-align: center;
      padding: 5px 14px;
      border-radius: 20px;
    }
    .dc-msg-time {
      font-size: 10px;
      opacity: 0.4;
      margin-top: 3px;
      display: block;
    }
    .dc-msg-user .dc-msg-time { text-align: right; }
    .dc-msg-system .dc-msg-time { display: none; }
    .dc-msg-cancel {
      position: absolute;
      top: 4px;
      left: -22px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(239,68,68,0.8);
      color: #fff;
      font-size: 11px;
      line-height: 18px;
      text-align: center;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      user-select: none;
    }
    .dc-msg-user:hover .dc-msg-cancel { opacity: 0.8; }
    .dc-msg-cancel:hover { opacity: 1 !important; transform: scale(1.15); }
    .dc-cancel-fired { opacity: 1 !important; background: rgba(153,27,27,0.9); }
    .dc-msg-user { position: relative; }
    .dc-input-area {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid rgba(180,180,200,0.07);
      flex-shrink: 0;
      background: rgba(180,180,200,0.02);
    }
    .dc-input {
      all: unset;
      flex: 1;
      padding: 8px 12px;
      background: rgba(180,180,200,0.06);
      border: 1px solid rgba(180,180,200,0.08);
      border-radius: 10px;
      color: rgba(210,210,220,0.85);
      font-size: 13px;
      font-family: inherit;
      resize: none;
      overflow-y: auto;
      max-height: 120px;
      min-height: 34px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .dc-input:focus { border-color: rgba(140,130,180,0.25); }
    .dc-input::placeholder { color: rgba(180,180,200,0.2); }
    .dc-send {
      all: unset;
      padding: 8px 16px;
      background: rgba(120,115,170,0.5);
      color: rgba(255,255,255,0.9);
      border-radius: 10px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .dc-send:hover { background: rgba(120,115,170,0.65); }
    .dc-capture { flex-shrink: 0; }
    .dc-attachment-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 0;
      width: 100%;
    }
    .dc-attach-thumb {
      max-width: 80px;
      max-height: 50px;
      border-radius: 6px;
      border: 1px solid rgba(180,180,200,0.1);
    }
    .dc-attach-remove {
      all: unset;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      cursor: pointer;
      font-size: 12px;
      color: rgba(200,200,210,0.4);
      background: rgba(180,180,200,0.06);
    }
    .dc-attach-remove:hover { background: rgba(220,38,38,0.25); color: rgba(248,113,113,0.9); }
    .dc-msg-img { max-width: 100%; border-radius: 6px; display: block; margin-bottom: 4px; }
    /* Interaction overlay — captures all mouse events during drag/resize */
    .dc-interaction-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 2147483646;
    }
    /* Edge + corner resize zones */
    .dc-edge { position: absolute; z-index: 2; }
    .dc-edge-n { top: -3px; left: 6px; right: 6px; height: 6px; }
    .dc-edge-s { bottom: -3px; left: 6px; right: 6px; height: 6px; }
    .dc-edge-e { right: -3px; top: 6px; bottom: 6px; width: 6px; }
    .dc-edge-w { left: -3px; top: 6px; bottom: 6px; width: 6px; }
    .dc-edge-nw { top: -4px; left: -4px; width: 10px; height: 10px; }
    .dc-edge-ne { top: -4px; right: -4px; width: 10px; height: 10px; }
    .dc-edge-sw { bottom: -4px; left: -4px; width: 10px; height: 10px; }
    .dc-edge-se { bottom: -4px; right: -4px; width: 10px; height: 10px; }
    .dc-preview {
      position: fixed;
      bottom: 20px;
      left: 20px;
      width: 380px;
      height: 340px;
      background: rgba(14,14,22,0.95);
      backdrop-filter: blur(28px);
      -webkit-backdrop-filter: blur(28px);
      border: 1px solid rgba(180,180,200,0.08);
      border-radius: 14px;
      display: flex;
      flex-direction: column;
      z-index: 2147483646;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05);
      direction: ltr;
      text-align: left;
      overflow: hidden;
    }
    .dc-preview.dc-minimized { height: 44px !important; }
    .dc-preview.dc-minimized .dc-edge { display: none; }
    .dc-preview.dc-hidden { display: none; }
    .dc-preview-content {
      flex: 1;
      overflow: auto;
      background: transparent;
      border-radius: 0 0 14px 14px;
    }
    .dc-preview.dc-minimized .dc-preview-content { display: none; }
    .dc-messages::-webkit-scrollbar,
    .dc-preview-content::-webkit-scrollbar { width: 5px; }
    .dc-messages::-webkit-scrollbar-track,
    .dc-preview-content::-webkit-scrollbar-track { background: transparent; }
    .dc-messages::-webkit-scrollbar-thumb,
    .dc-preview-content::-webkit-scrollbar-thumb { background: rgba(180,180,200,0.15); border-radius: 3px; }

    /* ---- Thinking indicator ---- */
    .dc-thinking {
      align-self: flex-start;
      padding: 10px 16px;
      background: rgba(180,180,200,0.06);
      border-radius: 12px;
      border-bottom-left-radius: 3px;
      display: none;
      max-width: 85%;
    }
    .dc-thinking.dc-visible { display: block; }
    .dc-thinking-dots { display: flex; gap: 5px; align-items: center; height: 18px; }
    .dc-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgba(180,175,210,0.5);
      opacity: 0.4;
      animation: dc-think 1.4s ease-in-out infinite;
    }
    .dc-dot:nth-child(2) { animation-delay: 0.2s; }
    .dc-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes dc-think {
      0%, 80%, 100% { opacity: 0.4; transform: scale(1); }
      40% { opacity: 1; transform: scale(1.2); }
    }

    /* ---- Light theme (glass light — frosted white) ---- */
    .dc-chat.dc-light { background: rgba(255,255,255,0.95); backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px); border-color: rgba(180,180,200,0.18); color: #333; box-shadow: 0 8px 32px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.5); }
    .dc-chat.dc-light .dc-header { background: linear-gradient(135deg, rgba(140,130,180,0.06), rgba(120,170,180,0.04)); border-bottom-color: rgba(180,180,200,0.12); }
    .dc-chat.dc-light .dc-header-title { background: linear-gradient(135deg, #6860a0, #508898); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .dc-chat.dc-light .dc-btn { color: rgba(100,100,120,0.4); }
    .dc-chat.dc-light .dc-btn:hover { background: rgba(100,100,120,0.08); color: rgba(80,80,100,0.6); }
    .dc-chat.dc-light .dc-btn.dc-active { background: rgba(120,115,170,0.12); color: rgba(100,95,150,0.7); }
    .dc-chat.dc-light .dc-msg-ai { background: rgba(230,228,240,0.5); color: #444; }
    .dc-chat.dc-light .dc-msg-user { background: rgba(120,115,170,0.55); backdrop-filter: blur(8px); color: #fff; }
    .dc-status-console.dc-status-light { color: rgba(160,140,50,0.8); background: rgba(255,255,255,0.7); backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px); border-color: rgba(200,180,100,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    .dc-chat.dc-light .dc-msg-system { background: rgba(200,180,100,0.08); color: rgba(160,140,50,0.7); }
    .dc-chat.dc-light .dc-input-area { background: rgba(240,240,248,0.3); border-top-color: rgba(180,180,200,0.12); }
    .dc-chat.dc-light .dc-input { background: rgba(255,255,255,0.5); border-color: rgba(180,180,200,0.15); color: #333; }
    .dc-chat.dc-light .dc-input::placeholder { color: rgba(100,100,120,0.35); }
    .dc-chat.dc-light .dc-input:focus { border-color: rgba(120,115,170,0.3); }
    .dc-chat.dc-light .dc-send { background: rgba(120,115,170,0.5); }
    .dc-chat.dc-light .dc-send:hover { background: rgba(120,115,170,0.65); }
    .dc-chat.dc-light .dc-thinking { background: rgba(230,228,240,0.5); }
    .dc-chat.dc-light .dc-dot { background: rgba(100,95,150,0.5); }
    .dc-chat.dc-light .dc-capture { color: rgba(100,100,120,0.35); }
    .dc-chat.dc-light .dc-capture:hover { background: rgba(100,100,120,0.08); color: rgba(80,80,100,0.55); }

    /* Responsive resize dropdown */
    .dc-responsive-dropdown {
      background: rgba(14,14,22,0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(180,180,200,0.07);
      padding: 4px 0;
      flex-shrink: 0;
    }
    .dc-responsive-item {
      padding: 8px 14px;
      font-size: 12px;
      color: rgba(200,200,210,0.6);
      cursor: pointer;
      transition: background 0.1s;
    }
    .dc-responsive-item:hover { background: rgba(140,130,180,0.12); color: rgba(220,220,230,0.8); }
    .dc-capture-dropdown {
      background: rgba(14,14,22,0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(180,180,200,0.07);
      padding: 4px 0;
      flex-shrink: 0;
    }
    .dc-capture-item {
      padding: 8px 14px;
      font-size: 12px;
      color: rgba(200,200,210,0.6);
      cursor: pointer;
      transition: background 0.1s;
    }
    .dc-capture-item:hover { background: rgba(140,130,180,0.12); color: rgba(220,220,230,0.8); }
    .dc-chat.dc-light .dc-responsive-dropdown { background: rgba(255,255,255,0.5); border-bottom-color: rgba(180,180,200,0.12); }
    .dc-chat.dc-light .dc-responsive-item { color: rgba(80,80,100,0.6); }
    .dc-chat.dc-light .dc-responsive-item:hover { background: rgba(120,115,170,0.1); color: rgba(80,80,100,0.8); }
    .dc-chat.dc-light .dc-capture-dropdown { background: rgba(255,255,255,0.5); border-bottom-color: rgba(180,180,200,0.12); }
    .dc-chat.dc-light .dc-capture-item { color: rgba(80,80,100,0.6); }
    .dc-chat.dc-light .dc-capture-item:hover { background: rgba(120,115,170,0.1); color: rgba(80,80,100,0.8); }
    .dc-chat.dc-light .dc-attach-thumb { border-color: rgba(180,180,200,0.15); }
    .dc-chat.dc-light .dc-attach-remove { background: rgba(100,100,120,0.06); color: rgba(100,100,120,0.5); }
    .dc-chat.dc-light .dc-attach-remove:hover { background: rgba(220,38,38,0.12); color: rgba(220,38,38,0.8); }
    .dc-chat.dc-light .dc-messages::-webkit-scrollbar-thumb { background: rgba(180,180,200,0.2); }
    .dc-preview.dc-light { background: rgba(255,255,255,0.95); backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px); border-color: rgba(180,180,200,0.18); box-shadow: 0 8px 32px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.5); }
    .dc-preview.dc-light .dc-header { background: linear-gradient(135deg, rgba(140,130,180,0.06), rgba(120,170,180,0.04)); border-bottom-color: rgba(180,180,200,0.12); }
    .dc-preview.dc-light .dc-header-title { background: linear-gradient(135deg, #6860a0, #508898); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .dc-preview.dc-light .dc-btn { color: rgba(100,100,120,0.4); }
    .dc-preview.dc-light .dc-btn:hover { background: rgba(100,100,120,0.08); color: rgba(80,80,100,0.6); }
    .dc-preview.dc-light .dc-preview-content::-webkit-scrollbar-thumb { background: rgba(180,180,200,0.2); }
  `;
  document.head.appendChild(styleEl);

  // ==================== BEHAVIOR ====================

  // Minimize chat — normalize to top-anchored so header stays in place
  let _chatHeightBeforeMin = null;
  minBtn.addEventListener('click', () => {
    if (!chat.classList.contains('dc-minimized')) {
      _normalizePosition(chat);
      _chatHeightBeforeMin = chat.style.height;
    }
    const isMin = chat.classList.toggle('dc-minimized');
    if (!isMin && _chatHeightBeforeMin) {
      chat.style.height = _chatHeightBeforeMin;
    }
    minBtn.textContent = isMin ? '\u25A1' : '\u2014';
  });

  // Minimize preview — normalize to top-anchored so header stays in place
  let _prevHeightBeforeMin = null;
  prevMinBtn.addEventListener('click', () => {
    if (!preview.classList.contains('dc-minimized')) {
      _normalizePosition(preview);
      _prevHeightBeforeMin = preview.style.height;
    }
    const isMin = preview.classList.toggle('dc-minimized');
    if (!isMin && _prevHeightBeforeMin) {
      preview.style.height = _prevHeightBeforeMin;
    }
    prevMinBtn.textContent = isMin ? '\u25A1' : '\u2014';
  });

  // ---- Message handling ----
  function renderMsgEl(text, type, time, imageData, mimeType) {
    const m = createEl('div', 'dc-msg dc-msg-' + type);
    if (imageData) {
      const img = document.createElement('img');
      img.className = 'dc-msg-img';
      img.src = 'data:' + (mimeType || 'image/png') + ';base64,' + imageData;
      m.appendChild(img);
    }
    if (text) {
      const textEl = document.createTextNode(text);
      m.appendChild(textEl);
    }
    if (type !== 'system' && time) {
      const timeEl = createEl('span', 'dc-msg-time');
      timeEl.textContent = formatTime(time);
      m.appendChild(timeEl);
    }
    // Cancel button for user messages — sends a cancel event to stop Claude
    if (type === 'user') {
      const cancelBtn = createEl('span', 'dc-msg-cancel');
      cancelBtn.textContent = '\u2715';
      cancelBtn.title = 'Cancel — stop Claude after current step';
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelBtn.classList.add('dc-cancel-fired');
        cancelBtn.textContent = '\u2715';
        cancelBtn.title = 'Cancel sent';
        state.cancelRequested = true;
        addMessage('Cancel requested — stopping current action.', 'system');
        relayCancel().catch(() => {});
      });
      m.appendChild(cancelBtn);
    }
    return m;
  }

  function showThinking() {
    msgContainer.appendChild(thinking);
    thinking.classList.add('dc-visible');
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function hideThinking() {
    thinking.classList.remove('dc-visible');
    if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
  }

  state._syncing = false; // guard against infinite loops during cross-tab sync

  function addMessage(text, type, skipPersist, imageData, mimeType, source) {
    // AI or system response arrived — hide thinking and clear fired cancel buttons
    if (type === 'ai') {
      hideThinking();
      msgContainer.querySelectorAll('.dc-cancel-fired').forEach(el => el.remove());
    }

    // Route system messages to the status console instead of chat
    if (type === 'system') {
      showStatus(text);
      // Still store in messages array for persistence/export
      var msg = { text: text, type: type, time: Date.now() };
      state.messages.push(msg);
      if (!skipPersist) persistMessages();
      return msg;
    }

    var msg = { text: text, type: type, time: Date.now() };
    if (source) msg.source = source;
    if (imageData) { msg.imageData = imageData; msg.mimeType = mimeType || 'image/png'; }
    state.messages.push(msg);

    // Sync to service worker for cross-tab broadcast (skip if this message came FROM sync)
    if (!state._syncing && !skipPersist && (type === 'user' || type === 'ai')) {
      window.postMessage({
        __dcRelay: true, action: 'chat-sync',
        chatText: text, chatRole: type, chatTime: msg.time
      }, window.location.origin !== 'null' ? window.location.origin : '*');
    }

    // Cap messages array to prevent unbounded memory growth in long sessions
    if (state.messages.length > 1000) {
      state.messages = state.messages.slice(500);
      state.lastReadIndex = Math.max(0, state.lastReadIndex - 500);
    }

    var m = renderMsgEl(text, type, msg.time, imageData, mimeType);
    msgContainer.appendChild(m);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    if (type === 'ai' && chat.classList.contains('dc-minimized')) {
      chat.style.borderColor = 'rgba(180,175,210,0.4)';
      setTimeout(() => { chat.style.borderColor = ''; }, 2000);
    }


    if (!skipPersist) persistMessages();
    return msg;
  }

  function send() {
    const text = input.value.trim();
    if (!text && !pendingAttachment) return;
    const hadImage = !!(pendingAttachment && (pendingAttachment.imageData || pendingAttachment.captureRect));
    // Capture attachment data before pendingAttachment is cleared below — the
    // relay carries it to the server store (extension mode single source of truth)
    const relayImage = pendingAttachment && pendingAttachment.imageData ? pendingAttachment.imageData : null;
    const relayMime = pendingAttachment && pendingAttachment.mimeType ? pendingAttachment.mimeType : null;
    if (pendingAttachment) {
      if (pendingAttachment.captureRect) {
        // Rect-based capture — store rect in message for Playwright to fulfill
        const msg = { text: text || '', type: 'user', time: Date.now(), captureRect: pendingAttachment.captureRect };
        state.messages.push(msg);
        const el = renderMsgEl(text || '\ud83d\udcf7 [screenshot]', 'user', msg.time);
        msgContainer.appendChild(el);
        msgContainer.scrollTop = msgContainer.scrollHeight;
        persistMessages();
      } else {
        addMessage(text || '', 'user', false, pendingAttachment.imageData, pendingAttachment.mimeType);
      }
      broadcast({ text: text || '\ud83d\udcf7', type: 'user' });
      pendingAttachment = null;
      attachmentBar.style.display = 'none';
    } else {
      addMessage(text, 'user');
      broadcast({ text, type: 'user' });
    }
    // Relay message to Node.js via Playwright bridge (no HTTP, no mixed content issues)
    // Include any pending selections so Claude doesn't need a separate collab_selections call
    const msgText = (text || '\ud83d\udcf7') + (hadImage ? ' [IMAGE ATTACHED — use collab_inbox to retrieve it]' : '');
    // Attach only selections not yet delivered — each rides along once, then is
    // marked sent (re-modifying an element clears the mark). The buffer itself
    // stays intact so a follow-up collab_selections call still works.
    var selections = [];
    var mods = state.modifiedElements;
    var modKeys = Object.keys(mods).filter(function(k) { return !state.sentSelectionKeys[k]; });
    if (modKeys.length > 0) {
      selections = modKeys.map(function(k) {
        var entry = mods[k];
        var out = Object.assign({}, entry.element);
        if (entry.dragDelta) out.dragDelta = entry.dragDelta;
        if (Object.keys(entry.styles).length > 0) out.styleChanges = entry.styles;
        return out;
      });
      modKeys.forEach(function(k) { state.sentSelectionKeys[k] = true; });
    }
    relayMessage(msgText, selections.length > 0 ? selections : null, relayImage, relayMime).catch(function() {
      // No working relay channel — surface it instead of silently dropping
      addMessage('⚠ Message not delivered — Claude is not connected to this tab', 'system');
    });
    input.value = '';
    input.style.height = 'auto';
    try { sessionStorage.removeItem(INPUT_KEY); } catch {}
    showThinking();
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Auto-grow textarea — reset to 1-line min first, then measure
  input.addEventListener('input', () => {
    input.style.height = '34px';
    const needed = input.scrollHeight;
    input.style.height = Math.min(needed, 120) + 'px';
  });

  // Paste image from clipboard — sets pendingAttachment and shows preview
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        e.preventDefault();
        const blob = items[i].getAsFile();
        if (!blob) continue;
        const mimeType = blob.type || 'image/png';
        const reader = new FileReader();
        reader.onload = function() {
          const base64 = reader.result.split(',')[1];
          pendingAttachment = { imageData: base64, mimeType: mimeType };
          attachThumb.src = reader.result;
          attachmentBar.style.display = 'flex';
          input.focus();
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  });

  // ---- Screenshot dropdown ----
  const captureDropdown = createEl('div', 'dc-capture-dropdown');
  captureDropdown.style.display = 'none';

  const CAPTURE_OPTS = [
    { label: '\ud83d\uddbc Visible area', id: 'viewport' },
    { label: '\ud83d\udcc4 Full page (scroll)', id: 'fullpage' },
    { label: '\u2b1c Draw area', id: 'drawarea' },
    { label: '\ud83c\udfaf Selected element', id: 'element' },
  ];

  CAPTURE_OPTS.forEach(opt => {
    const item = createEl('div', 'dc-capture-item');
    item.textContent = opt.label;
    item.dataset.captureType = opt.id;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      captureDropdown.style.display = 'none';
      captureBtn.classList.remove('dc-active');

      if (opt.id === 'viewport') {
        addMessage('Capturing visible area...', 'system');
        relayScreenshot(JSON.stringify({})).then(base64 => {
            if (base64) showCapturePreview(null, { base64, mimeType: 'image/png' });
            else addMessage('Screenshot failed.', 'system');
          }).catch(() => addMessage('Screenshot failed.', 'system'));
      } else if (opt.id === 'fullpage') {
        addMessage('Capturing full page...', 'system');
        relayScreenshot(JSON.stringify({ fullPage: true })).then(base64 => {
            if (base64) showCapturePreview(null, { base64, mimeType: 'image/png' });
            else addMessage('Screenshot failed.', 'system');
          }).catch(() => addMessage('Screenshot failed.', 'system'));
      } else if (opt.id === 'element') {
        if (state._currentElementKey) {
          // Get element rect from bridge, then screenshot via Playwright
          postToIframe('dc-capture-request');
          addMessage('Capturing selected element...', 'system');
        } else {
          addMessage('No element selected — turn on click capture and select an element first.', 'system');
        }
      } else if (opt.id === 'drawarea') {
        postToIframe('dc-draw-capture-start');
        addMessage('Draw a rectangle on the page to capture.', 'system');
      }
    });
    captureDropdown.appendChild(item);
  });

  // Insert dropdown after header (same pattern as responsive dropdown)
  chat.insertBefore(captureDropdown, msgContainer);

  captureBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = captureDropdown.style.display !== 'none';
    captureDropdown.style.display = isOpen ? 'none' : 'block';
    captureBtn.classList.toggle('dc-active', !isOpen);
    // Close responsive dropdown if open
    responsiveDropdown.style.display = 'none';
    responsiveBtn.classList.remove('dc-active');
  });

  // Close capture dropdown when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!captureDropdown.contains(e.target) && e.target !== captureBtn) {
      captureDropdown.style.display = 'none';
      captureBtn.classList.remove('dc-active');
    }
  });

  // ---- Screenshot preview overlay ----
  function handleCaptureResult(data) {
    if (data.captureRect) {
      showCapturePreview(data.captureRect, null);
    } else if (data.imageData) {
      showCapturePreview(null, { base64: data.imageData, mimeType: data.mimeType || 'image/png' });
    } else {
      addMessage('\ud83d\udcf7 ' + (data.error || 'Capture failed'), 'system');
    }
  }

  function showCapturePreview(captureRect, directImage) {
    // For rect-based captures, take the screenshot FIRST (before overlay is visible)
    // then show the overlay with the result
    if (captureRect && !directImage) {
      relayScreenshot(JSON.stringify(captureRect)).then(base64 => {
        if (base64) {
          showCaptureOverlay({ base64: base64, mimeType: 'image/png' });
        } else {
          addMessage('Screenshot failed — could not capture.', 'system');
        }
      }).catch(() => {
        addMessage('Screenshot failed — bridge error.', 'system');
      });
      return;
    }
    // Direct image or fallback — show overlay immediately
    showCaptureOverlay(directImage);
  }

  function showCaptureOverlay(directImage) {
    // Create overlay
    const overlay = createEl('div', 'dc-capture-overlay');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;';

    const previewImg = document.createElement('img');
    previewImg.style.cssText = 'max-width:80vw;max-height:65vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);border:2px solid rgba(255,255,255,0.1);';

    const btnRow = createEl('div', 'dc-capture-btns');
    btnRow.style.cssText = 'display:flex;gap:12px;margin-top:16px;';

    const sendBtn2 = createEl('button', 'dc-capture-send');
    sendBtn2.textContent = '\u2713 Send';
    sendBtn2.style.cssText = 'all:unset;padding:10px 28px;background:rgba(120,115,170,0.5);color:rgba(255,255,255,0.9);border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;transition:background 0.15s;';
    sendBtn2.addEventListener('mouseover', () => { sendBtn2.style.background = 'rgba(120,115,170,0.65)'; });
    sendBtn2.addEventListener('mouseout', () => { sendBtn2.style.background = 'rgba(120,115,170,0.5)'; });

    const discardBtn = createEl('button', 'dc-capture-discard');
    discardBtn.textContent = '\u2715 Discard';
    discardBtn.style.cssText = 'all:unset;padding:10px 28px;background:rgba(255,255,255,0.1);color:#ccc;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;border:1px solid rgba(255,255,255,0.15);transition:background 0.15s;';
    discardBtn.addEventListener('mouseover', () => { discardBtn.style.background = 'rgba(255,255,255,0.2)'; });
    discardBtn.addEventListener('mouseout', () => { discardBtn.style.background = 'rgba(255,255,255,0.1)'; });

    btnRow.appendChild(sendBtn2);
    btnRow.appendChild(discardBtn);
    overlay.appendChild(previewImg);
    overlay.appendChild(btnRow);
    document.body.appendChild(overlay);

    function closeOverlay() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

    discardBtn.addEventListener('click', () => {
      closeOverlay();
      addMessage('Screenshot discarded.', 'system');
    });

    // Escape to discard
    function onEsc(ev) { if (ev.key === 'Escape') { closeOverlay(); document.removeEventListener('keydown', onEsc, true); } }
    document.addEventListener('keydown', onEsc, true);

    if (directImage) {
      previewImg.src = 'data:' + directImage.mimeType + ';base64,' + directImage.base64;
      sendBtn2.addEventListener('click', () => {
        closeOverlay();
        pendingAttachment = { imageData: directImage.base64, mimeType: directImage.mimeType };
        attachThumb.src = previewImg.src;
        attachmentBar.style.display = 'flex';
        input.focus();
        addMessage('Screenshot ready — type a message and hit Send.', 'system');
      });
    } else {
      // No image available — shouldn't happen but handle gracefully
      closeOverlay();
      addMessage('Screenshot failed — no image data.', 'system');
    }
  }

  // ---- Restore persisted messages ----
  // (Skipped in extension mode — the service worker hydrates from its history)
  const persisted = IS_EXTENSION ? null : loadPersistedMessages();
  if (persisted && persisted.length > 0) {
    persisted.forEach(m => {
      state.messages.push({ text: m.text, type: m.type, time: m.time || Date.now() });
      if (m.type === 'system') return; // Don't render system messages in chat on restore
      const el = renderMsgEl(m.text, m.type, m.time);
      msgContainer.appendChild(el);
    });
    state.lastReadIndex = state.messages.length;
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  // ---- Restore preview panel ----
  try {
    const savedPreview = sessionStorage.getItem(PREVIEW_KEY);
    if (savedPreview) {
      setTrustedPreviewHTML(previewContent, savedPreview);
      preview.classList.remove('dc-hidden', 'dc-minimized');
      prevMinBtn.textContent = '\u2014';
    }
  } catch {}

  // ---- Cross-tab sync via localStorage ----
  // Extension mode: the service worker owns cross-tab sync. localStorage
  // broadcast only reaches same-origin tabs, and a tab ingesting it re-announces
  // to the service worker — two same-origin tabs form a duplication loop.
  function broadcast(msg) {
    if (IS_EXTENSION) return;
    tryLocalStorage(() => {
      const data = JSON.stringify({ text: msg.text, type: msg.type, time: Date.now(), from: TAB_ID });
      localStorage.setItem('dc-broadcast', data);
    });
  }

  if (!IS_EXTENSION) tryLocalStorage(() => {
    window.addEventListener('storage', (e) => {
      if (e.key !== 'dc-broadcast' || !e.newValue) return;
      try {
        const msg = JSON.parse(e.newValue);
        if (msg.from === TAB_ID) return;
        addMessage(msg.text, msg.type);
      } catch (err) { /* ignore parse errors */ }
    });
  });

  // ---- Click capture via iframe bridge (postMessage) ----
  clickToggle.addEventListener('click', () => {
    state.clickMode = !state.clickMode;
    clickToggle.classList.toggle('dc-active', state.clickMode);
    // Send click mode to iframe bridge
    postToIframe('dc-click-mode', { enabled: state.clickMode });
    if (state.clickMode) {
      addMessage('Click capture ON \u2014 click any element, \u2191/\u2193 to climb parents', 'system');
    } else {
      hideStatus();
    }
  });

  // ---- Inspector toggle ----
  inspectorToggle.addEventListener('click', () => {
    if (window.__dcInspector) {
      window.__dcInspector.toggle();
      inspectorToggle.classList.toggle('dc-active', window.__dcInspector.isVisible());
    }
  });

  // Sync toggle icon when inspector is closed via its own close button
  window.addEventListener('dc-inspector-hidden', () => {
    inspectorToggle.classList.remove('dc-active');
  });

  // ---- Ruler toggle via iframe bridge (postMessage) ----
  let rulerActive = false;
  rulerToggle.addEventListener('click', () => {
    rulerActive = !rulerActive;
    rulerToggle.classList.toggle('dc-active', rulerActive);
    postToIframe('dc-ruler-mode', { enabled: rulerActive });
    if (rulerActive) {
      addMessage('Rulers ON \u2014 move mouse to see position, click to pin a guide', 'system');
    } else {
      hideStatus();
    }
  });

  // ---- Undo/Redo buttons ----
  undoBtn.addEventListener('click', () => {
    postToIframe('dc-undo');
  });
  redoBtn.addEventListener('click', () => {
    postToIframe('dc-redo');
  });

  // ---- Send modifications to AI button ----
  function getModifiedCount() {
    var count = 0;
    var mods = state.modifiedElements;
    for (var k in mods) {
      if (mods[k].dragDelta || Object.keys(mods[k].styles).length > 0) count++;
    }
    return count;
  }

  function updateSendSelectionsBtn() {
    var count = getModifiedCount();
    sendSelectionsBtn.style.display = count > 0 ? 'flex' : 'none';
    if (count > 0) {
      sendSelectionsBtn.classList.add('dc-active');
      sendSelectionsBtn.title = 'Send ' + count + ' modified element(s) to AI';
    }
  }

  sendSelectionsBtn.addEventListener('click', () => {
    var mods = state.modifiedElements;
    var keys = Object.keys(mods).filter(function(k) {
      return mods[k].dragDelta || Object.keys(mods[k].styles).length > 0;
    });
    if (keys.length === 0) return;

    var lines = keys.map(function(k, i) {
      var entry = mods[k];
      var el = entry.element;
      var size = el.rect ? Math.round(el.rect.width) + '\u00d7' + Math.round(el.rect.height) : '';
      var line = (keys.length > 1 ? (i + 1) + '. ' : '') + k + (size ? ' (' + size + ')' : '');

      if (entry.dragDelta) {
        line += '\n   Moved: dx=' + entry.dragDelta.x + ', dy=' + entry.dragDelta.y;
      }
      var styleKeys = Object.keys(entry.styles);
      if (styleKeys.length > 0) {
        line += '\n   Styles: ' + styleKeys.map(function(p) { return p + ': ' + entry.styles[p]; }).join('; ');
      }
      return line;
    });

    var msg = '[' + keys.length + ' element' + (keys.length > 1 ? 's' : '') + ' modified]\n' + lines.join('\n\n');
    addMessage(msg, 'user');
    broadcast({ text: msg, type: 'user' });

    // Keep selections for re-inspection — only hide the send button
    sendSelectionsBtn.style.display = 'none';
    sendSelectionsBtn.classList.remove('dc-active');
    showThinking();
  });

  // ---- Receive messages from iframe bridge ----
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;

    // Cache iframe origin for targeted postMessage (security: avoid wildcard)
    if (e.source !== window && e.data.type.startsWith('dc-') && e.origin && e.origin !== 'null') {
      _iframeOrigin = e.origin;
      if (window.__dc) window.__dc._iframeOrigin = e.origin;
      _flushIframeQueue();
    }

    switch (e.data.type) {
      case 'dc-element-selected': {
        // Track current element for inspector changes
        var key = elementKey(e.data.element);
        state._currentElementKey = key;
        if (!state.modifiedElements[key]) {
          state.modifiedElements[key] = { element: e.data.element, dragDelta: null, styles: {} };
        } else {
          state.modifiedElements[key].element = e.data.element; // Update info
        }
        delete state.sentSelectionKeys[key]; // fresh selection → attach to next message
        updateSendSelectionsBtn();
        break;
      }

      case 'dc-element-deselected': {
        var dselKey = elementKey(e.data.element);
        delete state.modifiedElements[dselKey];
        delete state.sentSelectionKeys[dselKey];
        if (state._currentElementKey === dselKey) state._currentElementKey = null;
        updateSendSelectionsBtn();
        break;
      }

      case 'dc-drag-complete': {
        // Update drag delta for this element
        var dKey = elementKey(e.data.element);
        if (!state.modifiedElements[dKey]) {
          state.modifiedElements[dKey] = { element: e.data.element, dragDelta: e.data.delta, styles: {} };
        } else {
          state.modifiedElements[dKey].dragDelta = e.data.delta;
        }
        delete state.sentSelectionKeys[dKey]; // new modification → attach to next message
        updateSendSelectionsBtn();
        break;
      }

      case 'dc-inspector-change': {
        // Style change from inspector — track in modifiedElements
        var sKey = state._currentElementKey;
        if (sKey && state.modifiedElements[sKey]) {
          state.modifiedElements[sKey].styles[e.data.property] = e.data.value;
          delete state.sentSelectionKeys[sKey]; // new modification → attach to next message
        }
        updateSendSelectionsBtn();
        break;
      }

      case 'dc-selection-confirmed': {
        // Element selection was confirmed/cleared — keep inspector open
        break;
      }

      case 'dc-system-message':
        // System message from iframe (click capture navigation, etc.)
        addMessage(e.data.text, 'system');
        break;

      case 'dc-filter-overlays':
        // Forward filter request to iframe bridge (from preview panel buttons)
        postToIframe('dc-filter-overlays', { level: e.data.level || null, check: e.data.check || null });
        break;

      case 'dc-undo-state': {
        // Update undo/redo button states
        undoBtn.classList.toggle('dc-disabled', !e.data.canUndo);
        redoBtn.classList.toggle('dc-disabled', !e.data.canRedo);
        undoBtn.title = e.data.canUndo ? 'Undo (' + e.data.undoCount + ')' : 'Undo';
        redoBtn.title = e.data.canRedo ? 'Redo (' + e.data.redoCount + ')' : 'Redo';
        break;
      }

      case 'dc-capture-result':
        handleCaptureResult(e.data);
        break;

      case 'dc-page-theme': {
        // Auto-adapt widget theme to match page background
        const useLight = !e.data.isDark; // Dark page → dark widget, light page → light widget (matching)
        chat.classList.toggle('dc-light', useLight);
        preview.classList.toggle('dc-light', useLight);
        statusConsole.classList.toggle('dc-status-light', useLight);
        // Also notify tab bar
        if (window.__dcTabs && window.__dcTabs.setBarTheme) {
          window.__dcTabs.setBarTheme(e.data.isDark);
        }
        break;
      }
    }
  });

  // ==================== API ====================
  state.api = {
    /** Post a message as the AI (broadcasts to other tabs) */
    say(text) {
      addMessage(text, 'ai');
      broadcast({ text, type: 'ai' });
    },

    /** Add a message to the chat (used by cross-tab sync and hydration) */
    addMessage(text, type) {
      addMessage(text, type);
    },

    /** Replace chat state with service-worker history (extension mode).
     *  All hydrated messages are marked read — they were already delivered. */
    hydrate(history) {
      if (!Array.isArray(history) || history.length === 0) return;
      state._syncing = true;
      try {
        state.messages = [];
        msgContainer.querySelectorAll('.dc-msg').forEach(function (el) { el.remove(); });
        history.forEach(function (m) {
          state.messages.push({ text: m.text, type: m.role || m.type, time: m.time || Date.now() });
          var type = m.role || m.type;
          if (type === 'system') return; // don't re-render status noise
          var el = renderMsgEl(m.text, type, m.time);
          msgContainer.appendChild(el);
        });
        state.lastReadIndex = state.messages.length;
        msgContainer.scrollTop = msgContainer.scrollHeight;
      } finally {
        state._syncing = false;
      }
    },

    /** Read unread user messages since last check.
     *  Returns array of { text, imageData?, mimeType? } objects. */
    readNew() {
      const unread = state.messages
        .filter((m, i) => i >= state.lastReadIndex && m.type === 'user')
        .map(m => {
          const result = { text: m.text };
          if (m.imageData) { result.imageData = m.imageData; result.mimeType = m.mimeType; }
          if (m.captureRect) { result.captureRect = m.captureRect; }
          return result;
        });
      state.lastReadIndex = state.messages.length;
      return unread;
    },

    /** Read full conversation (for manual sync to cross-origin tabs) */
    readAll() {
      return state.messages.map(m => ({ text: m.text, type: m.type }));
    },

    /** Get modified elements with final state (clears buffer) */
    getSelections() {
      var mods = state.modifiedElements;
      var result = Object.keys(mods).map(function(k) {
        var entry = mods[k];
        var out = { ...entry.element };
        if (entry.dragDelta) out.dragDelta = entry.dragDelta;
        if (Object.keys(entry.styles).length > 0) out.styleChanges = entry.styles;
        return out;
      });
      state.modifiedElements = {};
      state.sentSelectionKeys = {};
      return result;
    },

    /** Render HTML into the preview panel (auto-shows it).
     *  NOTE: Accepts trusted AI-generated HTML only — design tool, not user-facing. */
    renderPreview(html) {
      setTrustedPreviewHTML(previewContent, html);
      preview.classList.remove('dc-hidden', 'dc-minimized');
      prevMinBtn.textContent = '\u2014';
      try { sessionStorage.setItem(PREVIEW_KEY, html); } catch {}
    },

    /** Hide the preview panel */
    hidePreview() {
      preview.classList.add('dc-hidden');
      try { sessionStorage.removeItem(PREVIEW_KEY); } catch {}
    },

    /** Clear all element highlights (in iframe) */
    clearHighlights() {
      postToIframe('dc-click-mode', { enabled: false });
    },

    /** Inject full message history (for cross-origin tab sync).
     *  Sets lastReadIndex to end so old messages aren't re-read. */
    syncMessages(msgs) {
      msgContainer.replaceChildren();
      state.messages = [];
      msgs.forEach(m => addMessage(m.text, m.type, true));
      state.lastReadIndex = state.messages.length;
      persistMessages();
    },

    /** Post a system message */
    system(text) { addMessage(text, 'system'); },

    /** Export full chat history as JSON string (for context recovery after compaction) */
    exportChat() {
      return JSON.stringify(
        state.messages.map(m => ({
          type: m.type,
          text: m.text,
          time: m.time,
          timeFormatted: formatTime(m.time)
        })),
        null, 2
      );
    },

    /** Clear chat history (both in-memory and persisted) */
    clearChat() {
      state.messages = [];
      state.lastReadIndex = 0;
      msgContainer.replaceChildren();
      try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
      addMessage('Chat cleared', 'system');
    },

    /** Render clickable option cards in the preview panel.
     *  When clicked, sends postMessage to iframe to replace target element.
     *  Includes a "Revert to original" button that restores via iframe bridge. */
    renderOptions(targetSelector, options) {
      // Tell iframe bridge to store the target element reference
      postToIframe('dc-init-options', { selector: targetSelector });

      const container = createEl('div', 'dc-options-container');
      container.style.cssText = 'padding: 12px; display: flex; flex-direction: column; gap: 10px; background: transparent;';

      const revertBtn = createEl('button', 'dc-options-revert');
      revertBtn.textContent = '\u21A9 Revert to original';
      revertBtn.style.cssText = 'display: none; padding: 8px 16px; background: rgba(200,180,100,0.5); color: rgba(255,255,255,0.9); border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600; text-align: center; transition: background 0.15s;';
      revertBtn.addEventListener('mouseover', () => { revertBtn.style.background = 'rgba(200,180,100,0.65)'; });
      revertBtn.addEventListener('mouseout', () => { revertBtn.style.background = 'rgba(200,180,100,0.5)'; });
      revertBtn.addEventListener('click', () => {
        postToIframe('dc-revert-option');
        revertBtn.style.display = 'none';
        cards.forEach(c => { c.style.borderColor = 'rgba(180,180,200,0.08)'; c.style.background = 'rgba(180,180,200,0.06)'; });
        addMessage('Reverted to original', 'system');
      });
      container.appendChild(revertBtn);

      const cards = [];
      options.forEach((opt, i) => {
        const card = createEl('div', 'dc-option-card');
        card.style.cssText = 'padding: 12px; border: 2px solid rgba(180,180,200,0.08); border-radius: 12px; cursor: pointer; background: rgba(180,180,200,0.06); transition: border-color 0.15s, background 0.15s, transform 0.1s;';

        const label = createEl('div', 'dc-option-label');
        label.style.cssText = 'font-weight: 600; font-size: 13px; color: rgba(210,210,220,0.85); margin-bottom: 8px;';
        label.textContent = opt.label || ('Option ' + String.fromCharCode(65 + i));

        const thumb = createEl('div', 'dc-option-thumb');
        thumb.style.cssText = 'border: 1px solid rgba(180,180,200,0.08); border-radius: 8px; padding: 8px; overflow: hidden; background: rgba(14,14,22,0.3); max-height: 120px; display: flex; align-items: center; justify-content: center;';
        setTrustedPreviewHTML(thumb, opt.html);

        card.appendChild(label);
        card.appendChild(thumb);

        card.addEventListener('mouseover', () => {
          if (card.style.borderColor !== 'rgb(140, 130, 180)') {
            card.style.borderColor = 'rgba(180,175,210,0.3)';
            card.style.background = 'rgba(180,180,200,0.1)';
          }
        });
        card.addEventListener('mouseout', () => {
          if (card.style.borderColor !== 'rgb(140, 130, 180)') {
            card.style.borderColor = 'rgba(180,180,200,0.08)';
            card.style.background = 'rgba(180,180,200,0.06)';
          }
        });

        card.addEventListener('click', () => {
          // Send replacement HTML to iframe bridge
          postToIframe('dc-apply-option', { html: opt.html });

          cards.forEach(c => { c.style.borderColor = 'rgba(180,180,200,0.08)'; c.style.background = 'rgba(180,180,200,0.06)'; });
          card.style.borderColor = 'rgb(140, 130, 180)';
          card.style.background = 'rgba(140,130,180,0.15)';

          revertBtn.style.display = 'block';
          addMessage('Applied: ' + (opt.label || ('Option ' + String.fromCharCode(65 + i))), 'system');
        });

        cards.push(card);
        container.appendChild(card);
      });

      previewContent.replaceChildren(container);
      preview.classList.remove('dc-hidden', 'dc-minimized');
      prevMinBtn.textContent = '\u2014';
      addMessage('Pick an option from the preview panel \u2014 click to apply it to the page', 'system');
    }
  };

  // Wire up voice module (if loaded) with internal functions
  if (window.__dc.voice && window.__dc.voice.wireUp) {
    window.__dc.voice.wireUp(addMessage, broadcast, showThinking);
  }
  // Also store refs so voice module can wire up if loaded after widget
  window.__dc._addMessage = addMessage;
  window.__dc._broadcast = broadcast;
  window.__dc._showThinking = showThinking;
  // Voice module sends through this — it works in BOTH extension mode
  // (MessageChannel port) and Playwright mode (__dcRelayMessage binding)
  window.__dc._relayMessage = relayMessage;

  // Welcome (only if no restored messages)
  if (!persisted || persisted.length === 0) {
    addMessage('Design session active.', 'system');
  } else {
    addMessage('Session restored (' + persisted.length + ' messages). Chat continues.', 'system');
  }

  return 'Collab widget v5 injected (iframe mode)';
})();


// === voice-module.js ===
/**
 * Voice Module for Claude Collab Widget
 *
 * Adds speech-to-text (STT) and text-to-speech (TTS) to the collab widget.
 * - STT: Web Speech API (SpeechRecognition) — continuous, auto-sends on silence
 * - TTS: Audio playback of base64 audio injected by MCP server via Edge TTS
 * - Echo prevention: mic mutes while TTS plays
 * - No buttons needed for conversation — mic button is just on/off toggle
 */
(() => {
  if (!window.__dc) { console.warn('[voice] Widget not ready'); return; }
  if (window.__dc.voice) return 'Voice already active';

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[voice] SpeechRecognition not supported');
    return;
  }

  // ==================== STATE ====================
  const voice = window.__dc.voice = {
    active: false,          // Is voice mode on?
    listening: false,       // Is STT currently listening?
    speaking: false,        // Is TTS currently playing?
    recognition: null,      // SpeechRecognition instance
    currentAudio: null,     // Currently playing Audio element
    lang: 'en-US',          // Recognition language
    pendingTranscript: '',  // Accumulates interim results
  };

  // ==================== STT ====================
  let recognition = null;
  let restartTimeout = null;
  let finalTranscript = '';
  let sendTimeout = null;

  function createRecognition() {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = voice.lang;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      voice.listening = true;
      updateMicUI();
      console.log('[voice] STT started');
    };

    rec.onend = () => {
      voice.listening = false;
      updateMicUI();
      console.log('[voice] STT ended');

      // Auto-restart if voice mode is still active and not speaking
      if (voice.active && !voice.speaking) {
        if (restartTimeout) { clearTimeout(restartTimeout); restartTimeout = null; }
        restartTimeout = setTimeout(() => {
          restartTimeout = null;
          if (voice.active && !voice.speaking) startListening();
        }, 300);
      }
    };

    rec.onerror = (e) => {
      console.warn('[voice] STT error:', e.error);
      voice.listening = false;
      updateMicUI();

      // Don't restart on "not-allowed" or "service-not-allowed"
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        voice.active = false;
        updateMicUI();
        window.__dc.api.system('Microphone access denied. Check browser permissions.');
        return;
      }

      // "aborted" needs care: our own aborts (stopListening, TTS mute, retry)
      // null or replace `recognition` first, so rec !== recognition there.
      // An abort on the CURRENT instance means another tab took the browser-wide
      // speech session — restarting would steal it back and the tabs would
      // fight forever (with a permission prompt each round). Release instead.
      if (e.error === 'aborted') {
        if (rec === recognition && voice.active) voice.release();
        return;
      }

      // Auto-restart on transient errors — clear existing timeout first to prevent leaks
      if (voice.active && !voice.speaking) {
        if (restartTimeout) { clearTimeout(restartTimeout); restartTimeout = null; }
        restartTimeout = setTimeout(() => {
          restartTimeout = null;
          if (voice.active && !voice.speaking) startListening();
        }, 1000);
      }
    };

    rec.onresult = (e) => {
      let interim = '';
      let newFinal = '';

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          newFinal += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      // Accumulate final results (don't reset — previous finals may be waiting to send)
      if (newFinal) {
        finalTranscript += (finalTranscript ? ' ' : '') + newFinal;
      }

      // Show interim transcript as typing indicator
      voice.pendingTranscript = interim || finalTranscript;
      updateTranscriptUI(voice.pendingTranscript);

      // When we get a final result, queue it for sending
      if (finalTranscript.trim()) {
        // Clear any previous send timeout (user is still talking)
        if (sendTimeout) clearTimeout(sendTimeout);

        // Wait a beat for more speech, then send everything accumulated
        sendTimeout = setTimeout(() => {
          sendVoiceMessage(finalTranscript.trim());
          finalTranscript = '';
          voice.pendingTranscript = '';
          updateTranscriptUI('');
        }, 800);
      }
    };

    return rec;
  }

  function startListening() {
    if (voice.listening) return;
    // Allow starting during TTS if in interrupt mode
    if (voice.speaking && !voice._ttsInterruptMode) return;
    try {
      if (!recognition) recognition = createRecognition();
      recognition.start();
    } catch (e) {
      console.warn('[voice] Failed to start STT:', e);
      // May already be running — abort and retry
      try { recognition.abort(); } catch (_) {}
      recognition = createRecognition();
      setTimeout(() => {
        try { recognition.start(); } catch (_) {}
      }, 200);
    }
  }

  function stopListening() {
    if (restartTimeout) { clearTimeout(restartTimeout); restartTimeout = null; }
    if (sendTimeout) { clearTimeout(sendTimeout); sendTimeout = null; }
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
      recognition = null;
    }
    voice.listening = false;
    voice.pendingTranscript = '';
    updateTranscriptUI('');
    updateMicUI();
  }

  function sendVoiceMessage(text) {
    if (!text) return;
    // Use the widget's send mechanism
    const dc = window.__dc;
    const addMessage = dc._addMessage;
    const broadcast = dc._broadcast;
    const showThinking = dc._showThinking;

    if (addMessage) {
      addMessage(text, 'user', false, null, null, 'voice');
      if (broadcast) broadcast({ text, type: 'user', source: 'voice' });
      if (showThinking) showThinking();
    }
    // Relay through the widget's shared relay — works in extension mode
    // (MessageChannel) and Playwright mode (binding). The old direct
    // window.__dcRelayMessage call hit a no-op stub in extension mode and
    // voice messages silently vanished.
    var relay = dc._relayMessage || window.__dcRelayMessage;
    if (relay) {
      relay(text).catch(function() {
        if (addMessage) addMessage('⚠ Voice message not delivered — Claude is not connected to this tab', 'system');
      });
    } else if (addMessage) {
      addMessage('⚠ Voice message not delivered — no relay channel', 'system');
    }
  }

  // ==================== TTS PLAYBACK ====================
  // MCP server injects audio via: window.__dc.voice.playAudio(base64, mime)
  voice.playAudio = function(base64Data, mimeType) {
    return new Promise((resolve, reject) => {
      // Stop any currently playing audio
      if (voice.currentAudio) {
        voice.currentAudio.pause();
        voice.currentAudio = null;
      }

      // MUTE STT during TTS to prevent feedback loop —
      // the mic picks up the speaker output and sends it back as "user" speech
      stopListening();
      voice.speaking = true;
      updateMicUI();

      const audio = new Audio('data:' + (mimeType || 'audio/mp3') + ';base64,' + base64Data);
      voice.currentAudio = audio;

      audio.onended = () => {
        voice.speaking = false;
        voice.currentAudio = null;
        // Clear any residual transcript from pre-mute capture
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        // Resume listening after a longer cooldown so mic doesn't catch audio tail
        if (voice.active) {
          setTimeout(() => startListening(), 800);
        }
        resolve();
      };

      audio.onerror = (e) => {
        console.warn('[voice] Audio playback error:', e);
        voice.speaking = false;
        voice.currentAudio = null;
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        if (voice.active) {
          setTimeout(() => startListening(), 800);
        }
        reject(e);
      };

      audio.play().catch(err => {
        console.warn('[voice] Audio play() rejected:', err);
        voice.speaking = false;
        voice.currentAudio = null;
        updateMicUI();
        if (voice.active) setTimeout(() => startListening(), 800);
        reject(err);
      });
    });
  };

  // Stop TTS playback (e.g., user interrupts)
  voice.stopAudio = function() {
    if (voice.currentAudio) {
      voice.currentAudio.pause();
      voice.currentAudio = null;
    }
    // Also stop browser speech synthesis
    if (speechSynthesis) {
      speechSynthesis.cancel();
    }
    voice.speaking = false;
    voice._ttsInterruptMode = false;
    updateMicUI();
  };

  // ==================== UI ====================
  let micBtn = null;
  let transcriptEl = null;

  function injectUI() {
    // Mic button — goes in header, before camera button
    const headerActions = document.querySelector('.dc-chat .dc-header-actions');
    if (!headerActions) return;

    micBtn = document.createElement('button');
    micBtn.className = 'dc-btn dc-mic';
    micBtn.title = 'Toggle voice mode';
    micBtn.textContent = '\uD83C\uDF99\uFE0F'; // 🎙️
    micBtn.style.cssText = 'font-size: 14px; transition: opacity 0.2s, filter 0.2s; opacity: 0.5;';

    micBtn.addEventListener('click', toggleVoice);

    // Insert before camera button in header
    const captureBtn = headerActions.querySelector('.dc-capture');
    if (captureBtn) {
      headerActions.insertBefore(micBtn, captureBtn);
    } else {
      const minBtn = headerActions.querySelector('.dc-minimize');
      if (minBtn) headerActions.insertBefore(micBtn, minBtn);
      else headerActions.appendChild(micBtn);
    }

    const inputArea = document.querySelector('.dc-input-area');

    // Transcript overlay — shows interim speech text
    transcriptEl = document.createElement('div');
    transcriptEl.className = 'dc-voice-transcript';
    transcriptEl.style.cssText = 'display: none; padding: 4px 10px; font-size: 12px; color: #a78bfa; background: rgba(167,139,250,0.08); border-radius: 6px; margin: 0 8px 4px; font-style: italic; min-height: 0; transition: all 0.2s;';

    // Insert transcript above input area
    const chatEl = inputArea.closest('.dc-chat');
    if (chatEl) {
      chatEl.insertBefore(transcriptEl, inputArea);
    }
  }

  function toggleVoice() {
    voice.active = !voice.active;
    if (voice.active) {
      // Claim the mic browser-wide: Chrome allows ONE speech session per
      // browser, so other tabs' widgets must release theirs or they steal
      // the session back and forth ("aborted" loops, silent transcripts)
      try {
        // Non-http(s) origins fail as postMessage targets ("file://" silently
        // drops, "null" throws) — claim lost, other tabs never release, mic fight.
        window.postMessage({ __dcRelay: true, action: 'voice-active' },
          /^https?:/.test(window.location.origin) ? window.location.origin : '*');
      } catch (_) {}
      startListening();
      window.__dc.api.system('Voice mode ON — speak naturally');
    } else {
      stopListening();
      voice.stopAudio();
      window.__dc.api.system('Voice mode OFF');
    }
    updateMicUI();
  }

  // Called (via service worker broadcast) when another tab takes the mic
  voice.release = function () {
    if (!voice.active) return;
    voice.active = false;
    stopListening();
    voice.stopAudio();
    updateMicUI();
    window.__dc.api.system('Voice mode moved to another tab — mic released here.');
  };

  function updateMicUI() {
    if (!micBtn) return;
    if (!voice.active) {
      micBtn.style.opacity = '0.5';
      micBtn.style.filter = '';
      micBtn.style.background = 'transparent';
      micBtn.title = 'Toggle voice mode (OFF)';
    } else if (voice.speaking) {
      micBtn.style.opacity = '1';
      micBtn.style.filter = 'hue-rotate(180deg)'; // blue tint while speaking
      micBtn.style.background = 'rgba(96,165,250,0.15)';
      micBtn.title = 'AI is speaking...';
    } else if (voice.listening) {
      micBtn.style.opacity = '1';
      micBtn.style.filter = '';
      micBtn.style.background = 'rgba(239,68,68,0.15)';
      micBtn.title = 'Listening... speak now';
    } else {
      micBtn.style.opacity = '0.8';
      micBtn.style.filter = '';
      micBtn.style.background = 'rgba(167,139,250,0.1)';
      micBtn.title = 'Voice mode ON (paused)';
    }
  }

  let transcriptDebounce = null;
  function updateTranscriptUI(text) {
    if (!transcriptEl) return;
    if (transcriptDebounce) clearTimeout(transcriptDebounce);
    transcriptDebounce = setTimeout(() => {
      if (text) {
        transcriptEl.textContent = text;
        transcriptEl.style.display = 'block';
      } else {
        transcriptEl.style.display = 'none';
        transcriptEl.textContent = '';
      }
    }, 150);
  }

  // ==================== BROWSER TTS (FAST PATH) ====================
  // Uses browser's built-in speechSynthesis for instant playback — no server round trip.
  // Auto-speaks AI messages when voice mode is active.

  let browserVoice = null; // cached SpeechSynthesisVoice

  function getBrowserVoice() {
    if (browserVoice) return browserVoice;
    const voices = speechSynthesis.getVoices();
    // Prefer natural-sounding English voices
    const preferred = ['Microsoft Aria', 'Microsoft Jenny', 'Google US English', 'Samantha', 'Karen'];
    for (const name of preferred) {
      const v = voices.find(v => v.name.includes(name));
      if (v) { browserVoice = v; return v; }
    }
    // Fallback: first English voice
    browserVoice = voices.find(v => v.lang.startsWith('en')) || voices[0];
    return browserVoice;
  }

  // Preload voices (they load async in some browsers)
  if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.addEventListener('voiceschanged', () => { browserVoice = null; getBrowserVoice(); });
  }

  function speakBrowser(text) {
    return new Promise((resolve) => {
      if (!text || !speechSynthesis) { resolve(); return; }

      // MUTE STT during TTS to prevent feedback loop
      stopListening();
      voice.speaking = true;
      updateMicUI();

      // Cancel any ongoing speech
      speechSynthesis.cancel();

      const utter = new SpeechSynthesisUtterance(text);
      const v = getBrowserVoice();
      if (v) utter.voice = v;
      utter.rate = 1.05;
      utter.pitch = 1.0;

      utter.onend = () => {
        voice.speaking = false;
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        if (voice.active) setTimeout(() => startListening(), 800);
        resolve();
      };
      utter.onerror = () => {
        voice.speaking = false;
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        if (voice.active) setTimeout(() => startListening(), 800);
        resolve();
      };

      speechSynthesis.speak(utter);
    });
  }

  // Expose for direct use and for widget's addMessage to call
  voice.speakBrowser = speakBrowser;

  // ==================== EXPOSE INTERNALS ====================
  // The widget needs to expose addMessage/broadcast/showThinking for voice to use
  // These get wired up after widget initialization
  voice.wireUp = function(addMessage, broadcast, showThinking) {
    window.__dc._addMessage = addMessage;
    window.__dc._broadcast = broadcast;
    window.__dc._showThinking = showThinking;
  };

  voice.toggle = toggleVoice;
  voice.start = () => { voice.active = true; startListening(); updateMicUI(); };
  voice.stop = () => { voice.active = false; stopListening(); voice.stopAudio(); updateMicUI(); };

  // Inject UI after a short delay to ensure widget DOM is ready
  setTimeout(injectUI, 100);

  return 'Voice module loaded';
})();


// === inspector-panel.js ===
/**
 * Claude Collab — Inspector Panel
 * Visual CSS property editor that appears when an element is selected.
 * Lives in the parent frame alongside the collab widget.
 * Communicates with iframe-bridge.js via postMessage to apply live style changes.
 *
 * Requires: collab-widget.js must be loaded first (uses window.__dc).
 */
(() => {
  if (window.__dcInspector) return;

  const dc = window.__dc;
  if (!dc) { console.error('[inspector] __dc not found'); return; }

  // ==================== STATE ====================
  let currentElement = null;   // Serialized element info from bridge
  let _pendingElement = null;  // Temporarily holds element info between selection and style retrieval
  let _pendingStyles = null;   // Stores styles when panel is closed, used when user opens it
  let changeLog = [];          // { property, oldValue, newValue }
  let panelVisible = false;
  let panelMinimized = false;  // Start expanded
  let dockedEdge = null;       // null | 'left' | 'right' | 'top' | 'bottom'
  const SNAP_THRESHOLD = 30;   // px from edge to trigger snap
  const DOCKED_WIDTH = 280;    // px width when docked left/right
  const DOCKED_HEIGHT = 320;   // px height when docked top/bottom

  // ==================== HELPERS ====================
  function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  function postToIframe(type, data) {
    let iframe;
    if (window.__dcTabs && window.__dcTabs.getActiveFrameName) {
      iframe = document.getElementById(window.__dcTabs.getActiveFrameName());
    } else {
      iframe = document.getElementById('dc-frame');
    }
    const target = (iframe && iframe.contentWindow) ? iframe.contentWindow : window;
    target.postMessage(Object.assign({ type }, data || {}), (window.__dc && window.__dc._iframeOrigin) || '*');
  }

  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return 'transparent';
    const m = str.match(/\d+/g);
    if (!m || m.length < 3) return str;
    const hex = '#' + [m[0], m[1], m[2]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
    return hex;
  }

  function parsePx(str) {
    if (!str) return 0;
    const n = parseFloat(str);
    return isNaN(n) ? 0 : Math.round(n);
  }

  function parseSides(str) {
    if (!str) return [0, 0, 0, 0];
    const parts = str.split(/\s+/).map(parsePx);
    if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
    if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
    if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
    return [parts[0], parts[1], parts[2], parts[3]];
  }

  // ==================== BUILD PANEL ====================
  const panel = el('div', 'dci-panel');
  panel.style.cssText = `
    all: initial;
    position: fixed;
    top: 60px;
    left: 20px;
    width: 280px;
    max-height: calc(100vh - 80px);
    background: rgba(14,14,22,0.6);
    backdrop-filter: blur(28px);
    -webkit-backdrop-filter: blur(28px);
    border: 1px solid rgba(180,180,200,0.08);
    border-radius: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    color: rgba(210,210,220,0.78);
    z-index: 2147483645;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05);
    display: none;
    flex-direction: column;
    overflow: hidden;
    box-sizing: border-box;
  `;

  // Header
  const header = el('div', 'dci-header');
  header.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: linear-gradient(135deg, rgba(140,130,180,0.04), rgba(120,170,180,0.03)); cursor: move; user-select: none;
    flex-shrink: 0; border-bottom: 1px solid rgba(180,180,200,0.07);
  `;
  const title = el('span');
  title.style.cssText = 'font-weight: 600; font-size: 12px; background: linear-gradient(135deg, #b0a8c8, #90b8c0); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: 0.4px;';
  title.textContent = 'Inspector';
  // Button container (minimize + close)
  const headerBtns = el('div');
  headerBtns.style.cssText = 'display: flex; align-items: center; gap: 2px;';

  const minBtn = el('button');
  minBtn.style.cssText = `
    all: unset; width: 24px; height: 24px; display: flex; align-items: center;
    justify-content: center; border-radius: 6px; cursor: pointer; font-size: 14px; color: rgba(200,200,210,0.28); transition: background 0.15s, color 0.15s;
  `;
  minBtn.textContent = '\u2014'; // —
  minBtn.title = 'Minimize inspector';
  minBtn.addEventListener('click', () => toggleMinimize());
  minBtn.addEventListener('mouseover', () => { minBtn.style.background = 'rgba(180,180,200,0.1)'; minBtn.style.color = 'rgba(220,220,230,0.55)'; });
  minBtn.addEventListener('mouseout', () => { minBtn.style.background = ''; minBtn.style.color = 'rgba(200,200,210,0.28)'; });

  const closeBtn = el('button');
  closeBtn.style.cssText = `
    all: unset; width: 24px; height: 24px; display: flex; align-items: center;
    justify-content: center; border-radius: 6px; cursor: pointer; font-size: 14px; color: rgba(200,200,210,0.28); transition: background 0.15s, color 0.15s;
  `;
  closeBtn.textContent = '\u2715';
  closeBtn.addEventListener('click', () => hidePanel());
  closeBtn.addEventListener('mouseover', () => { closeBtn.style.background = 'rgba(180,180,200,0.1)'; closeBtn.style.color = 'rgba(220,220,230,0.55)'; });
  closeBtn.addEventListener('mouseout', () => { closeBtn.style.background = ''; closeBtn.style.color = 'rgba(200,200,210,0.28)'; });

  headerBtns.appendChild(minBtn);
  headerBtns.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(headerBtns);

  // Element description bar
  const elDesc = el('div', 'dci-el-desc');
  elDesc.style.cssText = `
    padding: 6px 12px; background: rgba(180,180,200,0.04); font-size: 11px; color: rgba(180,175,210,0.7);
    font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex-shrink: 0; border-bottom: 1px solid rgba(180,180,200,0.05);
  `;

  // Scrollable body
  const body = el('div', 'dci-body');
  body.style.cssText = `
    flex: 1; overflow-y: auto; padding: 8px 0;
  `;
  // Scrollbar styling + light theme overrides
  const scrollStyle = document.createElement('style');
  scrollStyle.textContent = `
    .dci-body::-webkit-scrollbar { width: 4px; }
    .dci-body::-webkit-scrollbar-track { background: transparent; }
    .dci-body::-webkit-scrollbar-thumb { background: rgba(180,180,200,0.15); border-radius: 2px; }

    /* Light theme overrides (glass light) */
    .dci-panel.dci-light { background: rgba(255,255,255,0.65) !important; backdrop-filter: blur(28px) !important; -webkit-backdrop-filter: blur(28px) !important; border-color: rgba(180,180,200,0.18) !important; color: #444 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.5) !important; }
    .dci-light .dci-header { background: linear-gradient(135deg, rgba(140,130,180,0.06), rgba(120,170,180,0.04)) !important; border-bottom-color: rgba(180,180,200,0.12) !important; }
    .dci-light .dci-header span { background: linear-gradient(135deg, #6860a0, #508898) !important; -webkit-background-clip: text !important; -webkit-text-fill-color: transparent !important; }
    .dci-light .dci-el-desc { background: rgba(240,240,248,0.4) !important; color: rgba(100,95,150,0.7) !important; border-bottom-color: rgba(180,180,200,0.1) !important; }
    .dci-light .dci-body { color: #444 !important; }
    .dci-light .dci-body::-webkit-scrollbar-thumb { background: rgba(180,180,200,0.2); }
    .dci-light .dci-sec-header { color: rgba(80,80,100,0.7) !important; }
    .dci-light .dci-footer { border-top-color: rgba(180,180,200,0.12) !important; }
    .dci-light .dci-dock-btns { border-top-color: rgba(180,180,200,0.12) !important; }
    .dci-light label { color: rgba(70,70,90,0.75) !important; }
    .dci-light input, .dci-light select { background: rgba(255,255,255,0.5) !important; border-color: rgba(180,180,200,0.15) !important; color: #444 !important; }
    .dci-light input:focus, .dci-light select:focus { border-color: rgba(120,115,170,0.3) !important; }
    .dci-light option { background: rgba(255,255,255,0.9) !important; color: #444 !important; }
    .dci-light button { color: rgba(80,80,100,0.65) !important; }
    .dci-light button:hover { background: rgba(100,100,120,0.1) !important; color: rgba(60,60,80,0.8) !important; }
    .dci-light .dci-snap-preview { background: rgba(240,240,248,0.4) !important; border-color: rgba(180,180,200,0.15) !important; }
    /* Copy/Reset footer buttons — softer in light mode */
    .dci-light .dci-footer button,
    .dci-light .dci-dock-btns button { box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important; }
    /* Section border in horizontal dock mode */
    .dci-light .dci-body > div { border-right-color: #d0d0d8 !important; }
  `;
  document.head.appendChild(scrollStyle);

  // Footer — copy changes button
  const footer = el('div', 'dci-footer');
  footer.style.cssText = `
    padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0; display: flex; gap: 6px;
  `;
  const copyBtn = el('button', 'dci-copy-btn');
  function styleCopyBtn() {
    const light = isLightMode();
    copyBtn.style.cssText = `
      all: unset; flex: 1; padding: 6px 12px; border-radius: 6px;
      cursor: pointer; font-size: 11px; font-weight: 600; text-align: center;
      ${light ? 'background: rgba(240,240,248,0.6); color: rgba(80,75,130,0.9); border: 1px solid rgba(180,180,200,0.2);' : 'background: rgba(120,115,170,0.5); color: rgba(255,255,255,0.9);'}
    `;
  }
  styleCopyBtn();
  copyBtn.textContent = 'Copy Changes';
  copyBtn.addEventListener('click', copyChanges);
  copyBtn.addEventListener('mouseover', () => { copyBtn.style.background = isLightMode() ? '#ddd' : '#3730a3'; });
  copyBtn.addEventListener('mouseout', styleCopyBtn);

  const resetBtn = el('button', 'dci-reset-btn');
  function styleResetBtn() {
    const light = isLightMode();
    resetBtn.style.cssText = `
      all: unset; padding: 6px 12px; border-radius: 6px;
      cursor: pointer; font-size: 11px; font-weight: 600; text-align: center;
      ${light ? 'background: #f0e0e0; color: #b91c1c; border: 1px solid #dcc;' : 'background: #dc2626; color: white;'}
    `;
  }
  styleResetBtn();
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', resetChanges);
  resetBtn.addEventListener('mouseover', () => { resetBtn.style.background = isLightMode() ? '#e0d0d0' : '#b91c1c'; });
  resetBtn.addEventListener('mouseout', styleResetBtn);
  footer.appendChild(copyBtn);
  footer.appendChild(resetBtn);

  panel.appendChild(header);
  panel.appendChild(elDesc);
  panel.appendChild(body);
  panel.appendChild(footer);
  document.body.appendChild(panel);

  // ==================== EDGE SNAPPING ====================

  // Visual snap preview indicator
  const snapPreview = el('div', 'dci-snap-preview');
  snapPreview.style.cssText = `
    all: initial; position: fixed; background: rgba(99,102,241,0.15); border: 2px dashed rgba(99,102,241,0.5);
    border-radius: 8px; z-index: 2147483644; pointer-events: none; display: none; box-sizing: border-box;
    transition: all 0.15s ease;
  `;
  document.body.appendChild(snapPreview);

  function detectSnapEdge(clientX, clientY) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (clientX <= SNAP_THRESHOLD) return 'left';
    if (clientX >= vw - SNAP_THRESHOLD) return 'right';
    if (clientY <= SNAP_THRESHOLD) return 'top';
    if (clientY >= vh - SNAP_THRESHOLD) return 'bottom';
    return null;
  }

  function showSnapPreview(edge) {
    if (!edge) { snapPreview.style.display = 'none'; return; }
    snapPreview.style.display = 'block';
    switch (edge) {
      case 'left':
        snapPreview.style.cssText += `; top: 0; left: 0; width: ${DOCKED_WIDTH}px; height: 100vh; bottom: auto; right: auto;`;
        break;
      case 'right':
        snapPreview.style.cssText += `; top: 0; right: 0; width: ${DOCKED_WIDTH}px; height: 100vh; bottom: auto; left: auto;`;
        break;
      case 'top':
        snapPreview.style.cssText += `; top: 0; left: 0; width: 100vw; height: ${DOCKED_HEIGHT}px; bottom: auto; right: auto;`;
        break;
      case 'bottom':
        snapPreview.style.cssText += `; bottom: 0; left: 0; width: 100vw; height: ${DOCKED_HEIGHT}px; top: auto; right: auto;`;
        break;
    }
  }

  function getOffsetTarget() {
    // In tabs mode, adjust the frames container; in single mode, adjust the document
    return document.getElementById('dc-frames-container') || document.documentElement;
  }

  function setPageOffset(prop, value) {
    const target = getOffsetTarget();
    target.style.transition = 'all 0.25s ease';
    // For frames container (position:fixed), use top/left/right/bottom instead of margins
    if (target.id === 'dc-frames-container') {
      const map = { marginLeft: 'left', marginRight: 'right', marginTop: 'top', marginBottom: 'bottom' };
      const cssProp = map[prop] || prop;
      const current = parseInt(getComputedStyle(target)[cssProp]) || 0;
      target.style[cssProp] = (current + parseInt(value)) + 'px';
    } else {
      target.style[prop] = value;
    }
  }

  function clearPageOffsets() {
    const target = getOffsetTarget();
    target.style.transition = 'all 0.25s ease';
    if (target.id === 'dc-frames-container') {
      target.style.left = '0';
      target.style.right = '0';
      target.style.top = '36px'; // tab bar height
      target.style.bottom = '0';
    } else {
      target.style.marginLeft = '';
      target.style.marginRight = '';
      target.style.marginTop = '';
      target.style.marginBottom = '';
    }
  }

  function dockToEdge(edge) {
    undock(false); // Clear previous dock without resetting position
    dockedEdge = edge;
    panel.style.transition = 'all 0.25s ease';
    panel.style.borderRadius = '0';
    panel.style.maxHeight = 'none';

    const isHorizontal = (edge === 'left' || edge === 'right');
    const w = isHorizontal ? DOCKED_WIDTH + 'px' : '100vw';
    const h = isHorizontal ? '100vh' : DOCKED_HEIGHT + 'px';

    // Panel positioning — in tabs mode, respect tab bar height (36px)
    const tabBar = document.getElementById('dc-tab-bar');
    const tabBarH = tabBar ? tabBar.offsetHeight : 0;
    const topOffset = tabBarH + 'px';

    panel.style.top = (edge === 'bottom') ? 'auto' : topOffset;
    panel.style.bottom = (edge === 'top') ? 'auto' : (edge === 'bottom' ? '0' : '0');
    panel.style.left = (edge === 'right') ? 'auto' : '0';
    panel.style.right = (edge === 'left') ? 'auto' : (edge === 'right' ? '0' : '0');
    panel.style.width = w;
    panel.style.height = isHorizontal ? `calc(100vh - ${topOffset})` : DOCKED_HEIGHT + 'px';

    // Push page content with smooth transition
    if (edge === 'left') setPageOffset('marginLeft', DOCKED_WIDTH + 'px');
    else if (edge === 'right') setPageOffset('marginRight', DOCKED_WIDTH + 'px');
    else if (edge === 'top') setPageOffset('marginTop', DOCKED_HEIGHT + 'px');
    else if (edge === 'bottom') setPageOffset('marginBottom', DOCKED_HEIGHT + 'px');

    // Force minimized state to respect docked width
    if (panelMinimized) {
      panel.style.width = w;
    }

    // Make background opaque when docked — semi-transparent bg looks bad against wrapper body
    const light = isLightMode();
    panel.style.background = light ? 'rgba(255,255,255,0.97)' : 'rgba(14,14,22,0.95)';

    // Horizontal layout for top/bottom docking — sections side by side
    applyDockLayout(edge);

    setTimeout(() => { panel.style.transition = ''; }, 250);
  }

  function applyDockLayout(edge) {
    const isTopBottom = (edge === 'top' || edge === 'bottom');
    if (isTopBottom) {
      // Header: compact single row with element desc inline
      header.style.padding = '4px 12px';
      elDesc.style.display = 'inline';
      elDesc.style.padding = '4px 12px';
      elDesc.style.borderBottom = 'none';
      // Body: horizontal row of sections
      body.style.cssText = `
        display: flex; flex-direction: row; flex: 1; overflow-x: auto; overflow-y: hidden;
        padding: 4px 0; gap: 0; align-items: stretch; min-height: 0;
      `;
      // Style each section for horizontal tiling
      styleSectionsHorizontal();
      // Hide footer — move buttons into last section
      footer.style.display = 'none';
      const lastSec = body.children[body.children.length - 1];
      if (lastSec) {
        const btnRow = el('div', 'dci-dock-btns');
        btnRow.style.cssText = 'display: flex; gap: 6px; padding: 8px 12px; margin-top: auto; justify-content: flex-end;';
        const cpBtn = copyBtn.cloneNode(true);
        const rsBtn = resetBtn.cloneNode(true);
        cpBtn.style.flex = 'none';
        rsBtn.style.flex = 'none';
        cpBtn.addEventListener('click', copyChanges);
        rsBtn.addEventListener('click', resetChanges);
        btnRow.appendChild(cpBtn);
        btnRow.appendChild(rsBtn);
        lastSec.appendChild(btnRow);
        lastSec.style.display = 'flex';
        lastSec.style.flexDirection = 'column';
      }
    } else {
      resetDockLayout();
    }
  }

  function styleSectionsHorizontal() {
    Array.from(body.children).forEach(sec => {
      sec.style.minWidth = '180px';
      sec.style.flex = '1 1 0';
      sec.style.width = '';
      sec.style.maxWidth = '';
      sec.style.display = 'flex';
      sec.style.flexDirection = 'column';
      sec.style.borderRight = '1px solid rgba(255,255,255,0.06)';
      sec.style.overflow = 'hidden';
      sec.style.marginBottom = '0';
    });
  }

  function resetDockLayout() {
    header.style.padding = '8px 12px';
    elDesc.style.display = '';
    elDesc.style.padding = '6px 12px';
    elDesc.style.borderBottom = '1px solid rgba(255,255,255,0.04)';
    body.style.cssText = 'flex: 1; overflow-y: auto; padding: 8px 0;';
    // Remove cloned button rows from sections
    body.querySelectorAll('.dci-dock-btns').forEach(b => b.remove());
    Array.from(body.children).forEach(sec => {
      sec.style.minWidth = '';
      sec.style.width = '';
      sec.style.maxWidth = '';
      sec.style.flex = '';
      sec.style.flexShrink = '';
      sec.style.display = '';
      sec.style.flexDirection = '';
      sec.style.borderRight = '';
      sec.style.overflow = '';
    });
    footer.style.cssText = `padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; display: flex; gap: 6px;`;
    copyBtn.style.flex = '1';
    resetBtn.style.flex = '';
  }

  function undock(resetPosition) {
    if (dockedEdge) {
      clearPageOffsets();
      resetDockLayout();
    }
    dockedEdge = null;
    panel.style.transition = 'all 0.25s ease';
    panel.style.borderRadius = '12px';
    // Restore semi-transparent bg when floating
    const light = isLightMode();
    panel.style.background = light ? 'rgba(255,255,255,0.65)' : 'rgba(14,14,22,0.6)';
    panel.style.width = '280px';
    panel.style.height = '';
    panel.style.right = 'auto';
    panel.style.bottom = '';
    panel.style.maxHeight = 'calc(100vh - 80px)';
    if (resetPosition) {
      panel.style.top = '60px';
      panel.style.left = '20px';
    }
    setTimeout(() => { panel.style.transition = ''; }, 250);
  }

  // Make header draggable with edge snapping
  let dragSX, dragSY, dragSL, dragST;
  header.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn || e.target === minBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const r = panel.getBoundingClientRect();
    dragSX = e.clientX; dragSY = e.clientY; dragSL = r.left; dragST = r.top;

    // If currently docked, undock on drag start
    if (dockedEdge) {
      undock(false);
      // Kill transition so dragging feels instant
      panel.style.transition = 'none';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      dragSL = r.left;
      dragST = r.top;
    }

    let pendingEdge = null;

    const onMove = (ev) => {
      ev.stopPropagation();
      const newLeft = Math.max(0, dragSL + ev.clientX - dragSX);
      const newTop = Math.max(0, dragST + ev.clientY - dragSY);
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
      panel.style.right = 'auto';

      pendingEdge = detectSnapEdge(ev.clientX, ev.clientY);
      showSnapPreview(pendingEdge);
    };
    const onUp = (ev) => {
      ev.stopPropagation();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      snapPreview.style.display = 'none';
      if (pendingEdge) {
        dockToEdge(pendingEdge);
      }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  });

  // ==================== CONTROL BUILDERS ====================

  function makeSection(label) {
    const sec = el('div', 'dci-section');
    sec.style.cssText = 'margin-bottom: 4px;';

    const hdr = el('div', 'dci-sec-header');
    hdr.style.cssText = `
      padding: 4px 12px; font-size: 10px; font-weight: 700; color: #888;
      text-transform: uppercase; letter-spacing: 0.8px; cursor: pointer; user-select: none;
      display: flex; align-items: center; gap: 4px;
    `;
    const arrow = el('span');
    arrow.textContent = '\u25BC';
    arrow.style.cssText = 'font-size: 8px; transition: transform 0.15s;';
    const lbl = el('span');
    lbl.textContent = label;
    hdr.appendChild(arrow);
    hdr.appendChild(lbl);

    const content = el('div', 'dci-sec-content');
    content.style.cssText = 'padding: 4px 12px;';

    hdr.addEventListener('click', () => {
      const hidden = content.style.display === 'none';
      content.style.display = hidden ? 'block' : 'none';
      arrow.style.transform = hidden ? '' : 'rotate(-90deg)';
    });

    sec.appendChild(hdr);
    sec.appendChild(content);
    return { section: sec, content };
  }

  function makeRow(label) {
    const row = el('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 5px;';
    const lbl = el('label');
    lbl.style.cssText = 'width: 60px; font-size: 11px; color: #888; flex-shrink: 0;';
    lbl.textContent = label;
    row.appendChild(lbl);
    return row;
  }

  function makeNumberInput(value, prop, unit, min, max) {
    unit = unit || 'px';
    const input = el('input', '', { type: 'number' });
    input.style.cssText = `
      all: unset; width: 50px; padding: 3px 6px; background: rgba(180,180,200,0.06); border: 1px solid rgba(180,180,200,0.08);
      border-radius: 4px; color: rgba(210,210,220,0.85); font-size: 11px; font-family: monospace; text-align: right;
    `;
    input.value = value;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.addEventListener('change', () => {
      applyStyle(prop, input.value + unit);
    });
    input.addEventListener('focus', () => { input.style.borderColor = 'rgba(140,130,180,0.25)'; });
    input.addEventListener('blur', () => { input.style.borderColor = 'rgba(180,180,200,0.08)'; });
    return input;
  }

  function makeSlider(value, prop, unit, min, max, step) {
    unit = unit || 'px';
    min = min !== undefined ? min : 0;
    max = max !== undefined ? max : 100;
    step = step || 1;
    const wrap = el('div');
    wrap.style.cssText = 'display: flex; align-items: center; gap: 6px; flex: 1;';

    const slider = el('input', '', { type: 'range' });
    slider.style.cssText = 'flex: 1; height: 4px; accent-color: #818cf8; cursor: pointer;';
    slider.min = min; slider.max = max; slider.step = step; slider.value = value;

    const valLabel = el('span');
    valLabel.style.cssText = 'font-size: 10px; color: #aaa; font-family: monospace; min-width: 32px; text-align: right;';
    valLabel.textContent = value + unit;

    slider.addEventListener('input', () => {
      valLabel.textContent = slider.value + unit;
      applyStyle(prop, slider.value + unit);
    });

    wrap.appendChild(slider);
    wrap.appendChild(valLabel);
    return wrap;
  }

  function makeColorInput(value, prop) {
    const wrap = el('div');
    wrap.style.cssText = 'display: flex; align-items: center; gap: 4px; flex: 1;';

    const picker = el('input', '', { type: 'color' });
    picker.style.cssText = 'width: 28px; height: 24px; border: 1px solid rgba(180,180,200,0.08); border-radius: 4px; cursor: pointer; padding: 0; background: none;';
    picker.value = (value && value.startsWith('#') && value.length === 7) ? value : '#000000';

    const text = el('input', '', { type: 'text' });
    text.style.cssText = `
      all: unset; flex: 1; padding: 3px 6px; background: rgba(180,180,200,0.06); border: 1px solid rgba(180,180,200,0.08);
      border-radius: 4px; color: rgba(210,210,220,0.85); font-size: 11px; font-family: monospace;
    `;
    text.value = value || 'transparent';

    picker.addEventListener('input', () => {
      text.value = picker.value;
      applyStyle(prop, picker.value);
    });
    text.addEventListener('change', () => {
      if (text.value.match(/^#[0-9a-fA-F]{3,8}$/)) {
        picker.value = text.value.length <= 7 ? text.value : text.value.slice(0, 7);
      }
      applyStyle(prop, text.value);
    });

    wrap.appendChild(picker);
    wrap.appendChild(text);
    return wrap;
  }

  function isLightMode() { return panel.classList.contains('dci-light'); }
  function btnBgOff() { return isLightMode() ? 'rgba(240,240,248,0.4)' : 'rgba(180,180,200,0.06)'; }
  function btnColorOff() { return isLightMode() ? '#666' : '#888'; }
  function btnHoverBg() { return isLightMode() ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)'; }
  const BTN_ACTIVE_BG = 'rgba(99,102,241,0.25)';
  const BTN_ACTIVE_COLOR = '#818cf8';

  function makeButtonGroup(options, currentValue, prop) {
    const group = el('div');
    group.style.cssText = 'display: flex; gap: 2px; flex: 1;';

    options.forEach(opt => {
      const isActive = currentValue === opt.value;
      const btn = el('button');
      btn.style.cssText = `
        all: unset; flex: 1; padding: 4px 0; text-align: center; font-size: 11px; font-weight: 600;
        border-radius: 4px; cursor: pointer; transition: background 0.1s;
        ${isActive ? 'background:' + BTN_ACTIVE_BG + '; color:' + BTN_ACTIVE_COLOR + ';' : 'background:' + btnBgOff() + '; color:' + btnColorOff() + ';'}
      `;
      btn.textContent = opt.label;
      btn.title = opt.value;
      btn.addEventListener('click', () => {
        group.querySelectorAll('button').forEach(b => {
          b.style.background = btnBgOff(); b.style.color = btnColorOff();
        });
        btn.style.background = BTN_ACTIVE_BG;
        btn.style.color = BTN_ACTIVE_COLOR;
        applyStyle(prop, opt.value);
      });
      btn.addEventListener('mouseover', () => {
        if (btn.style.color !== 'rgb(129, 140, 248)') btn.style.background = btnHoverBg();
      });
      btn.addEventListener('mouseout', () => {
        if (btn.style.color !== 'rgb(129, 140, 248)') btn.style.background = btnBgOff();
      });
      group.appendChild(btn);
    });
    return group;
  }

  function makeSelect(options, currentValue, prop) {
    const select = el('select');
    select.style.cssText = `
      all: unset; flex: 1; padding: 3px 6px; background: rgba(180,180,200,0.06); border: 1px solid rgba(180,180,200,0.08);
      border-radius: 4px; color: rgba(210,210,220,0.85); font-size: 11px; cursor: pointer;
    `;
    options.forEach(opt => {
      const o = el('option');
      o.value = opt; o.textContent = opt;
      o.style.cssText = 'background: rgba(180,180,200,0.06); color: rgba(210,210,220,0.85);';
      if (opt === currentValue) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', () => applyStyle(prop, select.value));
    return select;
  }

  function makeBoxModel(marginVals, paddingVals) {
    const box = el('div');
    box.style.cssText = `
      position: relative; width: 100%; padding: 4px; box-sizing: border-box;
    `;

    // Margin layer (outer)
    const marginBox = el('div');
    marginBox.style.cssText = `
      border: 1px dashed #f59e0b44; border-radius: 6px; padding: 20px 28px;
      position: relative;
    `;
    const mLabel = el('span');
    mLabel.style.cssText = 'position: absolute; top: 2px; left: 6px; font-size: 9px; color: #f59e0b88; text-transform: uppercase;';
    mLabel.textContent = 'margin';
    marginBox.appendChild(mLabel);

    // Padding layer (inner)
    const paddingBox = el('div');
    paddingBox.style.cssText = `
      border: 1px dashed #22c55e44; border-radius: 4px; padding: 16px 24px;
      position: relative; background: rgba(99,102,241,0.06);
    `;
    const pLabel = el('span');
    pLabel.style.cssText = 'position: absolute; top: 2px; left: 6px; font-size: 9px; color: #22c55e88; text-transform: uppercase;';
    pLabel.textContent = 'padding';
    paddingBox.appendChild(pLabel);

    // Content box
    const contentBox = el('div');
    contentBox.style.cssText = 'text-align: center; font-size: 10px; color: #666; padding: 4px;';
    contentBox.textContent = 'content';
    paddingBox.appendChild(contentBox);

    // Margin inputs (top, right, bottom, left)
    const mInputs = makeBoxInputs(marginVals, 'margin');
    positionBoxInputs(mInputs, marginBox, '#f59e0b');

    // Padding inputs
    const pInputs = makeBoxInputs(paddingVals, 'padding');
    positionBoxInputs(pInputs, paddingBox, '#22c55e');

    marginBox.appendChild(paddingBox);
    box.appendChild(marginBox);
    return box;
  }

  function makeBoxInputs(vals, propBase) {
    const sides = ['top', 'right', 'bottom', 'left'];
    return sides.map((side, i) => {
      const input = el('input', '', { type: 'number' });
      input.style.cssText = `
        all: unset; width: 30px; padding: 1px 3px; background: transparent; border: 1px solid transparent;
        border-radius: 3px; color: #ccc; font-size: 10px; font-family: monospace; text-align: center;
        position: absolute;
      `;
      input.value = vals[i];
      input.addEventListener('focus', () => { input.style.borderColor = 'rgba(140,130,180,0.25)'; input.style.background = 'rgba(180,180,200,0.08)'; });
      input.addEventListener('blur', () => { input.style.borderColor = 'transparent'; input.style.background = 'transparent'; });
      input.addEventListener('change', () => {
        applyStyle(propBase + '-' + side, input.value + 'px');
      });
      return input;
    });
  }

  function positionBoxInputs(inputs, container, color) {
    // top, right, bottom, left
    inputs[0].style.top = '2px'; inputs[0].style.left = '50%'; inputs[0].style.transform = 'translateX(-50%)';
    inputs[1].style.right = '2px'; inputs[1].style.top = '50%'; inputs[1].style.transform = 'translateY(-50%)';
    inputs[2].style.bottom = '2px'; inputs[2].style.left = '50%'; inputs[2].style.transform = 'translateX(-50%)';
    inputs[3].style.left = '2px'; inputs[3].style.top = '50%'; inputs[3].style.transform = 'translateY(-50%)';
    inputs.forEach(inp => {
      inp.style.color = color;
      container.appendChild(inp);
    });
  }

  // ==================== PANEL POPULATION ====================

  function populatePanel(styles) {
    body.replaceChildren();

    // --- Layout Section ---
    const layout = makeSection('Layout');

    // Box model
    const marginVals = parseSides(styles.margin);
    const paddingVals = parseSides(styles.padding);
    const boxModel = makeBoxModel(marginVals, paddingVals);
    layout.content.appendChild(boxModel);

    // Width & Height
    const sizeRow = makeRow('Size');
    const wInput = makeNumberInput(parsePx(styles.width), 'width', 'px', 0);
    const hInput = makeNumberInput(parsePx(styles.height), 'height', 'px', 0);
    const wLabel = el('span'); wLabel.textContent = 'W'; wLabel.style.cssText = 'font-size: 10px; color: #666;';
    const hLabel = el('span'); hLabel.textContent = 'H'; hLabel.style.cssText = 'font-size: 10px; color: #666;';
    sizeRow.appendChild(wLabel); sizeRow.appendChild(wInput);
    sizeRow.appendChild(hLabel); sizeRow.appendChild(hInput);
    layout.content.appendChild(sizeRow);

    // Display
    const displayRow = makeRow('Display');
    displayRow.appendChild(makeSelect(
      ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'none'],
      styles.display, 'display'
    ));
    layout.content.appendChild(displayRow);

    // Gap
    const gapRow = makeRow('Gap');
    gapRow.appendChild(makeNumberInput(parsePx(styles.gap), 'gap', 'px', 0));
    layout.content.appendChild(gapRow);

    // Flex direction (show only if display is flex)
    if (styles.display && styles.display.includes('flex')) {
      const fdRow = makeRow('Direction');
      fdRow.appendChild(makeButtonGroup([
        { label: 'Row', value: 'row' },
        { label: 'Col', value: 'column' },
        { label: 'Row-R', value: 'row-reverse' },
        { label: 'Col-R', value: 'column-reverse' },
      ], styles.flexDirection || 'row', 'flex-direction'));
      layout.content.appendChild(fdRow);

      const jcRow = makeRow('Justify');
      jcRow.appendChild(makeButtonGroup([
        { label: 'Start', value: 'flex-start' },
        { label: 'Center', value: 'center' },
        { label: 'End', value: 'flex-end' },
        { label: 'Between', value: 'space-between' },
      ], styles.justifyContent || 'flex-start', 'justify-content'));
      layout.content.appendChild(jcRow);

      const aiRow = makeRow('Align');
      aiRow.appendChild(makeButtonGroup([
        { label: 'Start', value: 'flex-start' },
        { label: 'Center', value: 'center' },
        { label: 'End', value: 'flex-end' },
        { label: 'Stretch', value: 'stretch' },
      ], styles.alignItems || 'stretch', 'align-items'));
      layout.content.appendChild(aiRow);
    }

    // Overflow
    const overflowRow = makeRow('Overflow');
    overflowRow.appendChild(makeSelect(
      ['visible', 'hidden', 'scroll', 'auto', 'clip'],
      styles.overflow || 'visible', 'overflow'
    ));
    layout.content.appendChild(overflowRow);

    body.appendChild(layout.section);

    // --- Typography Section ---
    const typo = makeSection('Typography');

    const sizeSliderRow = makeRow('Size');
    sizeSliderRow.appendChild(makeSlider(parsePx(styles.fontSize), 'font-size', 'px', 8, 72));
    typo.content.appendChild(sizeSliderRow);

    const weightRow = makeRow('Weight');
    weightRow.appendChild(makeSelect(
      ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
      styles.fontWeight || '400', 'font-weight'
    ));
    typo.content.appendChild(weightRow);

    const alignRow = makeRow('Align');
    alignRow.appendChild(makeButtonGroup([
      { label: 'L', value: 'left' },
      { label: 'C', value: 'center' },
      { label: 'R', value: 'right' },
      { label: 'J', value: 'justify' },
    ], styles.textAlign || 'left', 'text-align'));
    typo.content.appendChild(alignRow);

    const colorRow = makeRow('Color');
    colorRow.appendChild(makeColorInput(parseColor(styles.color), 'color'));
    typo.content.appendChild(colorRow);

    const lhRow = makeRow('Line-H');
    const lhVal = parseFloat(styles.lineHeight) || 1.5;
    const lhIsPx = String(styles.lineHeight).indexOf('px') !== -1;
    if (lhIsPx) {
      lhRow.appendChild(makeSlider(Math.round(lhVal * 10) / 10, 'line-height', 'px', 0, 80, 0.5));
    } else {
      lhRow.appendChild(makeSlider(lhVal, 'line-height', '', 0.8, 4, 0.1));
    }
    typo.content.appendChild(lhRow);

    const lsRow = makeRow('Spacing');
    lsRow.appendChild(makeSlider(parsePx(styles.letterSpacing), 'letter-spacing', 'px', -2, 10, 0.5));
    typo.content.appendChild(lsRow);

    // Text transform
    const ttRow = makeRow('Transform');
    ttRow.appendChild(makeButtonGroup([
      { label: 'None', value: 'none' },
      { label: 'Upper', value: 'uppercase' },
      { label: 'Lower', value: 'lowercase' },
      { label: 'Cap', value: 'capitalize' },
    ], styles.textTransform || 'none', 'text-transform'));
    typo.content.appendChild(ttRow);

    body.appendChild(typo.section);

    // --- Appearance Section ---
    const appearance = makeSection('Appearance');

    const bgRow = makeRow('BG Color');
    bgRow.appendChild(makeColorInput(parseColor(styles.backgroundColor), 'background-color'));
    appearance.content.appendChild(bgRow);

    const radiusRow = makeRow('Radius');
    radiusRow.appendChild(makeSlider(parsePx(styles.borderRadius), 'border-radius', 'px', 0, 50));
    appearance.content.appendChild(radiusRow);

    // Border width
    const bwRow = makeRow('Border W');
    bwRow.appendChild(makeSlider(parsePx(styles.borderWidth || '0'), 'border-width', 'px', 0, 10));
    appearance.content.appendChild(bwRow);

    // Border style
    const bsRow = makeRow('Border S');
    bsRow.appendChild(makeSelect(
      ['none', 'solid', 'dashed', 'dotted', 'double', 'groove'],
      styles.borderStyle || 'none', 'border-style'
    ));
    appearance.content.appendChild(bsRow);

    // Border color
    const bcRow = makeRow('Border C');
    bcRow.appendChild(makeColorInput(parseColor(styles.borderColor), 'border-color'));
    appearance.content.appendChild(bcRow);

    // Opacity
    const opRow = makeRow('Opacity');
    opRow.appendChild(makeSlider(parseFloat(styles.opacity) || 1, 'opacity', '', 0, 1, 0.05));
    appearance.content.appendChild(opRow);

    // Box shadow (text input for flexibility)
    const shadowRow = makeRow('Shadow');
    const shadowInput = el('input', '', { type: 'text' });
    shadowInput.style.cssText = `
      all: unset; flex: 1; padding: 3px 6px; background: rgba(180,180,200,0.06); border: 1px solid rgba(180,180,200,0.08);
      border-radius: 4px; color: rgba(210,210,220,0.85); font-size: 10px; font-family: monospace;
    `;
    shadowInput.value = styles.boxShadow === 'none' ? '' : (styles.boxShadow || '');
    shadowInput.placeholder = '0 4px 12px rgba(0,0,0,0.3)';
    shadowInput.addEventListener('change', () => applyStyle('box-shadow', shadowInput.value || 'none'));
    shadowInput.addEventListener('focus', () => { shadowInput.style.borderColor = 'rgba(140,130,180,0.25)'; });
    shadowInput.addEventListener('blur', () => { shadowInput.style.borderColor = 'rgba(180,180,200,0.08)'; });
    shadowRow.appendChild(shadowInput);
    appearance.content.appendChild(shadowRow);

    body.appendChild(appearance.section);

    // --- Position Section ---
    const position = makeSection('Position');

    const posRow = makeRow('Position');
    posRow.appendChild(makeSelect(
      ['static', 'relative', 'absolute', 'fixed', 'sticky'],
      styles.position || 'static', 'position'
    ));
    position.content.appendChild(posRow);

    const zRow = makeRow('Z-Index');
    zRow.appendChild(makeNumberInput(parseInt(styles.zIndex) || 0, 'z-index', '', -10, 9999));
    position.content.appendChild(zRow);

    body.appendChild(position.section);
  }

  // ==================== STYLE APPLICATION ====================

  function applyStyle(prop, value) {
    // Record change
    changeLog.push({ property: prop, value: value, timestamp: Date.now() });

    // Send to iframe bridge
    postToIframe('dc-apply-style', { property: prop, value: value });

    // Notify widget to track in modifiedElements
    window.postMessage({ type: 'dc-inspector-change', property: prop, value: value }, location.origin || '*');

    // Notify via system message (debounced — only show for significant changes)
    if (changeLog.length === 1 || changeLog.length % 5 === 0) {
      dc.api.system('Changed ' + changeLog.length + ' properties');
    }
  }

  function copyChanges() {
    if (changeLog.length === 0) {
      dc.api.system('No changes to copy');
      return;
    }
    // Deduplicate — keep last value per property
    const latest = {};
    changeLog.forEach(c => { latest[c.property] = c.value; });
    const desc = currentElement
      ? (currentElement.tag + (currentElement.id ? '#' + currentElement.id : '') +
         (currentElement.classes.length ? '.' + currentElement.classes.slice(0, 2).join('.') : ''))
      : 'element';
    let text = 'Inspector changes for ' + desc + ':\n';
    Object.entries(latest).forEach(([prop, val]) => {
      text += '  ' + prop + ': ' + val + ';\n';
    });

    // Copy to clipboard and notify
    navigator.clipboard.writeText(text).then(() => {
      dc.api.system('Changes copied to clipboard (' + Object.keys(latest).length + ' properties)');
    }).catch(() => {
      // Fallback: log to console and send via chat
      console.log(text);
      dc.api.system('Changes logged to console');
    });

    // Also store in selectedElements for MCP retrieval
    dc.selectedElements.push({
      ...currentElement,
      inspectorChanges: latest
    });
  }

  function resetChanges() {
    if (changeLog.length === 0) return;
    postToIframe('dc-reset-styles');
    changeLog = [];
    dc.api.system('All changes reverted');
  }

  // ==================== SHOW/HIDE ====================

  function applyMinimizedState() {
    const isTopBottom = (dockedEdge === 'top' || dockedEdge === 'bottom');
    elDesc.style.display = panelMinimized ? 'none' : (isTopBottom ? 'inline' : '');
    // When docked top/bottom, body must stay display:flex for horizontal layout
    if (panelMinimized) {
      body.style.display = 'none';
    } else if (isTopBottom) {
      body.style.display = 'flex';
    } else {
      body.style.display = '';
    }
    footer.style.display = panelMinimized ? 'none' : 'flex';
    minBtn.textContent = panelMinimized ? '+' : '\u2014';
    minBtn.title = panelMinimized ? 'Expand inspector' : 'Minimize inspector';
    // When docked, always keep full docked dimensions; only shrink when floating
    if (dockedEdge) {
      const isHorizontal = (dockedEdge === 'left' || dockedEdge === 'right');
      panel.style.width = isHorizontal ? DOCKED_WIDTH + 'px' : '100vw';
      panel.style.height = isHorizontal ? '100vh' : DOCKED_HEIGHT + 'px';
    } else {
      panel.style.width = panelMinimized ? 'auto' : '280px';
    }
  }

  function toggleMinimize() {
    panelMinimized = !panelMinimized;
    applyMinimizedState();
  }

  function showPanel(elementInfo, fullStyles) {
    currentElement = elementInfo;
    changeLog = [];

    // Description bar
    const desc = elementInfo.tag +
      (elementInfo.id ? '#' + elementInfo.id : '') +
      (elementInfo.classes.length ? '.' + elementInfo.classes.slice(0, 3).join('.') : '');
    elDesc.textContent = desc + ' (' + Math.round(elementInfo.rect.width) + '\u00d7' + Math.round(elementInfo.rect.height) + ')';

    populatePanel(fullStyles);
    panel.style.display = 'flex';
    panelVisible = true;
    // Re-apply horizontal layout if docked top/bottom (sections were just rebuilt)
    if (dockedEdge === 'top' || dockedEdge === 'bottom') {
      applyDockLayout(dockedEdge);
    }
    // Respect minimized state — don't force expand on new element selection
    applyMinimizedState();
  }

  function hidePanel() {
    panelVisible = false;
    window.dispatchEvent(new CustomEvent('dc-inspector-hidden'));
    if (dockedEdge) {
      // Animate content back first, then hide panel
      clearPageOffsets();
      panel.style.transition = 'opacity 0.2s ease';
      panel.style.opacity = '0';
      setTimeout(() => {
        panel.style.display = 'none';
        panel.style.opacity = '1';
        panel.style.transition = '';
        dockedEdge = null;
        panel.style.borderRadius = '12px';
        panel.style.width = '280px';
        panel.style.height = '';
        panel.style.right = 'auto';
        panel.style.bottom = '';
        panel.style.maxHeight = 'calc(100vh - 80px)';
        panel.style.top = '60px';
        panel.style.left = '20px';
      }, 250);
    } else {
      panel.style.display = 'none';
    }
  }

  // ==================== MESSAGE HANDLING ====================

  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    // Accept messages from self or from any child frame (iframes post with different origins in tabs mode)
    // Only reject if the source is a parent/sibling window (not self, not a child)
    if (e.source !== window && e.source !== null) {
      try {
        // Check if source is one of our child frames
        var isChild = false;
        for (var i = 0; i < window.frames.length; i++) {
          if (e.source === window.frames[i]) { isChild = true; break; }
        }
        if (!isChild) return;
      } catch (ex) {
        // Cross-origin access error — likely a child iframe, allow it
      }
    }

    if (e.data.type === 'dc-page-theme') {
      const useLight = !e.data.isDark;
      panel.classList.toggle('dci-light', useLight);
      // Re-style buttons for new theme
      styleCopyBtn();
      styleResetBtn();
    }

    if (e.data.type === 'dc-element-selected') {
      // Element selected — store element info and request full styles from bridge
      _pendingElement = e.data.element;
      postToIframe('dc-get-full-styles');
    }

    if (e.data.type === 'dc-full-styles') {
      // Got full styles — only show inspector if it's already open, otherwise just store the data
      const elem = _pendingElement || dc.selectedElements[dc.selectedElements.length - 1];
      if (elem && panelVisible) {
        showPanel(elem, e.data.styles);
      } else if (elem) {
        // Store for when user opens inspector manually
        currentElement = elem;
        _pendingStyles = e.data.styles;
      }
    }
  });

  // ==================== PUBLIC API ====================

  const emptyStyles = {
    margin: '0', padding: '0', width: '0', height: '0', display: 'block',
    gap: '0', flexDirection: 'row', justifyContent: 'start', alignItems: 'start',
    overflow: 'visible', fontSize: '16px', fontWeight: '400', textAlign: 'left',
    color: 'rgb(0,0,0)', lineHeight: '24px', letterSpacing: '0px', textTransform: 'none',
    backgroundColor: 'transparent', borderRadius: '0px', borderWidth: '0px',
    borderStyle: 'none', borderColor: 'rgb(0,0,0)', opacity: '1',
    boxShadow: 'none', position: 'static', zIndex: '0'
  };

  function togglePanel() {
    if (panelVisible) {
      hidePanel();
    } else {
      // If we have pending styles from a selection made while panel was closed, show them
      if (_pendingStyles && currentElement) {
        showPanel(currentElement, _pendingStyles);
        _pendingStyles = null;
        return;
      }
      // If no element was ever selected, populate with empty defaults
      if (!currentElement) {
        elDesc.textContent = 'No element selected';
        populatePanel(emptyStyles);
      }
      panel.style.display = 'flex';
      panelVisible = true;
      panelMinimized = false;
      applyMinimizedState();
      // Default dock to left if not already docked
      if (!dockedEdge) {
        dockToEdge('left');
      }
    }
  }

  window.__dcInspector = {
    show: showPanel,
    hide: hidePanel,
    toggle: togglePanel,
    minimize: () => { panelMinimized = true; applyMinimizedState(); },
    expand: () => { panelMinimized = false; applyMinimizedState(); },
    toggleMinimize,
    dock: dockToEdge,
    undock: () => undock(true),
    getDockedEdge: () => dockedEdge,
    getChanges: () => {
      const latest = {};
      changeLog.forEach(c => { latest[c.property] = c.value; });
      return latest;
    },
    isVisible: () => panelVisible,
    isMinimized: () => panelMinimized,
  };

})();


// === iframe-bridge.js ===
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
