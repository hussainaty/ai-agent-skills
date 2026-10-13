# Source: Context Language Models

What the source says, what is only reported, and where this skill differs.

Source: "Context Language Models Explained: How AI Agents Edit Their Memory",
Nerdy Engineering Stuff, YouTube Short, published 2026-10-12, 2 min 46 s,
https://www.youtube.com/shorts/s6GMFuebiOo. Watched 2026-10-12 (captions and
frames). The video cites the Context Language Models paper and its repository,
the Pi and `pi-clm` documentation, and the Harbor harness guide, checked by its
author on 2026-10-09. The paper's repository and three ports were read on
2026-10-13; see [implementations.md](implementations.md). The paper's full
text was not read, only its arXiv listing.

## The mechanism

1. Normally, conversation and tool results accumulate until the harness
   summarizes them. A summary can drop an exact value needed later.
2. With a context language model (CLM), the harness mirrors the live context
   into a file.
3. The agent edits that file: remove stale output, preserve exact facts,
   update a tracker, create notes.
4. The harness validates the edit and loads the accepted revision into the
   next model request. Existing models can do this without retraining.

## The build checklist from the video, and how this skill meets it

| Video | This skill |
|---|---|
| Keep an untouched event log and a separate editable context | `events/` is written once and hash-checked; `notebook.md` is the editable file |
| Give messages stable identifiers | `E` ids for raw events; `F`, `T`, `N`, `R` ids for notebook items, never reused |
| Validate edits and reject malformed ones | `check` and `accept`; a rejected edit leaves the last accepted revision in force |
| Preserve valid tool-call and result pairs | A fact that cites an event id must point at an event that exists |
| Checkpoint the accepted revision | `accepted/NNNN.md`, one file per accepted revision |
| Send the accepted revision plus new events to the next call | `show` prints the accepted revision for read-back |
| Keep system instructions outside the editable file | Trust rules; `show` labels its output as data |
| Measure tokens and reserve room for the answer | A token budget on the notebook, enforced at `accept` |
| A memory file only works if the harness reads it back | Read-back at phase boundaries and after compaction; a start-up hook where available |

## Where this skill is not a CLM

A real CLM harness replaces the model's context with the edited file. A skill
cannot do that in Claude Code, Codex, or a hosted API: the runtime still owns
the context window and its own compaction. This skill is the same discipline
applied one level up. The notebook is a file the agent maintains and re-reads,
which survives compaction because it is on disk. It does not shrink the
context window by itself.

## Reported, not verified here

The video reports these from the paper, as the authors' results:

- BrowseComp-Plus accuracy of 59.4% for Qwen3.6-27B at a 32K context budget;
- an 11.4% relative accuracy gain (relative, not percentage points);
- 21.5% fewer estimated prefix-reuse inference operations (FLOPs), which is
  not a promise of lower cost or latency.

Do not quote these as measured results of this skill. The video's deployment
example and pseudocode are marked illustrative.

## Costs and risks the video names

- Edits can discard facts that turn out to matter.
- Injected instructions can survive inside notes.
- Mid-context edits break ordinary prefix caching. The paper explores suffix
  cache reuse; that is research, not a feature of every runtime.
- Working-context management is not memory across sessions. That still needs
  persistence and retrieval.
- Check who shrank the context: the model's own edit and an automatic overflow
  guard are different operations.

## Implementations named in the video

- `pi-clm`, an extension for Pi (not Pi's default compaction). Its panel shows
  context size and edit diffs; its compact command asks the model to edit its
  memory.
- `clm-minimal`, a Harbor research harness in the paper's repository.
  One-tool-per-turn mode is an optional research-parity setting.

Neither is installed or used by this skill. Ports for OpenCode and Claude Code
also exist; [implementations.md](implementations.md) lists them.
