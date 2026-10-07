/**
 * Claude Collab — Tab Manager
 * Manages multiple iframes in the wrapper page, providing a browser-like
 * tab experience. The chat widget stays fixed while tabs switch underneath.
 *
 * Exposes window.__dcTabs API for browser.ts to call via page.evaluate().
 * Tab bar is interactive — user can click tabs, close them, etc.
 */
(() => {
  if (window.__dcTabs) return;

  let tabCounter = 0;
  let activeTabId = 0;
  const tabs = new Map(); // id → { id, url, title, iframe }

  // ==================== DOM SETUP ====================
  const tabBar = document.createElement('div');
  tabBar.id = 'dc-tab-bar';

  const tabList = document.createElement('div');
  tabList.id = 'dc-tab-list';
  tabBar.appendChild(tabList);

  const framesContainer = document.createElement('div');
  framesContainer.id = 'dc-frames-container';

  // Insert tab bar and frames container, move any existing iframe into container
  const existingFrame = document.getElementById('dc-frame');
  if (existingFrame) {
    existingFrame.remove();
  }

  document.body.insertBefore(tabBar, document.body.firstChild);
  document.body.appendChild(framesContainer);

  // ==================== STYLES ====================
  const style = document.createElement('style');
  style.id = 'dc-tab-styles';
  style.textContent = `
    #dc-tab-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 36px;
      background: #0e0e1a;
      border-bottom: 1px solid #1e1e3a;
      display: flex;
      align-items: center;
      z-index: 2147483640;
      padding: 0 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      transition: background 0.3s, border-color 0.3s;
    }
    #dc-tab-bar.dc-light-bar {
      background: #f0f0f4;
      border-bottom-color: #d0d0d8;
    }
    #dc-tab-list {
      display: flex;
      gap: 2px;
      overflow-x: auto;
      flex: 1;
      align-items: center;
      height: 100%;
      scrollbar-width: none;
    }
    #dc-tab-list::-webkit-scrollbar { display: none; }
    .dc-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      height: 28px;
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      color: #888;
      white-space: nowrap;
      max-width: 180px;
      overflow: hidden;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
      user-select: none;
    }
    .dc-tab:hover { background: rgba(255,255,255,0.08); color: #bbb; }
    .dc-tab.dc-tab-active {
      background: rgba(99,102,241,0.15);
      color: #c4c4ff;
    }
    .dc-light-bar .dc-tab {
      background: rgba(0,0,0,0.04);
      color: #666;
    }
    .dc-light-bar .dc-tab:hover {
      background: rgba(0,0,0,0.08);
      color: #444;
    }
    .dc-light-bar .dc-tab.dc-tab-active {
      background: rgba(99,102,241,0.12);
      color: #4338ca;
    }
    .dc-tab-title {
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .dc-tab-close {
      all: unset;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      font-size: 14px;
      color: #555;
      cursor: pointer;
      flex-shrink: 0;
      line-height: 1;
    }
    .dc-tab-close:hover { background: rgba(255,255,255,0.1); color: #f87171; }
    .dc-light-bar .dc-tab-close:hover { background: rgba(0,0,0,0.08); color: #ef4444; }
    #dc-frames-container {
      position: fixed;
      top: 36px;
      left: 0;
      right: 0;
      bottom: 0;
    }
    .dc-frame {
      width: 100%;
      height: 100%;
      border: none;
      position: absolute;
      top: 0;
      left: 0;
      background: #fff;
      display: none;
    }
    .dc-frame.dc-frame-active {
      display: block;
    }
  `;
  document.head.appendChild(style);

  // ==================== TAB RENDERING ====================
  function renderTabBar() {
    tabList.replaceChildren();
    for (const [id, tab] of tabs) {
      const el = document.createElement('div');
      el.className = 'dc-tab' + (id === activeTabId ? ' dc-tab-active' : '');
      el.dataset.tabId = String(id);

      const title = document.createElement('span');
      title.className = 'dc-tab-title';
      title.textContent = tab.title || 'New Tab';
      el.appendChild(title);

      // Only show close button if more than 1 tab
      if (tabs.size > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'dc-tab-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.title = 'Close tab';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(id);
        });
        el.appendChild(closeBtn);
      }

      el.addEventListener('click', () => switchTab(id));
      tabList.appendChild(el);
    }
  }

  // ==================== TAB MANAGEMENT ====================
  function createTab(url, title) {
    tabCounter++;
    const id = tabCounter;
    const frameName = 'dc-frame-' + id;

    const iframe = document.createElement('iframe');
    iframe.id = frameName;
    iframe.name = frameName;
    iframe.className = 'dc-frame';
    framesContainer.appendChild(iframe);

    tabs.set(id, {
      id,
      url: url || 'about:blank',
      title: title || 'New Tab',
      iframe,
    });

    // Switch to the new tab
    switchTab(id);
    renderTabBar();

    return id;
  }

  function switchTab(id) {
    if (!tabs.has(id)) return;

    // Hide all frames, show target
    for (const [tabId, tab] of tabs) {
      tab.iframe.classList.toggle('dc-frame-active', tabId === id);
    }

    activeTabId = id;
    renderTabBar();
  }

  function closeTab(id) {
    if (!tabs.has(id)) return;
    if (tabs.size <= 1) return; // Keep at least one tab

    const tab = tabs.get(id);
    tab.iframe.remove();
    tabs.delete(id);

    // If closing active tab, switch to another
    if (activeTabId === id) {
      const remaining = [...tabs.keys()];
      switchTab(remaining[remaining.length - 1]);
    }

    renderTabBar();
  }

  function getActiveTabId() {
    return activeTabId;
  }

  function getActiveFrameName() {
    return 'dc-frame-' + activeTabId;
  }

  function listTabs() {
    const result = [];
    for (const [id, tab] of tabs) {
      result.push({
        id,
        url: tab.url,
        title: tab.title,
        active: id === activeTabId,
        frameName: 'dc-frame-' + id,
      });
    }
    return result;
  }

  function updateTabInfo(id, url, title) {
    if (!tabs.has(id)) return;
    const tab = tabs.get(id);
    if (url) tab.url = url;
    if (title) tab.title = title;
    renderTabBar();
  }

  // ==================== THEME ====================
  function setBarTheme(isDark) {
    tabBar.classList.toggle('dc-light-bar', !isDark);
  }

  // ==================== CREATE INITIAL TAB ====================
  createTab('about:blank', 'New Tab');

  // ==================== EXPOSE API ====================
  window.__dcTabs = {
    createTab,
    switchTab,
    closeTab,
    getActiveTabId,
    getActiveFrameName,
    listTabs,
    updateTabInfo,
    setBarTheme,
  };
})();
