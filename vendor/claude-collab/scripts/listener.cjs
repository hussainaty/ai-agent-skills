#!/usr/bin/env node
/**
 * Collab Listener — background process that wakes Claude when user messages arrive.
 *
 * Uses an idle-flag strategy:
 *   1. Polls GET /peek every second (does NOT advance cursor)
 *   2. When messages are detected, checks GET /idle to see if Claude is idle
 *      (flag set by the Stop hook when Claude finishes its turn)
 *   3. If idle: consumes via GET /pending and exits to wake Claude
 *   4. If not idle: PostToolUse event-hook will handle delivery — skip
 *
 * Only exits on: message consumed and delivered, or process killed.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.join(__dirname, '..');
const NOTIFY_PORT_FILE = path.join(PROJECT_ROOT, '.notify-port');
const WS_PORT_FILE = path.join(PROJECT_ROOT, '.ws-port');
const PID_FILE = path.join(PROJECT_ROOT, '.listener-pid');

// ==================== SINGLE-INSTANCE ENFORCEMENT ====================
try {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0); // check if alive
      process.kill(oldPid, 'SIGTERM');
      const start = Date.now();
      while (Date.now() - start < 200) { /* spin for cleanup */ }
    } catch {
      // Already dead
    }
  }
} catch {
  // No PID file
}

try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ==================== PORT DISCOVERY ====================
const deadPorts = new Set(); // Skip ports that already failed with ECONNREFUSED

function getTargets() {
  const targets = [];
  for (const file of [NOTIFY_PORT_FILE, WS_PORT_FILE]) {
    try {
      const raw = fs.readFileSync(file, 'utf-8').trim();
      const parts = raw.split(':');
      const port = parseInt(parts[0], 10);
      const token = parts.slice(1).join(':');
      if (port > 0 && !deadPorts.has(port)) targets.push({ port, token });
    } catch {}
  }
  return targets;
}

// ==================== HTTP REQUEST HELPER ====================
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
        try {
          callback(null, JSON.parse(body));
        } catch (e) {
          callback(e, null);
        }
      });
    },
  );
  req.on('error', (e) => {
    if (e.code === 'ECONNREFUSED') deadPorts.add(port);
    callback(e, null);
  });
  req.on('timeout', () => {
    req.destroy();
    callback(new Error('timeout'), null);
  });
}

// Try each target port in order, return first successful response
function tryTargets(endpoint, callback) {
  const targets = getTargets();
  if (targets.length === 0) { callback(null); return; }

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

// ==================== FORMAT OUTPUT ====================
function formatMessages(messages) {
  const output = [];
  output.push('[COLLAB] User said: ' + messages.map(m => m.text).join(' | '));
  for (const m of messages) {
    if (m.selections && m.selections.length > 0) {
      output.push('[COLLAB] Selected elements: ' + JSON.stringify(m.selections));
    }
  }
  output.push('\u2192 Respond via collab_chat, then restart listener.');
  return output.join('\n');
}

function exitWithOutput(text) {
  clearInterval(pollInterval);
  clearInterval(heartbeat);
  const flushed = process.stdout.write(text + '\n');
  if (flushed) {
    setTimeout(() => process.exit(0), 100);
  } else {
    process.stdout.once('drain', () => setTimeout(() => process.exit(0), 100));
  }
}

// ==================== MAIN LOOP ====================
const POLL_MS = 1000;    // Normal polling interval
const HEARTBEAT_MIN = 5; // Heartbeat interval in minutes

let pollCount = 0;

const pollInterval = setInterval(() => {
  // Peek — check for messages without consuming
  tryTargets('/peek', (data) => {
    pollCount++;
    if (!data || !data.messages || data.messages.length === 0) {
      if (pollCount === 1 || pollCount % 30 === 0) {
        console.error(`[listener] Poll #${pollCount}: empty`);
      }
      return;
    }

    // Messages detected! Check if Claude is idle.
    console.error(`[listener] Poll #${pollCount}: ${data.messages.length} message(s) detected — checking idle flag`);

    tryTargets('/idle', (idleData) => {
      if (!idleData || !idleData.idle) {
        // Claude is working — PostToolUse event-hook will handle delivery
        console.error('[listener] Claude is not idle — deferring to event-hook');
        return;
      }

      // Claude IS idle — consume and deliver
      console.error('[listener] Claude is idle — consuming and exiting');
      tryTargets('/pending', (consumeData) => {
        if (consumeData && consumeData.messages && consumeData.messages.length > 0) {
          exitWithOutput(formatMessages(consumeData.messages));
        } else {
          // Race: event-hook consumed between our peek and consume
          console.error('[listener] Race: consumed between peek and pending — resuming');
        }
      });
    });
  });
}, POLL_MS);

// Heartbeat every 5 minutes
let heartbeatCount = 0;
const heartbeat = setInterval(() => {
  heartbeatCount++;
  console.log(`[COLLAB-LISTENER] Still listening (${heartbeatCount * HEARTBEAT_MIN}m elapsed, no messages). Standing by.`);
}, HEARTBEAT_MIN * 60 * 1000);
