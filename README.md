# AI agent skills

A full software-engineering workflow for coding agents (Claude Code, Codex,
OpenCode, Hermes, and anything else that reads the
[Agent Skills format](https://agentskills.io/specification)), plus the skills
it is built from. Each skill is a folder with a `SKILL.md`, plus references
and tested scripts where they help. Original skills are MIT licensed; bundled
third-party skills keep their own licenses ([VENDOR.md](VENDOR.md)).

## The workflow

[`engineering-workflow`](skills/engineering-workflow) takes a request from
idea to a tested, documented, remembered result:

```
0 recall + route ─ 1 research ─ 2 QUESTION GATE (human answers) ─ 3 plan: tasks in waves
     │                                                                   │
     │        ┌───────────── for every task ──────────────┐              │
     │        │ 4 implementer ─ 5 jury (3–5) + judge ─ 6 testing team │ <──┘
     │        └───────────────────────────────────────────┘
     └─ 9 project graph + docs + memory ─ 8 whole-project tests ─ 7 connect tasks (seam tests)
```

- **Research first.** Public evidence (`scrapegraphai-research` + Agent
  Reach), repository context (`graphify`), and client context
  (`client-profiling`, kept private).
- **Questions before building.** Every open question goes to the human in
  one document, marked blocking or non-blocking, with defaults. The workflow
  stops until the blocking ones are answered.
- **Implementer, jury, judge.** Each task has its own implementer agent, a
  blind jury of reviewers with different lenses (`the-jury`), and a judge who
  verifies findings and returns ACCEPT, REVISE, or ESCALATE.
- **A testing team after each task.** Unit, contract, journey, security,
  and visual testers. They test; they never edit production code.
- **Connect, then test the whole.** Seam tests after each wave, then the
  full suite, end-to-end journeys, and release checks.
- **Graph and memory.** The project graph gets task, decision, test, and
  verdict nodes. Memory is written by type (working, semantic, episodic,
  procedural), with one dated `session-wrap-up` file per session.

The full list of collected skills, and where each one fits, is in
[COLLECTION.md](COLLECTION.md).

## Original skills

| Skill | What it does |
|---|---|
| [`engineering-workflow`](skills/engineering-workflow) | The full workflow above: research, question gate, jury-reviewed tasks, testing team, integration, whole-project tests, project graph, memory. |
| [`session-wrap-up`](skills/session-wrap-up) | One dated file of decisions (not dialogue) per session plus one index; reads back only the relevant entries next time. |
| [`client-profiling`](skills/client-profiling) | Private per-client profiles from a CRM export, mapped to product capabilities. Refuses to write inside a git repo and skips phone/email columns. |
| [`workflow-preflight`](skills/workflow-preflight) | Before substantive work, picks the smallest set of installed skills that covers the task, or decides none is needed. Includes routing evals. |
| [`agent-workflow-pipeline`](skills/agent-workflow-pipeline) | Coordinates repository context (Graphify), public research, implementation, verification, and optional local model routing across Claude Code, Codex, OpenCode, Hermes, Coder, and TrueForge. |
| [`product-quality-loop`](skills/product-quality-loop) | Plans, implements, and verifies scoped software changes through real user journeys, proportionate tests, visual checks, and authorized release steps. |
| [`remote-agent-graphify`](skills/remote-agent-graphify) | Prepares and refreshes Graphify repository context for agents running in Coder workspaces or the TrueForge harness, with explicit token budgets. |
| [`global-memory-recovery`](skills/global-memory-recovery) | Keeps a device-local, account-independent map of projects and task IDs, so work can continue after an account switch or lost chat. Never stores transcripts or secrets. |
| [`verified-code-translation`](skills/verified-code-translation) | Ports code between languages, especially high-level to C, Rust, or assembly. It orders the work by the dependency graph, untangles cycles, flags lock-order deadlock risks, and runs isolated implementer/adversarial-reviewer pairs in Docker containers that scale up and down. It proves the new "engine" behaves like the old one with black-box differential fuzzing and produces an evidence package for safety-critical review (DO-178C, IEC 61508, IEC 60880, NASA). |
| [`scrapegraphai-research`](skills/scrapegraphai-research) | Web research with ScrapeGraphAI and Exa, Agent Reach install/update for platform content (YouTube, GitHub, Reddit, X, RSS), plus a scientific mode that scales effort to the question, vets papers (venue, artifacts, scale), and verifies every citation. |
| [`blender-stylized-2d-animation`](skills/blender-stylized-2d-animation) | Builds stylized 2D-look (cel/toon) Blender scenes through the Blender Lab MCP: flat colour bands, inverted-hull outlines, boil animation on twos, procedural fire, Geometry Nodes bubbles. |

## Install

Copy a skill folder into your agent's skills directory:

- Claude Code: `~/.claude/skills/<skill>/` or `<repo>/.claude/skills/<skill>/`
- Codex: `~/.codex/skills/<skill>/` or `<repo>/.agents/skills/<skill>/`

```bash
git clone https://github.com/hussainaty/ai-agent-skills
cp -r ai-agent-skills/skills/verified-code-translation ~/.claude/skills/
```

Or use the pack tool (standard library only), which verifies hashes and
frontmatter before installing:

```bash
python tools/skill_pack.py verify     # checks manifest.json against skills/
python tools/skill_pack.py list
python tools/skill_pack.py install --help
python tools/validate_skills.py skills   # checks each SKILL.md against the Agent Skills format
```

`validate_skills.py` follows Anthropic's
[skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
It reports errors for invalid names and descriptions and for broken
references to bundled files. It warns about bodies over 500 lines, long
references without a table of contents, and unlinked references. Run it on
your own skills too.

`adapters/hermes-config.example.yaml` shows a Hermes agent configuration.
The skills reference optional tools (Graphify, ScrapeGraphAI, Coder,
TrueForge, Blender MCP) by name only. No keys or machine-specific
configuration are included.

## How they were tested

- **verified-code-translation:** 26 self-tests (`python tests/test_scripts.py`;
  set `VCT_DOCKER_IMAGE=<image with sh+python3>` to include the Docker
  tests). It also ran end to end: real Claude agents ported a 7-module
  Python program with an import cycle to C11 under the strict profile.
  All 6 units were accepted, and the differential test showed 443 cases
  with 0 divergences. See
  [`references/worked-example.md`](skills/verified-code-translation/references/worked-example.md),
  including the bugs that run found in the skill itself.
- **blender-stylized-2d-animation:** built and rendered headless on Blender 5.2.1 LTS (EEVEE).
- **scrapegraphai-research:** used for the research behind `verified-code-translation`.
  Sources are in [`references/research.md`](skills/verified-code-translation/references/research.md).

## Important limits

AI-translated code is unverified tool output. `verified-code-translation`
makes verification systematic and produces evidence for qualified reviewers.
It does not certify software, and measured timing is not a worst-case
execution-time (WCET) bound. Read
[`references/safety-critical.md`](skills/verified-code-translation/references/safety-critical.md)
before using it on anything safety-related.

## Third-party skills

Bundled copies, with licenses and local changes, are listed in
[VENDOR.md](VENDOR.md). Skills that are not bundled, with their install
commands, are in [COLLECTION.md](COLLECTION.md).

## Credits

The workflow draws on Bun's Zig -> Rust port write-up, the research papers
listed in `research.md`, and Zha Art's "Eggs in Blender (stylized)"
technique short. The memory rules follow the CoALA-style memory map in
Nerdy Engineering Stuff's "Agent Memory Types Explained" short; the session
wrap-up pattern comes from nocodealex's wrap-up skill reel; the review jury builds
on tech-leads-club's `the-jury`. Code in `skills/` is original; `vendor/` keeps
its authors' licenses.
