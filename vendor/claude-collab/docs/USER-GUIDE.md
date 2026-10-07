# User Guide — your side of the collaboration

[TOOLS.md](TOOLS.md) documents what Claude can do. This page is the other half: everything **you** can do from the widget while you and Claude share the page.

## Talk

Type in the chat box and hit Send — Claude sees your message within about a second, even mid-task (it gets interrupted between steps, not after finishing). Replies appear in the same thread, on whatever tab you're looking at.

- **Cancel** — the button that appears while Claude is working. Stops it after its current step.
- **Permission prompts** — when Claude Code needs your approval for an action, the prompt is mirrored into the widget so you can answer without switching to the terminal.
- **Voice** — the mic button toggles voice mode. While it's on: speak instead of typing, and Claude talks back (the mic auto-mutes while Claude is speaking, so it doesn't hear itself). The button shows the current state — listening, paused, or "AI is speaking".

## Point

- **Click capture** (crosshair button) — turns your cursor into a selector. Click any element to grab it; **Ctrl+click** to grab several. Whatever you've selected attaches automatically to your next message — "make *this* bigger" just works.
- **Send selections** (arrow button) — pushes your current selections to Claude without writing a message. The badge shows how many elements you've modified.

## Capture

The camera button opens a screenshot menu. Whatever you capture attaches as an image to your next message (with a remove button if you change your mind):

| Option | What it does |
|---|---|
| 🖼 Visible area | Captures what's on screen |
| 📄 Full page | Scrolls and captures the entire page |
| ⬜ Draw area | You drag a rectangle over the part you mean |
| 🎯 Selected element | Captures the element you click-selected |

**Draw area** is the one to remember on reference sites: see a card you like, draw a box around it, type "I like this — show me on my page."

## Edit

The **inspector panel** (panel toggle button) shows the live CSS of whatever you've selected:

- Edit any property and watch the page update in real time
- **↶ / ↷ Undo/Redo** — step your inspector edits back and forward, property by property
- **Arrow Up / Down** — walk up and down the element's ancestor chain
- **Esc** — deselect
- **Drag** — move elements around the page

Your inspector edits ride along to Claude with your next message, so you can rough something in by hand and say "like this, but do it properly."

## Measure & preview

- **Ruler** (ruler button) — pixel-measurement overlay on the page.
- **Responsive resize** (device button) — preview the current page at Mobile (390×844), Tablet (768×1024), Desktop (1280×800), or Wide (1440×900) in a fullscreen overlay. Reset restores normal view.

## Review Claude's work

Claude shows its work in a **draggable preview panel** on the page:

- **Mockups** — rendered HTML, before anything touches the real page
- **Options** — A/B variants as clickable cards; click one to apply it to the live page, hit **Revert** to undo
- **Moodboards** — the inspiration you've collected, as a thumbnail grid
- **Visual diffs** — before/after with a comparison slider

## Widget housekeeping

- **Follow tabs** — when on, the widget follows you to whichever tab you switch to (extension mode)
- **Minimize** — collapse the widget out of the way; chat history survives navigation and tab switches
