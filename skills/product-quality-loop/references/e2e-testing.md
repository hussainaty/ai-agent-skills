# End-to-end tests with `npx e2e init`

[e2e](https://github.com/tester-army/e2e) (TesterArmy, Apache-2.0, npm `e2e`)
is an end-to-end test framework for web (Playwright) and mobile (iOS/Android)
apps. Tests mix plain locators and assertions with optional `agent.act` steps
written in natural language. Use it when a change needs a representative
journey through the real UI and backend, and the project has no end-to-end
suite yet or already uses e2e.

## Before running it

- **Check first.** If the project already has an end-to-end suite (Playwright,
  Cypress, or e2e itself), extend that instead of adding a second framework.
- **Runtime.** Node.js 24.8+ (or 22.22.3+ on 22.x). On Windows, run inside
  WSL. Mobile also needs an iOS simulator or Android emulator.
- **Telemetry.** The CLI sends anonymous usage data by default. Set
  `E2E_TELEMETRY_DISABLED=1` before the first command (or run
  `npx e2e telemetry disable`) unless the user has accepted it.
- **Cost and keys.** Tests that use only locators need no model and cost
  nothing. Agent steps need a model: an existing subscription
  (`npx e2e login openai|github-copilot|...`), an API key, or a local model.
  Ask the user which, and do not add a key or sign in for them. Keys go in
  the environment or `credentials.user(name)`, never in tests or the config.
- **Pre-1.0.** APIs and config can change between minor versions. Pin the
  version (`npx e2e@<version> init`) and record it.

## Set up

```bash
E2E_TELEMETRY_DISABLED=1 npx e2e init            # interactive: engine, model, skill, MCP
E2E_TELEMETRY_DISABLED=1 npx e2e init --yes      # no terminal (agents, CI)
```

- Without a terminal, `init` without `--yes` exits 2. `--yes` picks the Web
  engine and **Vercel AI Gateway** (a paid service), installs the skill and
  the MCP config, and skips installing dependencies. Then edit
  `e2e.config.ts` for the model the user chose, or remove `agents` for
  tests that use only locators.
- It writes `e2e.config.ts`, `tests/example.e2e.ts`, a `test:e2e` script,
  `.gitignore` entries, the e2e skill (`.agents/skills/e2e/`, with
  `.claude/skills/e2e/` symlinked to it), and an `e2e mcp` registration in
  `.mcp.json` / `.cursor/mcp.json`. Existing files are kept. Review the diff
  before committing; the MCP registration is a tool-permission change, so
  confirm it with the user.
- Point the target at the app: `APP_URL` (default `http://localhost:3000`)
  and its start command. Never point it at production with real accounts.
  Use a local or preview environment, and test or seeded data only.

## Write and run tests

1. Read `.agents/skills/e2e/SKILL.md` (or `npx e2e guide [topic]`).
2. Run the example (`npx e2e run`) and fix setup errors until it passes.
3. Write one test for the changed journey. Use one `agent.act` per goal,
   each followed by an `expect`. Use no sleeps.
4. Read `.e2e/report.json`, not a truncated log, to decide pass or fail.

Agent steps are replayed from `.e2e/cache` without model calls only after an
assertion has verified them. A first run, or a run after the app changes,
calls the model and can vary. For deterministic evidence, such as an oracle
or a regression gate, assert outcomes with locators and treat agent steps as
navigation only.
