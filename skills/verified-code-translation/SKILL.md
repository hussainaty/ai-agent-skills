---
name: verified-code-translation
description: Translate a codebase or module from one programming language to another — especially high-level to low-level (Python/JS/Go/Zig/C++ -> C, Rust, or assembly) — with a dependency-ordered plan, cycle and deadlock untangling, isolated implementer/adversarial-reviewer pairs in Docker containers that scale up and down, black-box equivalence testing, and a traceable evidence package suitable for safety-critical review (DO-178C, IEC 61508, IEC 60880, NASA). Use for ports, rewrites, transpilation, "rewrite X in Rust/C", legacy migration, or when the user asks to replace an implementation while keeping identical behaviour. Not for greenfield code or single-function snippets.
metadata:
  short-description: Dependency-ordered, adversarially reviewed, differentially tested code translation
---

# Verified code translation

Swap the engine, keep the car: the new implementation must produce the same
observable behaviour as the old one on every input you can throw at it, and
you must be able to show the evidence. Speed comes from parallel agents;
trust comes from ordering, isolation, independent review, and black-box tests.

The workflow is distilled from Bun's 11-day Zig->Rust port (Anthropic, 2026)
and ~20 papers on LLM code translation; see
[references/research.md](references/research.md) for sources, numbers, and
the evidence behind every rule below.

## Non-negotiables

1. **Behaviour oracle first.** Before any translation, have a test corpus that
   treats the program as a black box (argv/stdin/files/network in, outputs
   and exit codes out). Unit tests bound to the old language do not survive
   the swap. Bun's port worked because its test suite was written outside
   the implementation and never changed; "0 tests skipped or deleted".
2. **Fix the process, not the output.** When agents repeat a mistake, change
   the porting guide or prompts and re-run. Hand-patching one file leaves
   the mistake in every other file.
3. **The implementer never judges its own work.** Separate context windows:
   one implementer, two or more reviewers who see only the source and the
   diff and are told to assume it is wrong.
4. **No stubs to satisfy a compiler.** A placeholder, `todo!()`, or a
   paragraph-long comment justifying a workaround is a rejection.
5. **AI output is unverified tool output.** This skill never certifies
   anything. For safety-critical work it produces an evidence package for
   qualified humans and qualified tools (see
   [references/safety-critical.md](references/safety-critical.md)).

## Phase 0 — Classify and freeze

- Record source/target languages, target platform/ABI, criticality level
  (DO-178C DAL A–E, IEC 61508 SIL, IEC 60880/62138 category, ISO 26262 ASIL,
  or "none"), real-time constraints, and allowed toolchain.
- Criticality A/B, SIL 3/4, category A, or hard real-time => use
  `--profile strict`, ≥2 reviewers from **different model families or
  prompts**, and a human sign-off per unit. Read
  [references/safety-critical.md](references/safety-critical.md) now.
- Build or locate the black-box oracle. If none exists, write it first in a
  language-neutral harness and get it green against the OLD program.
  Capture the old program's outputs as golden files.
- Tag the baseline commit. Nothing below modifies the source tree.

## Phase 1 — Dependency tree and deadlock analysis

```bash
python scripts/depgraph.py SRC_DIR --out plan.json --md plan.md
```

This builds the unit graph (C/C++ includes, Python imports, Zig `@import`,
Rust `mod`/`use`, JS/TS imports), collapses cycles into strongly connected
components, orders them into **waves** (dependencies first; tasks inside a
wave are independent), and scans for runtime deadlock hazards.

Resolve every finding before translating (details and the full taxonomy in
[references/deadlocks.md](references/deadlocks.md)):

| Finding | Meaning | Action |
|---|---|---|
| `co-translate-atomically` cycle | small SCC; no member can compile first | one implementer ports the whole group as one task (automatic) |
| `break-before-translate` cycle | large SCC | in the SOURCE language, cut the listed edges (extract shared types into a seam unit, invert a dependency, or move code). Re-run. Bun did this refactor before starting. |
| lock-order inversion | two paths take the same locks in different orders | define one global lock order; document it in the guide; reviewers check it |
| self-reacquire | non-recursive mutex locked twice | the source may rely on a recursive mutex; map it explicitly |
| lock held across await | executor deadlock | async mutex, or drop the guard first |
| `[CONCURRENCY]` unit | threads/atomics/signals/ISRs present | reviewers get the concurrency checklist; target needs a stress test |

