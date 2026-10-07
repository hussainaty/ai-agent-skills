/**
 * Extension-backed transport for Claude Collab.
 *
 * Proxies all tool commands over WebSocket to the Chrome extension.
 * The extension's service worker executes commands in the browser
 * and sends results back.
 */

import type { DesignTransport, ScreenshotOpts } from './transport.js';
import { serializeEval } from './transport.js';
import type { TabInfo } from './types.js';
import type { WebSocketConnection } from './ws-server.js';
import { startWSServer, waitForExtension, stopWSServer, isExtensionConnected, getExtensionConnection, onExtensionReconnect, getWSToken, sanitizeError } from './ws-server.js';
import { pushMessage, requestCancel } from './message-store.js';

let requestId = 0;

export class ExtensionTransport implements DesignTransport {
  private conn: WebSocketConnection | null = null;
  // Connections that already have a message handler — setupMessageHandler is
  // reachable from both onExtensionReconnect and connectExisting (repeat
  // collab_browse calls), and double-attaching duplicates every user message
  private handledConns = new WeakSet<WebSocketConnection>();
  private pending = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private managedTabs = new Set<number>();
  private activeTabId: number | null = null;
  private wsPort: number = 0;

  /** Phase 1: Start WS server only (non-blocking). Returns port + token for the user. */
  async initServer(): Promise<{ port: number; token: string }> {
    this.wsPort = await startWSServer();

    // Register reconnection handler early (before first connection)
    onExtensionReconnect((newConn) => {
      console.error('[collab] Extension reconnected — re-attaching message handler');
      for (const [, { reject }] of this.pending) {
        reject(new Error('Extension reconnected'));
      }
      this.pending.clear();
      this.conn = newConn;
      this.setupMessageHandler();
    });

    return { port: this.wsPort, token: getWSToken() };
  }

  /** Phase 2: Wait for the extension to connect (blocking). */
  async waitForConnection(timeoutMs: number = 120000): Promise<void> {
    console.error(`[collab] Waiting for extension to connect on ws://127.0.0.1:${this.wsPort}/ext ...`);
    this.conn = await waitForExtension(timeoutMs);
    this.setupMessageHandler();
  }

  /** Combined init: start WS server and wait for extension to connect. */
  async init(timeoutMs: number = 60000): Promise<void> {
    await this.initServer();
    await this.waitForConnection(timeoutMs);
  }

