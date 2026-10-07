# claude-browser-stack

A small pack of [Claude Code](https://claude.com/claude-code) skills for
**browser automation + full-spectrum browser observability**, built on top of
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).

Drive a real, *visible* browser from Claude Code so you can watch automation
happen live — and stream every signal the browser exposes (console, network,
performance, WebSocket frames, long tasks, layout shifts) while you QA.

## What's in the pack

| Skill | What it does |
|---|---|
| `/agent-browser` | **Default.** Attach to your visible local browser via CDP and drive it (navigate, fill, click, snapshot, screenshot). Tab-ownership discipline so it never hijacks your tabs. |
| `/agent-browser-headless` | Same CLI, headless/background — for scrapes and batch work with no window. |
| `/watchall` | Full-F12-parity CDP watcher: console + `Log` domain + network + perf metrics + WebSocket frames + long tasks + layout shifts. Always-on capture, filter at read-time. |
| `/watchconsole` | Lightweight sibling — console + errors only. |
| `/watchandlearn` | Narrated, step-by-step tour of a UI flow while driving the browser. |

These skills are the Claude-Code-facing layer; the heavy CLI reference is loaded
on demand from agent-browser itself (`agent-browser skills get core --full`).

## Install

### 1. Install agent-browser (required — this is the engine)

```bash
npm install -g agent-browser
agent-browser install
```

