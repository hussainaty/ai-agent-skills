#!/usr/bin/env node
// cookies.mjs — slice cookies out of a running browser into an agent-browser
// state file. Zero dependencies. Needs Node 21+ (global WebSocket).
//
//   node cookies.mjs export --profile weathercrm --domains weathercontracting.com[,other.com] [--from 9222]
//   node cookies.mjs load   --profile weathercrm --port 9223
//
// Profiles are JSON files in ./cookie-profiles/ — gitignored, local only.
// Export writes playwright storage-state format, so it plugs straight into:
//
//   agent-browser --session <pod> --cdp <port> state load cookie-profiles/<name>.json
//
// (preferred — lands cookies in the agent's own browser context). `load` is a
// fallback that injects into the DEFAULT browser context via CDP, for clients
// that attach there (e.g. Playwright MCP). agent-browser creates an isolated
// context, so `load` alone won't reach it — use `state load` for agent-browser.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const profilesDir = join(here, "cookie-profiles");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (!cur.startsWith("--")) { args._.push(cur); continue; }
    const key = cur.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { args[key] = true; }  // boolean flag (e.g. --all)
    else { args[key] = next; i++; }                                          // valued flag
  }
  return args;
}

async function cdpConnect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`CDP not responding on ${port}`);
  const { webSocketDebuggerUrl } = await res.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`WebSocket failed on ${port}`));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    }
  };
  return {
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        pending.set(++id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

function matchesDomain(cookieDomain, domains) {
  const d = cookieDomain.replace(/^\./, "");
  return domains.some((want) => d === want || d.endsWith("." + want));
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === "export") {
  const { profile, domains } = args;
  const all = args.all !== undefined;
  const from = args.from || "9222";
  if (!profile || (!domains && !all)) {
    console.error("Usage: cookies.mjs export --profile <name> (--domains <d1,d2> | --all) [--from 9222]");
    process.exit(1);
  }
  const wanted = all ? null : domains.split(",").map((s) => s.trim().toLowerCase());
  const cdp = await cdpConnect(from);
  const { cookies } = await cdp.send("Storage.getCookies");
  cdp.close();

  // playwright storage-state cookie shape (what agent-browser `state load` reads)
  const filtered = cookies
    .filter((c) => all || matchesDomain(c.domain.toLowerCase(), wanted))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires && c.expires > 0 ? c.expires : -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite || "Lax",
    }));

  await mkdir(profilesDir, { recursive: true });
  const file = join(profilesDir, `${profile}.json`);
  await writeFile(file, JSON.stringify({ cookies: filtered, origins: [] }, null, 2));
  console.log(`Exported ${filtered.length} cookies (${all ? "ALL domains" : wanted.join(", ")}) -> ${file}`);
  console.log(`Use: agent-browser --session <pod> --cdp <port> state load ${file}`);
} else if (cmd === "load") {
  const { profile, port } = args;
  if (!profile || !port) {
    console.error("Usage: cookies.mjs load --profile <name> --port <cdpPort>");
    process.exit(1);
  }
  const file = join(profilesDir, `${profile}.json`);
  // strip BOM — profiles hand-written on Windows often carry one
  const raw = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  const list = Array.isArray(raw) ? raw : raw.cookies; // accept both formats
  const cookies = list.map((c) => {
    const out = { ...c };
    if (out.expires === -1) delete out.expires; // CDP wants expires absent for session cookies
    delete out.session;
    return out;
  });
  const cdp = await cdpConnect(port);
  await cdp.send("Storage.setCookies", { cookies });
  cdp.close();
  console.log(`Loaded ${cookies.length} cookies from '${profile}' into default context on ${port}`);
} else {
  console.error("Commands: export | load");
  process.exit(1);
}
