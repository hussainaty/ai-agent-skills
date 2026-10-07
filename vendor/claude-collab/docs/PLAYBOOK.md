# Claude Collab — Playbook

Deep reference for Claude. The core protocol (always loaded) covers communication rules; this file covers workflows, per-tool gotchas, and limits. Read the sections relevant to your current task.

## 1. Message Delivery — How You Hear the User

Two delivery paths, both automatic:

**While you're working (making tool calls):** A `PreToolUse` hook checks for pending messages before every tool call. If found, the tool is blocked and you see the message as hook feedback. You are never interrupted mid-action — messages arrive in the gap between tool calls.
- **Cancel:** `User clicked CANCEL` → stop immediately, ask what they want via `collab_chat`.
- **Message:** `[COLLAB] User said: ...` → direction change: stop and respond. Minor feedback ("make it blue"): acknowledge via `collab_chat`, continue with it applied.

**While you're idle:** Only the background listener can wake you.
- The listener polls `/peek` every second (non-consuming). When messages appear AND you are idle (Stop hook sets the flag), it consumes and exits — waking you. If you're still working, it defers to the hook path. No race condition.
- Lifecycle: start it (background Bash, `run_in_background: true`) → it runs until it delivers one message → it exits → you respond via `collab_chat` → **immediately start a new one** (same command, provided in `[COLLAB-SETUP]`).
- Exactly ONE listener at a time. The script kills stale instances itself, but don't start extras "just in case".
- Heartbeat `[COLLAB-LISTENER] Still listening...` every 5 min = alive. Do NOT restart on heartbeats.
- If it dies, `[COLLAB-LISTENER-DOWN]` appears after your next tool call — restart then.
- After `collab_close`, `[COLLAB-CLEANUP]` appears — do NOT start a new listener.

**Speed matters when a message lands:** the user is watching the widget. Respond via `collab_chat` first (short is fine), restart the listener in the same message (parallel tool call), then continue working.

## 2. Key Workflows

### Element inspection (user points, you look)
1. User enables click-capture (crosshair icon) and clicks elements (Ctrl+click multi-select).
2. When they send a message, selections arrive automatically as `[COLLAB] Selected elements: [...]` — no need to call `collab_selections`.
3. Call `collab_selections` only if they selected elements but haven't messaged yet.
4. Inspector panel (hamburger icon) shows live CSS the user can edit. Arrow Up/Down walks the ancestor chain; Esc deselects; drag moves elements.

### Browse & interact (scan + act)
1. `collab_browse` URL → 2. `collab_scan` (snapshot) → 3. `collab_act` with batched `steps[]` → 4. re-scan after DOM changes (refs go stale) → 5. screenshot only for visual verification.

### Design iteration
Mock up with `collab_preview` → user approves → apply with `collab_evaluate` → verify with scan (screenshot only if visual) → critique → fix → repeat.

### Inspiration → build
Browse references in tabs → user clicks elements they like → `collab_collect` with category → `collab_moodboard` to review → `collab_synthesize` (use `clear: true` after) → build from the synthesis output.

### Preview vs evaluate
"Look at this" (mockups, variants, reports) → `collab_preview`. "Change the page" (DOM edits, builds, reading state) → `collab_evaluate`.

## 3. Per-Tool Gotchas

### collab_evaluate
- **Before significant DOM manipulation** (replacing body content, building full pages), call `collab_inbox` first — the user may have sent "wait"/"stop" that hasn't reached you. Check between steps of multi-step plans.
- Runs inside the iframe in tabs mode. Need the parent frame? Use single mode.
- Single mode: the widget auto-detaches before eval and re-attaches after — DOM clearing won't destroy it.
- After injecting full pages, external `@import` fonts take a moment — an immediate screenshot may miss them.
- `window.scrollTo()` inside iframes can be unreliable — verify visually.
- Expression cap: 500KB.

### collab_screenshot
- Captures the visible viewport only. Long pages: scroll and capture sections.
- `fullPage: true` may not capture below the scroll limit in iframe mode.
- The widget overlay appears in captures — relevant for precision comparisons.
- Retina screenshots may be 2x DPI — divide pixel coordinates by 2 for CSS values.

### collab_act / collab_scan
- Batch interactions into one `collab_act` call via `steps[]` (form fill = click + type + click submit in ONE call). Add `delay` when the page needs to react.
- Refs (`[ref=eN]`) go stale after DOM changes — re-scan when warned.

### Tabs mode
- Never close the last tab — broken state. Tab IDs are not reused.
- Sites that block iframes (X-Frame-Options/CSP) → use single mode.

### Extension mode
- Real Chrome tabs: no iframes, no cross-origin issues, logged-in sessions work.
- **Join the user's current tab**: call `collab_browse` with `mode: "extension"` and NO url — it attaches to whatever page the user is on (http/https only; chrome:// and similar pages are rejected). Prefer this when the user says "join me" or is already on the page they want to work on. Attached tabs are never closed by `collab_close` — only the widget is removed.
- Widget auto-reinjects on navigation.
- Not yet supported: `collab_wireframe`.
- Auth: `collab_browse` returns port + token when the extension isn't connected — relay them to the user to paste into the extension popup (one-time per session). Stale tokens auto-clear.

### Voice
- Track the last "Voice mode ON/OFF" system message — it determines whether you speak. ON → both `collab_voice_tts` and `collab_chat`. OFF → chat only, stop speaking immediately.

## 4. Performance

- Every tool call is a full round trip — minimize calls: scan over screenshot, batched act, batched evaluate.
- Chat history caps at 1000 messages (oldest trimmed) — `collab_export_chat` preserves long sessions; do it before context gets long.
- Inspiration collection caps at 50 items — synthesize with `clear: true` before collecting more.
- Pixel-probing screenshots: sample element centers, not edges (anti-aliasing); never assume two similar colors are the same hex.

## 5. Input Limits

| Input | Limit |
|---|---|
| CSS selectors | 500 chars |
| Chat messages | 50,000 chars |
| Evaluate expressions | 500KB |
| Visual diff images | 10MB base64 each |
| Action delays | 10,000ms |
| Wireframe grid | 1–200px |
| Responsive audit viewport | 100–5000px |
| A11y audit | first 2000 elements |

## 6. Session Hygiene

- Re-poll after timeouts — the user may be busy testing; a timeout does NOT mean they left.
- Close cleanly with `collab_close` when the session ends.
- When building full pages, scroll through and verify every section before declaring done.
