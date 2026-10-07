# The full collection

This is everything the [engineering workflow](skills/engineering-workflow) can
use. Where each skill fits is listed in
[`skills/engineering-workflow/references/skill-map.md`](skills/engineering-workflow/references/skill-map.md).

## Bundled in this repository

- **Original skills** (`skills/`, MIT): `engineering-workflow`,
  `session-wrap-up`, `client-profiling`, `workflow-preflight`,
  `agent-workflow-pipeline`, `product-quality-loop`, `scrapegraphai-research`
  (with Agent Reach), `verified-code-translation`, `remote-agent-graphify`,
  `global-memory-recovery`, `blender-stylized-2d-animation`.
- **Third-party copies** (`vendor/`, each under its own license): see
  [VENDOR.md](VENDOR.md).

## Install from source

These are not bundled. Install them from their authors, and review each one
first: skills run with your agent's full permissions.

```bash
# Review jury and judge (Phase 5)
npx skills add tech-leads-club/agent-skills --skill the-jury --agent claude-code

# softaworks agent toolkit (44 skills: requirements-clarity, qa-test-planner,
# c4-architecture, session-handoff, mermaid-diagrams, skill-judge, ...)
npx skills add softaworks/agent-toolkit --agent claude-code

# Browser automation, security, testing
npx skills add vercel-labs/agent-browser --agent claude-code
npx skills add usestrix/strix --skill application-security-testing --agent claude-code
npx skills add alinaqi/maggy --skill playwright-testing --agent claude-code
npx skills add wshobson/agents --skill code-review-excellence --agent claude-code

# Frontend and React
npx skills add pbakaus/impeccable --agent claude-code
npx skills add vercel-labs/agent-skills --skill react-best-practices --agent claude-code
npx skills add anthropics/skills --skill frontend-design --agent claude-code

# Client and account research (for client-profiling)
npx skills add anthropics/knowledge-work-plugins --skill account-research --agent claude-code
npx skills add phuryn/pm-skills --skill ideal-customer-profile --agent claude-code

# Video, code search, prompts, skill discovery
npx skills add remotion-dev/skills --agent claude-code
npx skills add ast-grep/agent-skill --agent claude-code
npx skills add vercel-labs/skills --skill find-skills --agent claude-code
```

Also used: [mattpocock/skills](https://github.com/mattpocock/skills) (`tdd`,
`grilling`, `code-review`),
[rebelytics/one-skill-to-rule-them-all](https://github.com/rebelytics/one-skill-to-rule-them-all)
(`task-observer`),
[alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)
(`senior-prompt-engineer`), and
[Panniantong/agent-reach](https://github.com/Panniantong/agent-reach) (CLI,
installed per `scrapegraphai-research/references/agent-reach.md`).
