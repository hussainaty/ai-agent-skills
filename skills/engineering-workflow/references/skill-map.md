# Skill map

Every skill in this collection, by workflow phase. "Bundled" means it ships in
this repository (`skills/` or `vendor/`); otherwise use the install command.
A missing skill is skipped and noted in `STATE.md`.

## Contents

- Phase 0 — recall and route
- Phase 1 — research
- Phase 2 — question gate
- Phase 3 — plan and split
- Phase 4 — build
- Phase 5 — review
- Phase 6–8 — testing, integration, release
- Phase 9 — documentation and memory
- Specialist skills
- Install sources

## Phase 0 — recall and route

| Skill | Role | Source |
|---|---|---|
| `workflow-preflight` | Choose the smallest skill set | bundled (`skills/`) |
| `global-memory-recovery` | Read/refresh the device-local memory map | bundled |
| `agent-workflow-pipeline` | Cross-agent coordination (Codex, Claude Code, OpenCode, Hermes, Coder) | bundled |
| `remote-agent-graphify` | Hand work to a Coder/TrueForge remote workspace | bundled |
| `caveman`, `cavecrew` | Compressed output and subagents to save context | vendor/caveman |
| `session-handoff` | Handoff notes between sessions | softaworks/agent-toolkit |

## Phase 1 — research

| Skill | Role | Source |
|---|---|---|
| `scrapegraphai-research` | Public-web research; Agent Reach for platform content | bundled |
| `web-scraping` | Scraping strategy and tooling | vendor/web-scraping |
| `graphify` | Repository knowledge graph | `npx skills add` (see graphify upstream) |
| `prime-codebase`, `prime-backend`, `prime-frontend` | Load codebase context | vendor/coleam00-skills |
| `client-profiling` | Private client/lead profiles that shape requirements | bundled |
| `account-research`, `stakeholder-map` | Company and stakeholder research | anthropics/knowledge-work-plugins (sales) |
| `perplexity`, `web-to-markdown` | Extra research routes | softaworks/agent-toolkit |

## Phase 2 — question gate

| Skill | Role | Source |
|---|---|---|
| `plan-create-prd` | Product intent (what/why) | vendor/coleam00-skills |
| `plan-architecture` | Approach and stack (how) | vendor/coleam00-skills |
| `requirements-clarity` | Find ambiguous requirements | softaworks/agent-toolkit |
| `grilling` | Hard questioning of a plan | mattpocock/skills |

## Phase 3 — plan and split

| Skill | Role | Source |
|---|---|---|
| `piv-slice-epic` | Epic -> tickets with dependencies | vendor/coleam00-skills |
| `piv-plan-implementation` | Per-ticket implementation plan | vendor/coleam00-skills |
| `plan-create-stories` | User stories | vendor/coleam00-skills |
| `verified-code-translation` | Ports/rewrites: dependency waves, cycle handling, oracle | bundled |
| `c4-architecture`, `mermaid-diagrams`, `database-schema-designer` | Architecture and data diagrams | softaworks/agent-toolkit |

## Phase 4 — build

| Skill | Role | Source |
|---|---|---|
| `worktree-create`, `worktree-merge` | Isolated branches per task | vendor/coleam00-skills |
| `piv-implement`, `piv-implement-issue`, `piv-run-full-loop` | Implementer loops | vendor/coleam00-skills |
| `tdd` | Test-first implementation | mattpocock/skills |
| `refactor-safely` | Dependency-aware refactors | tirth8205/code-review-graph |
| `ast-grep` | Structural search and rewrite | ast-grep/agent-skill |
| `impeccable`, `frontend-design`, `taste-skill` family | UI quality | vendor/taste-skill; pbakaus/impeccable; anthropics/skills |
| `vercel-react-best-practices`, `react-dev`, `react-useeffect` | React guidance | vercel-labs/agent-skills; softaworks/agent-toolkit |

## Phase 5 — review

| Skill | Role | Source |
|---|---|---|
| `the-jury` | Blind panel, anonymous deliberation, committed verdict | tech-leads-club/agent-skills |
| `piv-review-changes`, `piv-review-pr`, `piv-fix-review-findings` | Code review and fix loop | vendor/coleam00-skills |
| `caveman-review` | Compressed review comments | vendor/caveman |
| `code-review-excellence` | Review checklist | wshobson/agents |
| `skill-judge` | Judge skills themselves | softaworks/agent-toolkit |

## Phase 6–8 — testing, integration, release

| Skill | Role | Source |
|---|---|---|
| `product-quality-loop` | Risk-based verification; e2e setup; release checks | bundled |
| `agent-browser` | Real-browser journeys and screenshots | vercel-labs/agent-browser |
| `claude-collab`, `claude-browser-stack` | Shared browser sessions and MCP browser stack | vendor/ |
| `piv-validate` | Full validation suite | vendor/coleam00-skills |
| `playwright-testing` | Playwright patterns | alinaqi/maggy |
| `qa-test-planner` | Test plans | softaworks/agent-toolkit |
| `application-security-testing` | Security assessment | usestrix/strix |
| `error-analysis` | LLM-pipeline failure analysis | hamelsmu/evals-skills |
| `build-dark-factory` | Autonomous issue-to-PR factory | vendor/coleam00-skills |

## Phase 9 — documentation and memory

| Skill | Role | Source |
|---|---|---|
| `graphify` | Project graph with task/decision/test nodes | graphify upstream |
| `repo-story-time` | Repository narrative | github/awesome-copilot |
| `document-multiple-repository` | Multi-repo documentation | credited in README |
| `crafting-effective-readmes`, `backend-to-frontend-handoff-docs` | Docs | softaworks/agent-toolkit |
| `session-wrap-up` | Dated per-session decision records + one index; read back only what matters | bundled |
| `hooks-create` | Enforce procedural memory in code | vendor/coleam00-skills |
| `task-observer`, `system-evolution-review`, `opportunity-scan`, `ablate-ai-layer` | Improve the AI layer from real runs | rebelytics/one-skill-to-rule-them-all; vendor/coleam00-skills |
| `lesson-learned` | Capture lessons | softaworks/agent-toolkit |

## Specialist skills

| Skill | Use | Source |
|---|---|---|
| `blender-stylized-2d-animation` | Blender 2D animation | bundled |
| `remotion-*` | Video with Remotion | remotion-dev/skills |
| `agent-pods`, `watchall`, `watchandlearn`, `watchconsole` | Agent pods and observers | vendor/agent-pods |
| `senior-prompt-engineer` | Prompt design | credited in README |

## Install sources

```bash
npx skills add tech-leads-club/agent-skills --skill the-jury --agent claude-code
npx skills add softaworks/agent-toolkit --agent claude-code          # review first; 44 skills
npx skills add anthropics/knowledge-work-plugins --skill account-research --agent claude-code
npx skills add vercel-labs/agent-browser --agent claude-code
npx skills add remotion-dev/skills --agent claude-code
npx skills add hamelsmu/evals-skills --skill error-analysis --agent claude-code
npx skills add tirth8205/code-review-graph --skill refactor-safely --agent claude-code
npx skills add github/awesome-copilot --skill repo-story-time --agent claude-code
npx skills add usestrix/strix --skill application-security-testing --agent claude-code
```

Review any third-party skill before installing: skills run with the agent's
full permissions.