`max_parallel_width` is the most pairs that can ever help. Many waves of
width 1 mean a sequential port: don't add agents, which only adds
coordination cost.

## Phase 2 — De-risk: guide, ownership, hazards, trial run

Write these into the repository (the orchestrator feeds them to every agent):

- `PORTING.md`: pattern map from source idioms to target idioms, file
  layout, naming, error model (exceptions -> status codes, etc.), integer
  and float semantics, string encoding, allowed libraries, build command.
  Start from the language-pair hazards in
  [references/language-hazards.md](references/language-hazards.md).
- `OWNERSHIP.tsv` (for C/Rust/assembly targets): for each struct field or
  global, who owns it, its lifetime, and who frees it. Bun generated a
  per-field lifetime table before porting.
- Run a **trial on 2–3 representative units**, read every output yourself,
  and fix the guide until a trial passes review without hand edits.

Cost: the guide is re-read on every agent call. Keep it stable and at the
top of the prompt so the provider's prompt cache can serve it. In Bun's port
the cached input reads (72B tokens) were more than ten times the uncached
input (5.9B).

## Phase 3 — Isolated implementer/reviewer loop with dynamic containers

```bash
python scripts/orchestrate.py --repo REPO --plan plan.json --target-root port \
  --guide PORTING.md --guide OWNERSHIP.tsv \
  --implementer 'claude -p --model sonnet --permission-mode acceptEdits --allowedTools "Read,Write,Edit,Glob,Grep" --disallowedTools "Bash" < "{prompt_file}" > "{out_file}"' \
  --reviewer    'claude -p --model sonnet --disallowedTools "Bash,Write,Edit,NotebookEdit" < "{prompt_file}" > "{out_file}"' \
  --reviewers 2 --profile strict --image YOUR_TOOLCHAIN_IMAGE \
  --gate 'make -C port check' --max-pairs 8 --run-dir ../run
```

Per task: fresh git worktree -> implementer (file tools only, no git, no
slow global commands) -> **path guard** (only `--target-root` may change)
-> `audit.py` static gate -> build/test **gate inside that pair's container**
(`--network none`, CPU/memory/PID limits, private build cache, so no
`cargo`/`make` lock contention) -> N reviewers with fresh context -> merge
by explicit commit, serialised -> accept, or retry with the findings, and
escalate to a human after `--max-attempts`.

**Dynamic scaling** (`scripts/scale_policy.py`, re-evaluated every tick):
- Add pair containers, at most ×2 per step, while ready tasks wait and
  the rejection rate is ≤25%.
- Remove pair containers when:
  - the DAG section is sequential (no ready tasks), or
  - rejections exceed 40% or merge conflicts exceed 10% (errors are
    amplifying: independent agents amplified errors 17× vs 4× for
    centrally coordinated ones), or
  - disk I/O saturates, or the CPU, disk, or budget caps are hit.
- **Pause** at ≥60% rejections: stop, fix `PORTING.md` or the prompts, then
  resume. `state.json` makes the run resumable.
- A liveness rule and a stall watchdog guarantee the loop itself cannot
  deadlock.

Any agent CLI works (Claude Code, Codex, a local model): the templates take
`{prompt_file} {out_file} {workdir}`. For stronger independence, point
`--reviewer` at a different model family than `--implementer`. If agents
must also run inside containers, wrap the command in `docker run` with the
worktree mounted and network egress limited to the model API.

Operational lessons from testing this skill end to end:
- **Guide bugs look like implementer bugs.** In the first review round,
  reviewers rejected code that faithfully followed a wrong rule in
  `PORTING.md`: C `isspace()` misses the bytes 0x1C–0x1F that Python's
  `str.split()` treats as whitespace. When a finding traces back to the
  guide, fix the guide, re-open every unit ported under the old revision,
  and resume from `state.json`.
- **Put shared bounds and types in one committed guide artifact** (for
  example `port/limits.h`). If each unit guesses its own limits, you get
  cross-unit mismatches that only review or integration will catch.
- **Stale base:** a unit reviewed while one of its dependencies is being
  re-ported gets checked against the old dependency. Each retry branches
  from the current integration head, so the retry sees the fix.
- **Windows / Git Bash:** MSYS rewrites container paths such as `-w /w`
  to `W:/`. Call Docker from Python (as the scripts do), or prefix shell
  calls with `MSYS_NO_PATHCONV=1`.

