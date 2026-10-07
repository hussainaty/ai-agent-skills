# Tool Reference

The complete reference for all 26 MCP tools, derived from the tool schemas in `src/tools/`. For workflows and per-tool gotchas aimed at Claude itself, see [PLAYBOOK.md](PLAYBOOK.md).

Conventions: parameters marked **required** have no default; everything else is optional. All selectors are CSS selectors, capped at 500 characters unless noted.

---

## Browsing & tabs

### `collab_browse`

Open a URL in a new tab, or — in extension mode with no url — join the page the user is currently on. Each call with a url creates a new tab; the chat widget persists across all tabs.

| Param | Type | Default | Description |
|---|---|---|---|
| `url` | string (URL) | — | The URL to navigate to. Omit in extension mode to attach to the user's currently active tab ("join me here"). |
| `mode` | `tabs` \| `single` \| `extension` | `tabs` | `tabs` uses iframe tabs for multi-page browsing. `single` opens the page directly without iframes. `extension` uses the Chrome extension in the user's real browser. |

Notes: in extension mode, the first call returns a one-time auth token for the extension popup. Attached (joined) tabs are user-owned — `collab_close` removes the widget but never closes them.

### `collab_navigate`

Navigate to a URL within the active tab. Lighter than `collab_browse` — does not open a new tab or return page info.

| Param | Type | Default | Description |
|---|---|---|---|
| `url` | string | **required** | URL (http/https) or relative path starting with `/` (e.g. `/about`). |

### `collab_tabs`

Manage browser tabs: list all open tabs, switch to a specific tab, or close a tab.

| Param | Type | Default | Description |
|---|---|---|---|
| `action` | `list` \| `switch` \| `close` | **required** | What to do. |
| `tabId` | number | — | Tab ID (required for `switch` and `close`). |

Notes: tabs-mode sessions must keep at least one tab open; tab IDs are never reused.

### `collab_resize`

Resize the browser viewport for responsive design testing.

| Param | Type | Default | Description |
|---|---|---|---|
| `width` | number (320–2560) | **required** | Viewport width in pixels. |
| `height` | number (480–1600) | **required** | Viewport height in pixels. |

Common breakpoints: mobile 390×844, tablet 768×1024, desktop 1280×800, wide 1440×900.

### `collab_close`

Close the collab browser window and clean up. Call when the session is over. No parameters.

---

## Page understanding

### `collab_scan`

Instantly read a web page as structured text — ~100x faster and cheaper than a screenshot. Returns an accessibility-tree-like snapshot of interactive elements (with clickable `[ref=eN]` indices for `collab_act`), page content as markdown, or both.

| Param | Type | Default | Description |
|---|---|---|---|
| `mode` | `snapshot` \| `content` \| `full` | `snapshot` | `snapshot` = interactive element tree with refs, `content` = main content as markdown, `full` = both. |
| `scope` | string (selector) | `body` | Limit the scan area (e.g. `main`, `#content`). |
| `maxTokens` | number | `4000` | Approximate token budget — output is truncated to fit. |

Notes: refs go stale after DOM changes — re-scan before acting again.

### `collab_act`

Interact with page elements using `[ref=eN]` indices from `collab_scan`. Supports click, type, select, hover, focus, clear — a single action or multiple steps in sequence.

| Param | Type | Default | Description |
|---|---|---|---|
| `action` | `click` \| `type` \| `select` \| `hover` \| `focus` \| `clear` | — | Action for single-step mode. |
| `ref` | string | — | Element ref for single-step mode, e.g. `e5`. |
| `value` | string (≤100KB) | — | Text to type or option to select. |
| `steps` | array of `{ action, ref, value?, delay? }` | — | Multiple actions executed in sequence. `delay` (ms, ≤10000) lets the page react between steps. |

Notes: batch a whole flow (click + type + submit) into one call via `steps`.

### `collab_screenshot`

Take a screenshot of the target site or a specific element within it. Returns the image as base64.

