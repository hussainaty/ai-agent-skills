---
name: agent-browser-headless
description: Headless browser automation CLI for AI agents. Use ONLY when the user explicitly invokes `/agent-browser-headless` or asks for headless browsing, background scraping, no-window automation, or anything where the browser does not need to be visible to the user. Default browser automation (visible browser via CDP) is the separate `/agent-browser` skill — prefer that unless the user has explicitly asked for headless. Triggers: "/agent-browser-headless", "headless", "background browser", "no UI", "scrape without opening browser", "run in headless mode".
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser-headless

Headless browser automation. Uses Chrome/Chromium via CDP in the background with
no visible window. Faster, no user visibility, no manual intervention.

This is the **opt-in** mode. The default `/agent-browser` skill attaches to a
visible browser window so the user can watch. Use this skill only when the user
wants automation to run silently — background scrapes, CI-style checks, batch
operations, anything where seeing the browser would just be noise.

## Loading the CLI skill content

```bash
agent-browser skills get core             # core workflows + common patterns
agent-browser skills get core --full      # full reference + templates
```

Read that before running commands. The CLI ships the canonical reference and it
stays in sync with the installed version.

## Basic headless workflow

`agent-browser open` launches its own headless Chromium by default. No extra
setup. No CDP-attach step. No PowerShell.

```bash
agent-browser open https://example.com         # launches headless Chromium
agent-browser snapshot -i                       # interactive elements + @eN refs
agent-browser click @e3
agent-browser screenshot result.png
agent-browser close                             # tear down when done
```

The browser is invisible. The user cannot see what is happening. Report what you
found via text or screenshots.

## When to use headless vs visible

| Task | Use |
|------|-----|
| User wants to watch / intervene / sign in themselves | `/agent-browser` (visible) |
| Scraping public pages, no auth required | `/agent-browser-headless` |
| Batch processing many URLs | `/agent-browser-headless` |
| Testing flows that hit gated apps the user is logged into | `/agent-browser` (visible — uses their session) |
| QA / dogfooding a UI the user wants to see | `/agent-browser` (visible) |
| Background data extraction during a longer task | `/agent-browser-headless` |
| Reproducing a bug the user reported | `/agent-browser` (visible — they watch the repro) |

When in doubt, default to visible (`/agent-browser`). Silent automation surprises
users — prefer letting them watch unless they asked otherwise.

## Specialized skills (load on demand)

```bash
agent-browser skills get electron          # Electron apps (VS Code, Slack, etc.)
agent-browser skills get slack             # Slack workspace automation
agent-browser skills get dogfood           # Exploratory testing / QA
agent-browser skills get vercel-sandbox    # agent-browser inside Vercel Sandbox
agent-browser skills get agentcore         # AWS Bedrock AgentCore cloud browsers
```

`agent-browser skills list` shows everything installed.

## Cleanup

Headless sessions linger between commands. Close them when done:

```bash
agent-browser close              # close current session
agent-browser close --all        # close all agent-browser sessions
```

This does NOT touch any visible browser window (managed by the separate
`/agent-browser` skill anyway).
