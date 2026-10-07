#!/usr/bin/env node
/**
 * Stop hook — fires when Claude finishes its turn and goes idle.
 *
 * 1. Listener gate: if the background listener is not running, BLOCKS the
 *    stop (exit 2) so Claude must restart it before going idle — otherwise
 *    the session goes deaf to widget messages. Escape hatch: if this stop
 *    was already triggered by a stop-hook block (stop_hook_active), allow
 *    it through rather than looping forever on a failing restart.
 * 2. Sets the idle flag on the MCP server via POST /idle, signaling
 *    the background listener that it's safe to consume pending messages.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');
const NOTIFY_PORT_FILE = path.join(PROJECT_ROOT, '.notify-port');
const WS_PORT_FILE = path.join(PROJECT_ROOT, '.ws-port');

// Collect candidate ports + tokens
const targets = [];
for (const file of [NOTIFY_PORT_FILE, WS_PORT_FILE]) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    const parts = raw.split(':');
    const port = parseInt(parts[0], 10);
    const token = parts.slice(1).join(':');
    if (port > 0) targets.push({ port, token });
  } catch {}
}

if (targets.length === 0) process.exit(0); // No collab session

// Only the collab-owning session may set the idle flag — a different session
// going idle must not trigger message delivery into this one
const OWNER_FILE = path.join(PROJECT_ROOT, '.owner-session');
let hookInput = {};
try { hookInput = JSON.parse(fs.readFileSync(0, 'utf-8')) || {}; } catch {}
try {
  const owner = fs.readFileSync(OWNER_FILE, 'utf-8').trim();
  const sessionId = String(hookInput.session_id || '');
  if (owner && sessionId && owner !== sessionId) process.exit(0);
} catch {} // no owner file or unparsable stdin — proceed (pre-claim sessions)

// Listener gate: going idle without a live listener means the session is
// deaf to widget messages. Block the stop so Claude restarts it first.
const PID_FILE = path.join(PROJECT_ROOT, '.listener-pid');
let listenerAlive = false;
try {
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  process.kill(pid, 0); // signal 0 = liveness check only
  listenerAlive = true;
} catch {}

if (!listenerAlive && !hookInput.stop_hook_active) {
  const listenerPath = path.join(__dirname, 'listener.cjs');
  process.stderr.write(
    'BLOCKED: the collab listener is not running — if you go idle now you cannot hear the user. ' +
    'Start it with the Bash tool (run_in_background: true):\nnode "' + listenerPath + '"\n' +
    'Then end your turn.',
  );
  process.exit(2);
}

function tryPort(idx) {
  if (idx >= targets.length) {
    process.exit(0); // All ports failed — nothing to do
  }

  const { port, token } = targets[idx];
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/idle',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Length': '0',
      },
      timeout: 2000,
    },
    (res) => {
      // Drain response
      res.on('data', () => {});
      res.on('end', () => {
        console.error(`[stop-hook] Set idle flag on port ${port}`);
        process.exit(0);
      });
    },
  );

  req.on('error', () => tryPort(idx + 1));
  req.on('timeout', () => { req.destroy(); tryPort(idx + 1); });
  req.end();
}

tryPort(0);
