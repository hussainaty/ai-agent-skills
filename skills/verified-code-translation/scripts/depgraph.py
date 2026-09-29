#!/usr/bin/env python3
"""Dependency-tree and deadlock analysis for a source-to-source translation.

Builds the unit dependency graph of a source tree, collapses cycles into
strongly connected components (Tarjan), orders the condensation into
translation waves (dependencies before dependents), proposes the smallest
set of edges to cut for each cycle, and scans for lock-order inversions
that a translation could preserve or introduce.

Standard library only. Python 3.8+.

Usage:
  depgraph.py SRC_DIR [--out plan.json] [--md plan.md] [--unit stem|file]
              [--atomic-scc-max 4] [--exclude DIR ...]
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

LANG_BY_EXT = {
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
    ".hpp": "cpp", ".hh": "cpp", ".py": "python", ".zig": "zig",
    ".rs": "rust", ".js": "js", ".mjs": "js", ".ts": "js", ".tsx": "js",
    ".go": "go",
}
DEFAULT_EXCLUDES = {".git", "node_modules", "target", "zig-cache",
                    ".zig-cache", "__pycache__", "build", "dist", ".venv"}

INCLUDE_RE = re.compile(r'^\s*#\s*include\s*"([^"]+)"', re.M)
ZIG_IMPORT_RE = re.compile(r'@import\(\s*"([^"]+\.zig)"\s*\)')
PY_IMPORT_RE = re.compile(r'^\s*import\s+([\w\.]+(?:\s*,\s*[\w\.]+)*)', re.M)
PY_FROM_RE = re.compile(r'^[ \t]*from[ \t]+(\.*)([\w\.]*)[ \t]+import[ \t]+(\([^)]*\)|[\w\*, \t]+)', re.M)
RS_MOD_RE = re.compile(r'^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;', re.M)
RS_USE_RE = re.compile(r'\b(?:crate|super)::(\w+)')
JS_IMPORT_RE = re.compile(r'''(?:import|export)[^'"]*?from\s*['"](\.{1,2}/[^'"]+)['"]|require\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)''')

# Lock acquire/release patterns: (acquire regex, release regex). Group 1 is the lock name.
LOCK_PATTERNS = {
    "c": [(re.compile(r'pthread_mutex_lock\s*\(\s*&?\s*([\w\.\->\[\]]+)\s*\)'),
           re.compile(r'pthread_mutex_unlock\s*\(\s*&?\s*([\w\.\->\[\]]+)\s*\)')),
          (re.compile(r'\b(?:EnterCriticalSection|AcquireSRWLockExclusive)\s*\(\s*&?\s*([\w\.\->]+)\s*\)'),
           re.compile(r'\b(?:LeaveCriticalSection|ReleaseSRWLockExclusive)\s*\(\s*&?\s*([\w\.\->]+)\s*\)'))],
    "cpp": [(re.compile(r'(?:lock_guard|unique_lock|scoped_lock)\s*<[^>]*>\s*\w+\s*[\(\{]\s*([\w\.\->]+)'), None),
            (re.compile(r'\b([\w\.\->]+)\s*\.\s*lock\s*\(\s*\)'),
             re.compile(r'\b([\w\.\->]+)\s*\.\s*unlock\s*\(\s*\)'))],
    "rust": [(re.compile(r'\b([\w\.]+)\s*\.\s*(?:lock|write|read)\s*\(\s*\)'), None)],
    "python": [(re.compile(r'^\s*(?:async\s+)?with\s+([\w\.]+)\s*(?::|,)'), None),
               (re.compile(r'\b([\w\.]+)\.acquire\s*\('), re.compile(r'\b([\w\.]+)\.release\s*\('))],
    "zig": [(re.compile(r'\b([\w\.]+)\.lock\s*\(\s*\)'), re.compile(r'\b([\w\.]+)\.unlock\s*\(\s*\)'))],
    "go": [(re.compile(r'\b([\w\.]+)\.(?:R)?Lock\s*\(\s*\)'), re.compile(r'\b([\w\.]+)\.(?:R)?Unlock\s*\(\s*\)'))],
}
LOCK_PATTERNS["js"] = []

CONCURRENCY_MARKERS = re.compile(
    r'\b(pthread_\w+|std::thread|std::mutex|std::atomic|_Atomic|volatile|'
    r'threading\.|multiprocessing|asyncio|async\s+fn|\.await|tokio::|'
    r'Mutex|RwLock|Condvar|Semaphore|sem_wait|sem_post|spin_lock|'
    r'signal\s*\(|sigaction|__attribute__\s*\(\(\s*interrupt|ISR\b|'
    r'std\.Thread|@atomic\w*|go\s+func|sync\.WaitGroup|chan\s+\w+)')


def iter_files(root, excludes):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in excludes)
        for name in sorted(filenames):
            ext = os.path.splitext(name)[1].lower()
            if ext in LANG_BY_EXT:
                yield os.path.join(dirpath, name), LANG_BY_EXT[ext]


def rel(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


def unit_of(relpath, mode):
    if mode == "file":
        return relpath
    base, ext = os.path.splitext(relpath)
    if ext == ".rs" and os.path.basename(base) == "mod":
        return os.path.dirname(base) or base
    if ext == ".py" and os.path.basename(base) == "__init__":
        return os.path.dirname(base) or base
    return base


def strip_comments(text, lang):
    if lang == "python":
        return re.sub(r'#[^\n]*', '', text)
    text = re.sub(r'/\*.*?\*/', lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return re.sub(r'//[^\n]*', '', text)


def resolve_edges(root, files, mode):
    """Return {unit: {dep_unit: weight}}, unit metadata."""
    by_rel = {rel(root, p): (p, lang) for p, lang in files}
    units = defaultdict(lambda: {"files": [], "lang": set(), "loc": 0})
    # Register every dotted suffix of each module path ("py.app.a", "app.a",
    # "a") because the scan root is rarely the import root. Ambiguous
    # suffixes are dropped rather than guessed.
    suffix_hits = defaultdict(set)
    for r, (p, lang) in by_rel.items():
        if lang == "python":
            mod = r[:-3].replace("/", ".")
            if mod.endswith(".__init__"):
                mod = mod[: -len(".__init__")]
            parts = mod.split(".")
            for i in range(len(parts)):
                suffix_hits[".".join(parts[i:])].add(r)
    py_modules = {m: next(iter(rs)) for m, rs in suffix_hits.items() if len(rs) == 1}
    edges = defaultdict(lambda: defaultdict(int))
    texts = {}
    for r, (p, lang) in by_rel.items():
        u = unit_of(r, mode)
        with open(p, "r", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        text = strip_comments(raw, lang)
        texts[r] = (text, lang)
        units[u]["files"].append(r)
        units[u]["lang"].add(lang)
        units[u]["loc"] += sum(1 for line in text.splitlines() if line.strip())
        here = os.path.dirname(r)
        targets = []
        if lang in ("c", "cpp"):
            for inc in INCLUDE_RE.findall(text):
                for cand in (os.path.normpath(os.path.join(here, inc)), os.path.normpath(inc)):
                    cand = cand.replace(os.sep, "/")
                    if cand in by_rel:
                        targets.append(cand)
                        break
        elif lang == "zig":
            for imp in ZIG_IMPORT_RE.findall(text):
                cand = os.path.normpath(os.path.join(here, imp)).replace(os.sep, "/")
                if cand in by_rel:
                    targets.append(cand)
        elif lang == "python":
            pkg = r[:-3].replace("/", ".").split(".")[:-1]
            if r.endswith("__init__.py"):
                pkg = r[:-3].replace("/", ".").split(".")[:-1]
            for group in PY_IMPORT_RE.findall(text):
                for name in re.split(r'\s*,\s*', group):
                    name = name.split(" as ")[0].strip()
                    while name:
                        if name in py_modules:
                            targets.append(py_modules[name])
                            break
                        name = name.rpartition(".")[0]
            for dots, mod, names in PY_FROM_RE.findall(text):
                if dots:
                    base = pkg[: len(pkg) - (len(dots) - 1)] if len(dots) > 1 else pkg
                    full = ".".join(base + ([mod] if mod else []))
                else:
                    full = mod
                cleaned = [n.strip().split(" as ")[0].strip() for n in names.replace("(", "").replace(")", "").split(",")]
                hit = False
                for n in cleaned:
                    sub = (full + "." + n) if full else n
                    if n and n != "*" and sub in py_modules:
                        targets.append(py_modules[sub])
                        hit = True
                if not hit:
                    name = full
                    while name:
                        if name in py_modules:
                            targets.append(py_modules[name])
                            break
                        name = name.rpartition(".")[0]
        elif lang == "rust":
            for m in RS_MOD_RE.findall(text):
                for cand in (os.path.join(here, m + ".rs"), os.path.join(here, m, "mod.rs")):
                    cand = os.path.normpath(cand).replace(os.sep, "/")
                    if cand in by_rel:
                        targets.append(cand)
            for m in RS_USE_RE.findall(text):
                for cand in by_rel:
                    if cand.endswith("/" + m + ".rs") or cand == m + ".rs" or cand.endswith("/" + m + "/mod.rs"):
                        targets.append(cand)
        elif lang == "js":
            for a, b in JS_IMPORT_RE.findall(text):
                spec = a or b
                base = os.path.normpath(os.path.join(here, spec)).replace(os.sep, "/")
                for cand in (base, base + ".ts", base + ".js", base + ".tsx", base + ".mjs", base + "/index.ts", base + "/index.js"):
                    if cand in by_rel:
                        targets.append(cand)
                        break
        for t in targets:
            tu = unit_of(t, mode)
            if tu != u:
                edges[u][tu] += 1
    for u in units:
        edges.setdefault(u, defaultdict(int))
    return edges, units, texts


def tarjan_scc(nodes, edges):
    """Iterative Tarjan. Returns list of SCCs (each a sorted list)."""
    index, low, on_stack, stack, sccs = {}, {}, set(), [], []
    counter = [0]
    for start in sorted(nodes):
        if start in index:
            continue
        work = [(start, iter(sorted(edges[start])))]
        index[start] = low[start] = counter[0]
        counter[0] += 1
        stack.append(start)
        on_stack.add(start)
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, iter(sorted(edges[w]))))
                    advanced = True
                    break
                if w in on_stack:
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                sccs.append(sorted(comp))
    return sccs


def feedback_edges(members, edges):
    """Greedy Eades-Lin-Smyth ordering; backward edges form a small cut set.

    Returns edges (u, v, weight) whose removal makes the SCC acyclic,
    preferring low-weight (few references) edges.
    """
    members = set(members)
    out_w = {u: {v: w for v, w in edges[u].items() if v in members} for u in members}
    in_w = defaultdict(dict)
    for u, vs in out_w.items():
        for v, w in vs.items():
            in_w[v][u] = w
    remaining = set(members)
    left, right = [], []
    while remaining:
        changed = True
        while changed:
            changed = False
            for v in sorted(remaining):
                if not any(x in remaining for x in out_w[v]):
                    right.insert(0, v)
                    remaining.discard(v)
                    changed = True
            for v in sorted(remaining):
                if not any(x in remaining for x in in_w[v]):
                    left.append(v)
                    remaining.discard(v)
                    changed = True
        if remaining:
            best = max(sorted(remaining), key=lambda v: sum(w for x, w in out_w[v].items() if x in remaining)
                       - sum(w for x, w in in_w[v].items() if x in remaining))
            left.append(best)
            remaining.discard(best)
    order = {v: i for i, v in enumerate(left + right)}
    # Order is "dependents first"; an edge u->v with order[v] < order[u] closes a cycle.
    cut = [(u, v, w) for u in members for v, w in out_w[u].items() if order[v] < order[u]]
    return sorted(cut, key=lambda e: (e[2], e[0], e[1]))


def waves_from_condensation(sccs, edges):
    comp_of = {}
    for i, comp in enumerate(sccs):
        for u in comp:
            comp_of[u] = i
    deps = defaultdict(set)
    for u, vs in edges.items():
        for v in vs:
            if comp_of[u] != comp_of[v]:
                deps[comp_of[u]].add(comp_of[v])
    level = {}

    def depth(c, seen=()):
        if c in level:
            return level[c]
        stack = [(c, False)]
        while stack:
            node, done = stack.pop()
            if node in level:
                continue
            if done:
                level[node] = 1 + max((level[d] for d in deps[node]), default=-1)
                continue
            stack.append((node, True))
            for d in deps[node]:
                if d not in level:
                    stack.append((d, False))
        return level[c]

    for i in range(len(sccs)):
        depth(i)
    waves = defaultdict(list)
    for i, lv in level.items():
        waves[lv].append(i)
    return [sorted(waves[k], key=lambda i: sccs[i]) for k in sorted(waves)], comp_of, deps


def split_functions(text, lang):
    """Very rough function-body splitter: yields (start_line, body_text)."""
    lines = text.splitlines()
    if lang == "python":
        cur, start, indent = [], 0, None
        for i, line in enumerate(lines):
            m = re.match(r'^(\s*)(?:async\s+)?def\s+\w+', line)
            if m:
                if cur:
                    yield start, "\n".join(cur)
                cur, start, indent = [line], i + 1, len(m.group(1))
            elif cur is not None:
                cur.append(line)
        if cur:
            yield start, "\n".join(cur)
        return
    depth, cur, start = 0, [], 0
    for i, line in enumerate(lines):
        if depth == 0 and "{" in line:
            cur, start = [], i + 1
        if depth > 0 or "{" in line:
            cur.append(line)
        depth += line.count("{") - line.count("}")
        if depth <= 0 and cur:
            yield start, "\n".join(cur)
            cur, depth = [], 0


def lock_order_graph(texts):
    """Edges A->B when B is acquired while A is still held in the same function."""
    graph = defaultdict(lambda: defaultdict(list))
    hazards = []
    for relpath, (text, lang) in texts.items():
        pats = LOCK_PATTERNS.get(lang, [])
        if not pats:
            continue
        for start, body in split_functions(text, lang):
            held = []
            body_lines = body.splitlines()
            base_indent = None
            for off, line in enumerate(body_lines):
                if lang == "python":
                    ind = len(line) - len(line.lstrip())
                    held = [h for h in held if h[1] < ind or not line.strip()] if line.strip() else held
                for acq, relre in pats:
                    for m in acq.finditer(line):
                        name = m.group(1)
                        ind = len(line) - len(line.lstrip())
                        for h, _ in held:
                            if h != name:
                                graph[h][name].append(f"{relpath}:{start + off}")
                            elif lang in ("c", "rust", "zig", "go", "cpp"):
                                hazards.append({"kind": "self-reacquire", "lock": name,
                                                "at": f"{relpath}:{start + off}",
                                                "note": "non-recursive mutex re-locked while held: guaranteed self-deadlock unless the source used a recursive mutex"})
                        held.append((name, ind))
                    if relre is not None:
                        for m in relre.finditer(line):
                            held = [h for h in held if h[0] != m.group(1)]
                if lang == "rust" and re.search(r'\.await\b', line) and held:
                    hazards.append({"kind": "lock-held-across-await", "lock": held[-1][0],
                                    "at": f"{relpath}:{start + off}",
                                    "note": "a blocking guard held across .await can deadlock the executor; use an async mutex or drop the guard first"})
    cycles = []
    nodes = set(graph) | {b for a in graph for b in graph[a]}
    for comp in tarjan_scc(nodes, _dd(graph, nodes)):
        if len(comp) > 1:
            witness = {f"{a}->{b}": graph[a][b][:3] for a in comp for b in graph[a] if b in comp}
            cycles.append({"locks": comp, "witness": witness,
                           "note": "lock-order inversion: two paths acquire these locks in different orders (potential deadlock); fix a global lock order before or during translation"})
    return {a: {b: v for b, v in bs.items()} for a, bs in graph.items()}, cycles, hazards


def _dd(graph, nodes):
    d = defaultdict(dict)
    for a in nodes:
        d[a] = {b: len(v) for b, v in graph.get(a, {}).items()}
    return d


def analyze(root, mode="stem", atomic_scc_max=4, excludes=None):
    excludes = DEFAULT_EXCLUDES | set(excludes or [])
    files = list(iter_files(root, excludes))
    edges, units, texts = resolve_edges(root, files, mode)
    nodes = set(units)
    sccs = tarjan_scc(nodes, edges)
    waves, comp_of, cdeps = waves_from_condensation(sccs, edges)
    cycles = []
    for i, comp in enumerate(sccs):
        if len(comp) > 1:
            cut = feedback_edges(comp, edges)
            loc = sum(units[u]["loc"] for u in comp)
            if len(comp) <= atomic_scc_max:
                strategy = "co-translate-atomically"
                why = f"{len(comp)} units / {loc} LOC is small enough for one implementer to port as a single unit"
            else:
                strategy = "break-before-translate"
                why = "too large to port atomically; cut the listed edges in the SOURCE language first (extract shared types/interfaces into a seam unit, or invert the dependency), re-run this analysis, then translate"
            cycles.append({"component": i, "units": comp, "loc": loc, "strategy": strategy,
                           "reason": why,
                           "cut_edges": [{"from": u, "to": v, "references": w} for u, v, w in cut]})
    lock_graph, lock_cycles, lock_hazards = lock_order_graph(texts)
    conc_units = sorted({unit_of(r, mode) for r, (t, _) in texts.items() if CONCURRENCY_MARKERS.search(t)})
    plan_waves = []
    for n, wave in enumerate(waves):
        entries = []
        for c in wave:
            comp = sccs[c]
            entries.append({
                "id": "+".join(comp),
                "units": comp,
                "files": sorted(f for u in comp for f in units[u]["files"]),
                "loc": sum(units[u]["loc"] for u in comp),
                "depends_on": sorted("+".join(sccs[d]) for d in cdeps[c]),
                "cyclic": len(comp) > 1,
                "concurrency_review": any(u in conc_units for u in comp),
            })
        plan_waves.append({"wave": n, "parallel_width": len(entries), "tasks": entries})
    critical_path = len(plan_waves)
    return {
        "root": os.path.abspath(root),
        "unit_mode": mode,
        "summary": {
            "files": len(files), "units": len(units),
            "edges": sum(len(v) for v in edges.values()),
            "sccs_with_cycles": len(cycles), "waves": critical_path,
            "max_parallel_width": max((w["parallel_width"] for w in plan_waves), default=0),
            "lock_order_cycles": len(lock_cycles), "lock_hazards": len(lock_hazards),
            "units_needing_concurrency_review": len(conc_units),
        },
        "waves": plan_waves,
        "cycles": cycles,
        "lock_order": {"graph": lock_graph, "cycles": lock_cycles, "hazards": lock_hazards},
        "concurrency_units": conc_units,
        "edges": {u: dict(v) for u, v in sorted(edges.items())},
    }


def to_markdown(plan):
    s = plan["summary"]
    out = ["# Translation dependency plan", "",
           f"- Files: {s['files']}, units: {s['units']}, edges: {s['edges']}",
           f"- Waves (critical path length): {s['waves']}; max useful parallel pairs: {s['max_parallel_width']}",
           f"- Dependency cycles: {s['sccs_with_cycles']}; lock-order cycles: {s['lock_order_cycles']}; other lock hazards: {s['lock_hazards']}",
           ""]
    if plan["cycles"]:
        out.append("## Translation-order deadlocks (dependency cycles)")
        for c in plan["cycles"]:
            out.append(f"- **{' <-> '.join(c['units'])}** ({c['loc']} LOC): `{c['strategy']}` — {c['reason']}")
            for e in c["cut_edges"]:
                out.append(f"  - cut candidate: `{e['from']}` -> `{e['to']}` ({e['references']} reference(s))")
        out.append("")
    lo = plan["lock_order"]
    if lo["cycles"] or lo["hazards"]:
        out.append("## Runtime deadlock hazards")
        for c in lo["cycles"]:
            out.append(f"- lock-order inversion among {', '.join(c['locks'])}: {json.dumps(c['witness'])}")
        for h in lo["hazards"]:
            out.append(f"- {h['kind']} on `{h['lock']}` at {h['at']}: {h['note']}")
        out.append("")
    out.append("## Waves (translate top to bottom; tasks inside one wave are independent)")
    for w in plan["waves"]:
        out.append(f"### Wave {w['wave']} — {w['parallel_width']} task(s)")
        for t in w["tasks"]:
            flags = []
            if t["cyclic"]:
                flags.append("CYCLE")
            if t["concurrency_review"]:
                flags.append("CONCURRENCY")
            dep = ", ".join(t["depends_on"]) or "none"
            out.append(f"- `{t['id']}` ({t['loc']} LOC) deps: {dep} {' '.join('['+f+']' for f in flags)}")
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("--out", default=None, help="write plan JSON here (default: stdout)")
    ap.add_argument("--md", default=None, help="also write a Markdown summary")
    ap.add_argument("--unit", choices=["stem", "file"], default="stem",
                    help="stem groups x.c+x.h (and mod.rs/__init__.py) into one unit")
    ap.add_argument("--atomic-scc-max", type=int, default=4)
    ap.add_argument("--exclude", action="append", default=[])
    a = ap.parse_args(argv)
    if not os.path.isdir(a.src):
        ap.error(f"not a directory: {a.src}")
    plan = analyze(a.src, a.unit, a.atomic_scc_max, a.exclude)
    js = json.dumps(plan, indent=2)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(js)
    else:
        print(js)
    if a.md:
        with open(a.md, "w", encoding="utf-8") as fh:
            fh.write(to_markdown(plan))
    return 0


if __name__ == "__main__":
    sys.exit(main())
