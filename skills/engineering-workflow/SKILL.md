---
name: engineering-workflow
description: Run a proportionate end-to-end engineering workflow for substantial builds, changes and releases, using existing context, risk-based review and verification, and human decisions only when needed.
metadata:
  short-description: Evidence-led engineering with risk-based delegation and verification
---

# Engineering Workflow

Use this workflow for substantial engineering work. Preserve the project's established architecture, user decisions, permissions and existing workflows. Continue from current state rather than starting a competing process. The lead owns acceptance and may implement directly or delegate when the expected benefit justifies coordination. Do not require a fixed team, a jury, or a human approval for every task.

## Flow

1. **Understand and route.** Inspect relevant repository instructions, current Git state, existing tests and accepted notebook state. Use `workflow-preflight` and the existing `working-context-notebook`. Read only relevant skills and sources. Define observable acceptance criteria and risks; reuse existing architecture and prior evidence.
2. **Research and decisions.** Research only material unknowns and current external facts. Resolve routine reversible choices from existing conventions. Batch genuinely material human-owned decisions with context and reasonable options; keep working on independent safe items while decisions are pending. Do not require a question gate or plan approval when the task already authorizes the work.
3. **Plan and implement.** Choose the smallest maintainable change. Group related delegated work into a complete brief with relevant context, scope, tests, acceptance criteria and stop conditions. Choose model and number of agents based on demonstrated suitability, independence, risk, cost and elapsed time; one agent is valid. Keep one writer per shared file set, reuse related worker sessions, and let workers implement, test and repair until completion or a real blocker.
4. **Verify and review.** Where useful, reproduce bugs and prefer a focused failing test before a behavioral fix. Run the cheapest meaningful checks during iteration and broader integration checks when warranted. Review the actual diff, important edge cases and test evidence; use independent review, a jury or specialized security testing when risk or an explicit request justifies it. Do not create tests that merely mirror implementation or bypass failing checks to appear green.
   - **Fix acceptance tests before implementing.** Take them from the human, the spec, or a separate test author, and do not let the implementer weaken them to pass. Agents resolved 94.3% of SWE-Bench Verified issues against human-written tests but 69.8% when generating their own (TDFlow, arXiv 2510.23761).
   - **Run the tests that cover dependents of the changed code**, not only the new tests: find them with `graphify` or an import/call search. Graph-based impact analysis cut test-level regressions from 6.08% to 1.82% (TDAD, arXiv 2603.17973).
5. **Integrate and deliver.** Review seams for multi-component work, document useful changes, and deploy or communicate externally only when authorized and available. When deployment is in scope, use project-appropriate health checks and recovery. Report actual verification and limitations. Record concise sourced state in the existing notebook; retain substantive cross-session memory only when requested.

## Continuity and economy

Retain related worker sessions and wait efficiently for completion; do not duplicate a running job on timeout. The `session-supervisor` handoff guidance preserves the task state when limits are observed, but a handoff file cannot wake or start another agent. Do not claim automatic continuation, model availability, token savings or successful verification without evidence. Record actual per-role usage, latency and outcomes when exposed; mark unavailable metrics unknown. Do not repeatedly load whole histories, skills, or logs.

For an explicitly requested or risk-justified full independent jury, testing team and dependency-wave process, consult [full-team workflow](references/full-team-workflow.md) as an optional playbook. Its gates, role counts and permissions are not universal requirements; current user instructions and host rules take precedence. Supporting references and templates remain available.
