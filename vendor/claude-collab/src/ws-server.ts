/**
 * WebSocket server for Chrome extension communication.
 *
 * Uses the `ws` package for a reliable WebSocket implementation.
 * The extension's service worker connects here and receives
 * commands (eval, screenshot, tab-action) as JSON messages.
 */

import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { handlePending, handlePeek, handleCancel, handleSetIdle, handleGetIdle } from './pending-handler.js';

const __dirname_ws = dirname(fileURLToPath(import.meta.url));
const WS_PORT_FILE = resolve(__dirname_ws, '..', '.ws-port');
const NOTIFY_PORT_FILE = resolve(__dirname_ws, '..', '.notify-port');

// Re-export WebSocket as our connection type so extension-transport.ts can use it
export type WebSocketConnection = WebSocket;

/** Strip file paths and limit length in error messages before sending externally. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/[A-Z]:\\[^\s'"]+/gi, '[path]')
    .replace(/\/(?:home|Users|tmp|var|etc|usr|opt)[^\s'"]+/g, '[path]')
    .slice(0, 500);
}

// Fixed port range — extension auto-connects to these without manual config
const DEFAULT_PORT = 19876;
const MAX_PORT_ATTEMPTS = 5;

let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;
let activeConnection: WebSocket | null = null;
let connectionListeners: Array<(conn: WebSocket) => void> = [];
let reconnectListeners: Array<(conn: WebSocket) => void> = [];
let boundPort: number = 0;
let authToken: string = '';

/** Get the port the WS server is running on. */
export function getWSPort(): number {
  return boundPort;
}

/** Get the auth token for the current session. */
export function getWSToken(): string {
  return authToken;
}

/**
 * Start the WebSocket server on a fixed port (19876 by default).
 * Falls back to 19877, 19878, etc. if the port is taken.
 * Returns the port number.
 */
export function startWSServer(): Promise<number> {
  if (httpServer) {
    return Promise.resolve(boundPort);
  }

  authToken = randomBytes(32).toString('hex');
  return tryListenOnPort(DEFAULT_PORT, 0);
}