  /** Connect to an already-connected extension. */
  connectExisting(): void {
    this.conn = getExtensionConnection();
    if (!this.conn) throw new Error('No extension connected');
    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    if (!this.conn) return;
    if (this.handledConns.has(this.conn)) return; // already wired — avoid duplicate delivery
    this.handledConns.add(this.conn);
    // Capture the connection this handler set belongs to — the close handler
    // must not act if a newer connection has already replaced it (a stale
    // socket's delayed close event would otherwise orphan the live one)
    const conn = this.conn;

    conn.on('message', (data: any) => {
      try {
        const text = typeof data === 'string' ? data : data.toString();
        const msg = JSON.parse(text);

        // Response to a pending request
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.type === 'error') {
            reject(new Error(sanitizeError(msg.message || 'Extension error')));
          } else {
            resolve(msg.data);
          }
          return;
        }

        // Unsolicited events from extension (user messages, cancels)
        // Store server-side so /pending can respond instantly without evalWidget round-trip
        if (msg.type === 'event') {
          if (msg.eventType === 'message' && msg.data?.text) {
            pushMessage(msg.data.text, msg.data.selections, msg.data.imageData, msg.data.mimeType);
            console.error(`[collab] User message stored: "${msg.data.text.slice(0, 80)}"${msg.data.imageData ? ' [+image]' : ''}`);
          } else if (msg.eventType === 'cancel') {
            requestCancel();
            console.error('[collab] Cancel requested');
          } else if (msg.eventType === 'tab-switch' && msg.data?.tabId) {
            this.activeTabId = msg.data.tabId;
            this.managedTabs.add(msg.data.tabId);
            console.error(`[collab] Tab switched to ${msg.data.tabId} (${msg.data.url?.slice(0, 60) || '?'})`);
          }
        }
      } catch (err) {
        console.error('[collab] Failed to parse extension message:', err);
      }
    });

    conn.on('close', () => {
      if (this.conn !== conn) return; // a newer connection already took over
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error('Extension disconnected'));
      }
      this.pending.clear();
      this.conn = null;
    });
  }

  private send(msg: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.conn) {
        return reject(new Error('Extension not connected'));
      }

      const id = `req-${++requestId}`;

      // Timeout after 30 seconds — cleared on resolve/reject to prevent leaks
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Extension request timeout: ${msg.type}`));
        }
      }, 30000);

      this.pending.set(id, {
        resolve: (val: any) => { clearTimeout(timer); resolve(val); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      });

      this.conn.send(JSON.stringify({ id, ...msg }));
    });
  }

  /** Deliver an AI chat message to all widget tabs via structured command —
   *  no eval(), so it works on strict-CSP pages (eval-based delivery doesn't). */
  async deliverChat(text: string): Promise<void> {
    await this.send({ type: 'chat-deliver', text });
  }

  async evalWidget(fnOrCode: Function | string, arg?: any): Promise<any> {
    const code = typeof fnOrCode === 'string' ? fnOrCode : serializeEval(fnOrCode, arg);
    return await this.send({
      type: 'eval-widget',
      code,
      tabId: this.activeTabId,
    });
  }

  async evalFrame(fnOrCode: Function | string, arg?: any): Promise<any> {
    const code = typeof fnOrCode === 'string' ? fnOrCode : serializeEval(fnOrCode, arg);
    return await this.send({
      type: 'eval-frame',
      code,
      tabId: this.activeTabId,
    });
  }

  async browse(url: string): Promise<{ tabId: number }> {
    const result = await this.send({
      type: 'tab-action',
      action: 'create',
      url,
    });
    const tabId = result.tabId;
    this.managedTabs.add(tabId);
    this.activeTabId = tabId;

    // Inject widget into the new tab
    await this.send({
      type: 'inject-widget',
      tabId,
    });

    return { tabId };
  }

  /** Join the user's currently active tab instead of opening a new one. */
  async attach(): Promise<{ tabId: number; url: string }> {
    const result = await this.send({
      type: 'tab-action',
      action: 'attach',
    });
    const tabId = result.tabId;
    this.managedTabs.add(tabId);
    this.activeTabId = tabId;

    await this.send({
      type: 'inject-widget',
      tabId,
    });

    return { tabId, url: result.url };
  }

  async navigate(url: string): Promise<string> {
    const result = await this.send({
      type: 'tab-action',
      action: 'navigate',
      tabId: this.activeTabId,
      url,
    });
    return result.url;
  }

  async listTabs(): Promise<TabInfo[]> {
    const result = await this.send({
      type: 'tab-action',
      action: 'list',
      managedTabIds: [...this.managedTabs],
    });
    return result.tabs;
  }

  async switchTab(tabId: number): Promise<void> {
    await this.send({
      type: 'tab-action',
      action: 'switch',
      tabId,
    });
    this.activeTabId = tabId;
  }

  async closeTab(tabId: number): Promise<void> {
    await this.send({
      type: 'tab-action',
      action: 'close',
      tabId,
    });
    this.managedTabs.delete(tabId);
    if (this.activeTabId === tabId) {
      // Switch to another managed tab if available
      this.activeTabId = this.managedTabs.size > 0
        ? [...this.managedTabs][this.managedTabs.size - 1]
        : null;
    }
  }

  async screenshot(opts?: ScreenshotOpts): Promise<Buffer> {
    const result = await this.send({
      type: 'screenshot',
      tabId: this.activeTabId,
      opts: opts || {},
    });
    // Extension returns base64 string
    return Buffer.from(result.data, 'base64');
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.send({
      type: 'set-viewport',
      tabId: this.activeTabId,
      ...size,
    });
  }

  async getViewportSize(): Promise<{ width: number; height: number } | null> {
    return await this.evalFrame(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }

  isReady(): boolean {
    return this.conn !== null && isExtensionConnected();
  }

  getMode(): 'tabs' | 'single' | 'extension' {
    return 'extension';
  }

  async cleanup(): Promise<void> {
    // Tell the service worker to clean up: remove widgets from followed tabs,
    // close only originally-created tabs, clear chat history
    try {
      await this.send({ type: 'cleanup' });
    } catch { /* ignore */ }

    this.managedTabs.clear();
    this.activeTabId = null;

    // Close WebSocket
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }

    stopWSServer();
  }

  /** Get the WebSocket port for the extension to connect to. */
  getWSPort(): number {
    return this.wsPort;
  }
}
