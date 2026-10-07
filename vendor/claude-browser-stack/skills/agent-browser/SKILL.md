---
name: agent-browser
description: Browser automation CLI for AI agents. DEFAULT MODE — connect to the user's visible local browser via CDP so they can watch the automation happen live. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction. Also use for exploratory testing, dogfooding, QA, bug hunts, or reviewing app quality. If the user wants HEADLESS automation (no visible window), use the separate `/agent-browser-headless` skill instead.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*), PowerShell(*)
---

# agent-browser (visible-browser mode — DEFAULT)

Browser automation CLI for AI agents, built on [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).

**DEFAULT BEHAVIOR:** attach to a real *visible* browser via CDP so the user can
watch the automation happen in real time. This is what most users want when they
invoke `/agent-browser` — they can course-correct, intervene, and sign in to
gated apps in the same window. Hidden Chromium defeats the point.

For true headless automation (no window, faster, no user visibility), use the
separate `/agent-browser-headless` skill.

## Pick your browser

Any Chromium-family browser works (Chrome, Brave, Edge, Arc, …). Set the binary
path for your machine once. Common Windows paths:

```
Chrome: C:\Program Files\Google\Chrome\Application\chrome.exe
Brave:  C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
Edge:   C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

macOS:
```
Chrome: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

The behavior is identical regardless of browser: launch with a CDP debug port,
attach agent-browser to it.

## Mandatory setup sequence — run this BEFORE any agent-browser command

When the user invokes `/agent-browser` or asks for browser automation, do this
sequence first. Do not skip steps.

### Step 0 — pod check (optional, containerized browser binding)

If you use the optional [agent-pods](https://github.com/jgharbieh/agent-pods)
companion and the workspace root contains `.claude/pod.json`, this worktree is
bound to a containerized browser. Read it:

```json
{ "name": "wt2", "cdp": 9223, "watch": "http://localhost:7901/vnc.html?autoconnect=true&resize=scale", "state": "<path-to-cookie-state.json>" }
```

Pod found → **skip Steps 1–2 entirely** (do NOT touch the host browser, do NOT
probe 9222, do NOT run bare `connect`). Probe the pod's port
(`http://127.0.0.1:<cdp>/json/version`), then drive it with **explicit flags on
every command**:

```bash
agent-browser --session <name> --cdp <cdp> state load <state>   # only if pod.json has "state"
agent-browser --session <name> --cdp <cdp> open <url>
agent-browser --session <name> --cdp <cdp> snapshot -i
agent-browser --session <name> --cdp <cdp> click @e3
```

If the pod's CDP doesn't respond, say so — never fall back to 9222 silently,
that's the host browser, not the pod.

No `pod.json` (or not using pods) → this is the primary session; continue with
Step 1 (host browser on 9222).

### Step 1 — probe CDP first, reuse if alive

**Always probe before killing anything.** Leave the browser open with CDP on so
any session can attach instantly. Do NOT relaunch unless the probe fails.

PowerShell probe:

```powershell
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" `
    -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
  Write-Host "CDP alive on 9222 — reusing existing browser"
  $cdpAlive = $true
} catch {
  Write-Host "CDP not responding on 9222"
  $cdpAlive = $false
}
```

**Probe succeeds → skip directly to Step 2.** No kill, no relaunch.

**Probe fails →** the browser is closed, OR running without the
`--remote-debugging-port` flag.

> **Closing a running browser destroys the user's live tabs — irreversible.**
> NEVER kill/relaunch the browser without explicit confirmation. First check
> whether it's even running:
>
> - **Not running** → nothing to lose; just launch it with the debug port. No prompt needed.
> - **Running** (just without the flag) → STOP. Ask first:
>   *"CDP not responding on 9222. The browser is open without the debug flag.
>   Relaunching closes all your current tabs — save anything open. OK to relaunch?"*
>   Proceed only on explicit yes.

After explicit yes (or if it wasn't running):

```powershell
Get-Process -Name "brave" -ErrorAction SilentlyContinue | Stop-Process -Force   # only if confirmed
Start-Sleep -Milliseconds 500

Start-Process "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" `
  -ArgumentList "--remote-debugging-port=9222" -NoNewWindow

Start-Sleep -Seconds 2
```

**To skip the relaunch dance entirely:** pin a browser shortcut with
`--remote-debugging-port=9222` baked into the Target field. Every normal launch
then exposes CDP automatically.

### Step 2 — drive the browser with an explicit session, in your OWN tab

Use explicit `--session main --cdp 9222` on **every** command. Never bare
commands, never `connect` (session state from a previous run can leave bare
commands pointed at the wrong browser).

