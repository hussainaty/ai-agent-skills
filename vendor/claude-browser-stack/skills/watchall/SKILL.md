---
name: watchall
description: BEGIN full-spectrum browser observability on Claude's end. Brings up a CDP watcher (full-F12 console via Runtime + Log domains, network, API, perf metrics, WebSocket frames, long tasks, layout shifts) so any issues found during a QA/testing session land data-first. Pairs with /agent-browser.
triggers:
  - /watchall
  - watch everything
  - watch all
  - monitor everything
  - start watching
---

# /watchall — activation signal

`/watchall` is **not** a permanent state. It's a command to **start watching
everything on Claude's end, now**, while the user runs a QA flow on the
front-end.

## What "everything" means

Everything Claude can observe **through the browser tab** via CDP:

| Stream | Source | Purpose |
|---|---|---|
| Browser console | CDP `Runtime.consoleAPICalled` | App's own `console.*` — all levels, unfiltered |
| Uncaught exceptions | CDP `Runtime.exceptionThrown` | Thrown errors with stack |
| Browser log entries | CDP `Log.entryAdded` | Everything else F12 shows: failed loads, CSP, deprecations, interventions, mixed-content, network errors |
| HTTP requests/responses | CDP `Network.*` | API surface; POST bodies for `/api/*`; flag 4xx/5xx and >1s requests |
| WebSocket frames | CDP `Network.webSocketFrame*` | Realtime backend traffic (Convex/Supabase/etc.); sent + received payloads |
| Navigation markers | CDP `Page.frameNavigated` | `[NAV]` lines so screenshot timestamps map to pages |
| Performance metrics | CDP `Performance.getMetrics` polled 5s | DOM nodes, listeners, ScriptDuration, layouts, recalcs, JS heap |
| Long tasks | injected `PerformanceObserver` for `longtask` | Any main-thread block >50ms |
| Layout shifts | injected `PerformanceObserver` for `layout-shift` | CLS spikes |

