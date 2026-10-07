// Host-compatibility smoke test — proves Claude Collab's MCP tool surface works
// from a GENERIC MCP host (no Claude Code, no hooks), using the official MCP SDK
// client exactly the way Cursor / Cline / any host connects.
//
// Run:  node test/host-compat.mjs
//
// ── Blast radius (deliberately small & safe) ───────────────────────────────
//  • tabs mode ONLY — uses Playwright's own isolated Chromium. NEVER touches
//    your real Chrome, your logins, or extension mode.
//  • Target is a throwaway page served from 127.0.0.1 (loopback) — no DNS, no
//    external network, never your real sites. Fully hermetic.
//  • Read-only tools only: browse → scan → inbox → close. No evaluate/act, so
//    nothing mutates any page.
//  • Does NOT run setup.cjs, does NOT install hooks, does NOT touch any
//    settings.json. Completely independent of your working Claude Code config.
//  • The MCP server and the loopback HTTP server are both torn down on exit.
// ───────────────────────────────────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A distinctive marker we can look for in the scan output to prove the agent
// actually READ the rendered page (not just that a tool returned something).
const MARKER = 'Collab Host Compat OK';
const PAGE_HTML = `<!doctype html><html><head><title>Collab Host Test</title></head>`
  + `<body><h1>${MARKER}</h1><p>served from loopback for the host-compat test</p>`
  + `<a href="/next">a link</a></body></html>`;

// Tiny loopback server — bound to 127.0.0.1 on an ephemeral port.
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const TARGET_URL = `http://127.0.0.1:${httpServer.address().port}/`;

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// Pull the first text block out of an MCP tool result.
const text = (res) => (res?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

// Spawn the server exactly as a host would: `tsx src/index.ts` over stdio.
const transport = new StdioClientTransport({
  command: process.execPath,            // node (absolute) — robust on Windows
  args: ['--import', 'tsx', join(ROOT, 'src', 'index.ts')],
  cwd: ROOT,
  stderr: 'inherit',                    // surface server-side [collab] logs/errors
});

const client = new Client(
  { name: 'host-compat-test', version: '0.0.0' },
  { capabilities: {} },
);

try {
  // 1. Handshake — proves a non-Claude-Code client can initialize the server.
  await client.connect(transport);
  check('connect + initialize (generic MCP client)', true);

  // 2. Tool surface — proves all tools are exposed host-agnostically.
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  check('listTools returns the full surface', tools.length >= 20, `${tools.length} tools`);
  for (const required of ['collab_browse', 'collab_scan', 'collab_inbox', 'collab_close']) {
    check(`exposes ${required}`, names.includes(required));
  }

  // 3. browse (tabs mode, benign URL) — core: open a shared page, no hooks.
  const browse = await client.callTool(
    { name: 'collab_browse', arguments: { url: TARGET_URL, mode: 'tabs' } },
    undefined,
    { timeout: 90_000 },                // first run may download/launch Chromium
  );
  const browseOk = /Collab Host Test/.test(text(browse));
  check('collab_browse opens an isolated Playwright tab + loads the page', browseOk);

  // 4. scan — core: the agent can READ the rendered page as structured text.
  //    Asserting on MARKER proves real content was read, not just a non-empty reply.
  const scan = await client.callTool(
    { name: 'collab_scan', arguments: { mode: 'full' } },
    undefined,
    { timeout: 30_000 },
  );
  check('collab_scan reads the rendered page content', text(scan).includes(MARKER), `${text(scan).length} chars`);

  // 5. inbox — the turn-based replacement for the hook-driven interrupt.
  //    Should return instantly with no messages (proves the polling path works).
  const inbox = await client.callTool(
    { name: 'collab_inbox', arguments: { timeout: 0 } },
    undefined,
    { timeout: 15_000 },
  );
  let inboxOk = false;
  try { inboxOk = 'hasMessages' in JSON.parse(text(inbox)); } catch { /* not json */ }
  check('collab_inbox polls cleanly (turn-based message path)', inboxOk, text(inbox).slice(0, 80));

  // 6. close — clean teardown of the browser session.
  await client.callTool({ name: 'collab_close', arguments: {} }, undefined, { timeout: 15_000 });
  check('collab_close tears down the session', true);
} catch (err) {
  check('test run completed without throwing', false, String(err?.stack || err));
} finally {
  try { await client.close(); } catch { /* already closing */ }
  try { httpServer.close(); } catch { /* already closed */ }
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️ '} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