| Param | Type | Default | Description |
|---|---|---|---|
| `selector` | string (selector) | — | Screenshot a specific element. If omitted, captures the viewport. |
| `fullPage` | boolean | `false` | Capture the full scrollable page. |

Notes: works in all three modes, including extension mode (full-page capture there uses the Chrome debugger API briefly). The chat widget overlay appears in captures.

### `collab_evaluate`

Execute arbitrary JavaScript in the target page. Use for DOM inspection, style queries, design token extraction, or any custom page interaction.

| Param | Type | Default | Description |
|---|---|---|---|
| `expression` | string (≤500KB) | **required** | JavaScript expression that returns a serializable value. |

Notes: runs in the target page context (the iframe in tabs mode). Strict-CSP sites block this in extension mode.

---

## Live building & mockups

### `collab_preview`

Render HTML into the widget's draggable in-page preview panel. Use for design mockups, component variations, or CSS experiments.

| Param | Type | Default | Description |
|---|---|---|---|
| `html` | string | — | HTML to render. Omit to hide the panel. |

### `collab_options`

Present clickable design options in the preview panel. Clicking an option replaces the target element in the live page; a revert button undoes it. Use for A/B comparisons.

| Param | Type | Default | Description |
|---|---|---|---|
| `selector` | string (selector) | **required** | The element each option replaces (e.g. `.hero-title`, `nav`). |
| `options` | array of `{ label, html }` (min 2) | **required** | `label` names the option; `html` (≤100KB) replaces the target when clicked. |

### `collab_wireframe`

Open a blank wireframing canvas with optional grid overlay. Use `collab_evaluate` to add sections, the inspector to refine.

| Param | Type | Default | Description |
|---|---|---|---|
| `html` | string (≤500KB) | — | Initial wireframe HTML to render. |
| `grid` | boolean | `true` | Show alignment grid. |
| `gridSize` | number (1–200) | `8` | Grid size in pixels. |

Notes: not yet supported in extension mode. Utility classes available: `.wf-section`, `.wf-text`, `.wf-box`, `.wf-img`, `.wf-btn`, `.wf-nav`, `.wf-grid`, `.wf-flex`.

### `collab_visual_diff`

Show a before/after comparison slider in the preview panel.

| Param | Type | Default | Description |
|---|---|---|---|
| `before` | string (base64 PNG, ≤10MB) | **required** | The "before" state (from `collab_screenshot`). |
| `after` | string (base64 PNG, ≤10MB) | **required** | The "after" state. |
| `labelBefore` | string | `Before` | Label for the before image. |
| `labelAfter` | string | `After` | Label for the after image. |

---

## You pointing at things

### `collab_selections`

Get elements the user has selected via click capture in the widget. Returns element data with computed styles, then clears the selection buffer. No parameters.

Notes: usually unnecessary — selections attach automatically to the user's next message. Call this only when the user has selected elements but not yet sent a message. Inspector edits (live CSS changes) ride along with selections.

---

## Inspection & extraction

### `collab_extract_styles`

Extract computed styles and design tokens from an element: colors, typography, spacing, borders, shadows — everything needed to replicate its appearance.

| Param | Type | Default | Description |
|---|---|---|---|
| `selector` | string (selector) | **required** | Element to extract styles from. |
| `includeChildren` | boolean | `false` | Also extract styles from direct children. |

### `collab_extract_tokens`

Scan the page and extract its design system: colors, typography scales, spacing values, border radii, and shadows. Clusters similar values and outputs structured tokens.

| Param | Type | Default | Description |
|---|---|---|---|
| `scope` | string (selector) | `body` | Limit the scan. |
| `maxElements` | number (≤5000) | `500` | Max elements to scan (performance cap). |

### `collab_extract_component`

Extract a DOM element as a self-contained HTML+CSS component. Captures the full subtree with computed styles, resolves relative URLs, and returns portable code.

