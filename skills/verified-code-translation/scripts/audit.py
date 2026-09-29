#!/usr/bin/env python3
"""Static gates for translated code, plus a test-inventory diff.

These are cheap, deterministic checks that run BEFORE an LLM reviewer sees a
diff. They catch the failure modes documented in the Bun Zig->Rust port
(stubbed functions, paragraph-long justifications, debug_assert side effects)
and a subset of NASA/JPL "Power of Ten" style rules for C. They are
heuristics, not a MISRA/CERT checker: a qualified static analyser is still
required for certification evidence.

Usage:
  audit.py code DIR [--profile default|strict] [--out findings.json]
  audit.py tests --before OLD_TEST_DIR --after NEW_TEST_DIR

Profiles: "strict" is for DO-178C DAL A/B, IEC 61508 SIL 3/4,
IEC 60880 category A style work; it turns most warnings into errors.
"""
import argparse
import json
import os
import re
import sys

EXT_LANG = {".rs": "rust", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
            ".s": "asm", ".S": "asm", ".asm": "asm", ".zig": "zig", ".py": "python",
            ".js": "js", ".ts": "js", ".go": "go"}

STUB_RE = {
    "rust": re.compile(r'\b(todo!|unimplemented!)\s*\(|panic!\s*\(\s*"(?:[^"]*\b(?:TODO|not implemented|unimplemented|stub)\b[^"]*)"', re.I),
    "c": re.compile(r'\b(?:TODO|FIXME|STUB|NOT_IMPLEMENTED)\b|abort\s*\(\s*\)\s*;\s*/[/*]\s*(?:todo|unimplemented)', re.I),
    "asm": re.compile(r'[;#]\s*(?:TODO|FIXME|STUB)\b', re.I),
}
STUB_RE["cpp"] = STUB_RE["c"]
TODO_COMMENT_RE = re.compile(r'(?://|#|;)\s*(TODO|FIXME|XXX|HACK)\b', re.I)
SIDE_EFFECT_CALL_RE = re.compile(r'\b(insert|push|pop|remove|take|set|write|next|fetch_\w+|swap|replace|drain|clear|send|recv|lock|reload|init)\w*\s*\(')
DEBUG_ASSERT_RE = re.compile(r'\bdebug_assert(?:_eq|_ne)?!\s*\((.*)')
TRUNC_CAST_RE = re.compile(r'\bas\s+(u8|u16|u32|i8|i16|i32|usize|isize)\b')
C_FUNC_RE = re.compile(r'^[A-Za-z_][\w\s\*]*?\b([A-Za-z_]\w*)\s*\([^;{)]*\)\s*\{?\s*$')

SEVERITY = {
    "default": {"stub": "error", "long-justification": "warn", "unsafe-undocumented": "warn",
                "debug-assert-side-effect": "error", "dynamic-alloc": "warn", "recursion": "warn",
                "goto": "warn", "setjmp": "error", "func-length": "info", "assert-density": "info",
                "unbounded-loop": "info", "multi-indirection": "info", "trunc-cast": "info",
                "static-mut": "warn", "transmute": "warn", "todo-comment": "warn",
                "push-pop-imbalance": "warn", "unwrap": "info"},
}
SEVERITY["strict"] = dict(SEVERITY["default"], **{
    "unsafe-undocumented": "error", "dynamic-alloc": "error", "recursion": "error", "goto": "error",
    "func-length": "error", "assert-density": "warn", "unbounded-loop": "warn",
    "multi-indirection": "warn", "trunc-cast": "warn", "static-mut": "error", "transmute": "error",
    "todo-comment": "error", "push-pop-imbalance": "error", "long-justification": "error", "unwrap": "warn"})


def files_in(root):
    if os.path.isfile(root):
        yield root
        return
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in {".git", "target", "node_modules", "__pycache__"}]
        for n in sorted(names):
            if os.path.splitext(n)[1] in EXT_LANG:
                yield os.path.join(d, n)


JUSTIFY_RE = re.compile(
    r'\b(workaround|hack|kludge|is (?:fine|ok|okay|safe) (?:because|here|since)|safe to (?:ignore|skip)|'
    r'for now|temporar(?:y|ily)|instead of porting|cannot (?:be )?port|not ported|skip(?:ped|ping)? (?:the|this)|'
    r'borrow checker|to (?:silence|appease|satisfy) the compiler|stub(?:bed)?|pretend|good enough)\b', re.I)


