# Jury and judge review protocol

A task is reviewed by a **jury** (3 jurors, 5 for high-risk) and decided by
one **judge**. This separates finding problems (many independent eyes) from
deciding (one accountable verdict). It builds on `the-jury`
(tech-leads-club/agent-skills, MIT): blind independent opinions first, then
anonymous deliberation, then a committed verdict with dissent preserved.

## Contents

- Risk tiers
- Juror lenses
- Juror prompt
- Judge prompt
- Verdict rules
- Rounds and escalation

## Risk tiers

| Tier | Examples | Jury size |
|---|---|---|
| Low | copy, styling, isolated pure function | 3 |
| Medium | new endpoint, schema change, state management | 3 |
| High | auth, payments, data deletion, migrations, security boundaries, concurrency | 5 |

## Juror lenses

Give each juror one lens so the panel does not converge on the same
surface-level comments:

1. **Correctness:** does it meet the task card's acceptance tests, including
   edge and failure cases?
2. **Security and data:** authorization, input validation, secrets, injection,
   tenant isolation, and personal data.
3. **Fit and maintainability:** follows the codebase's patterns, no needless
   abstraction, no dead code, names are clear.
4. **UX and accessibility** (UI tasks): states, errors, keyboard, contrast,
   responsive and RTL behavior.
5. **Operations** (high tier): migrations, rollback, performance, logging,
   failure modes.

## Juror prompt

Give each juror, in a fresh context: the task card, the diff, the
implementer's test output, and its lens. Not the other jurors' output, and not
the implementer's reasoning.

> Review this diff only through the lens of <lens>. For each finding, give
> file:line, the concrete failure scenario (inputs -> wrong result), severity
> (blocker / major / minor), and the smallest fix. Say "no findings" if there
> are none; do not invent issues to look thorough. Do not edit files.

## Judge prompt

The judge gets the task card, the diff, the test output, and all juror
findings (anonymized, order shuffled).

> For each finding, check it against the code and mark it CONFIRMED, REJECTED
> (say why), or UNSURE. Then return exactly one verdict:
> - ACCEPT: no confirmed blocker or major finding.
> - REVISE: list the required changes, each tied to a confirmed finding.
> - ESCALATE: a confirmed finding needs a product or risk decision only the
>   human can make.
> Preserve dissent: list any juror finding you rejected that a reasonable
> reviewer could still hold.

## Verdict rules

- A finding counts only after the judge confirms it in the code.
  Majority vote alone never blocks or accepts.
- Minor findings do not block. Record them as follow-ups in `STATE.md`.
- The judge never edits code. Fixes go back to the implementer.
- Tests the judge cannot see run do not count. Ask for output.

## Rounds and escalation

- Round limit: 3 `REVISE` rounds per task. On the 4th, `ESCALATE` with the
  history of findings and fixes.
- Rejection rate: if more than half of the tasks in a wave need a second
  round, pause the wave. The cause is usually the plan or the shared
  interfaces, not the implementers. Fix the task cards, then resume.
- Record every verdict in `STATE.md`: task, round, verdict, confirmed
  findings, dissent.
