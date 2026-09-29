---
name: agent-workflow-pipeline
description: "Coordinate Graphify, public research, implementation quality checks, Jev routing, and Needle 3 local tool calls across compatible coding agents, including Coder, TrueForge, Codex, Claude Code, OpenCode, and Hermes. Use for a cross-agent software task that needs more than one of these capabilities."
---

# Agent Workflow Pipeline

Use this skill to run a coherent, evidence-backed software workflow across the
available agent environments. It routes work to specialized capabilities; it
does not replace the main coding model with a classifier or a tiny local model.

## Route the task

1. For repository structure, dependencies, architecture, or unfamiliar code,
   use **Graphify**. Build one graph per repository, update it incrementally,
   and query an existing graph before rebuilding it.
2. For current public facts that affect an engineering decision, use
   **ScrapeGraphAI research**. Start with a narrow research question, verify
   primary sources, record evidence and limitations, then add only the selected
   evidence to the Graphify context.
3. For a user-authorized code or product change, use the main coding model in
   the selected workspace and complete **Product Quality Loop** verification.
   Match the checks to risk: browser evidence for UI behavior, focused tests for
   logic, and representative end-to-end journeys for cross-layer workflows.
4. Use **Jev** only when the decision is a known, finite set of labels. Examples
   include routing a request as `research`, `graph-query`, `implementation`, or
   `needs-user-input`, and assigning a pre-defined risk tier. Include a
   no-match option and route low-confidence results to the main model instead of
   treating them as instructions.
5. Use **Needle 3** only for local, schema-constrained tool selection,
   structured extraction, or embeddings. Its tool schema must expose only the
   smallest capabilities needed for the turn. A Needle result is a routing or
   extraction result, not authority to change files, deploy, spend money, or
   contact a service.

Read [pipeline-routing.md](references/pipeline-routing.md) when configuring the
Jev and Needle 3 stages or evaluating their routing quality.

## Keep roles separate

The main coding model handles code, prose, multi-step judgment, user questions,
and any action that changes state. Coder, TrueForge, Codex, Claude Code,
OpenCode, Hermes, or another compatible runtime may supply that model,
workspace, sandbox, approvals, and sessions. Graphify supplies repository
evidence. ScrapeGraphAI supplies verified external evidence. Jev classifies a
bounded decision. Needle 3 produces local constrained structure.

Do not install Jev or Needle, supply an API key, register an MCP server,
provision a sandbox, or widen tool permissions unless the user authorizes that
specific platform action. Keep `TYPESAFE_API_KEY` and any Needle platform key
outside skill files and source control.

## Preserve evidence and validate outcomes

Keep the repository graph in `<repo>/graphify-out/`, not in the skill folder.
For planning work, distinguish extracted facts, inferences, and proposed work in
the Graphify context sidecars. Before calling a stage reliable, validate it with
representative inputs and an explicit pass signal; do not borrow a confidence
threshold from another project or model.

Close each user-requested change with the evidence required by Product Quality
Loop. A successful classification, tool call, build, or graph query is not
proof that the changed user journey works.
