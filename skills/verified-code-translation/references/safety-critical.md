# Safety-critical profile (aviation, space, nuclear, medical, automotive)

**Bottom line:** an LLM is an unqualified tool. Under DO-178C/DO-330
thinking, a tool needs qualification only if its output is *not*
verified. So the way to use AI here is to verify **everything** it produces
with the same rigour as human-written code, and to keep the evidence. This
skill makes that verification cheaper and more systematic. It does not
replace the certification process, the qualified tools, or the
independent humans that the standard requires.

Read the actual standard for your programme: the clauses of DO-178C,
IEC 60880, IEC 61508, and ISO 26262 are paywalled, and project-specific
plans (PSAC, SDP, SVP, software safety plan) override generic advice.

## Map the level to this skill's settings

| Criticality | Examples | Settings |
|---|---|---|
| DO-178C DAL A/B; IEC 61508 SIL 3/4; IEC 60880 category A; ISO 26262 ASIL C/D; NASA Class A/B safety-critical | flight control, reactor protection, engine control | `--profile strict`; ≥2 reviewers from different model families + a named human reviewer per unit; MC/DC on the target; qualified static analyser (MISRA/CERT); requirements-based tests traced to every unit; timing via static WCET analysis; no assembly without proof or exhaustive-domain testing |
| DAL C; SIL 2; category B; ASIL B | major-but-not-catastrophic functions | `strict`; 2 reviewers; decision coverage; qualified static analyser |
| DAL D/E; SIL 1; category C; QM | monitoring, ground tools, lab automation | `default`; 2 reviewers; statement coverage; difftest fuzzing |

## Coding rules the strict audit approximates (not a replacement for a qualified checker)

The NASA/JPL "Power of Ten" (Holzmann), summarised:
1. Simple control flow: no `goto`, `setjmp`/`longjmp`, or recursion.
2. Every loop has a fixed, provable upper bound.
3. No dynamic memory allocation after initialisation.
4. Functions about 60 lines at most.
5. Assertion density of at least two per function on average.
6. Data declared at the smallest possible scope.
7. Every non-void return value is checked, and every parameter validated.
8. Limited preprocessor use.
9. Pointers restricted to one level of dereference; no function pointers.
10. Compile with all warnings on, from day one, and use static analysers.

`audit.py --profile strict` flags rules 1–5 and 9 heuristically. Use
Polyspace, Astrée, CodeSonar, Helix QAC, PC-lint Plus, Parasoft, or
equivalent for MISRA C:2023/2025 and CERT C evidence. For Rust, use a
qualified toolchain (e.g. Ferrocene) and consult MISRA C:2025 Addendum 6
for how the rules apply.

## Verification evidence to produce per translated unit

1. **Requirements trace:** which requirements (or source-code behaviours,
   for a like-for-like port) the unit implements. `journal.jsonl` records
   source file -> target file -> commit.
2. **Review record:** each reviewer's verdict and findings (journal),
   plus the human reviewer's sign-off.
3. **Test evidence:**
   - the oracle suite passes on target hardware or a qualified simulator;
   - difftest reports are clean;
   - structural coverage (statement/decision/MC-DC) is measured on the
     target build;
   - where coverage is missing, a justification is recorded.
4. **Static analysis:** a clean or dispositioned report from a qualified
   analyser.
5. **Timing:** hard real-time needs a static WCET bound (e.g. AbsInt aiT)
   on the final binary, target CPU, and cache configuration, plus
   schedulability analysis. `difftest.py` timing is only a regression
   signal.
6. **Numerical behaviour:** floating-point mode, rounding, and denormals
   are identical or analysed. Fixed-point scaling is documented.
7. **Configuration record:** exact toolchain, compiler flags, model
   names/versions, guide hash.

## Time-critical systems (reactor labs, flight, control loops)

- Translate control logic to C or Rust first. Use assembly only for
  measured hotspots, each routine proven or exhaustively tested.
- No heap, no unbounded loops, no blocking I/O in the control path, no
  locks in ISRs. Use priority-inheritance mutexes if locks are shared
  across priorities.
- Determinism: fixed iteration order, no hash-based containers in
  control logic, no time-dependent behaviour except through an explicit
  clock interface that can be mocked in the oracle.
- Watchdog and fail-safe behaviour are part of the oracle: inject faults
  (sensor out of range, timeouts) and compare old vs new responses.
- Run the oracle on target hardware (HIL) as well as on the host.

## When to say no

Refuse to present AI-translated code as certifiable when:
- no behaviour oracle exists for a required function;
- the unit has no human reviewer with authority to sign;
- the structural coverage target cannot be measured;
- a deviation from a mandated rule has not been approved.

Report the gap instead.