def comment_runs(lines, lang):
    marker = {"rust": "//", "c": "//", "cpp": "//", "asm": ";", "zig": "//"}.get(lang, "#")
    run_start, run = None, 0
    for i, line in enumerate(lines):
        s = line.strip()
        is_c = s.startswith(marker) or (lang in ("c", "cpp") and (s.startswith("/*") or s.startswith("*")))
        is_doc = s.startswith("///") or s.startswith("//!") or s.startswith("/**")
        if is_c and not is_doc:
            if run == 0:
                run_start = i
            run += 1
        else:
            if run:
                yield run_start, run
            run = 0
    if run:
        yield run_start, run


def c_functions(lines):
    """Yield (name, start_idx, end_idx) using brace depth from a signature line."""
    i, n = 0, len(lines)
    while i < n:
        m = C_FUNC_RE.match(lines[i])
        if m and m.group(1) not in ("if", "for", "while", "switch", "return", "sizeof"):
            j = i
            while j < n and "{" not in lines[j]:
                j += 1
            if j >= n:
                break
            depth, k = 0, j
            while k < n:
                depth += lines[k].count("{") - lines[k].count("}")
                if depth <= 0 and k >= j:
                    break
                k += 1
            yield m.group(1), i, k
            i = k + 1
        else:
            i += 1


def audit_file(path, profile, long_comment):
    sev = SEVERITY[profile]
    lang = EXT_LANG[os.path.splitext(path)[1]]
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    lines = text.splitlines()
    out = []

    def add(rule, line_no, msg):
        out.append({"rule": rule, "severity": sev[rule], "file": path.replace(os.sep, "/"),
                    "line": line_no, "message": msg})

    stub = STUB_RE.get(lang)
    for i, line in enumerate(lines, 1):
        if stub and stub.search(line):
            add("stub", i, "stubbed/placeholder implementation; port the logic or record an approved deviation")
        elif TODO_COMMENT_RE.search(line):
            add("todo-comment", i, "TODO/FIXME left in translated code")
    # Brace depth per line, to tell in-body comments from API documentation.
    depth_at, depth = [], 0
    for line in lines:
        depth_at.append(depth)
        if lang in ("c", "cpp", "rust", "zig", "js", "go"):
            depth += line.count("{") - line.count("}")
    for start, run in comment_runs(lines, lang):
        if run < long_comment:
            continue
        block = "\n".join(lines[start:start + run])
        justifies = bool(JUSTIFY_RE.search(block))
        in_body = depth_at[start] > 0 and lang != "asm"
        if justifies or in_body:
            add("long-justification", start + 1,
                f"{run}-line comment {'justifying a workaround' if justifies else 'inside a function body'}: "
                "'if you need a paragraph to justify the workaround, the code is wrong' (Bun porting rule)")

    if lang == "rust":
        for i, line in enumerate(lines, 1):
            if re.search(r'\bunsafe\s*(\{|fn\b|impl\b)', line):
                prev = "\n".join(lines[max(0, i - 4):i])
                if "SAFETY:" not in prev and "# Safety" not in prev:
                    add("unsafe-undocumented", i, "unsafe without a preceding `// SAFETY:` justification of the invariant")
            m = DEBUG_ASSERT_RE.search(line)
            if m and SIDE_EFFECT_CALL_RE.search(m.group(1)):
                add("debug-assert-side-effect", i,
                    "debug_assert! is compiled out in release; a side-effecting call inside it vanishes (Bun regression #30678)")
            if TRUNC_CAST_RE.search(line):
                add("trunc-cast", i, "`as` narrowing cast silently truncates/wraps; prefer try_from with explicit handling")
            if re.search(r'\bstatic\s+mut\b', line):
                add("static-mut", i, "static mut: unsynchronised global state")
            if "transmute" in line:
                add("transmute", i, "mem::transmute: reinterpretation needs a proof of layout compatibility")
            if ".unwrap()" in line:
                add("unwrap", i, "unwrap(): confirm the source program could not fail here or map the error explicitly")
    if lang in ("c", "cpp"):
        for i, line in enumerate(lines, 1):
            code = line.split("//")[0]
            if re.search(r'\b(malloc|calloc|realloc|free)\s*\(', code):
                add("dynamic-alloc", i, "dynamic memory: NASA P10 rule 3 / MISRA C Dir 4.12 forbid heap use after initialisation")
            if re.search(r'\bgoto\b', code):
                add("goto", i, "goto: NASA P10 rule 1 (simple control flow)")
            if re.search(r'\b(setjmp|longjmp)\s*\(', code):
                add("setjmp", i, "setjmp/longjmp: NASA P10 rule 1")
            if re.search(r'while\s*\(\s*(1|true)\s*\)|for\s*\(\s*;\s*;\s*\)', code):
                add("unbounded-loop", i, "loop without a static bound: NASA P10 rule 2 (justify as the intended non-terminating scheduler loop, or bound it)")
            if re.search(r'\w\s*\*\s*\*\s*\w|\*\*\w', code) and "/*" not in code:
                add("multi-indirection", i, "more than one level of pointer dereference: NASA P10 rule 9")
        funcs = list(c_functions(lines))
        total_asserts = 0
        for name, s, e in funcs:
            body = "\n".join(lines[s + 1:e + 1])
            if re.search(r'\b' + re.escape(name) + r'\s*\(', body):
                add("recursion", s + 1, f"{name} calls itself: NASA P10 rule 1 / MISRA C 17.2 (recursion)")
            length = e - s + 1
            if length > 60:
                add("func-length", s + 1, f"{name} is {length} lines; NASA P10 rule 4 limits a function to ~60 lines")
            total_asserts += len(re.findall(r'\bassert\s*\(', body))
        if funcs and total_asserts / len(funcs) < 2:
            add("assert-density", 1, f"{total_asserts} assertions across {len(funcs)} functions; NASA P10 rule 5 asks for >=2 per function on average")
    if lang == "asm":
        label = None
        pushes = pops = 0
        for i, line in enumerate(lines + ["__end__:"], 1):
            s = line.split(";")[0].split("#")[0].strip()
            if re.match(r'^[A-Za-z_.$][\w.$]*:\s*$', s) and not s.startswith(".L"):
                if label and pushes != pops:
                    add("push-pop-imbalance", label[1], f"{label[0]}: {pushes} push vs {pops} pop; check callee-saved registers and stack alignment on every return path")
                label, pushes, pops = (s[:-1], i), 0, 0
            elif re.match(r'^push[qlw]?\b', s):
                pushes += 1
            elif re.match(r'^pop[qlw]?\b', s):
                pops += 1
    return out


