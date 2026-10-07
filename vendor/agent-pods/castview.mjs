#!/usr/bin/env node
// castview.mjs — view + control any CDP browser (your real Brave, or a pod)
// inside VSCode. Zero dependencies. Needs Node 21+ (global WebSocket + fetch).
//
//   node castview.mjs                 # view Brave on CDP 9222, serve at :9333
//   node castview.mjs --cdp 9223      # view a pod instead
//   node castview.mjs --serve 9444    # different viewer port
//
// Then in VSCode:  Ctrl+Shift+P -> "Simple Browser: Show" -> http://localhost:9333
//
// How: connects to the browser's CDP endpoint, attaches to a page target, runs
// Page.startScreencast (live JPEG frames), and streams them to the viewer over
// Server-Sent Events. Clicks / scroll / keystrokes from the viewer POST back and
// are replayed into the real browser via Input.dispatchMouseEvent/KeyEvent. So
// it IS your Brave — real cookies, real session — just rendered in a VSCode tab.

import http from "node:http";

function parseArgs(argv) {
  const a = { cdp: "9222", serve: "9333" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cdp") a.cdp = argv[++i];
    else if (argv[i] === "--serve") a.serve = argv[++i];
  }
  return a;
}
const { cdp, serve } = parseArgs(process.argv.slice(2));

// ── minimal CDP client with flatten/sessionId support ──────────────────────
let ws, nextId = 1;
const pending = new Map();
const listeners = new Set();

async function cdpConnect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`CDP not responding on ${port}`);
  const { webSocketDebuggerUrl } = await res.json();
  ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`WS failed on ${port}`));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? fail(new Error(m.error.message)) : ok(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  };
}
function send(method, params = {}, sessionId) {
  return new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
}

// ── target / screencast state ──────────────────────────────────────────────
let session = null;          // current page sessionId
let lastMeta = { deviceWidth: 1600, deviceHeight: 900 };
const sseClients = new Set();

async function listPages() {
  const { targetInfos } = await send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
}

async function attach(targetId) {
  if (session) {
    try { await send("Page.stopScreencast", {}, session); } catch {}
    try { await send("Target.detachFromTarget", { sessionId: session }); } catch {}
  }
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  session = sessionId;
  await send("Page.enable", {}, session);
  await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 }, session);
}

listeners.add(async (m) => {
  if (m.method === "Page.screencastFrame" && m.sessionId === session) {
    lastMeta = m.params.metadata || lastMeta;
    for (const c of sseClients) c.write(`data: ${m.params.data}\n\n`);
    try { await send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, session); } catch {}
  }
});

// ── input replay ────────────────────────────────────────────────────────────
async function handleInput(ev) {
  const W = lastMeta.deviceWidth || 1600;
  const H = lastMeta.deviceHeight || 900;
  const x = Math.round((ev.x ?? 0) * W);
  const y = Math.round((ev.y ?? 0) * H);
  if (ev.kind === "mouse") {
    await send("Input.dispatchMouseEvent", {
      type: ev.event, x, y,
      button: ev.button || "left",
      buttons: ev.event === "mousePressed" ? 1 : 0,
      clickCount: ev.event === "mousePressed" || ev.event === "mouseReleased" ? 1 : 0,
    }, session);
  } else if (ev.kind === "wheel") {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: ev.dx || 0, deltaY: ev.dy || 0 }, session);
  } else if (ev.kind === "key") {
    await send("Input.dispatchKeyEvent", {
      type: ev.event, key: ev.key, code: ev.code,
      windowsVirtualKeyCode: ev.keyCode || 0, text: ev.text || "",
    }, session);
  }
}

// ── viewer page ──────────────────────────────────────────────────────────────
const VIEWER = `<!doctype html><html><head><meta charset="utf-8"><title>castview</title>
<style>
  html,body{margin:0;background:#111;height:100%;font:13px system-ui;color:#ccc}
  #bar{display:flex;gap:8px;align-items:center;padding:6px 8px;background:#1b1b1b;border-bottom:1px solid #333}
  select{background:#222;color:#ddd;border:1px solid #444;border-radius:4px;padding:3px}
  #wrap{position:absolute;top:36px;bottom:0;left:0;right:0;display:flex;align-items:flex-start;justify-content:center;overflow:auto}
  #screen{max-width:100%;cursor:crosshair;outline:none}
  #dot{color:#6c6}
</style></head><body>
<div id="bar"><span id="dot">●</span><select id="tabs"></select><span id="status">connecting…</span></div>
<div id="wrap"><img id="screen" tabindex="0" draggable="false"></div>
<script>
const img=document.getElementById('screen'),tabs=document.getElementById('tabs'),status=document.getElementById('status');
let down=false;
function frac(e){const r=img.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}};
function post(o){fetch('/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)})}
img.addEventListener('mousedown',e=>{down=true;const f=frac(e);post({kind:'mouse',event:'mousePressed',...f});img.focus();e.preventDefault()});
window.addEventListener('mouseup',e=>{if(!down)return;down=false;const f=frac(e);post({kind:'mouse',event:'mouseReleased',...f})});
img.addEventListener('mousemove',e=>{const f=frac(e);post({kind:'mouse',event:'mouseMoved',...f})});
img.addEventListener('wheel',e=>{const f=frac(e);post({kind:'wheel',dx:e.deltaX,dy:e.deltaY,...f});e.preventDefault()},{passive:false});
img.addEventListener('keydown',e=>{post({kind:'key',event:'keyDown',key:e.key,code:e.code,keyCode:e.keyCode,text:e.key.length===1?e.key:''});if(e.key!=='F12')e.preventDefault()});
img.addEventListener('keyup',e=>{post({kind:'key',event:'keyUp',key:e.key,code:e.code,keyCode:e.keyCode})});
async function loadTabs(){const r=await fetch('/tabs');const list=await r.json();tabs.innerHTML='';list.forEach(t=>{const o=document.createElement('option');o.value=t.targetId;o.textContent=(t.title||t.url).slice(0,60);tabs.appendChild(o)});}
tabs.addEventListener('change',()=>fetch('/select?id='+encodeURIComponent(tabs.value)));
const es=new EventSource('/frames');
es.onmessage=e=>{img.src='data:image/jpeg;base64,'+e.data;status.textContent='live'};
es.onerror=()=>{status.textContent='reconnecting…'};
loadTabs();setInterval(loadTabs,5000);
</script></body></html>`;

// ── http server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" }); res.end(VIEWER);
  } else if (u.pathname === "/tabs") {
    const pages = await listPages();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url }))));
  } else if (u.pathname === "/select") {
    await attach(u.searchParams.get("id"));
    res.writeHead(200); res.end("ok");
  } else if (u.pathname === "/frames") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  } else if (u.pathname === "/input" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => { try { await handleInput(JSON.parse(body)); } catch {} res.writeHead(200); res.end("ok"); });
  } else { res.writeHead(404); res.end(); }
});

// ── boot ─────────────────────────────────────────────────────────────────────
await cdpConnect(cdp);
await send("Target.setDiscoverTargets", { discover: true });
const pages = await listPages();
if (!pages.length) throw new Error(`No page tabs on CDP ${cdp}. Open a tab first.`);
await attach(pages[0].targetId);
server.listen(Number(serve), "127.0.0.1", () => {
  console.log(`castview: streaming CDP ${cdp} -> http://localhost:${serve}`);
  console.log(`VSCode: Ctrl+Shift+P -> "Simple Browser: Show" -> http://localhost:${serve}`);
});
