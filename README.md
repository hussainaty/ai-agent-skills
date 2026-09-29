# AI agent skills

Three open skills for coding agents (Claude Code, Codex, and others that read
`SKILL.md`). Each skill is a folder of instructions plus tested scripts.
MIT licensed: use them, fork them, improve them.

| Skill | What it does |
|---|---|
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

## Credits

The workflow draws on Bun's Zig -> Rust port write-up, the research papers
listed in `research.md`, and Zha Art's "Eggs in Blender (stylized)"
technique short. All code here is original.
