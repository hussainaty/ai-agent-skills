# Deadlocks in a translation project: four layers

A translation can deadlock at four different layers. `depgraph.py` detects
the first and third statically; `orchestrate.py` guards the second and
fourth by construction.

## 1. Translation-order deadlock (dependency cycles)

**Symptom:** units A and B import each other. Neither can be translated and
compiled first, because each needs the other's translated interface.
Splitting a monolith into many build units (Bun: one crate into ~100)
exposes cycles that a single compilation unit hid.

**Detection:** Tarjan SCC over the unit graph. Every SCC with more than
one member is a cycle group. The condensation is a DAG, and its
longest-path levels are the waves.

**Untangling, in order of preference:**
1. **Co-translate atomically** (small SCC, default ≤4 units): one
   implementer ports the whole group in one task, so the group is
   internally consistent.
2. **Cut edges in the source language first.** `cut_edges` is a small
   feedback-arc set (Eades–Lin–Smyth greedy order; low-reference edges
   preferred). Typical cuts:
   - move the shared types and constants into a new "seam" unit that
     both depend on;
   - invert the dependency with a callback or interface;
   - move the misplaced function to the unit that owns its data.
   Re-run the analysis and check that the oracle is still green on the OLD
   program: the refactor must not change behaviour.
3. **Interface-first translation.** Translate every declaration in the SCC
   (headers, traits, type definitions, `extern` signatures) as wave −1,
   then the bodies in parallel.
4. **FFI strangler.** Keep the old implementation of one side linked and
   call it across FFI until its counterpart is translated. This needs a
   mixed build and ABI tests at the seam.
5. **Never** break a cycle with stubs that change behaviour. A stub needs
   a tracked deviation entry and a failing test that proves it is
   temporary.

## 2. Build and tooling deadlocks (agents blocking each other)

| Cause | Guard in this skill |
|---|---|
| Concurrent `git stash`/`reset`/`checkout` on a shared tree (Bun's first run) | one worktree per task; agents have no git; orchestrator commits explicit paths; merges serialised by one lock |
| Shared build-cache locks (`cargo` "waiting for file lock", `make` races) | one pair container per pair, each with a private `CARGO_TARGET_DIR`/tmp |
| Disk I/O starvation from repository-wide commands | implementers get file tools only; `io_wait` scale-down rule |
| Resource exhaustion from tests spawning thousands of processes | `--pids-limit`, `--memory`, `--cpus` on every container |
| Implementer↔reviewer ping-pong (livelock) | `--max-attempts`, then escalate to a human; high rejection rates pause the whole run |
| Scaler starvation (0 pairs + ready work + "hold") | liveness rule in `scale_policy.py` + stall watchdog (found and fixed while testing this skill) |

## 3. Runtime deadlocks introduced or preserved by translation

| Hazard | Why translation triggers it | Check |
|---|---|---|
| Lock-order inversion | two functions take L1->L2 and L2->L1; the source may have been "safe" only by timing | `lock_order.cycles`; fix one global order |
| Recursive vs non-recursive mutex | C `PTHREAD_MUTEX_RECURSIVE`, Java `synchronized`, and Python `RLock` are re-entrant; Rust `std::sync::Mutex` and default pthread mutexes are not | `self-reacquire` hazard |
| Guard lifetime longer than intended | Rust temporaries in `match`/`if let` scrutinees keep the guard alive for the whole block (narrowed in edition 2024), so a nested lock deadlocks | reviewer checklist; explicit `drop(guard)` |
| Lock held across `.await` / callback / blocking I/O | the executor thread blocks, and another task that needs the lock can never run | `lock-held-across-await` hazard |
| Lost implicit atomicity | Python's GIL made some multi-step updates effectively atomic; in C/Rust they race | `[CONCURRENCY]` units need an explicit lock or atomic, plus a TSan run |
| Condition variables | spurious wakeups: the source's `wait` loop must stay a loop | reviewer checklist |
| Signal and interrupt handlers | only async-signal-safe calls; a lock taken in both an ISR and thread context deadlocks on a single core | strict profile: no locks in handlers |
| Priority inversion (real-time) | a low-priority task holds a lock a high-priority task needs while a medium task runs, as in Mars Pathfinder (1997) | use priority-inheritance or priority-ceiling mutexes; schedulability analysis |

Static detection is heuristic (function-local, name-based). Complement it
with dynamic tools on the translated program: ThreadSanitizer (C/C++/Rust),
a lock-order validator in the style of Linux lockdep, `loom` for Rust
concurrency models, and a model checker (e.g. SPIN) for protocol-level
logic when the unit is safety-critical.

## 4. Semantic deadlocks between the old and new systems

During an incremental (strangler) migration, old and new halves may
exchange locks, file locks, sockets, or IPC messages. Check that both
halves use the same lock files and the same protocol order, and do the
cutover per subsystem with a rollback path.
