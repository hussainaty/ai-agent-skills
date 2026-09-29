---
name: product-quality-loop
description: "Plan, implement, and verify scoped software changes through working user journeys, proportionate tests, visual inspection, and authorized release checks. Use for feature work, bug fixes, UI improvements, and release completion; not read-only questions or draft-only requests."
---

# Product Quality Loop

Complete the user's intended outcome with evidence from the environment where they will use it. A passing build proves a build; it does not prove a usable workflow, populated production data, or delivered email. Scale this loop to the change: a spacing fix needs visual inspection, while an account invitation needs authorization, persistence, and delivery checks.

## 1. Recover context and define completion

- Reconcile the current request, accepted corrections, prior authorization, and unfinished work. After a handoff or interruption, inspect current state before repeating mutations. Treat earlier reports as leads to verify, not fresh proof.
- Inspect relevant code, tests, working-tree changes, and project instructions. Preserve unrelated edits. Use existing architecture knowledge, including a repository graph when available and relevant; if tooling is unavailable, inspect source directly and state the limitation.
- Identify the actual user, role, tenant, environment, and entry point for the reported behavior. A restricted client view and an empty manager workspace are different cases.
- State observable acceptance criteria. For multi-part work, keep a compact checklist connecting each requested outcome to its implementation, configuration/data needs, verification, and unresolved items. Use working notes; create persistent planning files only when useful or requested.
- Research unfamiliar behavior in current primary documentation when it affects the solution. Do not substitute broad research or installing more tools for examining the existing product.
- Carry forward authorization already given. Ask only for a missing decision or authority that materially changes scope, cost, security, or an irreversible action; an authorized deployment or email does not need another conversational approval.

## 2. Implement complete user journeys

- Work in coherent slices: entry point, UI, API, authorization, persistence, relevant states, and feedback. Implement the smallest complete outcome using established patterns.
- Where users create content, provide a reachable empty state and creation route. Seeded content must not be required to open a page or create the first item. Check parent-child relationships and navigation between workflow stages.
- Preserve tenant boundaries, role semantics, existing business rules, and user data. Resolve a visibility defect at its cause rather than granting broader authority.
- For UI changes, inspect the relevant design system and reference images before editing. Treat spacing, hierarchy, visible actions, responsive layout, focus, scroll behavior, and motion as part of the requested result. Check long real names, translations, relevant RTL behavior, and reduced motion when affected.
- Keep loading, empty, error, populated, and permission-denied states usable where they are affected. A visual fix must also work with realistic content and the intended role.

## 3. Prove behavior, then fix what fails

Choose evidence by risk, not by tool count. Do not automatically add tests for low-impact reversible edits; add regression tests where they protect meaningful behavior.

| Changed behavior | Useful evidence |
| --- | --- |
| Layout, interaction, animation | Real browser inspection at affected widths and states; screenshots for visual comparison |
| Logic or persistence | Focused unit/integration tests for outcomes and relevant failure modes |
| Authorization | Allowed and denied API requests, including cross-tenant access when relevant |
| Cross-layer workflow | A representative end-to-end journey through the actual UI and backend |
| Schema, seed, deployment, or email | Read [release-verification.md](references/release-verification.md) and use its relevant sections |

- Run applicable repository checks, including types/build for changes that can affect them. Confirm completion using the exit status and relevant result or an authoritative machine-readable report. A background start or truncated log without another conclusive result is insufficient.
- Reproduce reported bugs before fixing when practical. For consequential or intermittent bugs, verify that the regression test exposes the original failure and passes with the fix.
- Classify failures using evidence: product defect, incorrect assertion, fixture interference, or environment problem. Do not label a failure pre-existing or flaky merely because it is inconvenient.
- Keep behavior coverage when correcting tests. For example, scope an ambiguous locator to the intended region; do not skip the workflow. Isolated passing reruns explain a failure but do not make the original full-suite run green.
- Fix the cause, rerun its reproducer and relevant regressions, then broaden only if integration risk or new findings justify it. Avoid repeated full suites after the relevant evidence is already sound.
- Use a real browser for visual claims. Browser-rendered screenshots can establish static layout; inspect interaction when it is affected. HTTP 200, DOM text, and passing unit tests cannot establish visual quality or successful interaction.

## 4. Finish the authorized outcome

- When the request includes release, continue through required configuration, migrations, data, deployment, and live checks. When it asks only for code or diagnosis, respect that boundary.
- For release, seeding, invitations, recovery, or notification work, read [release-verification.md](references/release-verification.md) before acting. Preserve the user's target URL and environment.
- Under a deadline or usage limit, reduce narration and optional investigation. Prioritize the complete requested workflow and checks that could expose a consequential failure; do not silently drop requirements or replace evidence with confidence.
- If a step is blocked, finish independent authorized work. State the exact blocker, attempted checks, and the narrow input or access needed. Do not repeat a mutation with uncertain results until its state is reconciled.

## 5. Close out accurately

Lead with the delivered outcome, then give the relevant evidence and outstanding limitations. Mention files when helpful; use exact test counts only when observed. Distinguish local verification, live API checks, live browser checks, provider acceptance, and recipient-confirmed receipt.

For a broad request, reconcile every acceptance criterion before saying it is complete. Explicitly identify partial verification, unresolved failures, or required follow-up. Do not call a subset of tests a full suite, populated notes a finished media deliverable, or a queued deployment a live release. Avoid promising perfection or zero future defects.