First action: create your own labeled tab and work only inside it:

```bash
agent-browser --session main --cdp 9222 tab new --label agent <url>
```

### Step 3 — normal commands, always flagged, always your tab

```bash
agent-browser --session main --cdp 9222 snapshot -i        # interactive elements + @eN refs
agent-browser --session main --cdp 9222 click @e3
agent-browser --session main --cdp 9222 fill @e2 "text"
agent-browser --session main --cdp 9222 screenshot file.png
```

**Tab ownership discipline — hard rule. Two modes, pick one consciously per
task, never drift between them:**

**Own-lane mode (DEFAULT).** The user gave you an independent task ("go scrape
X", "test the login flow", "fill out the form on site Y"):

1. Work ONLY in tabs you created (`tab new --label agent`, `agent-2`, …).
   The user opening a new tab for themselves must NEVER pull your automation
   onto it. Before each action burst, re-select your tab: `... tab agent`.
   The historic failure mode — user opens a tab mid-task, agent silently starts
   driving it and abandons its own — is exactly what this kills.
2. Mark your tabs so the user knows what not to touch. Right after every
   navigation, run:
   ```bash
   agent-browser --session main --cdp 9222 eval "document.title = '🤖 ' + document.title"
   ```
   🤖 prefix on the tab = agent-controlled, hands off. Re-apply after each nav —
   titles reset on navigation. (Skip inside pods; the whole pod browser is agent-owned.)
3. Real Chrome tab *groups* are NOT reachable over CDP (extension-only API), so
   grouping agent tabs programmatically is impossible. The 🤖 marker is the
   mechanism. If a task needs many agent tabs, open a separate window
   (`... window new`) so agent tabs live in their own window entirely.

**Takeover mode (EXPLICIT only).** The user's task references THEIR current tab
("look at this page", "what's on my screen", "fill this form I have open",
"debug this") — then their active tab IS the work surface:

1. Say you're taking the tab: "Taking over your active tab (<title>)." One line.
2. List tabs (`... tab`), select THEIR active one, work there. No 🤖 marker — it's their tab.
3. When done, say you're off it: "Done — your tab is yours." Then do not touch it
   again; new follow-up work goes back to own-lane tabs unless re-pointed at theirs.

If you cannot tell which mode the task implies, ask one short question
("Your current tab, or my own?") before touching anything.

The browser stays visible. The user sees every action and can interact with
their own tabs manually while you remain connected in yours.

## Known pitfalls (learned the hard way)

1. **Never run bare agent-browser commands (no `--session`/`--cdp`).** Bare
   commands hit the default session, which may still be bound to a different
   browser from an earlier run. Proven failure: after `connect 9223` (a pod), a
   bare `navigate` drove the host browser on 9222. Explicit `--session <name>
   --cdp <port>` on every single command.

2. **Do NOT use `open <url>` without `--cdp`.** Without it the CLI launches its
   own hidden Chromium and the user sees nothing. `--session main --cdp 9222
   open <url>` attaches to the visible browser.

3. **`agent-browser close --all` only closes agent-browser's own sessions.** It
   does not close the user's browser. To kill the browser use the PowerShell
   `Stop-Process` command above — and only after confirmation.

4. **CDP port collisions.** If something else is already on 9222 (rare), pick
   another port — pass the new port to both the launch flag and `--cdp`.

5. **After the browser is killed externally** (user closes it, reboot), the CDP
   connection is dead. Re-run Step 1 (probe → reuse or ask-then-relaunch) + Step 2.

6. **Tabs.** Stable ids (`t1`, `t2`, …) and labels survive across commands within
   a session. Never resolve "current tab" by focus — focus follows the user's
   clicks. Resolve by your own label (own-lane) or by their explicitly chosen tab
   (takeover). See tab ownership discipline above.

## Loading the full CLI command reference

The CLI ships its own up-to-date command reference. Load it whenever you need
flags, semantic locators, waits, or anything beyond the basics:

```bash
agent-browser skills get core             # core workflows + common patterns
agent-browser skills get core --full      # full reference + templates
```

## Specialized skills (load on demand)

```bash
agent-browser skills get electron          # Electron apps (VS Code, Slack, Discord, etc.)
agent-browser skills get slack             # Slack workspace automation
agent-browser skills get dogfood           # Exploratory testing / QA
agent-browser skills get vercel-sandbox    # agent-browser inside Vercel Sandbox
agent-browser skills get agentcore         # AWS Bedrock AgentCore cloud browsers
```

`agent-browser skills list` shows everything installed.
