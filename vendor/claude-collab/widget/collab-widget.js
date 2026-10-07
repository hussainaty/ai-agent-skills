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
