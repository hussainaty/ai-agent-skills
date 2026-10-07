#!/usr/bin/env node
/**
 * PostToolUse hook for collab. LEGACY — not installed by setup.cjs.
 *
 * The canonical configuration delivers messages via cancel-hook.cjs on
 * PreToolUse (it checks both /cancel and /pending before every tool call),
 * making this PostToolUse variant redundant. Kept for setups that prefer
 * post-call delivery.
 *
 * Queries the MCP server's GET /pending endpoint to fetch unread user
 * messages from the widget state. Outputs them so Claude sees them
 * after every tool call.
 *
 * Tries .notify-port (Playwright mode) then .ws-port (extension mode).
 * CommonJS for fast startup (no tsx needed). Runs in <100ms.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');
const NOTIFY_PORT_FILE = path.join(PROJECT_ROOT, '.notify-port');
const WS_PORT_FILE = path.join(PROJECT_ROOT, '.ws-port');

// Collect candidate ports + tokens from port files
const targets = [];
for (const file of [NOTIFY_PORT_FILE, WS_PORT_FILE]) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    const parts = raw.split(':');
    const port = parseInt(parts[0], 10);
    const token = parts.slice(1).join(':'); // token may contain colons
    if (port > 0) targets.push({ port, token });
  } catch {}
}

if (targets.length === 0) process.exit(0); // No collab session

function tryPort(idx) {
  if (idx >= targets.length) {
    // All ports failed — check if listener is alive and remind if not
    checkListener();
    process.exit(0);
  }

  const { port, token } = targets[idx];
  console.error(`[event-hook] GET /pending on port ${port}...`);
  const startTime = Date.now();
  const req = http.get(
    {
      hostname: '127.0.0.1',
      port,
      path: '/pending',
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 2000,
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        console.error(`[event-hook] Response ${res.statusCode} in ${elapsed}ms: ${body.slice(0, 200)}`);
        try {
          const data = JSON.parse(body);
          const output = [];

          if (data.messages && data.messages.length > 0) {
            output.push('[COLLAB] User said: ' + data.messages.map(m => m.text).join(' | '));
            for (const m of data.messages) {
              if (m.selections && m.selections.length > 0) {
                output.push('[COLLAB] Selected elements: ' + JSON.stringify(m.selections));
              }
            }
          }

          if (output.length > 0) {
            console.error(`[event-hook] Outputting: ${output[0]}`);
            console.log(output.join('\n'));
          }
        } catch (e) { console.error(`[event-hook] Parse error: ${e}`); }

        checkListener();
      });
    },
  );

  req.on('error', (e) => { console.error(`[event-hook] Port ${port} error: ${e.message}`); tryPort(idx + 1); });
  req.on('timeout', () => { console.error(`[event-hook] Port ${port} TIMEOUT`); req.destroy(); tryPort(idx + 1); });
}

// Check if listener is alive — if not, remind Claude to restart it
function checkListener() {
  const pidFile = path.join(PROJECT_ROOT, '.listener-pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    process.kill(pid, 0); // signal 0 = just check if alive
    return; // Listener is alive
  } catch {}

  const listenerPath = path.join(__dirname, 'listener.cjs');
  console.log(`[COLLAB-LISTENER-DOWN] The background listener is not running. Start it NOW with run_in_background: true:\nnode "${listenerPath}"`);
}

tryPort(0);
