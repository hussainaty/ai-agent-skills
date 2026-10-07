import { chromium, type Browser, type Page, type Frame } from 'playwright';
import { createServer, type Server } from 'http';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { handlePending, handlePeek, handleCancel, handleSetIdle, handleGetIdle } from './pending-handler.js';
import { getWidgetScript, getTabManagerScript, getIframeBridgeInitScript, getInspectorScript, getVoiceModuleScript } from './widget.js';

const __dirname_browser = dirname(fileURLToPath(import.meta.url));
const NOTIFY_PORT_FILE = resolve(__dirname_browser, '..', '.notify-port');

let browser: Browser | null = null;
let page: Page | null = null;
let mode: 'tabs' | 'single' = 'tabs';
let notifyServer: Server | null = null;
let notifyToken: string = '';

/** Get the current session mode. */
export function getMode(): 'tabs' | 'single' {
  return mode;
}

/** Check if running in single-page mode (no iframes). */
export function isSingleMode(): boolean {
  return mode === 'single';
}

/**
 * Launch Playwright's bundled Chromium, turning its cryptic "Executable doesn't
 * exist" error into a clear, actionable one. The bundled browser isn't downloaded
 * by `npm install`, and extension mode never needs it — so tabs/single users who
 * skip `npx playwright install` get told exactly what to run instead of a stack trace.
 */
async function launchChromium(options: Parameters<typeof chromium.launch>[0]): Promise<Browser> {
  try {
    return await chromium.launch(options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new Error(
        "Chromium for tabs/single mode isn't installed. Run `npx playwright install chromium` " +
        'in the collab repo, then try again. (Extension mode uses your real Chrome — no download needed.)',
      );
    }
    throw err;
  }
}

/**
 * Build the wrapper HTML page that hosts the tab bar and widget in the parent frame.
 * Tab manager creates iframes dynamically. Widget floats on top.
 */
function buildWrapperHTML(): string {
  const tabManagerCode = getTabManagerScript();
  const widgetCode = getWidgetScript();
  const inspectorCode = getInspectorScript();
  const voiceCode = getVoiceModuleScript();
  return `<!DOCTYPE html>
<html>
<head>
  <title>Claude Collab</title>
  <style>
    * { margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0e0e1a; }
  </style>
</head>
<body>
  <script>${tabManagerCode}</script>
  <script>${widgetCode}</script>
  <script>${voiceCode}</script>
  <script>${inspectorCode}</script>
</body>
</html>`;
}

/**
 * Ensure browser is launched with the wrapper page loaded.
 * Sets up response interception to strip X-Frame-Options and CSP frame-ancestors,
 * and registers the iframe bridge init script.
 */
