#!/usr/bin/env node
/**
 * Claude Code PermissionRequest hook script.
 * Reads the notification port from .notify-port and POSTs
 * the permission request payload to the collab MCP server,
 * which then pushes a notification to the collab browser widget.
 *
 * Receives the permission request JSON on stdin.
 * Exits silently if the collab browser isn't running (no port file).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT_FILE = resolve(__dirname, '..', '.notify-port');
const WS_PORT_FILE = resolve(__dirname, '..', '.ws-port');

// Read stdin (hook payload)
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  // Collect all candidate ports + auth tokens: Playwright notify port + WS server port
  const targets = []; // { port, token? }
  try {
    const raw = readFileSync(PORT_FILE, 'utf-8').trim();
    const parts = raw.split(':');
    const p = parseInt(parts[0], 10);
    if (p > 0) targets.push({ port: p, token: parts[1] || '' });
  } catch {}
  try {
    const raw = readFileSync(WS_PORT_FILE, 'utf-8').trim();
    const parts = raw.split(':');
    const p = parseInt(parts[0], 10);
    if (p > 0) targets.push({ port: p, token: parts[1] || '' });
  } catch {}

  if (targets.length === 0) process.exit(0);

  // Try each port — if one fails, try the next
  function tryPort(idx) {
    if (idx >= targets.length) { process.exit(0); return; }

    const headers = { 'Content-Type': 'application/json' };
    if (targets[idx].token) {
      headers['Authorization'] = `Bearer ${targets[idx].token}`;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: targets[idx].port,
        path: '/notify',
        method: 'POST',
        headers,
        timeout: 2000,
      },
      (res) => {
        res.resume();
        // Success — done
        process.exit(0);
      },
    );

    req.on('error', () => {
      // This port didn't work — try next
      tryPort(idx + 1);
    });

    req.on('timeout', () => {
      req.destroy();
      tryPort(idx + 1);
    });

    req.write(input || '{}');
    req.end();
  }

  tryPort(0);
});

// Handle case where stdin closes immediately (no data)
process.stdin.on('close', () => {
  if (!input) {
    process.exit(0);
  }
});
