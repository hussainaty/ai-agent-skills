# AI agent skills

Eight open skills for coding agents (Claude Code, Codex, OpenCode, Hermes,
and anything else that reads the [Agent Skills format](https://agentskills.io/specification)).
Each skill is a folder with a `SKILL.md`, plus references and tested scripts
where they help. MIT licensed: use them, fork them, improve them.

| Skill | What it does |
|---|---|
| [`workflow-preflight`](skills/workflow-preflight) | Before substantive work, picks the smallest set of installed skills that covers the task, or decides none is needed. Includes routing evals. |
| [`agent-workflow-pipeline`](skills/agent-workflow-pipeline) | Coordinates repository context (Graphify), public research, implementation, verification, and optional local model routing across Claude Code, Codex, OpenCode, Hermes, Coder, and TrueForge. |
| [`product-quality-loop`](skills/product-quality-loop) | Plans, implements, and verifies scoped software changes through real user journeys, proportionate tests, visual checks, and authorized release steps. |
| [`remote-agent-graphify`](skills/remote-agent-graphify) | Prepares and refreshes Graphify repository context for agents running in Coder workspaces or the TrueForge harness, with explicit token budgets. |
| [`global-memory-recovery`](skills/global-memory-recovery) | Keeps a device-local, account-independent map of projects and task IDs, so work can continue after an account switch or lost chat. Never stores transcripts or secrets. |
| [`verified-code-translation`](skills/verified-code-translation) | Ports code between languages, especially high-level to C, Rust, or assembly. It orders the work by the dependency graph, untangles cycles, flags lock-order deadlock risks, and runs isolated implementer/adversarial-reviewer pairs in Docker containers that scale up and down. It proves the new "engine" behaves like the old one with black-box differential fuzzing and produces an evidence package for safety-critical review (DO-178C, IEC 61508, IEC 60880, NASA). |
| [`scrapegraphai-research`](skills/scrapegraphai-research) | Web research with ScrapeGraphAI and Exa, plus a scientific mode that scales effort to the question, vets papers (venue, artifacts, scale), and verifies every citation. |
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
```

`adapters/hermes-config.example.yaml` shows a Hermes agent configuration.
The skills reference optional tools (Graphify, ScrapeGraphAI, Coder,
TrueForge, Blender MCP) by name only. No keys or machine-specific
configuration are included.

## How they were tested

- **verified-code-translation:** 25 self-tests (`python tests/test_scripts.py`;
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

## Also recommended (third-party, not included here)

These work well with the skills above. They belong to their authors, so get
them from the original sources, under their own licenses:

- [coleam00/skills](https://github.com/coleam00/skills): PIV-loop planning/implementation skills
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman): compressed-output mode
- [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill): frontend design taste
- [jgharbieh/agent-pods](https://github.com/jgharbieh/agent-pods) and [jgharbieh/claude-browser-stack](https://github.com/jgharbieh/claude-browser-stack): containerised agents and browser automation
- [hamelsmu/evals-skills](https://github.com/hamelsmu/evals-skills) (`error-analysis`), [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) (`refactor-safely`), [github/awesome-copilot](https://github.com/github/awesome-copilot) (`repo-story-time`)
- [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) (`frontend-design`, Apache-2.0) and [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) (`senior-prompt-engineer`)
- Graphify (the knowledge-graph tool used by `agent-workflow-pipeline` and `remote-agent-graphify`); `web-scraping` by Top of Funnel (MIT); Claude Collab by Adam Goldsmith (Apache-2.0)

## Credits

The workflow draws on Bun's Zig -> Rust port write-up, the research papers
listed in `research.md`, and Zha Art's "Eggs in Blender (stylized)"
technique short. All code here is original.
