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