> Note: these are **browser-process** metrics (the page's Chromium process), not
> OS/machine metrics (CPU/RAM/disk), and not server logs. It's full F12 parity,
> not system monitoring.

Capture is always **everything** — every stream on by default, never narrowed
preemptively. Filter at *read-time* when filing an issue, not at capture-time.

## Activation steps (in order)

0. **Resolve CDP port** — if you use the optional
   [agent-pods](https://github.com/jgharbieh/agent-pods) companion and the
   workspace root has `.claude/pod.json`, use its `cdp` port everywhere
   (including `CDP({ port: <cdp> })` in the script). Otherwise default 9222.

1. **Check CDP + browser (in this exact order)** —
   **a. Curl the port** — `curl -s http://localhost:<port>/json/version`.
      - Responds → CDP already live. **Attach only. Tear nothing down.** Skip to step 2.
   **b. Down → check if the browser is running** — e.g. `Get-Process brave -ErrorAction SilentlyContinue` (or chrome/msedge).
      - **Browser NOT running** → nothing to lose. Just open it with the debug port. No prompt needed. → step c.
      - **Browser IS running** (just without the debug port) → relaunching closes the user's live window. **STOP. Prompt first** (`AskUserQuestion`): spell out it will close all current tabs, tell the user to save anything open. Proceed only on explicit "yes". If no → abort watchall. **Never close/kill the browser or any tab silently — irreversible.**
   **c. Open the browser** with `--remote-debugging-port=<port>` (+ the normal profile so tabs/sessions restore).
   **d. Re-check the tab** — curl the port again, confirm a page target exists before attaching.
   - **Pod port (not 9222)** → do NOT touch the host browser. Suggest your pod tooling (e.g. `pod.ps1 ls` / `pod.ps1 up <name>`) instead.

2. **Launch watcher** in background (`run_in_background: true`). Use the inline
   script below (auto-reconnect, full F12 parity — no noise filtering).

3. **Announce live + ask scope**: capture is always everything, but output must
   be context-worthy — so ask what the user is testing / what to watch for, so log
   excerpts can be filtered to the relevant feature when filing issues. One line,
   e.g.: "Watcher live — everything on. What are you testing?" Default if no
   answer: everything, unfiltered.

## Watcher inline script (v6)

Requires `chrome-remote-interface` (`npm install -g chrome-remote-interface`).
Adjust the `require` path to wherever it's installed on your machine, or install
it locally in the project and use a bare `require('chrome-remote-interface')`.

```javascript
const CDP = require('chrome-remote-interface');
const fmt = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};
const ts = () => fmt(new Date());        // wall-clock NOW — for WS frames + network (CDP MonotonicTime can't map to wall directly)
const wall = (ms) => fmt(new Date(ms));  // for CDP Runtime/Log timestamps (milliseconds since epoch)
const out = (line) => process.stdout.write(line + '\n');
const PORT = Number(process.env.CDP_PORT || 9222);

async function attach() {
  const client = await CDP({ port: PORT });
  const { Runtime, Network, Performance, Page, Log } = client;
  await Runtime.enable();
  await Network.enable();
  await Performance.enable({ timeDomain: 'timeTicks' });
  await Page.enable();
  await Log.enable();

  const observerScript = `
    if (!window.__perfObsInstalled) {
      window.__perfObsInstalled = true;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            console.warn('__PERFOBS__ LONGTASK ' + Math.round(e.duration) + 'ms ' + (e.name || ''));
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch {}
      try {
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) {
              cls += e.value;
              if (e.value > 0.05) console.warn('__PERFOBS__ CLS +' + e.value.toFixed(3) + ' (cumulative ' + cls.toFixed(3) + ')');
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
    }
  `;
  await Page.addScriptToEvaluateOnNewDocument({ source: observerScript });
  await Runtime.evaluate({ expression: observerScript });

  Runtime.consoleAPICalled(({ type, args, timestamp }) => {
    const msg = args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500);
    if (msg.startsWith('__PERFOBS__ LONGTASK')) { out(`[${wall(timestamp)}] [LONGTASK] ${msg.replace('__PERFOBS__ LONGTASK ', '')}`); return; }
    if (msg.startsWith('__PERFOBS__ CLS')) { out(`[${wall(timestamp)}] [LAYOUT-SHIFT] ${msg.replace('__PERFOBS__ CLS ', '')}`); return; }
    // Full F12 parity — capture EVERYTHING, no noise filtering. Filter at read-time when filing issues, not at capture-time.
    out(`[${wall(timestamp)}] [${type.toUpperCase()}] ${msg}`);
  });
  Runtime.exceptionThrown(({ exceptionDetails, timestamp }) => {
    out(`[${wall(timestamp)}] [EXCEPTION] ${exceptionDetails.text}`);
  });

  // Browser-emitted console entries Runtime misses but F12 shows:
  // failed resource loads, CSP violations, deprecations, interventions, mixed-content, network errors.
  Log.entryAdded(({ entry }) => {
    const where = entry.url ? ` ${entry.url.replace(/^https?:\/\/[^/]+/, '')}` : '';
    out(`[${wall(entry.timestamp)}] [LOG:${entry.level.toUpperCase()}/${entry.source}]${where} ${(entry.text || '').slice(0, 500)}`);
  });

  const reqTimes = new Map();
  Network.requestWillBeSent(({ requestId, request, type, timestamp }) => {
    if (type === 'XHR' || type === 'Fetch' || request.method !== 'GET') {
      reqTimes.set(requestId, { url: request.url, t: timestamp, method: request.method });
      if (request.url.includes('/api/') && request.postData) {
        out(`[${ts()}] [REQ] ${request.method} ${request.url.replace(/^https?:\/\/[^/]+/, '')} → ${request.postData.slice(0, 400)}`);
      }
    }
  });
  Network.responseReceived(({ response, requestId, timestamp }) => {
    if (response.status >= 400 && !response.url.includes('_rsc=')) {
      out(`[${ts()}] [${response.status}] ${response.url.replace(/^https?:\/\/[^/]+/, '')}`);
    }
    const s = reqTimes.get(requestId);
    if (s && (timestamp - s.t) > 1.0 && s.url.includes('/api/')) {
      out(`[${ts()}] [SLOW ${Math.round((timestamp - s.t)*1000)}ms] ${s.method} ${s.url.replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });

  // Generic WebSocket frame logging (works for Convex, Supabase, socket.io, raw WS, etc.)
  Network.webSocketFrameSent(({ response, timestamp }) => {
    const p = (response.payloadData || '').slice(0, 300);
    if (p) out(`[${ts()}] [WS→] ${p}`);
  });
  Network.webSocketFrameReceived(({ response, timestamp }) => {
    const p = (response.payloadData || '');
    if (p.includes('error') || p.includes('"success":false')) out(`[${ts()}] [WS←ERR] ${p.slice(0, 400)}`);
  });

  Page.frameNavigated(async ({ frame }) => {
    if (frame.parentId) return;
    const path = (frame.url || '').replace(/^https?:\/\/[^/]+/, '');
    if (path && !path.startsWith('chrome')) out(`[${ts()}] [NAV] ${path}`);
    try { await Runtime.evaluate({ expression: observerScript }); } catch {}
  });

  let prev = null;
  setInterval(async () => {
    try {
      const { metrics } = await Performance.getMetrics();
      const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
      if (prev) {
        const flags = [];
        if (m.Nodes - prev.Nodes > 1000) flags.push(`Δnodes:+${m.Nodes - prev.Nodes}`);
        if (m.JSEventListeners - prev.JSEventListeners > 500) flags.push(`Δlisteners:+${m.JSEventListeners - prev.JSEventListeners}`);
        if (m.ScriptDuration - prev.ScriptDuration > 1.0) flags.push(`script:+${(m.ScriptDuration - prev.ScriptDuration).toFixed(2)}s`);
        if (m.LayoutCount - prev.LayoutCount > 50) flags.push(`layouts:+${m.LayoutCount - prev.LayoutCount}`);
        if (m.RecalcStyleCount - prev.RecalcStyleCount > 50) flags.push(`recalcs:+${m.RecalcStyleCount - prev.RecalcStyleCount}`);
        if (m.JSHeapUsedSize - prev.JSHeapUsedSize > 20*1024*1024) flags.push(`heap:+${((m.JSHeapUsedSize - prev.JSHeapUsedSize)/1024/1024).toFixed(1)}MB`);
        if (flags.length) out(`[${ts()}] [PERF] ${flags.join(' ')} | ${m.Nodes}n ${m.JSEventListeners}L heap:${(m.JSHeapUsedSize/1024/1024).toFixed(1)}MB`);
      }
      prev = m;
    } catch {}
  }, 5000);

  client.on('disconnect', () => {
    out(`[${ts()}] [CDP-DISCONNECT] reconnecting in 2s...`);
    setTimeout(() => attach().catch(e => out(`[${ts()}] [CDP-ERR] ${e.message}`)), 2000);
  });
  out(`[${ts()}] Watcher live. Go.`);
}
attach().catch(e => out(`[${ts()}] CDP error: ${e.message}`));
setInterval(() => {}, 60000);
```

## Issue-filing workflow (active while watcher is live)

When the user drops a screenshot or describes a bug:
1. Read the screenshot to see annotations.
2. Grep the watcher output by the screenshot's timestamp.
3. File the issue data-first:
   - Screenshot embedded
   - Watcher log excerpt (3–10 lines)
   - Measured number from `Performance.getMetrics` if perf-related
   - Industry baseline with sources if quantifiable
   - Root-cause hypothesis (one paragraph linking data to a code area)
   - Repro steps

## Deactivation

User says "pause", "stop watching", or closes the browser. Kill the node watcher process.

## Related skills

- `/watchconsole` — lighter, console + errors only
- `/agent-browser` — drive the browser while this watches
- `/watchandlearn` — narrate a flow while this captures the signal