Inside a Claude Code session without the CLI loop, apply the same protocol
with subagents: one implementer subagent per ready task (worktree
isolation), then two fresh reviewer subagents per diff, never reusing the
implementer.

## Phase 4 — Integration: prove the new engine behaves the same

1. `audit.py tests --before OLD_TESTS --after NEW_TESTS`: no test deleted,
   no skip added.
2. Full oracle suite against the new build on every target platform.
3. Differential fuzzing, old vs new, on generated inputs, with divergent
   inputs auto-shrunk:
   ```bash
   python scripts/difftest.py difftest.json --out diff-report.json
   ```
   Run it inside a container (`"docker": {...}`) for untrusted binaries.
   Passing the shipped tests is not enough: LLM translations that pass every
   test still diverge on other inputs (4.9% of candidates overall, up to
   13% for one system, in a 2026 decompiler study).
4. Beyond testing, use equivalence proof where the target allows it:
   bounded model checking or symbolic equivalence (CBMC/Kani/KLEE-style),
   LLVM translation validation (Alive2) for IR-level work, or
   oracle-vs-candidate verification as in VERT. Record which units are
   proven, which are tested, and which are only reviewed.
5. Timing and resources: `difftest.py` records observed times and
   binary sizes. Observed time is **not** a WCET bound. Hard real-time
   targets need static WCET analysis on the final binary and target CPU.
6. Sanitizers and fuzzing on the new code (ASan/UBSan/TSan for C/C++,
   Miri + `cargo fuzz` for Rust), continuously if the code parses input
   (Bun: parsers were fuzzed 24/7, ~100B executions -> ~15 fix PRs).

## Phase 5 — Evidence package (hand to humans)

From `run/journal.jsonl` and the reports, produce:
- **Traceability matrix**: source unit -> target files -> commit -> gate
  result -> reviewer verdicts -> oracle/difftest coverage.
- **Deviation log**: every intentional behaviour difference, with approval.
- **Unsafe/assembly inventory**: each `unsafe` block or asm routine with
  its SAFETY invariant and its test or proof.
- **Escalations**: tasks the loop could not close, with findings.
- **Tool record**: models and versions, prompts/guide hash, toolchain
  versions. The AI is an unqualified tool, so every output is covered by
  independent verification.
- **Regression list after release**: Bun still shipped 19 regressions
  despite a green suite (debug-assert side effects, slice-length
  assumptions, retained bounds checks, format-macro semantics). Add each
  class to `PORTING.md` and the reviewer checklist.

## Assembly targets

Translate to C or Rust first, verify, then go to assembly only for the units
that need it, one routine at a time. Per routine:
- state the ABI (SysV vs Win64: argument registers, callee-saved registers,
  16-byte stack alignment, 32-byte shadow space on Win64);
- differential-test it against the C reference with edge values;
- bounded-verify it where tools exist;
- put the audit's push/pop balance check in the gate.

Research systems pair the LLM with a solver for this. Guess & Sketch lets
the LLM propose and localise errors, then a symbolic solver repairs them.
Don't trust an unchecked LLM rewrite of assembly.

## Stop conditions

Stop and report instead of pushing on when:
- the rejection rate stays high after two guide revisions;
- a cycle cannot be broken without changing behaviour;
- the oracle cannot observe a requirement (timing, concurrency, hardware
  I/O): say which requirement has no evidence;
- the target violates a mandated standard that needs a human deviation.

## Files

- `scripts/depgraph.py`: dependency waves, SCC cycles plus cut edges, lock-order/deadlock scan
- `scripts/orchestrate.py`: worktree plus container pairs, reviewer quorum, merge, journal, resume
- `scripts/scale_policy.py`: add/remove/pause decision rules
- `scripts/difftest.py`: black-box old-vs-new equivalence, fuzzing, shrinking, timing, sizes
- `scripts/audit.py`: stub/unsafe/assert-side-effect/NASA P10 gates; test-inventory diff
- `templates/implementer.md`, `templates/reviewer.md`: role prompts
- `tests/test_scripts.py`: self-tests (`VCT_DOCKER_IMAGE=... python tests/test_scripts.py`)
- `references/`: research evidence, deadlock taxonomy, language hazards, safety-critical profile, and [references/worked-example.md](references/worked-example.md) (a real end-to-end run, its numbers, and the skill bugs it found)
