# Open implementations: what was taken and what was left

Five repositories were cloned and read on 2026-10-13. Ideas were re-written
for this skill; no code was copied. Read means the protocol, prompts,
validation, budget, and steering files. Not read: terminal panels, model
serving and training code, most tests, and the paper's full text (only its
arXiv listing).

## Contents

- Sources
- Taken, by idea
- Left out on purpose
- Editing the real context, per agent
- Related work outside the paper

## Sources

| Repository | What it is | Licence |
|---|---|---|
| `facebookresearch/context-language-models` | The paper's code: Harbor harness, prompts, budget controller, ContextBench adapter | CC BY-NC 4.0 (ideas only, never code) |
| `lolipopshock/pi-clm` | The authors' extension for the Pi agent | MIT |
| `cskwork/claude-code-clm` | Port to Claude Code, with a benchmark against `/compact` | MIT |
| `francescovidaich964/opencode-clm` | Port to OpenCode | MIT |
| `cv/pit` (issue 198, `src/context/`) | A stricter design: a few validated operations, not a free file | MIT |

Paper: "Context Language Models", Shao et al., arXiv 2609.37725, submitted
2026-09-29.

## Taken, by idea

| Idea | From | In this skill |
|---|---|---|
| Budget reminders in tiers, each fired once and re-armed when the size drops | Meta `budget.py`, pi-clm, pit `notices.ts` | `accept` and `nudge` print a note at 50, 75, and 90% |
| The low tier only informs; a how-to there causes early wholesale deletion | Meta `budget.py` | The 50% note says to finish the step first |
| "Do not wipe": edits keeping under a quarter of a region are followed by redoing the work | Meta `budget.py` | Warning when one edit drops most items |
| Note contract: ruled-out attempts with reason and "do not retry", exact commands tried, values marked verified or unverified, a next line | Meta `budget.py` | `Ruled out` section with a required reason; facts already carry status; `Next` |
| Fit gate with a rejection that says what to do instead | Meta `edit_gate.py` | Over-budget message: replace with a shorter line, do not append |
| Locate text with code, never retype it | Meta `prompts.yaml` | "Copy exact values from the source"; `recall --grep` |
| One batched edit beats many small ones; be generous in what replaces removed text | Meta `prompts.yaml`, pi-clm skill | "When to edit" |
| Large output moved to a file, replaced by a one-line note naming how to re-read it | pi-clm `overflow.ts`, pit `elisionStub` | `log` prints a pointer line; `recall` |
| Bounded recall of an archived source | pi-clm `continuity.ts` (128 to 8,000 tokens) | `recall` prints about 2,000 tokens, with `--grep` and `--offset` |
| Head and tail kept when long output is cut | Meta `prompts.yaml`, pi-clm `observation.ts` (80/20) | `recall` keeps 80% head and 20% tail |
| Per-revision diff and timeline | pi-clm panel, pit provenance entries | `diff` and `history` |
| Code fingerprint recorded with each run | Meta `provenance.py` | `history.jsonl` stores a hash of `notebook.py` |
| Persist before activate; atomic writes; owner-only files | pi-clm `mirror-store.ts`, opencode-clm `SECURITY.md` | Temp-file-then-rename writes; `0700`/`0600` where supported |
| Model-written notes never carry authority; "working memory, not instructions" | pi-clm, opencode-clm, pit `metadata.ts` | Trust rules; `show` and `recall` label output as data; injection phrasing is rejected |
| Compact at task boundaries, after extracting a result, before a large read, when a decision supersedes work | LangChain Deep Agents (blog) | "When to edit" triggers |
| Each rule fires on its trigger; no standing ritual | Meta `proposer_prompt.md` | `nudge` is silent unless something is newly due |
| Planted-fact recall quiz by source of fact (user, tool, derived, update) | claude-code-clm `bench/` | `scripts/bench.py` |

## Left out on purpose

| Not taken | Why |
|---|---|
| Replacing the live conversation | Needs a per-agent plugin and pins the skill to one runtime and version. It would end cross-agent use. See the next section. |
| Free rewriting of any message, including the user's | pit's rule is safer: the model cannot change what the user said. The notebook never holds the conversation at all. |
| No size gate (pi-clm's default mode) | A notebook that can grow without limit stops being read. The budget stays. |
| Whole-context rewrite into one summary | Loses everything else. pi-clm's own skill says to use it sparingly. |
| Rollback and retry at the context limit | Deletes recent work to make room. Only a harness that owns the context can do it. |
| One tool per turn, size trailer on every result | Research-parity switches for the paper's harness. |
| Provider token calibration | Needs the provider's own count per request, which a script cannot see. The estimate stays at four characters per token. The ports measured that estimate 1.8 to 2.5 times too low on dense text, so set a lower `--budget` for dense data. |
| Blocking compaction from a hook | A stuck session is worse than a lossy summary. |
| Pin, continuity, and archive annotations | A fact with a source already is a pin, and a logged event already is an archive. |

## Editing the real context, per agent

This skill works the same in every agent because it only needs files and
Python. An agent that also wants its actual context window edited can add a
plugin beside it. None is installed by this skill. Each runs with the agent's
full permissions, so review it first.

| Agent | Plugin | Limits stated by its author |
|---|---|---|
| Pi | `pi install npm:@lolipopshock/pi-clm` | Edits re-send everything after the edit point; the edit turn stays in context until removed |
| OpenCode | `opencode-clm` | Model not trained for CLM; one edit accepted in nine benchmark runs; code not hand-reviewed |
| Claude Code | `cskwork/claude-code-clm` | Edits apply between turns only; tested on Claude Code 2.1.290; about twice the cost of `/compact` in its benchmark |
| Codex | none found | Use the notebook alone |

Results reported by `claude-code-clm` (three sessions, three runs per arm):
174 of 174 key facts kept, against 173 of 174 for `/compact`; 7.9k tokens left
against 5.6k; cost 0.65 to 1.07 USD against 0.30 to 0.48. Its author calls the
gap within run-to-run variance. Not reproduced here.

## Related work outside the paper

- Anthropic's context-engineering cookbook separates three tools: compaction
  (lossy; exact values need explicit instructions), tool-result clearing
  (re-fetchable output), and the memory tool (across sessions). The notebook
  sits between the first two and is not the third.
- LangChain Deep Agents lets the model choose when to compact. Its authors saw
  no self-triggered compaction on Terminal-bench-2, so do not expect an agent
  to tidy unprompted. That is why `nudge` exists.
