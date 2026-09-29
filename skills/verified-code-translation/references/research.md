# Research evidence behind this skill

Collected 2026-09-28. Route: the ScrapeGraphAI API key was unavailable, so
web search plus direct fetches of primary pages were used (fallback allowed
by `scrapegraphai-research`). Numbers are from the primary source unless
marked *secondary*. Each item says what it establishes and what it does not.

## 1. Industrial case: Bun, Zig -> Rust (Anthropic, May 2026)

Primary: [Rewriting Bun in Rust — Bun blog](https://bun.com/blog/bun-in-rust).
Context: [Simon Willison](https://simonwillison.net/2026/Jul/8/rewriting-bun-in-rust/),
[The Register (critique)](https://www.theregister.com/devops/2026/07/14/zig-creator-calls-buns-claude-rust-rewrite-unreviewed-slop/5270743),
video ["Bun Just Replaced Coders With AI"](https://youtu.be/dJrVi2CbgvY) (captions reviewed).

| Fact (primary) | Used in skill as |
|---|---|
| ~535K lines of Zig (1,448 files) ported in 11 days (May 3–14); 6,502 non-merge commits | scale reference |
| Prep before coding: a PORTING.md pattern guide + per-field lifetime analysis; trial on 3 files first | Phase 2 guide, OWNERSHIP.tsv, trial run |
| Loop: implementer -> ≥2 adversarial reviewers (diff only, "assume the code is wrong") -> fixer -> commit | orchestrator + reviewer template |
| Up to 64 agents: 4 workflows in separate worktrees × 16 | worktree per task, pairs |
| False start: agents ran `git stash`/`reset --hard` and clobbered each other; rule: only commit specific files | agents get no git; explicit-path commits |
| One slow `grep` froze disk I/O for minutes; "no slow commands" | io_wait scale-down, no-Bash implementers |
| Agents stubbed functions to silence the compiler; rule: needing a paragraph to justify a workaround means the code is wrong | audit `stub` + `long-justification` |
| Pre-port refactor to remove cyclic dependencies; a workflow classified where cyclic code belongs; split into ~100 crates; ~16,000 compiler errors distributed per crate across 64 agents | depgraph SCC + cut edges, break-before-translate |
| Tests isolated with `systemd-run` cgroups (memory, CPU, PID namespaces) | pair containers with limits |
| Language-independent TypeScript test suite (~1.0–1.4M `expect()` calls per platform); 0 tests skipped or deleted; initial CI 972 failing files -> 23 -> green | black-box oracle, test-inventory gate |
| 5.9B uncached input, 690M output, 72B cached-read tokens, ≈$165K at API prices | prompt-cache guidance, budget cap |
| ~4% of the Rust is inside `unsafe`; 78% of unsafe blocks are one line (FFI) | unsafe inventory, SAFETY comments |
| 19 known regressions after release: `debug_assert!` erasing side effects; `cast_slice` panicking on odd lengths; bounds checks kept in release; format-macro semantics | audit rules, hazards file, reviewer checklist |
| 24/7 coverage-guided fuzzing of parsers (~100B executions -> ~15 PRs); 11 rounds of automated security review | Phase 4 continuous fuzzing |
| Outcomes: repeated in-process builds 6,745 MB -> 609 MB; binaries ~20% smaller; +2–5% throughput | "same car, better engine" metrics |

Limits: the port was done by the language's original author with deep
context; results are self-reported by the vendor; critics (Andrew Kelley, via
The Register) point out that a million lines were not human-reviewed and
that tests which pass in one language need not catch bugs in the other.
Secondary reports disagree on line counts (535K vs 960K); the primary figure
is used here.

## 2. Peer-reviewed and preprint research on LLM code translation

| Work | Venue | Finding | Skill rule |
|---|---|---|---|
| [Lost in Translation](https://arxiv.org/abs/2308.03109) (Pan et al.) | ICSE 2024 | 1,700 samples across C/C++/Go/Java/Python: only 2.1–47.3% correct; 15 bug categories | never trust unverified translations; hazards checklist |
| [AlphaTrans](https://arxiv.org/abs/2410.24117) (Ibrahimzada et al., [code](https://github.com/Intelligent-CAT-Lab/AlphaTrans)) | FSE 2025 | repository-level, compositional, translate code and tests in dependency order; 99.1% syntactically valid, only 25.8% validated functionally | dependency-order waves; syntax ≠ correctness |
| [TRAM: in-isolation validation](https://arxiv.org/abs/2511.21878) | preprint 2025 | validates each method in isolation with mocks and type resolution | per-unit gates before integration |
| [Syzygy](https://arxiv.org/abs/2412.14234) (Shetty et al.) | LLM4Code @ ICSE 2025 | code and tests translated together, in dependency order, with dynamic-analysis info; Zopfli (~3K LOC) C -> safe Rust, equivalence-tested | test with dynamic execution data |
| [ACToR](https://arxiv.org/abs/2510.03879) (Li et al.) | preprint 2025 | translator vs discriminator agent that writes differential fuzzers; >90% pass on 63 utilities; up to +36.7% vs non-adversarial | adversarial reviewers + difftest |
| [TRAIL: Translator vs Challenger](https://arxiv.org/abs/2609.15381) | preprint 2026 | challenger finds executable counterexamples; +15.9% relative semantic accuracy | reviewers must give counterexamples |
| [Flourine](https://arxiv.org/abs/2405.11514) (Eniser et al.) | preprint 2024 | differential fuzzing for I/O equivalence without existing tests; best models ≤47% on real C/Go -> Rust | difftest fuzz mode |
| [VERT](https://arxiv.org/abs/2404.18852) (Yang et al., AWS) | preprint 2024 | Wasm-compiled oracle + LLM candidate + verification; PBT pass 31% -> 54%, bounded model checking 1% -> 42% | oracle-vs-candidate proof where possible |
| [C2SaferRust](https://arxiv.org/abs/2501.14257) | preprint 2025 | c2rust first, then LLM rewrites slices; raw pointers −38%, unsafe −28%, tests still pass | rule-based transpiler + LLM hybrid |
| [DepTrans](https://arxiv.org/abs/2604.02852) | FSE 2026 | dependency-guided iterative refinement across files; 60.7% compile, 43.5% correct; 7/15 industrial projects built | cross-file dependency context |
| [RustRepoTrans](https://arxiv.org/abs/2411.13990) | preprint 2024 | repository-level C -> Rust Pass@1 29.5% | expect low first-pass rates at repo level |
| [Guess & Sketch](https://arxiv.org/abs/2309.14396) (Lee et al.) | ICLR 2024 | assembly transpilation: LLM guesses and localises errors, a symbolic solver fixes them; +57.6% vs GPT-4 | assembly lane needs a solver or checker |
| [LLM-Vectorizer](https://arxiv.org/abs/2406.04693) | CGO 2025 | LLM vectorisation checked with Alive2; 38.2% of TSVC vectorisations proven; 1.1–9.4× speedups | translation validation for low-level output |
| [When LLM Decompilers Recompile More and Preserve Less](https://arxiv.org/abs/2609.05370) | preprint 2026 | code passing every shipped test still diverges (4.9% overall, up to 13%); recompilability rose 75% -> 90% while behavioural accuracy fell 74% -> 62% | tests alone are insufficient; fuzz beyond the suite |
| [Migrating Code at Scale with LLMs at Google](https://arxiv.org/abs/2504.09691) (Ziftci et al.) | FSE 2025 industry | 39 migrations, 595 changes; 74.45% of changes LLM-generated; ~50% time saved | humans stay in review loop |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) ([Google blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)) | preprint 2025 | independent agents amplify errors 17.2× vs 4.4× centralized; sequential tasks −39–70% with multi-agent; parallelizable +81% | scale by DAG frontier; central orchestrator; shrink on rejections |
| [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | engineering blog 2025 | explicit effort-scaling rules were needed; early versions spawned 50 subagents for simple queries | explicit, testable scaling policy |

## 3. Standards and programmes (scope only; the full texts are paywalled)

- DO-178C / ED-12C: Design Assurance Levels A–E; Level A requires MC/DC structural coverage.
- DO-330 / ED-215: a tool must be qualified (TQL-1 to TQL-5) when it
  eliminates, reduces, or automates a DO-178C process **without its output
  being verified**. An LLM is not qualified, so its output must be fully
  verified. ([summary](https://en.wikipedia.org/wiki/AC_20-115))
- EASA AI roadmap / concept papers: an incremental, level-based approach
  and an "abstraction layer" above DO-178C/DO-254 for ML
  ([overview](https://arxiv.org/pdf/2501.17028)). They cover ML **in**
  aircraft, not AI-written code, so they give no credit for AI generation.
- [MISRA C:2025 Addendum 6](https://misra.org.uk/app/uploads/2025/03/MISRA-C-2025-ADD6.pdf):
  applicability of MISRA C rules to Rust.
  [MISRust](https://arxiv.org/html/2605.23490v1): 47.75% of the 111
  directly applicable rules are enforced by Rust itself.
- [Ferrocene](https://ferrous-systems.com/blog/ferrocene-26-02-0/): Rust
  toolchain qualified for ISO 26262 (ASIL D), IEC 61508, and IEC 62304;
  26.02 certifies a core-library subset (SIL 2 / ASIL B).
- [NASA-STD-8739.8B](https://standards.nasa.gov/sites/default/files/standards/NASA/B/0/NASA-STD-87398-Revision-B.pdf)
  (software assurance and safety; IV&V); NASA SWEHB cites MC/DC for
  safety-critical flight software and cyclomatic complexity ≤ 15 (*secondary*).
- [Holzmann, "The Power of Ten"](https://spinroot.com/gerard/pdf/P10.pdf)
  (NASA/JPL): ten rules for safety-critical C.
- [IEC 60880](https://webstore.ansi.org/standards/iec/iec60880ed2006)
  (nuclear I&C, category A software) and
  [IEC 62138](https://webstore.ansi.org/standards/iec/iec62138ed2004)
  (categories B/C): cover the whole software lifecycle; language
  restrictions are in the paywalled text and must be read from it.
- [DARPA TRACTOR](https://www.darpa.mil/research/programs/translating-all-c-to-rust):
  C -> safe idiomatic Rust combining static/dynamic analysis and LLMs;
  MIT Lincoln Lab publishes [benchmarks](https://www.ll.mit.edu/r-d/projects/translating-all-c-rust-tractor-benchmarks).

## 4. What the evidence does NOT support

- No source shows AI-translated code accepted as certification credit at
  DAL A/B, SIL 3/4, or nuclear category A without full independent
  verification. The skill assumes it cannot be.
- Pass rates in the papers come from benchmarks, mostly small programs.
  Repository-scale results (AlphaTrans 25.8% validated, RustRepoTrans 29.5%,
  DepTrans 43.5%) are far lower than per-function results.
- Observed timing is not WCET, and fuzzing is not proof.
