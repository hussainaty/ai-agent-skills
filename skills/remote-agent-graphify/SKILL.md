---
name: remote-agent-graphify
description: "Prepare and maintain Graphify repository context for coding agents running in Coder workspaces or the TrueForge harness. Use for repository exploration, architecture questions, and context refreshes; not for provisioning either platform."
---

# Remote Agent Graphify

Keep a durable, queryable Graphify map beside the repository while Coder supplies
the development workspace and TrueForge supplies an optional agent runtime. The
graph is repository knowledge; it is not a substitute for either platform's
skill, sandbox, approval, or session mechanisms.

## Select the runtime

- **Coder workspace:** use the checked-out workspace directory. This skill lives
  in `.agents/skills/`, which Coder discovers when that directory is the
  workspace working directory. After changing a skill, refresh the Coder chat's
  context or start a new chat before expecting the change to apply.
- **TrueForge:** mount this directory from a Git repository as a Git-backed
  skill. Ensure the selected sandbox has access to the target repository and a
  shell or an approved Graphify MCP tool. Treat generated graph data as
  ephemeral unless the sandbox or checkout explicitly persists it.

Do not provision a Coder workspace, install a dependency, publish a TrueForge
skill, connect an MCP server, or change sandbox permissions without the user's
authorization for that platform action.

## Keep one graph per repository

Store generated data at `<repo>/graphify-out/`; never put it inside a skill
directory or load `graph.json` wholesale into agent instructions.

1. Resolve the repository root. Prefer the Git top-level directory; otherwise
   use the workspace project root.
2. If `graphify-out/graph.json` is absent, use the installed Graphify workflow
   to build a baseline graph for that root. Report the corpus summary, graph
   health, and Graphify's output paths.
3. If a graph already exists and code or docs changed, run Graphify's incremental
   update flow. Preserve the manifest and cache so unchanged files are not
   re-extracted.
4. If the user asks an architecture question and a graph already exists, query
   it immediately. Do not rebuild first. Expand the query against the graph
   vocabulary and cite source locations returned by Graphify.

When Graphify is not available in the selected runtime, state that the missing
dependency is the Graphify skill, CLI, or MCP integration. Do not invent graph
findings from an absent graph or silently replace Graphify with an unrelated
indexer.

## Assemble agent context deliberately

For a focused implementation task, begin with the named files or symbols and
select one or two graph hops, with a 2,500-token budget by default. For an
architecture, roadmap, or cross-repository task, begin with community summaries
and bridge nodes, using a 4,000-token budget by default. Keep extracted facts,
inferences, and proposed work distinct.

Give the agent only the selected graph context and the source snippets needed
to verify it. Keep the graph output on the workspace volume or persistent
checkout so later Coder or TrueForge runs can refresh and query the same
repository map.

## Use the companion workflows

Use the Graphify workflow for repository structure and evidence-backed codebase
retrieval. For time-sensitive public information that changes an engineering
decision, use `scrapegraphai-research` first and retain only verified primary
sources as graph evidence. For a user-authorized implementation, use
`product-quality-loop` to verify the real user journey after the graph-guided
change. Use `agent-workflow-pipeline` when the task needs all of these routes
plus optional Jev or Needle 3 model routing.

## Handoff between Coder and TrueForge

Use the same repository revision when passing work from a Coder workspace to a
TrueForge sandbox. Before acting on a prior graph, confirm that its manifest or
last update matches the checkout; otherwise update it. Keep the agent's model,
tools, sandbox, approvals, and session state in TrueForge, while Graphify
provides repository structure and evidence-backed retrieval.

For proposed engineering work, write `graphify-out/context.json` and
`graphify-out/CONTEXT_PLAN.md` only when the user requests planning or
architecture context. Record the token budget, source evidence, uncertainties,
risks, extension points, and validation signals there.