function tryListenOnPort(port: number, attempt: number): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer((req, res) => {
      // --- GET /pending — return unread user messages (advances cursor) ---
      if (req.method === 'GET' && req.url === '/pending') {
        handlePending(req, res, authToken);
        return;
      }

      // --- GET /peek — return unread messages WITHOUT advancing cursor ---
      if (req.method === 'GET' && req.url === '/peek') {
        handlePeek(req, res, authToken);
        return;
      }

      // --- GET /cancel — check cancel flag, peek at messages ---
      if (req.method === 'GET' && req.url === '/cancel') {
        handleCancel(req, res, authToken);
        return;
      }

      // --- POST /idle — set idle flag (called by Stop hook) ---
      if (req.method === 'POST' && req.url === '/idle') {
        handleSetIdle(req, res, authToken);
        return;
      }

      // --- GET /idle — check idle flag (called by listener) ---
      if (req.method === 'GET' && req.url === '/idle') {
        handleGetIdle(req, res, authToken);
        return;
      }

      // Health check — does NOT expose the auth token (token is in .ws-port file
      // and shown in terminal output; the extension reads it from there or user pastes it).
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, connected: !!activeConnection }));
        return;
      }

      // Notify endpoint — permission request hook sends here in extension mode.
      // Forwards the notification to the widget via WebSocket → extension → eval.
      // Requires Bearer auth token to prevent unauthorized notifications.
      if (req.method === 'POST' && req.url === '/notify') {
        const authHeader = req.headers['authorization'] || '';
        if (authHeader !== `Bearer ${authToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"error":"unauthorized"}');
          return;
        }
        let body = '';
        let bodySize = 0;
        req.on('data', (chunk: Buffer) => {
          bodySize += chunk.length;
          if (bodySize > 65536) { res.writeHead(413); res.end(); req.destroy(); return; }
          body += chunk.toString();
        });
        req.on('end', () => {
          let toolName = 'a tool';
          try { toolName = JSON.parse(body).tool_name || 'a tool'; } catch {}

          if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
            const safeToolName = JSON.stringify(String(toolName)).slice(1, -1); // escape for safe interpolation
            activeConnection.send(JSON.stringify({
              type: 'notify',
              code: `(() => {
                if (window.__dc && window.__dc.api) {
                  window.__dc.api.say('⚡ Need your attention in the terminal — approving: ${safeToolName}');
                }
                try {
                  const ctx = new AudioContext();
                  const osc = ctx.createOscillator();
                  const gain = ctx.createGain();
                  osc.connect(gain); gain.connect(ctx.destination);
                  osc.frequency.value = 880; osc.type = 'sine';
                  gain.gain.setValueAtTime(0.3, ctx.currentTime);
                  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
                  osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
                } catch {}
              })()`,
            }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    // No verifyClient — auth is done via the first message (keeps token out of URLs/logs)
    const wsServer = new WebSocketServer({ server, path: '/ext', maxPayload: 10 * 1024 * 1024 });

    wsServer.on('connection', (ws) => {
      // Don't set activeConnection yet — wait for first-message auth.
      // The extension must send { type: 'connected', token: '...' } as its first message.
      let authenticated = false;
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          console.error('[collab] WS connection closed: no auth within 5s');
          ws.close(4001, 'Auth timeout');
        }
      }, 5000);

      const authHandler = (data: any) => {
        try {
          const text = typeof data === 'string' ? data : data.toString();
          const msg = JSON.parse(text);

          if (msg.type === 'connected' && msg.token === authToken) {
            authenticated = true;
            clearTimeout(authTimeout);
            ws.removeListener('message', authHandler);

            activeConnection = ws;
            console.error('[collab] Extension authenticated and connected');

            // Notify any pending first-connection listeners (consumed once)
            for (const listener of connectionListeners) {
              listener(ws);
            }
            connectionListeners = [];

            // Notify persistent reconnection listeners (kept across reconnects)
            for (const listener of reconnectListeners) {
              listener(ws);
            }
          } else {
            console.error('[collab] WS auth failed: invalid token or wrong first message');
            clearTimeout(authTimeout);
            ws.close(4003, 'Invalid token');
          }
        } catch {
          console.error('[collab] WS auth failed: malformed first message');
          clearTimeout(authTimeout);
          ws.close(4003, 'Malformed auth');
        }
      };

      ws.on('message', authHandler);

      ws.on('close', () => {
        clearTimeout(authTimeout);
        console.error('[collab] Extension disconnected');
        if (activeConnection === ws) {
          activeConnection = null;
        }
      });

      ws.on('error', (err) => {
        console.error('[collab] WebSocket error:', err);
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
        console.error(`[collab] Port ${port} in use, trying ${port + 1}...`);
        resolvePort(tryListenOnPort(port + 1, attempt + 1) as any);
      } else {
        console.error(`[collab] Failed to start WS server:`, err);
        resolvePort(0);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      httpServer = server;
      wss = wsServer;
      boundPort = port;
      writeFileSync(WS_PORT_FILE, `${port}:${authToken}`, { encoding: 'utf-8', mode: 0o600 });
      // Clean up stale notify-port from previous Playwright sessions
      try { unlinkSync(NOTIFY_PORT_FILE); } catch { /* may not exist */ }
      console.error(`[collab] WebSocket server listening on port ${port}`);
      console.error(`[collab] Auth token: ${authToken}`);
      resolvePort(port);
    });
  });
}

/** Get the active extension connection, or null. */
export function getExtensionConnection(): WebSocket | null {
  return activeConnection;
}

/** Check if an extension is connected. */
export function isExtensionConnected(): boolean {
  return activeConnection !== null && activeConnection.readyState === WebSocket.OPEN;
}

/** Register a persistent listener that fires on every reconnection. */
export function onExtensionReconnect(listener: (conn: WebSocket) => void): void {
  reconnectListeners.push(listener);
}

/** Wait for an extension to connect (with timeout). */
export function waitForExtension(timeoutMs = 30000): Promise<WebSocket> {
  if (activeConnection && activeConnection.readyState === WebSocket.OPEN) {
    return Promise.resolve(activeConnection);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = connectionListeners.indexOf(listener);
      if (idx >= 0) connectionListeners.splice(idx, 1);
      reject(new Error('Extension connection timeout'));
    }, timeoutMs);

    const listener = (conn: WebSocket) => {
      clearTimeout(timer);
      resolve(conn);
    };
    connectionListeners.push(listener);
  });
}

/** Stop the WebSocket server. */
export function stopWSServer(): void {
  if (activeConnection) {
    activeConnection.close();
    activeConnection = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  reconnectListeners = [];
  try { unlinkSync(WS_PORT_FILE); } catch { /* may not exist */ }
}
