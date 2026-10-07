---
name: watchandlearn
description: Guided narrated tour of a feature or flow — Claude opens pages in the browser, walks through the UI step by step, and narrates what it sees. Useful for onboarding, feature documentation, and demos.
triggers:
  - watch and learn
  - show me how X works
  - walk me through
  - narrate the flow
  - /watchandlearn
---

# /watchandlearn

Agent-browse a feature or flow while narrating in real time. The user watches;
Claude drives and explains.

## When to invoke

- "Show me how the checkout flow works"
- "Walk me through what a new user sees during onboarding"
- "Narrate the proposal send flow"
- "/watchandlearn [feature]"

## What you need

- The `/agent-browser` skill (or WebFetch for read-only page inspection)
- A URL to start from (local dev, staging, or prod)
- A goal: what flow are we walking through?

## Steps

### 1. Clarify (if not obvious)

Ask:
- Which environment? (local, staging, prod)
- What feature/flow?
- Audience: just the user, or generating team docs?

### 2. Plan the tour

State the steps before starting. Example:

> Tour: signature request flow
> 1. Requests tab → list view
> 2. "New Request" → fill form
> 3. Send → confirm email provider returns 200
> 4. Recipient signing page (via signing link)
> 5. Submit → confirm notification + signed copy email

### 3. Walk step by step

For each step:
1. Navigate to the page / trigger the action
2. **Narrate** what you see — what the UI shows, what's happening under the hood, what the user experiences
3. Note anything surprising, broken, or worth documenting

Use `/agent-browser` for interactive flows. Use WebFetch for read-only page inspection.

### 4. Narration style

- Present tense: "The list view shows all pending requests sorted by date."
- Explain the why: "This status badge turns orange at 'viewed' — recipient opened the email but hasn't signed."
- Flag issues: "⚠️ This field doesn't validate email format client-side — only the backend rejects it."
- Connect to code where you can: "The token in this URL maps to a record in the signatures table."

### 5. Output

After the tour:

```markdown
## [Feature] — Walkthrough Summary
**Date:** YYYY-MM-DD
**Environment:** [local / staging / prod]

### Flow
[Numbered steps with what happens at each]

### What Works
- [item]

### Issues / Gaps Found
- [item] → [suggested fix or ticket]

### Architecture Notes
- [anything worth capturing about how this feature is built]
```

## Notes

- Pair with `/watchall` or `/watchconsole` to capture console/network signal while you narrate.
- Don't log in as a real customer in prod — use staging or a test account.