TEST_RE = re.compile(r'^\s*def\s+test_\w+|\b(?:test|it)\s*\(\s*["\'`]|#\[test\]|\bTEST(?:_F)?\s*\(|^\s*test\s+"', re.M)
SKIP_RE = re.compile(r'@pytest\.mark\.(?:skip|xfail)|\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(|#\[ignore\]|\bGTEST_SKIP\b|unittest\.skip', re.M)


def test_inventory(root):
    files = tests = skips = 0
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in {".git", "node_modules", "target"}]
        for n in names:
            p = os.path.join(d, n)
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    t = fh.read()
            except OSError:
                continue
            c = len(TEST_RE.findall(t))
            if c:
                files += 1
                tests += c
            skips += len(SKIP_RE.findall(t))
    return {"test_files": files, "tests": tests, "skips": skips}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("code")
    c.add_argument("path")
    c.add_argument("--profile", choices=sorted(SEVERITY), default="default")
    c.add_argument("--long-comment", type=int, default=6)
    c.add_argument("--out")
    t = sub.add_parser("tests")
    t.add_argument("--before", required=True)
    t.add_argument("--after", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "code":
        findings = []
        for p in files_in(a.path):
            findings += audit_file(p, a.profile, a.long_comment)
        counts = {}
        for f in findings:
            counts[f["severity"]] = counts.get(f["severity"], 0) + 1
        res = {"profile": a.profile, "counts": counts, "findings": findings,
               "gate": "FAIL" if counts.get("error") else "PASS"}
        js = json.dumps(res, indent=2)
        if a.out:
            with open(a.out, "w", encoding="utf-8") as fh:
                fh.write(js)
            print(json.dumps({"gate": res["gate"], "counts": counts}))
        else:
            print(js)
        return 1 if res["gate"] == "FAIL" else 0
    before, after = test_inventory(a.before), test_inventory(a.after)
    problems = []
    if after["tests"] < before["tests"]:
        problems.append(f"tests dropped: {before['tests']} -> {after['tests']}")
    if after["skips"] > before["skips"]:
        problems.append(f"skips added: {before['skips']} -> {after['skips']}")
    res = {"before": before, "after": after, "problems": problems, "gate": "FAIL" if problems else "PASS"}
    print(json.dumps(res, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