(Also available via `brew install agent-browser` or `cargo install agent-browser`,
each followed by `agent-browser install`. See the
[upstream repo](https://github.com/vercel-labs/agent-browser).)

### 2. Install this skill pack

```bash
git clone https://github.com/jgharbieh/claude-browser-stack.git
cd claude-browser-stack
```

Then link the skills into your Claude Code skills directory.

**macOS / Linux:**
```bash
./install.sh
```

**Windows (PowerShell, Developer Mode or admin shell):**
```powershell
.\install.ps1
```

Or do it manually — symlink each skill folder into `~/.claude/skills/`:
```bash
ln -sf "$(pwd)/skills/agent-browser"          ~/.claude/skills/agent-browser
ln -sf "$(pwd)/skills/agent-browser-headless" ~/.claude/skills/agent-browser-headless
ln -sf "$(pwd)/skills/watchall"               ~/.claude/skills/watchall
ln -sf "$(pwd)/skills/watchconsole"           ~/.claude/skills/watchconsole
ln -sf "$(pwd)/skills/watchandlearn"          ~/.claude/skills/watchandlearn
```

Skills are auto-discovered — they're live in your next Claude Code session.

### 3. Dependency for the watchers (`/watchall`, `/watchconsole`)

The observability watchers use [`chrome-remote-interface`](https://www.npmjs.com/package/chrome-remote-interface):

```bash
npm install -g chrome-remote-interface
```

(The `/agent-browser` skills do **not** need this — only the watchers do.)

### 4. (Optional) agent-pods — containerized browsers for parallel sessions

If you want isolated, containerized browsers (Chromium + CDP + noVNC viewer) so a
Claude session's automation never fights your real browser — e.g. for parallel
worktrees — install the optional companion:

- **[agent-pods](https://github.com/jgharbieh/agent-pods)**

All skills here detect `.claude/pod.json` and route to the pod's CDP port
automatically when present. Without pods, everything just uses your local browser
on port 9222 — pods are entirely optional.

## Quick start

```text
You: /agent-browser open my staging site and click through the signup flow
```

Claude probes CDP on 9222, attaches to your visible browser (asking before it
ever relaunches/closes anything), opens its own labeled tab, and drives it while
you watch.

```text
You: /watchall    (then run your QA flow manually)
```

Claude brings up the watcher in the background and streams every browser signal,
timestamped, so any bug you hit is already backed by data.

## In the wild — a UI-perf bug, proven not vibed

The point of a *visible* browser wired to CDP isn't just driving clicks — it's turning subjective front-end complaints into hard numbers. A real example from a production CRM, start to finish in one session:

**The ticket:** *"Theme switching feels sluggish."* No stack trace, no failing test — a feeling. (And a landmine: an earlier fix had already been reverted for tanking scroll performance app-wide.)

**What the stack did:**

- Drove a pod browser to the real authenticated app — a **31,000-node DOM**, actual conditions, not a toy page — while a human watched live over noVNC.
- Throttled the CPU to **11.7×** (`Emulation.setCPUThrottlingRate`) to stretch a one-frame stagger into something measurable.
- Snapshotted `getComputedStyle` at the **exact style recalc** of the theme swap, via a `MutationObserver` on the swap marker.
- Triggered the app's **real** code path (the theme picker's own `localStorage` write + change event), not a synthetic shortcut.
- Reproduced the bug **and** the fix on the same page by toggling the fix's CSS rule at runtime — an honest before/after.

**The proof** — `<body>` at the swap recalc, light → dark:

| | transition | background | result |
|---|---|---|---|
| **Bug** | `0.32s` (live) | still the **old** color | borders/text animate a frame behind the bg → visible "wave" |
| **Fixed** | **`0s`** (suppressed) | already the **new** color | every property, one frame → **atomic snap** |

| Light start | Fixed — +40ms after switch | Bug — +40ms after switch |
|---|---|---|
| ![light start](docs/img/crm-theme-before.png) | ![fixed, atomic](docs/img/crm-theme-fixed.png) | ![bug, the wave](docs/img/crm-theme-bug.png) |
| the dashboard before | fully dark, one frame later — **atomic** | mid-crossfade — **the wave** |

<sub>Captured by the agent over CDP at 11.7× CPU throttle on a real CRM dashboard.</sub>

Then it ran a production build and re-ran the **entire** instrument: identical result — the fix held through minification. A subjective complaint became measured engineering — dev *and* prod, with a human watching the browser the whole time. That's the stack.

> **100% AI in the loop.** The only human input was the prompt: *"fix it."* The agent reproduced the bug, root-caused it, wrote the fix, verified it on a dev server **and** a production build, and produced the full measured trace — in a single chat. Pushed, tested, and prod-ready when that first chat ended. It was that good.

That instrument is shipped — [`bin/paint-probe.mjs`](bin/paint-probe.mjs). Point it at any page, pass the trigger that causes your restyle, and it prints the same per-recalc snapshots + a screenshot burst (CPU-throttled, with an optional `--disable-rule` baseline for an honest before/after).

## Notes

- **Any Chromium-family browser works** — Chrome, Brave, Edge, Arc. Set the binary
  path for your machine in the `/agent-browser` skill (it ships with common
  Windows/macOS paths as examples).
- **The browser stays visible by default.** Hidden automation is opt-in via
  `/agent-browser-headless`.
- **The watchers see browser-process signal only** — console/network/perf/WS, full
  F12 parity. Not OS metrics, not server logs.
- **Safety:** the skills never close or relaunch your browser without explicit
  confirmation — your live tabs are treated as irreplaceable.

## Structured run logs (`bin/`)

Helper scripts that capture a QA/verify session as **one run = one folder = the
complete black box** (best for AI search + post-mortems). Default root
`D:\dev\sandbox` (override with `AB_TRACE_ROOT`).

```
<root>\<pod>\
├── docker-<stamp>.log               pod-lifetime container logs (from agent-pods)
└── <start>-<end>\                   one RUN (folder name = start-end timestamps)
    ├── env.json        git SHA, pod, purpose, cwd, host, timestamps
    ├── console.txt     console.* + exceptions + Log entries
    ├── network.txt     requests / responses / failures
    ├── api.txt         /api/* calls
    ├── convex.txt      Convex HTTP + WebSocket frames
    ├── performance.txt DOM nodes / JS heap / listeners / layout count (3s sample)
    ├── server.txt      app dev-server stdout (redirect here)
    └── transcript.jsonl agent-browser actions (auto-written by ab.ps1)
```

| Tool | What it does |
|---|---|
| `bin\run.ps1 start <pod> [-Purpose "verify #54"]` | mint a run folder, print its path, mark it active |
| `bin\run.ps1 end <pod>` | stamp end time, finalize folder name `<start>-<end>` |
| `bin\ab.ps1 <agent-browser args>` | traced wrapper — every call appended to the active run's `transcript.jsonl` |
| `bin\watch.mjs --port <cdp> --dir <run>` | CDP watcher — writes console/network/api/convex/performance into the run folder |

Typical loop:
```powershell
# 1) start a run — name it the SAME as the --session you'll pass to ab.ps1
$rd = .\bin\run.ps1 start wt1 -Purpose "verify #54"
$env:AB_RUN_DIR = $rd                 # transcript + ab.ps1 land in this exact run folder
$env:NODE_PATH = (npm root -g)        # so watch.mjs finds chrome-remote-interface

# 2) start the watcher — CAPTURE its pid (never `Stop-Process -Name node`; that kills
#    your Next/Convex/Vite dev servers too)
$watch = Start-Process node -ArgumentList "bin\watch.mjs","--port","9223","--dir",$rd -WindowStyle Hidden -PassThru

# 3) drive
.\bin\ab.ps1 --session wt1 --cdp 9223 open https://staging.example.com
# ... drive + click ...

# 4) stop ONLY the watcher, end the run
Stop-Process -Id $watch.Id -ErrorAction SilentlyContinue
$env:AB_RUN_DIR = $null
.\bin\run.ps1 end wt1
```

## License

MIT
