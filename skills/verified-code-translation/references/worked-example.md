# Worked example: Python engine -> safety-profile C (real run, 2026-09-28/29)

A 7-module Python command interpreter was ported to C11 under `--profile strict`.
It contains a registry↔dispatcher import cycle, exceptions, floor modulo,
Python's permissive `int()`, and CRC-32. Agents: headless `claude -p`
(Sonnet), with file tools only for implementers and no write tools for
reviewers, 2 reviewers per unit. Gates ran in `--network none` Alpine
pair containers.

## What each stage did

| Stage | Result |
|---|---|
| depgraph | 7 units, 1 cycle (dispatcher<->registry, co-translated atomically), 3 waves, max width 4 |
| scaling | 1 -> 2 -> 3 pair containers for wave 0; shrank as work became sequential; 0 left at the end |
| audit (strict) | rejected a 72-line `parse_int64` (Power of Ten rule 4) before any reviewer tokens were spent |
| reviewers, round 1 | blockers: C `isspace()` misses 0x1C–0x1F, which Python `str.split()` treats as whitespace; 4096-byte buffer truncates `error: unknown command: <long token>`. Both were **guide bugs** |
| pause | rejection rate ≥ 60% -> run stopped for a process fix |
| process fix | PORTING.md rev 2 + shared `port/engine_limits.h`; `ops_text` re-opened; resumed from `state.json` |
| reviewers, round 2 | caught a cross-unit mismatch (dispatcher passing 2047 args into the old 64-arg `ops_text`); fixed on retry |
| outcome | 6/6 units accepted; strict audit PASS (3 assertion-density warnings) on 623 lines of C |
| integration | `gcc -std=c11 -Wall -Wextra -Werror -pedantic` clean; difftest in a container: **443 cases, 0 divergences** (43 edge cases + 400 fuzzed multi-line scripts); worst observed time 0.35× the Python |
| deviation probe | int64 overflow correctly detected as DIVERGENT and shrunk to one line -> logged as an approved deviation |

## Bugs found in the skill itself during this run (all fixed, with regression tests)

1. Scaler starvation: 0 pairs + ready work + a middling rejection rate returned "hold" forever. Fixed with a liveness rule and a stall watchdog.
2. The long-justification audit flagged a legitimate header API comment. It now requires justification wording or an in-body position.
3. An MSYS crash dump (`bash.exe.stackdump`) tripped the path guard. Known tool artifacts are now removed and journaled.
4. On resume, branch names collided with branches from the earlier run and burned attempts. Names are now unique per attempt.

Found later, on a clean Linux clone (2026-10-02):

5. With no git identity configured (fresh CI or cloud containers), every merge commit failed and was misread as a merge conflict, so all units escalated. Merges now use a fallback identity only when none is configured, and a merge failure that is not a conflict reports git's own error.

## Deviation log (for the evidence package)

- Lines longer than 4094 bytes: out of scope.
- Integers outside int64: C reports `error: bad number` where Python computes exactly.
- Probe `difftest-oos.json` demonstrates both detections.
