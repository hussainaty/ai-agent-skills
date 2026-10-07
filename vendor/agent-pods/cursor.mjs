#!/usr/bin/env node
// cursor.mjs — drive a pod's REAL X cursor to an element (or coords) and click.
// Zero dependencies. Needs Node 21+ (global WebSocket).
//
//   node cursor.mjs click --pod wt2 --port 9223 --selector "button.submit"
//   node cursor.mjs move  --pod wt2 --port 9223 --selector "nav .menu"      # hover only
//   node cursor.mjs click --pod wt2 --port 9223 --x 400 --y 300             # viewport CSS px
//
// How it works: resolves the element's center to absolute SCREEN coordinates
// inside the container (page rect + window.screenX/Y + browser chrome height),
// then runs `docker exec <pod> glide-click X Y` so xdotool moves the actual
// Xvfb pointer. Real OS input — fires native :hover, transitions, HTML5 drag —
// and the cursor visibly travels in the noVNC viewer.
//
// Assumes devicePixelRatio = 1 (the pod display runs at 24-bit, dpr 1).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
    else a._.push(argv[i]);
  }
  return a;
}

// Minimal CDP client with target-session support (isolated-context pages are
// reachable via Target.getTargets + attachToTarget, not /json/list).
async function cdp(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`pod CDP not responding on ${port}`);
  const { webSocketDebuggerUrl } = await res.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("CDP socket failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? fail(new Error(m.error.message)) : ok(m.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      pending.set(++id, { ok, fail });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });
  return { send, close: () => ws.close() };
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] === "move" ? "move" : "click";
const { pod, port, selector } = args;
if (!pod || !port) { console.error("Required: --pod <name> --port <cdpPort>"); process.exit(1); }

const c = await cdp(port);

// Pick the active page target (single-tab pods: the only one).
const { targetInfos } = await c.send("Target.getTargets");
const pages = targetInfos.filter((t) => t.type === "page");
if (!pages.length) { console.error("No page target in pod."); process.exit(1); }
const target = pages[pages.length - 1];
const { sessionId } = await c.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
await c.send("Runtime.enable", {}, sessionId);

// Resolve screen coords in the page.
const expr = `(() => {
  const dpr = window.devicePixelRatio || 1;
  const base = window.screenX;
  const baseY = window.screenY;
  const chromeH = window.outerHeight - window.innerHeight;   // toolbar + tabstrip
  const chromeW = (window.outerWidth - window.innerWidth) / 2;
  let cx, cy;
  ${selector ? `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ error: "selector not found: " + ${JSON.stringify(selector)} });
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  ` : `
    cx = ${Number(args.x) || 0};
    cy = ${Number(args.y) || 0};
  `}
  return JSON.stringify({
    x: Math.round((base + chromeW + cx) * dpr),
    y: Math.round((baseY + chromeH + cy) * dpr),
  });
})()`;

const { result } = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
c.close();

const out = JSON.parse(result.value);
if (out.error) { console.error(out.error); process.exit(1); }

await exec("docker", ["exec", `agent-pod-${pod}`, "glide-click", String(out.x), String(out.y), "60", mode === "move" ? "move" : ""].filter(Boolean));
console.log(`${mode} -> screen ${out.x},${out.y}${selector ? ` (${selector})` : ""}`);
