# agent-pods

> **One browser per AI coding session.** Git worktrees isolate your files — pods isolate your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Made for](https://img.shields.io/badge/made%20for-Claude%20Code%20%2B%20agent--browser-8A2BE2)]()

---

## The problem

Run two AI coding sessions in parallel (Claude Code on git worktrees, for example) and they share one thing they shouldn't: **the browser**. Every CDP tool — [agent-browser](https://github.com/vercel-labs/agent-browser), Playwright MCP, console watchers — attaches to the same browser on `localhost:9222` and drives the active tab. Two sessions means tab fights. An agent navigating away mid-task while *you* were reading that page. Chaos.

## The fix

A **pod** is a disposable Docker container holding one headed Chromium:

| Inside the pod | What it gives you |
|---|---|
| **Chromium (headed)** on Xvfb | A real browser, not headless quirks-mode |
| **CDP** on a unique localhost port | Every CDP tool works against it unchanged |
| **noVNC** web viewer | Watch the agent work, live, in any browser tab — or docked right inside VSCode |
| **Cookie injection** | Slice session cookies from your real browser by domain, load only those into the pod |

Your real browser keeps `9222`. Each parallel session gets its own pod:

```
┌─ VSCode #1 ── main worktree ──── your real browser ── CDP 9222
├─ VSCode #2 ── worktree wt2 ───── pod "wt2" ────────── CDP 9223 ── watch :7901
└─ VSCode #3 ── worktree wt3 ───── pod "wt3" ────────── CDP 9224 ── watch :7902
```

Zero interference. And because the viewer is just a URL, you can open it in **VSCode's Simple Browser** (`Ctrl+Shift+P` → "Simple Browser: Show") and have the agent's browser docked next to your agent's terminal — one window holds the session, its files, and its browser.

## Requirements

- Docker (Desktop with WSL2 backend on Windows)
- Node 21+ (only for cookie export/load)
- Any CDP client — [agent-browser](https://github.com/vercel-labs/agent-browser) recommended

## Choosing the browser & compute

The image bakes in **Chromium** by default. To use **Brave** instead (same
engine, speaks CDP identically), build with the arg — or set `POD_BROWSER`
once so every build/spawn uses it:

```powershell
$env:POD_BROWSER = "brave"     # or set it as a User env var to make it permanent
.\pod.ps1 build                # rebuilds the image as Brave
```

Per-pod compute is overridable (defaults: 8 CPU / 8g RAM / 2g shm). Set
per-call or machine-wide via env:

```powershell
.\pod.ps1 up wt2 -Cpus 4 -Memory 6g -Shm 2g
# or: $env:POD_CPUS=6 ; $env:POD_MEMORY=6g ; $env:POD_SHM=2g
```

A bigger shm (shared memory) is the main lever for Chromium-family stability
under heavy pages.

## Quick start

```powershell
git clone https://github.com/jgharbieh/agent-pods
cd agent-pods

.\pod.ps1 build            # once — builds the image
.\pod.ps1 up wt2           # spawn a pod
```

```
Pod 'wt2' is up.
  CDP:    127.0.0.1:9223
  Drive:  agent-browser --session wt2 --cdp 9223 open <url>
  Watch:  http://localhost:7901/vnc.html?autoconnect=true&resize=scale
```

Drive it (note the **explicit session + port flags on every command** — bare commands fall through to a default session that may be attached to a different browser):

```bash
agent-browser --session wt2 --cdp 9223 open https://example.com
agent-browser --session wt2 --cdp 9223 snapshot -i
agent-browser --session wt2 --cdp 9223 click @e3
```

Open the watch URL and see every move.

## All commands

```
pod.ps1 build                                      build the image
pod.ps1 up <name> [-Cookies <p>] [-Worktree <dir>] spawn a pod
pod.ps1 ls                                         list pods, ports, watch URLs
pod.ps1 url <name>                                 print watch URL
pod.ps1 logs <name> [-Tail 100] [-Follow]          container logs + restart count
pod.ps1 down <name> | down -All                    remove pod(s)
```

## Cookies — log the pod in without sharing your profile

```powershell
# Slice cookies out of your real browser (CDP 9222), filtered by domain:
node cookies.mjs export --profile myapp --domains example.com,api.example.com
```

Profiles are playwright storage-state JSON in `cookie-profiles/` — **gitignored**. Only the domains you name leave your browser, never your whole profile.

Two ways into a pod:

```bash
# Preferred — straight into the agent-browser session's own context:
agent-browser --session wt2 --cdp 9223 state load cookie-profiles/myapp.json

# Fallback — into the pod's DEFAULT browser context (Playwright MCP etc.).
# agent-browser uses an isolated context, so this alone won't reach it:
node cookies.mjs load --profile myapp --port 9223
```

`pod.ps1 up wt2 -Cookies myapp` does the fallback injection automatically and records the state file path in `pod.json` so agent tooling can run the `state load` itself.

## Humanized cursor — test UI flows with a *real* pointer

Inside a pod we own the whole X display, so the agent can drive the **actual cursor** instead of injecting synthetic CDP events:

```powershell
.\pod.ps1 click wt2 -Selector "button.start-trial"   # cursor glides over, then clicks
.\pod.ps1 move  wt2 -Selector "nav .dropdown"         # glide only — fires real :hover
.\pod.ps1 click wt2 400 300                           # viewport coords (CSS px)
```

The pointer visibly travels across the screen in the noVNC viewer — you watch the agent *use* the page like a person. More than cosmetic: `Input.dispatchMouseEvent` (what most CDP automation uses) skips parts of the native input path — some `:hover` states, CSS transitions, and HTML5 drag never fire. xdotool moves the real X pointer, so Chromium sees genuine OS input. **Catches a class of UI bugs synthetic clicks can't reproduce.**

This only works in pods (the host browser has no controllable virtual display). It's the reason to run UI-flow testing in a pod even when isolation isn't the goal.

## Worktree binding — zero per-session setup

```powershell
.\pod.ps1 up wt2 -Worktree D:\dev\myproject-wt2 -Cookies myapp
```

writes `.claude/pod.json` into the worktree:

```json
{ "name": "wt2", "cdp": 9223, "watch": "http://localhost:7901/vnc.html?autoconnect=true&resize=scale", "state": "...\\cookie-profiles\\myapp.json" }
```

Convention: agent skills check the workspace root for `.claude/pod.json` first. Present → connect to that pod's port. Absent → default `9222`. A fresh session opened in that worktree automatically drives that worktree's browser.

## Logging & crash forensics

Container stdout (Xvfb, Chromium, socat, x11vnc, websockify) goes to Docker's json-file driver, rotated at 5×50 MB for the live view:

```powershell
.\pod.ps1 logs wt2 -Tail 200        # recent logs + restart count
.\pod.ps1 logs wt2 -Follow          # live tail
```

**Durable archive (extended runs):** on `up`, a detached `docker logs --follow` streams the whole run to `D:\dev\sandbox\<pod-name>\<name>-<timestamp>.log` — survives json-file rotation *and* teardown. On `down`, a final snapshot of the json-file ring is also dumped there. So nothing is lost when you kill a long-lived pod. Override the root with the `POD_LOG_ROOT` env var.

The first line of `logs` tells you the health story: `0 restarts, status=running, started=...`. Pods run with `--restart unless-stopped`, so a crashed browser comes back on its own — the restart count tells you it happened. For in-page logs (console, network), point your usual CDP watcher at the pod's port.

## How the container works

`debian:bookworm-slim` + headed Chromium on a virtual display (Xvfb). Chromium only binds CDP to loopback, so `socat` bridges it to the container interface. `x11vnc` + noVNC serve the display over HTTP. All ports publish on `127.0.0.1` only — nothing is reachable from your network.

**No API keys. No LLM in the container. It's just a browser.** The agent stays on your host.

## Variant: Claude *inside* the pod (`claude-pod.ps1`)

The base pod keeps the agent on your host. The **claude-pod** variant flips that:
it bakes a full Claude Code runtime *into* the image so the agent runs **inside
the container** and drives the local browser. Why: isolation. With the agent on
the host, a prompt-injected shell command (from a malicious page) runs on your
host; inside the container its blast radius is the disposable pod, so
`--dangerously-skip-permissions` is safe to run.

```powershell
.\claude-pod.ps1 build                   # agent-pod-claude:latest (base + Node + Claude Code + agent-browser + nodriver)
.\claude-pod.ps1 up <name>               # spawn (reuses pod.ps1: ports, profile, cookies, logs)
.\claude-pod.ps1 login <name>            # ONE-TIME interactive OAuth -> your Claude quota (NOT an API key); persists on the mount
.\claude-pod.ps1 run <name> "<mission>"  # dispatch a mission headless -> JSON result
.\claude-pod.ps1 shell <name>            # interactive shell in the pod (agent user)
```

- The host only builds / spawns / logs-in-once / dispatches. All browser work is sandboxed.
- Runs as non-root `agent` (Claude Code refuses `--dangerously-skip-permissions` as root).
- Credentials persist at `/data/profile/.claude` (`CLAUDE_CONFIG_DIR`) on the profile mount: log in once, survives teardown.
- The agent's standing manual is baked in at `/work/CLAUDE.md` (source: `claude-pod.CLAUDE.md`); each `run` adds the mission on top.
- Driving: `agent-browser --cdp 9221` (easy default) or `nodriver` (raw-CDP, higher stealth) for high-detection targets.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Agent drives the wrong browser | Bare `agent-browser` command without `--session`/`--cdp`. Always pass both. |
| Cookies loaded but page doesn't see them | They went to the default context; agent-browser uses an isolated one. Use `state load`. |
| Pod's pages missing from `/json/list` | Isolated-context pages don't show there. Use `Target.getTargets` over the browser WebSocket. |
| `pod.ps1` parse errors after editing | Keep the file ASCII-only. PowerShell 5.1 reads BOM-less files as ANSI; smart-quote bytes corrupt string parsing. |
| CDP never comes up | `pod.ps1 logs <name>` — Chromium needs `--shm-size=1g` (already set) and a working `/dev/shm`. |

## License

MIT — see [LICENSE](./LICENSE). Use it, fork it, ship it.
