# Changelog

## 0.8.0 — 2026-06-12

### New: join the user's current tab
- In extension mode, `collab_browse` with no url attaches to the page the user is already on — "use collab to join me here". Attached tabs are treated as user-owned: `collab_close` removes the widget but never closes the tab.

### Reliability: message delivery rebuilt (found in live testing)
Every fix below was root-caused and re-verified in live sessions — a 9-point delivery checklist passes end to end.

- **No more duplicate messages.** A `collab_browse` that timed out waiting for the extension token left an orphaned transport whose reconnect hook double-handled every message. The transport is now a reused singleton — one instance, one handler.
- **file:// pages work.** Chrome reports `location.origin` as the literal string `file://` there, and `postMessage` to that target is *silently dropped* — the relay handshake never completed, so every message from a local file vanished. Only http(s) origins are trusted as postMessage targets now (else `'*'`), across the relay, content script, widget ack, and voice broadcast.
- **Voice messages actually send.** The voice module posted through a Playwright-only binding that extension mode stubbed as a no-op; it now routes through the shared widget relay in both modes.
- **Selections attach once.** Click-selected elements used to re-attach to every later message; now they attach to the next send only, and re-attach only if you modify them again.
- **Mic handoff between tabs.** Starting voice in a second tab no longer triggers an infinite cross-tab fight over Chrome's single speech-recognition session (with permission-prompt spam); the losing tab releases cleanly.
- **One terminal owns the session.** `collab_browse` claims ownership, so a second Claude Code terminal on the same machine can no longer steal your messages mid-task. Ownership transfers when another terminal deliberately joins.
- **Claude can't go idle deaf.** The stop hook now refuses to let the session go idle while the background listener is dead, forcing a restart first — message delivery no longer depends on the model remembering anything.
- Failed deliveries surface as a visible "⚠ Message not delivered" line in the widget instead of being swallowed.

### Renamed: `design_*` → `collab_*`
- All 26 tools renamed (`design_scan` → `collab_scan`, `design_chat` → `collab_chat`, …) and the recommended MCP registration name is now `collab` (was `design-collab`). The old names were a remnant of the original design-tool framing. **Breaking** if you installed 0.7.0: re-register the server (`claude mcp remove design-collab`, then the new `claude mcp add collab …` from the README) and re-run `npm run setup`.
- Hook matchers are now unanchored tool-name suffixes (`collab_browse|collab_close`), so they work regardless of what name you register the server under.

### Onboarding overhaul
- **Automated hook installer**: `npm run setup` configures all Claude Code hooks with correct absolute paths (global or `--project`), backs up your settings, replaces stale entries after repo moves, and supports `--remove`. No more hand-editing settings.json.
- **Fixed the hook configuration itself**: the previously documented config used bare `design_*` matchers, which never matched the actual namespaced tool names (`mcp__design-collab__design_*`), and put the session hook on the wrong event — fresh installs following the old README had silently broken message delivery. The installer ships the tested configuration.
- **Claude actually sees its instructions now**: Claude Code truncates MCP server instructions at 2,048 characters; the previous 20K-character INSTRUCTIONS.md lost 90% of its content, including the entire communication protocol. The core protocol now fits the budget, and the deep reference moved to `docs/PLAYBOOK.md`, which Claude reads on demand (its path is delivered in the `collab_browse` result).
- `collab_chat` only nags about restarting the background listener when the listener is actually down (was: after every message, causing redundant restarts).

### Positioning
- README rewritten around what the tool is: pair-working with Claude Code inside the live page — shared browser, click-to-point, in-page previews — rather than a design-tool feature list.

### Hardening
- Server-side message store now trims like the widget does (1000 → 500) — no unbounded growth in long extension-mode sessions.
- HTML sanitizer (preview panel) additionally blocks CSS `@import`.
- Extension service worker logs failed chat broadcasts and unmanages dead tabs instead of failing silently.
- Removed misleading `Access-Control-Allow-Origin: *` from the local notify server (nothing browser-side calls it; it binds to 127.0.0.1).
- Added `.gitattributes` (consistent line endings) and ignored `.playwright-mcp/`.

### Fixes
- Widget theme detection no longer reads the misleading wrapper background in tabs/extension mode; defers to iframe-bridge theme reports.
- Light-mode contrast fixes in the inspector panel; opaque panel background when docked.
- Inspector toggle icon stays in sync when the panel is closed from its own button.

## 0.7.0 — initial public release
