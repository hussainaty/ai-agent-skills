# Language-pair semantic hazards (seed for PORTING.md and the reviewers)

Each row is a way that code which looks identical behaves differently.
Copy the relevant rows into `PORTING.md` as mandatory mappings.

## Any high-level language -> C / C++ / Rust / assembly

| Source behaviour | Target trap | Mapping |
|---|---|---|
| Arbitrary-precision ints (Python, JS BigInt) | fixed width; C signed overflow is **undefined behaviour**; Rust panics in debug and wraps in release | choose a width per value, use checked/wrapping ops explicitly, and document the range |
| Floor division / modulo (Python `//`, `%`) | C and Rust `/` and `%` truncate toward zero | correct the result when the signs differ |
| `int("…")` permissive parsing (`+5`, `1_000`, whitespace) | `atoi`/`strtol`/`parse` accept different sets | write a parser matching the source grammar exactly |
| Exceptions | no exceptions in C; Rust uses `Result`/panic | status codes or `Result`; one error path per source `except` |
| Garbage collection | manual/RAII lifetimes; use-after-free, double free, leaks | OWNERSHIP.tsv; arenas or pools in strict profiles |
| Strings are Unicode code points | bytes; UTF-8 vs UTF-16 lengths differ | define the encoding and length unit per API |
| Dict/map iteration order (insertion-ordered in Python 3.7+ and JS) | `HashMap` order is unspecified | ordered map or explicit sort where order is observable |
| Floats print as shortest repr (Python `repr`, JS) | `printf("%f")`/`%g` differ | port the formatting algorithm or constrain the output |
| Recursion with deep stacks | fixed small stacks; strict profiles ban recursion | explicit stack with a static bound |
| Implicit GIL atomicity | data races | locks or atomics; TSan |
| `str.split()` with no argument (runs of whitespace) | `strtok` semantics differ; empty tokens | spell out the delimiter set and empty-field behaviour |

## Zig -> Rust (from Bun's regressions)

- `assert()` in Zig always evaluates its argument; `debug_assert!` removes
  the whole expression, side effects included, in release builds.
- `ReleaseFast` Zig has no bounds checks, while Rust release keeps them, so
  code that silently read past a placeholder size now panics.
- Byte-slice reinterpretation (`bytemuck::cast_slice`) panics on odd
  lengths where Zig ignored the trailing byte.
- Compile-time format strings: Zig processed markup before argument
  substitution, and the Rust macro did not, so user data was
  interpreted as markup.
- Negative time values: `floor` vs `trunc` for splitting into
  seconds/nanoseconds.
- Eager vs lazy evaluation: `unwrap_or(expr)` evaluates `expr` even when it
  is not needed; `unwrap_or_else(|| expr)` does not.

## C -> Rust

- `unsafe` blocks each need a written invariant. Prefer c2rust (mechanical)
  followed by LLM rewriting of slices into safe Rust, as in C2SaferRust.
- Unions, bitfields, pointer arithmetic, and `goto` cleanup chains need
  explicit designs.
- `errno`, `setjmp`/`longjmp`, and signal handlers have no safe equivalent;
  isolate them.
- Integer promotion and implicit conversions: Rust demands explicit casts,
  and `as` silently truncates, so use `try_from`.

## C / Rust -> assembly

- ABI: SysV x86-64 passes arguments in rdi, rsi, rdx, rcx, r8, r9; Win64
  uses rcx, rdx, r8, r9 plus 32 bytes of shadow space. Callee-saved
  registers differ (Win64 also saves rdi, rsi, xmm6–15). Keep the stack
  16-byte aligned at calls.
- Flags: signed vs unsigned comparisons (`jl` vs `jb`), and carry/overflow
  for multi-word arithmetic.
- Memory model: ordering guarantees on x86 are not ARM's, so barriers are
  needed on weakly ordered CPUs.
- Every routine: a differential test against the C reference with edge
  values (0, −1, INT_MIN, INT_MAX, empty buffers, unaligned buffers), a
  push/pop balance check, and bounded verification where tools allow.
