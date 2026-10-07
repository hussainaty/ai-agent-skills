# Testing team

After the judge accepts a task, a testing team checks it. After each wave,
the team tests the seams between tasks. At the end, it tests the whole
project. Testers write and run tests; they never change production code.

## Contents

- Roles
- Per-task checklist
- Seam tests (after each wave)
- Whole-project run
- Report format
- Evidence graph

## Roles

Deploy only the roles the task needs:

| Role | When | Tools |
|---|---|---|
| Unit/property tester | Every task with logic | the project's test runner; `tdd` |
| Contract tester | Task exposes or changes an API, event, or schema | API tests, schema validation, generated clients |
| Journey tester | UI or cross-layer change | `agent-browser`; e2e suite via `product-quality-loop` (`references/e2e-testing.md`) |
| Security tester | Auth, input, secrets, file upload, multi-tenant data | `security-review`; `application-security-testing` if installed |
| Visual/UX tester | Visible UI change | screenshots at mobile/tablet/desktop widths; RTL when bilingual; accessibility checks |
| Data tester | Migrations, seeds, reports | migrate up/down on a copy, seed completeness, report totals |

## Per-task checklist

- Acceptance tests from the task card all exist and pass.
- At least one failure-path test per new behavior (bad input, denied access,
  timeout, empty state).
- No test depends on order, wall-clock sleeps, or production data.
- UI: each state renders (loading, empty, error, success) and the main
  journey works by keyboard.
- Results come from exit codes and report files (`junit.xml`,
  `.e2e/report.json`, coverage output), not from reading a truncated log.

## Seam tests (after each wave)

For every edge in the task graph that the wave completed:

1. The consumer's contract test runs against the real provider, not a mock.
2. One journey crosses the seam end to end.
3. Errors propagate correctly across the seam (provider failure gives a
   clear consumer error, not a hang).

A failing seam becomes a fix task with its own implementer, jury, and judge.

## Whole-project run

On the integrated branch: full test suite, type check, lint, build, all e2e
journeys, seed data complete enough to demo every feature, migrations from
an empty database, and a deployment smoke test in a non-production
environment. Add the performance, cost, or accessibility budgets agreed at the
question gate.

## Report format

```markdown
## Testing report — <task id or "wave N" or "project">
- Commit: <sha>
- Roles run: unit, contract, journey, security, visual
- Commands and exit codes:
  - `npm test` -> 0 (212 passed)
  - `npx e2e run` -> 0 (.e2e/report.json: 9/9)
- Failures: none | <test, cause, owner task>
- Not run, and why: <role> — <reason>
```

## Evidence graph

At Phase 9, add these nodes to the project graph (`graphify`) next to the code
nodes, so anyone can trace why something exists and how it was proven:

- `task:<id>` (goal, wave, status), linked to the files it changed;
- `decision:<id>` from `DECISIONS.md`, linked to the tasks it shaped;
- `test:<name>`, linked to the task and to the files it covers;
- `verdict:<task>:<round>`, linked to its task, with confirmed findings;
- `research:<id>`, linked to the decisions it informed.

Keep client names and personal data out of graph nodes. Use a project-level
label such as "client A".