export async function ensureBrowser(): Promise<{ browser: Browser; page: Page }> {
  // If already running in single mode, close and restart for tabs
  if (browser && mode === 'single') {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    page = null;
  }

  mode = 'tabs';

  if (browser && browser.isConnected() && page && !page.isClosed()) {
    return { browser, page };
  }

  // Clean up stale state
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
  }

  console.error('[collab] Launching Chromium...');
  browser = await launchChromium({
    headless: false,
    args: [
      '--window-size=1400,900',
      // Note: CORS/localStorage in cross-origin iframes is handled by the route interceptor
      // (frame-ancestors CSP stripping) and the localStorage polyfill addInitScript below.
      '--autoplay-policy=no-user-gesture-required',  // Allow TTS audio playback without user gesture
      '--use-fake-ui-for-media-stream',  // Auto-grant mic/camera permission dialogs
    ],
  });

  const context = await browser.newContext({
    viewport: null,  // Let viewport follow browser window size (enables manual resize)
    permissions: ['microphone'],  // Grant microphone access
  });

  // Strip frame-blocking headers from document responses
  // so target sites load in our iframes
  await context.route('**/*', async (route) => {
    if (route.request().resourceType() === 'document') {
      try {
        const response = await route.fetch();
        const body = await response.body();
        const headers = { ...response.headers() };

        // Remove X-Frame-Options
        delete headers['x-frame-options'];

        // Remove frame-ancestors from CSP (keep other directives)
        if (headers['content-security-policy']) {
          headers['content-security-policy'] = headers['content-security-policy']
            .replace(/\s*frame-ancestors\s+[^;]*(;|$)/gi, '$1');
        }

        // Remove content-encoding — route.fetch() decompresses the body,
        // so we must not tell the browser to decompress again
        delete headers['content-encoding'];
        delete headers['content-length'];

        await route.fulfill({
          status: response.status(),
          headers,
          body,
        });
      } catch (err) {
        console.error('[collab] Route interception error:', err);
        // If fetch fails, let the original request through
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });

  // Polyfill __name helper that tsx/esbuild injects into compiled functions.
  // Without this, any frame.evaluate() that passes a compiled function will fail
  // with "ReferenceError: __name is not defined" in the browser context.
  await context.addInitScript(`if(typeof __name==='undefined'){window.__name=function(t,v){Object.defineProperty(t,"name",{value:v,configurable:true});return t};}`);

  // Polyfill localStorage/sessionStorage when blocked in cross-origin iframes.
  // Runs in ALL frames before any page script. The try-catch ensures it only
  // activates when storage is actually denied.
  // NOTE: Must be a string, not a function — tsx/esbuild transforms functions
  // and injects __name helpers that don't exist in the browser context.
  await context.addInitScript(`(function() {
    function makeStore() {
      var data = {};
      return {
        getItem: function(k) { return data.hasOwnProperty(k) ? data[k] : null; },
        setItem: function(k, v) { data[k] = String(v); },
        removeItem: function(k) { delete data[k]; },
        clear: function() { data = {}; },
        get length() { return Object.keys(data).length; },
        key: function(i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; }
      };
    }
    ['localStorage', 'sessionStorage'].forEach(function(prop) {
      try { window[prop].getItem('__dc_test'); }
      catch(e) {
        try { Object.defineProperty(window, prop, { value: makeStore(), configurable: true }); }
        catch(e2) { /* not configurable */ }
      }
    });
  })();`);

  // Register iframe bridge init script — runs in all frames,
  // but the guard (window.name.startsWith('dc-frame-')) ensures it only
  // activates in our target iframes
  await context.addInitScript(getIframeBridgeInitScript());

  page = await context.newPage();

  // Load the wrapper page with tab manager + widget
  const wrapperHTML = buildWrapperHTML();
  await page.setContent(wrapperHTML, { waitUntil: 'load' });

  // Start notification server for permission request hooks + message relay
  const notifyPort = await startNotifyServer();
  if (notifyPort) await page.evaluate((p: number) => { (window as any).__dcNotifyPort = p; }, notifyPort);

  // Expose a direct bridge function so the widget can relay messages without HTTP
  await exposeRelayFunction(page);

  console.error('[collab] Browser ready (iframe + tabs architecture)');
  return { browser, page };
}

/**
 * Launch browser in single-page mode (no wrapper, no tabs, no iframes).
 * Navigates directly to the URL, injects widget + bridge on the page.
 */
export async function ensureBrowserSingle(url: string): Promise<{ browser: Browser; page: Page }> {
  // If already running in tabs mode, close and restart
  if (browser && mode === 'tabs') {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    page = null;
  }

  mode = 'single';

  if (browser && browser.isConnected() && page && !page.isClosed()) {
    // Browser exists — navigate to new URL and re-inject widget
    console.error(`[collab] Single-page mode: re-navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(getWidgetScript());
    await page.evaluate(getVoiceModuleScript());
    await page.evaluate(getInspectorScript());
    // Re-inject notify port for message relay
    const renavPort = await startNotifyServer();
    if (renavPort) await page.evaluate((p: number) => { (window as any).__dcNotifyPort = p; }, renavPort);
    // Re-expose relay function (lost on navigation)
    await exposeRelayFunction(page);
    return { browser, page };
  }

  // Clean up stale state
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
  }

  console.error('[collab] Launching Chromium (single-page mode)...');
  browser = await launchChromium({
    headless: false,
    args: [
      '--window-size=1400,900',
      '--enable-gpu',
      '--enable-webgl',
      '--use-gl=angle',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',  // Allow TTS audio playback without user gesture
      '--use-fake-ui-for-media-stream',  // Auto-grant mic/camera permission dialogs
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    permissions: ['microphone'],  // Grant microphone access
  });

  // Polyfill __name helper (tsx/esbuild injects it into compiled functions)
  await context.addInitScript(`if(typeof __name==='undefined'){window.__name=function(t,v){Object.defineProperty(t,"name",{value:v,configurable:true});return t};}`);

  // Set window.name so the bridge guard passes, then inject bridge
  await context.addInitScript(`
    if (!window.__dcNameSet) {
      window.name = 'dc-frame-single';
      window.__dcNameSet = true;
    }
  `);
  await context.addInitScript(getIframeBridgeInitScript());

  page = await context.newPage();

  // Navigate to the target URL
  console.error(`[collab] Single-page mode: navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Inject widget + voice module + inspector directly onto the page
  const widgetCode = getWidgetScript();
  const voiceCode = getVoiceModuleScript();
  const inspectorCode = getInspectorScript();
  await page.evaluate(widgetCode);
  await page.evaluate(voiceCode);
  await page.evaluate(inspectorCode);

  // Start notification server for permission request hooks + message relay
  const notifyPort = await startNotifyServer();
  if (notifyPort) await page.evaluate((p: number) => { (window as any).__dcNotifyPort = p; }, notifyPort);

  // Expose a direct bridge function so the widget can relay messages without HTTP
  await exposeRelayFunction(page);

  console.error('[collab] Browser ready (single-page mode)');
  return { browser, page };
}

/**
 * Open a new tab and navigate to URL. Returns the tab ID and frame.
 */
export async function openNewTab(url: string): Promise<{ tabId: number; frame: Frame }> {
  const p = getPage();

  // Create new tab via tab manager
  const tabId = await p.evaluate((u: string) => {
    return window.__dcTabs.createTab(u);
  }, url);

  // Get the frame by name
  const frameName = `dc-frame-${tabId}`;
  const frame = p.frame({ name: frameName });
  if (!frame) {
    throw new Error(`Frame ${frameName} not found after tab creation`);
  }

  // Navigate the frame
  console.error(`[collab] Tab ${tabId}: navigating to ${url}`);
  await frame.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Update tab info with actual page title
  const title = await frame.evaluate(() => document.title).catch(() => '');
  if (title) {
    await p.evaluate(({ id, t }: { id: number; t: string }) => {
      window.__dcTabs.updateTabInfo(id, null, t);
    }, { id: tabId, t: title });
  }

  return { tabId, frame };
}

/**
 * Navigate the active tab's iframe (or page in single mode) to a URL.
 * The iframe bridge script auto-injects via addInitScript.
 */
export async function navigateIframe(url: string): Promise<Frame> {
  const p = getPage();

  if (mode === 'single') {
    console.error(`[collab] Single-page: navigating to ${url}`);
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Re-inject widget + voice + inspector (new page load clears them; bridge re-injects via addInitScript)
    await p.evaluate(getWidgetScript());
    await p.evaluate(getVoiceModuleScript());
    await p.evaluate(getInspectorScript());
    return p.mainFrame();
  }

  const frame = await getActiveFrame();

  console.error(`[collab] Navigating active tab to ${url}`);
  await frame.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Update tab info
  const tabId = await p.evaluate(() => window.__dcTabs.getActiveTabId());
  const title = await frame.evaluate(() => document.title).catch(() => '');
  if (title) {
    await p.evaluate(({ id, u, t }: { id: number; u: string; t: string }) => {
      window.__dcTabs.updateTabInfo(id, u, t);
    }, { id: tabId, u: url, t: title });
  }

  return frame;
}

/**
 * Switch to a different tab by ID.
 */
export async function switchToTab(tabId: number): Promise<void> {
  const p = getPage();
  await p.evaluate((id: number) => {
    window.__dcTabs.switchTab(id);
  }, tabId);
}

/**
 * Close a tab by ID.
 */
export async function closeTabById(tabId: number): Promise<void> {
  const p = getPage();
  await p.evaluate((id: number) => {
    window.__dcTabs.closeTab(id);
  }, tabId);
}

/**
 * List all open tabs.
 */
export async function listAllTabs(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
  const p = getPage();
  return await p.evaluate(() => window.__dcTabs.listTabs());
}

/**
 * Get the parent page (where the widget lives).
 * Use this for chat, preview, and widget API interactions.
 */
export function isBrowserReady(): boolean {
  return !!(page && !page.isClosed());
}

export function getPage(): Page {
  if (!page || page.isClosed()) {
    throw new Error('No active browser page. Call collab_browse first.');
  }
  return page;
}

/**
 * Get the active tab's frame asynchronously (more reliable with multiple tabs).
 * In single mode, returns the main frame directly.
 */
export async function getActiveFrame(): Promise<Frame> {
  const p = getPage();

  if (mode === 'single') {
    return p.mainFrame();
  }

  const frameName = await p.evaluate(() => window.__dcTabs.getActiveFrameName());
  const frame = p.frame({ name: frameName });
  if (!frame) {
    throw new Error(`Active frame ${frameName} not found. Call collab_browse first.`);
  }
  return frame;
}

/**
 * Start the notification HTTP server.
 * Listens on a random port, writes port to .notify-port file.
 * When a POST /notify arrives, pushes a notification to the browser widget.
 */
function startNotifyServer(): Promise<number> {
  if (notifyServer) {
    const addr = notifyServer.address();
    return Promise.resolve(addr && typeof addr !== 'string' ? addr.port : 0);
  }

  notifyToken = randomBytes(32).toString('hex');

  return new Promise((resolvePort) => {
  notifyServer = createServer((req, res) => {
    // --- GET /pending — return unread user messages (advances cursor) ---
    if (req.method === 'GET' && req.url === '/pending') {
      handlePending(req, res, notifyToken);
      return;
    }

    // --- GET /peek — return unread messages WITHOUT advancing cursor ---
    if (req.method === 'GET' && req.url === '/peek') {
      handlePeek(req, res, notifyToken);
      return;
    }

    // --- GET /cancel — check cancel flag, peek at messages ---
    if (req.method === 'GET' && req.url === '/cancel') {
      handleCancel(req, res, notifyToken);
      return;
    }

    // --- POST /idle — set idle flag (called by Stop hook) ---
    if (req.method === 'POST' && req.url === '/idle') {
      handleSetIdle(req, res, notifyToken);
      return;
    }

    // --- GET /idle — check idle flag (called by listener) ---
    if (req.method === 'GET' && req.url === '/idle') {
      handleGetIdle(req, res, notifyToken);
      return;
    }

    if (req.method === 'POST' && req.url === '/notify') {
      let body = '';
      let bodySize = 0;
      req.on('error', () => { try { res.writeHead(400); res.end(); } catch {} });
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > 65536) { res.writeHead(413); res.end(); req.destroy(); return; }
        body += chunk.toString();
      });
      req.on('end', () => {
        // Parse the hook payload (tool_name, tool_input)
        let toolName = 'a tool';
        try {
          const payload = JSON.parse(body);
          toolName = payload.tool_name || 'a tool';
        } catch { /* use default */ }

        // Push notification to browser if page is available
        if (page && !page.isClosed()) {
          page.evaluate((tool: string) => {
            // Show chat notification
            if (window.__dc?.api) {
              window.__dc.api.say(`⚡ Need your attention in the terminal — approving: ${tool}`);
            }
            // Play notification sound
            try {
              const ctx = new AudioContext();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.frequency.value = 880;
              osc.type = 'sine';
              gain.gain.setValueAtTime(0.3, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
              osc.start(ctx.currentTime);
              osc.stop(ctx.currentTime + 0.3);
            } catch { /* audio not available */ }
          }, toolName).catch(() => { /* page might be closed */ });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else if (req.method === 'OPTIONS') {
      // No CORS headers: this server is only called by local Node hook
      // scripts (no browser origin), and it binds to 127.0.0.1 anyway.
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  notifyServer.listen(0, '127.0.0.1', () => {
    const addr = notifyServer!.address();
    if (addr && typeof addr !== 'string') {
      const port = addr.port;
      // Store port and auth token so hooks can authenticate
      writeFileSync(NOTIFY_PORT_FILE, `${port}:${notifyToken}`, { encoding: 'utf-8', mode: 0o600 });
      console.error(`[collab] Notify server listening on port ${port}`);
      resolvePort(port);
    } else {
      resolvePort(0);
    }
  });
  }); // end Promise
}

/**
 * Expose a bridge function on the page so the widget can relay messages
 * directly to Node.js via Chrome DevTools Protocol — no HTTP, no mixed content issues.
 */
async function exposeRelayFunction(p: Page): Promise<void> {
  try {
    // No-op: widget state (window.__dc.messages) is the source of truth now.
    // Keep the function exposed so the widget doesn't throw when calling it.
    await p.exposeFunction('__dcRelayMessage', (_text: string, _selectionsJson?: string) => {});
  } catch {
    // Already exposed (e.g. re-navigation in tabs mode) — ignore
  }
  try {
    // No-op: widget sets cancelRequested directly in state now.
    await p.exposeFunction('__dcRelayCancel', () => {});
  } catch {
    // Already exposed — ignore
  }
  try {
    await p.exposeFunction('__dcTakeScreenshot', async (optsJson: string) => {
      try {
        const opts = JSON.parse(optsJson);
        const screenshotPage = getPage();
        // Hide collab elements before screenshot
        await screenshotPage.evaluate(() => {
          const sels = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
          document.querySelectorAll(sels).forEach((el: any) => { el.dataset.dcHidden = el.style.display; el.style.display = 'none'; });
        });
        try {
          const buf = await screenshotPage.screenshot({
            type: 'png',
            fullPage: !!opts.fullPage,
            clip: opts.x !== undefined && opts.w > 0 ? { x: opts.x, y: opts.y, width: opts.w, height: opts.h } : undefined,
          });
          return buf.toString('base64');
        } finally {
          // Restore collab elements
          await screenshotPage.evaluate(() => {
            const sels = '.dc-chat, .dc-preview, .dc-status-console, .dci-panel, .dci-snap-preview, .dc-capture-overlay, [id^="dc-panel-"]';
            document.querySelectorAll(sels).forEach((el: any) => { el.style.display = el.dataset.dcHidden || ''; delete el.dataset.dcHidden; });
          });
        }
      } catch (err) {
        console.error('[collab] Screenshot failed:', err);
        return null;
      }
    });
  } catch {
    // Already exposed — ignore
  }
}

/**
 * Stop the notification server and clean up port file.
 */
function stopNotifyServer(): void {
  if (notifyServer) {
    notifyServer.close();
    notifyServer = null;
  }
  try { unlinkSync(NOTIFY_PORT_FILE); } catch { /* file may not exist */ }
}

/**
 * Clean up browser on exit.
 */
export async function cleanup(): Promise<void> {
  console.error('[collab] Cleaning up...');
  stopNotifyServer();
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    page = null;
  }
  mode = 'tabs';
}
