# Pipeline routing and evaluation

Use this reference when configuring the optional model stages. The goal is a
smaller, more reliable decision boundary, not a chain of models for every task.

## Execution flow

```text
request
  -> Jev: bounded route or risk classification, if configured
  -> Graphify: repository context for codebase questions
  -> ScrapeGraphAI research: current public facts, when needed
  -> main coding model in Coder, TrueForge, Codex, or Claude Code
  -> Needle 3: local structured read-only tool dispatch or extraction, if useful
  -> Product Quality Loop: proportionate verification of the completed journey
  -> Graphify update: durable repository context for the next task
```

Skip any stage that does not improve the task. Simple local changes normally do
not need external research, Jev, or Needle 3.

## Jev routing contract

Use Jev only when the output labels are known before the call. A useful request
schema includes `route`, `risk`, and `needs_human_input`, each with criteria and
a no-match state. Calibrate `min-confidence` against a versioned sample of real
requests; a threshold is not portable across wording or projects. A result below
the measured threshold goes to the main model or the user, never directly to a
mutation.

Example routes:

- `graph-query` — a graph exists and the task is a codebase question.
- `research` — current external evidence could alter the implementation.
- `implementation` — the task requests an authorized change.
- `needs-human-input` — a material destination, credential, or product choice is
  missing.

## Needle 3 tool contract

Use one tool per action and precise JSON schemas. Prefer pure, read-only tools
such as `query_graph`, `retrieve_source_snippet`, `extract_requirement_fields`,
and `classify_document`. Do not expose file edits, deployments, credentials,
messages, purchases, or permission changes to Needle 3.

Require the host to check its confidence result. Use a product-specific,
evaluated threshold: accept above it, ask or route to the main model below it,
and reject empty or unsupported calls. Needle's grammar makes the chosen call
well-formed; it does not prove that the request or resulting action is correct.

## Minimum evaluation set

Keep a small, versioned set of representative tasks. Measure:

| Stage | Pass signal |
| --- | --- |
| Jev | Correct route/risk label and safe no-match behavior at the selected threshold |
| Graphify | Expected relevant files or symbols appear in retrieved context |
| ScrapeGraphAI | Claims are traceable to primary sources with scope and limits |
| Needle 3 | Correct schema-valid read-only call; low-confidence and unsupported requests do not act |
| Product Quality Loop | The affected user journey passes with suitable browser, test, or integration evidence |

Record selected-token count with retrieval coverage and downstream task success.
Do not optimize cost or latency by discarding evidence that a task needs.