| Param | Type | Default | Description |
|---|---|---|---|
| `selector` | string (selector) | **required** | Root element of the component. |
| `mode` | `inline` \| `stylesheet` | `stylesheet` | `inline` = styles as attributes, `stylesheet` = scoped style block. |
| `pseudoStates` | boolean | `false` | Also extract `:hover`/`:focus` rules from stylesheets. |

---

## Inspiration workflow

### `collab_collect`

Collect a design inspiration from the current page: the element's styles, component HTML, a screenshot thumbnail, and the source URL. Items accumulate across tabs for later synthesis.

| Param | Type | Default | Description |
|---|---|---|---|
| `selector` | string (selector) | **required** | Element to collect. |
| `category` | enum | **required** | One of: `header`, `nav`, `hero`, `layout`, `colors`, `typography`, `spacing`, `component`, `footer`, `card`, `button`, `form`, `animation`, `other`. |
| `note` | string (≤2000) | — | e.g. "love the gradient", "clean spacing". |

Notes: the collection caps at 50 items — synthesize (with `clear`) before collecting more.

### `collab_moodboard`

Show all collected inspirations as a visual moodboard in the preview panel: thumbnails, categories, notes, and source info in a grid.

| Param | Type | Default | Description |
|---|---|---|---|
| `filter` | enum | `all` | Filter by any `collab_collect` category, or show all. |

### `collab_synthesize`

Analyze all collected inspirations and produce a unified design specification: color palettes, typography scales, spacing systems, and layout patterns combining the best of each source.

| Param | Type | Default | Description |
|---|---|---|---|
| `clear` | boolean | `false` | Clear the inspiration collection after synthesis. |

---

## Auditing

### `collab_a11y_audit`

Run an accessibility audit: contrast ratios, missing alt text, form labels, heading hierarchy, touch targets, and link text. Highlights issues on the page with severity-coded overlays.

| Param | Type | Default | Description |
|---|---|---|---|
| `scope` | string (selector) | `body` | Limit the audit scope. |
| `showOverlays` | boolean | `true` | Show severity-coded overlays on the page. |

Notes: audits the first 2000 elements.

### `collab_responsive_audit`

Audit responsive design across breakpoints: resizes the viewport, runs layout checks, captures screenshots per breakpoint.

| Param | Type | Default | Description |
|---|---|---|---|
| `breakpoints` | array of `{ name, width, height }` (100–5000px) | 5 presets | Defaults: mobile-portrait 390×844, mobile-landscape 844×390, tablet-portrait 768×1024, tablet-landscape 1024×768, desktop 1280×800. |
| `includeScreenshots` | boolean | `true` | Capture screenshots per breakpoint. |

---

## Communication

### `collab_chat`

Send a message to the user via the widget chat.

| Param | Type | Default | Description |
|---|---|---|---|
| `message` | string (≤50000) | **required** | Message to send. |
| `waitForReply` | boolean | `false` | Leave false — blocking here conflicts with hook-based delivery and can lose messages. Replies arrive via the hooks/listener instead. |
| `timeout` | number (≤300000) | `120000` | Max wait in ms when `waitForReply` is true. |

### `collab_inbox`

Check for new user messages without blocking. Returns immediately, or short-polls up to `timeout`.

| Param | Type | Default | Description |
|---|---|---|---|
| `timeout` | number | `0` | `0` = instant check; e.g. `5000` = wait up to 5s. |

### `collab_voice_tts`

Speak text aloud in the collab browser using Edge TTS. The mic is muted during playback to prevent echo.

| Param | Type | Default | Description |
|---|---|---|---|
| `text` | string | **required** | Text to speak. |
| `voice` | string | `en-US-AriaNeural` | Edge TTS voice name (e.g. `en-US-GuyNeural`, `he-IL-AvriNeural`). |

### `collab_export_chat`

Export the full chat history from the widget — as a session log, or to preserve context before compaction.

| Param | Type | Default | Description |
|---|---|---|---|
| `filePath` | string | — | Absolute path to write the export to. If omitted, returns the chat JSON directly. |

Notes: widget chat history caps at 1000 messages (oldest trimmed) — export long sessions early.
