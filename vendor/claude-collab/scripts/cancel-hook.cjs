#!/usr/bin/env node
/**
 * PreToolUse hook — intercepts cancel events AND regular user messages.
 *
 * Checks in order:
 *   1. GET /cancel — if cancel flag is set, blocks the tool (exit 2)
 *   2. GET /pending — if regular messages are pending, consumes and
 *      delivers them by blocking the tool (exit 2). Claude sees the
 *      message and decides whether to stop or incorporate it.
 *
 * If nothing is pending: exits 0 (tool proceeds normally).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');
const NOTIFY_PORT_FILE = path.join(PROJECT_ROOT, '.notify-port');
const WS_PORT_FILE = path.join(PROJECT_ROOT, '.ws-port');
const OWNER_FILE = path.join(PROJECT_ROOT, '.owner-session');

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

// This hook is installed globally and fires in EVERY Claude session — only
// the session that ran collab_browse (recorded in .owner-session) may consume
// and deliver collab messages. Others exit silently.
let input = '';
try {
  process.stdin.setEncoding('utf-8');
  input = fs.readFileSync(0, 'utf-8');
} catch {}
try {
  const parsed = JSON.parse(input) || {};
  const sessionId = String(parsed.session_id || '');
  const toolName = String(parsed.tool_name || '');

  // collab_browse is the deliberate "join" — the calling session claims
  // (or takes over) message ownership. Other collab tools do NOT claim,
  // so a stray collab_chat from another terminal can't hijack the session.
  if (sessionId && /collab_browse$/.test(toolName)) {
    try { fs.writeFileSync(OWNER_FILE, sessionId); } catch {}
  }

  const owner = fs.readFileSync(OWNER_FILE, 'utf-8').trim();
  if (owner && sessionId && owner !== sessionId) process.exit(0);
} catch {} // no owner file or unparsable stdin — proceed (pre-claim sessions)

function httpGet(port, token, endpoint, callback) {
  const req = http.get(
    {
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 2000,
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { callback(null, JSON.parse(body)); }
        catch (e) { callback(e, null); }
      });
    },
  );
  req.on('error', (e) => callback(e, null));
  req.on('timeout', () => { req.destroy(); callback(new Error('timeout'), null); });
}

// Try ports in order for a given endpoint
function tryTargets(endpoint, callback) {
  function next(idx) {
    if (idx >= targets.length) { callback(null); return; }
    const { port, token } = targets[idx];
    httpGet(port, token, endpoint, (err, data) => {
      if (err) { next(idx + 1); return; }
      callback(data);
    });
  }
  next(0);
}

const listenerPath = path.join(__dirname, 'listener.cjs');
const LISTENER_REMINDER = '\nIMPORTANT: Respond via collab_chat, then restart the background listener:\nnode "' + listenerPath + '"';

// Step 1: Check for cancel
tryTargets('/cancel', (cancelData) => {
  if (cancelData && cancelData.cancel) {
    const reason = cancelData.messages && cancelData.messages.length > 0
      ? 'User clicked CANCEL in the collab chat. They also said: "' + cancelData.messages.join(' | ') + '". STOP what you are doing. Use collab_chat to ask the user what they want instead.' + LISTENER_REMINDER
      : 'User clicked CANCEL in the collab chat. STOP what you are doing immediately. Use collab_chat to ask the user what they want instead.' + LISTENER_REMINDER;

    process.stderr.write(reason);
    process.exit(2);
    return;
  }

  // Step 2: Check for regular messages (consume them)
  tryTargets('/pending', (pendingData) => {
    if (pendingData && pendingData.messages && pendingData.messages.length > 0) {
      const texts = pendingData.messages.map(m => m.text).join(' | ');
      const output = ['[COLLAB] User said: ' + texts];

      for (const m of pendingData.messages) {
        if (m.selections && m.selections.length > 0) {
          output.push('[COLLAB] Selected elements: ' + JSON.stringify(m.selections));
        }
      }

      output.push('Use your judgment: if this changes direction, stop and respond via collab_chat. If it\'s minor feedback you can incorporate, acknowledge briefly via collab_chat and continue your work.');

      process.stderr.write(output.join('\n'));
      process.exit(2);
    }

    // Nothing pending — check listener health, then let the tool proceed
    checkListener();
    process.exit(0);
  });
});

// Check if listener is alive — if not, remind Claude to restart it
function checkListener() {
  const pidFile = path.join(PROJECT_ROOT, '.listener-pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    process.kill(pid, 0); // signal 0 = just check if alive
    return; // Listener is alive
  } catch {}

  console.log('[COLLAB-LISTENER-DOWN] The background listener is not running. Start it NOW with run_in_background: true:\nnode "' + listenerPath + '"');
}
