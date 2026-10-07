---
name: watchconsole
description: Connect to a local Chrome/Brave via CDP and stream browser console logs + errors into the conversation in real time. Pure browser — no server logs needed.
triggers:
  - /watchconsole
  - watch console
  - stream browser logs
  - monitor console
---

# /watchconsole

Connect to a running Chromium-family browser via CDP (port 9222) and stream
console output live. Lightweight sibling of `/watchall` — console + errors only,
no network/perf/observability layer.

## Port resolution (optional pods)

If you use the optional [agent-pods](https://github.com/jgharbieh/agent-pods)
companion and the workspace root has `.claude/pod.json`, use its `cdp` port
everywhere this skill says 9222. No `pod.json` → default 9222.

## Prerequisites

Browser must be launched with remote debugging enabled. One-time setup:

**Windows (Chrome):**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

**Windows (Brave):**
```powershell
& "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

**macOS (Chrome):**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

## What it captures

Via CDP `Runtime.consoleAPICalled`:
- `console.log`, `console.warn`, `console.error`, `console.info`, `console.debug`
- Stack traces on errors
- Network failures (via `Network.loadingFailed`)
- Uncaught exceptions (via `Runtime.exceptionThrown`)

## Running the watcher

```bash
node - <<'EOF'
const CDP = require('chrome-remote-interface');
(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime, Network } = client;
  await Runtime.enable();
  await Network.enable();
  Runtime.consoleAPICalled(({ type, args, timestamp }) => {
    const msg = args.map(a => a.value ?? a.description ?? '').join(' ');
    const t = new Date(timestamp).toISOString().slice(11, 23);
    console.log(`[${t}] [${type.toUpperCase()}] ${msg}`);
  });
  Runtime.exceptionThrown(({ exceptionDetails }) => {
    console.error(`[EXCEPTION] ${exceptionDetails.text}`, exceptionDetails.exception?.description ?? '');
  });
  Network.loadingFailed(({ requestId, errorText }) => {
    console.error(`[NET FAIL] ${requestId} — ${errorText}`);
  });
  console.log('Watching console on port 9222. Ctrl+C to stop.');
})().catch(console.error);
EOF
```

Requires `chrome-remote-interface`:
```bash
npm install -g chrome-remote-interface
```

## What to do with output

- Paste errors into conversation → Claude diagnoses
- Watch for `[ERROR]` / `[EXCEPTION]` lines while triggering a flow
- Combine with `/watchandlearn` to narrate what the console says during a UI walkthrough
- For the full observability layer (network, perf, long tasks, layout shifts, WebSocket frames), use `/watchall` instead
