#!/usr/bin/env python3
"""Engine-swap equivalence harness: old program vs translated program.

Treats both programs as black boxes (like Bun's TypeScript suite treated the
runtime): same argv + stdin in, compare exit code / stdout / optional stderr
out. Adds seeded random inputs (differential fuzzing, cf. Flourine
arXiv:2405.11514, ACToR arXiv:2510.03879), shrinks any divergent input
(delta debugging), and records per-case timing and binary size.

Timing is OBSERVED execution time on this host. It is evidence for
regression tracking, never a worst-case execution time (WCET) bound.

Usage:
  difftest.py CONFIG.json [--out report.json]

CONFIG keys (all optional except old/new):
  old, new          argv lists, e.g. ["python", "src/main.py"]
  cwd               working directory (default: config's directory)
  cases             [{"name", "args": [...], "stdin": "..."}]
  fuzz              {"count": 200, "seed": 1, "max_lines": 8, "max_len": 40,
                     "alphabet": "...", "line_template": null,
                     "ints": [lo, hi]}   # if set, lines are space-separated ints
  compare           {"stdout": true, "stderr": false, "exit_code": true,
                     "float_tol": 0.0, "strip_trailing_ws": true}
  timeout_s         per run (default 10)
  repeat            timing repetitions per case (default 3)
  timing            {"max_ratio": null}  fail if new_max > ratio * old_max
  binaries          {"old": path, "new": path}  size comparison
  docker            {"image": "...", "cpus": "1", "memory": "512m",
                     "pids": 256, "mount": "."}  run inside --network none
  shrink            true (default) minimise divergent stdin
"""
import argparse
import json
import os
import random
import re
import statistics
import subprocess
import sys
import time

FLOAT_RE = re.compile(r'^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$')


class Runner:
    def __init__(self, cfg, cwd):
        self.cfg = cfg
        self.cwd = cwd
        self.timeout = float(cfg.get("timeout_s", 10))
        self.container = None
        d = cfg.get("docker")
        if d:
            mount = os.path.abspath(os.path.join(cwd, d.get("mount", ".")))
            cmd = ["docker", "run", "-d", "--rm", "--network", "none",
                   "--cpus", str(d.get("cpus", "1")), "--memory", str(d.get("memory", "512m")),
                   "--pids-limit", str(d.get("pids", 256)), "--read-only",
                   "--tmpfs", "/tmp:rw,size=64m", "--security-opt", "no-new-privileges",
                   "--cap-drop", "ALL", "-v", f"{mount}:/work:ro", "-w", "/work",
                   d["image"], "sleep", "infinity"]
            self.container = subprocess.check_output(cmd, text=True).strip()

    def close(self):
        if self.container:
            subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)

    def run(self, argv, stdin):
        full = (["docker", "exec", "-i", self.container] + argv) if self.container else argv
        t0 = time.perf_counter()
        try:
            p = subprocess.run(full, input=stdin.encode("utf-8"), capture_output=True,
                               cwd=None if self.container else self.cwd, timeout=self.timeout)
            dt = time.perf_counter() - t0
            return {"code": p.returncode, "out": p.stdout.decode("utf-8", "replace"),
                    "err": p.stderr.decode("utf-8", "replace"), "time": dt, "timeout": False}
        except subprocess.TimeoutExpired:
            return {"code": None, "out": "", "err": "", "time": self.timeout, "timeout": True}


def norm(text, cmp):
    text = text.replace("\r\n", "\n")
    if cmp.get("strip_trailing_ws", True):
        text = "\n".join(line.rstrip() for line in text.split("\n")).rstrip("\n")
    return text


def same_text(a, b, tol):
    if a == b:
        return True
    if not tol:
        return False
    ta, tb = a.split(), b.split()
    if len(ta) != len(tb):
        return False
    for x, y in zip(ta, tb):
        if x == y:
            continue
        if FLOAT_RE.match(x) and FLOAT_RE.match(y):
            fx, fy = float(x), float(y)
            if abs(fx - fy) <= tol * max(1.0, abs(fx), abs(fy)):
                continue
        return False
    return True


def compare(a, b, cmp):
    diffs = []
    if a["timeout"] != b["timeout"]:
        diffs.append("timeout")
    if cmp.get("exit_code", True) and a["code"] != b["code"]:
        diffs.append(f"exit_code {a['code']} != {b['code']}")
    tol = float(cmp.get("float_tol", 0.0))
    if cmp.get("stdout", True) and not same_text(norm(a["out"], cmp), norm(b["out"], cmp), tol):
        diffs.append("stdout")
    if cmp.get("stderr", False) and not same_text(norm(a["err"], cmp), norm(b["err"], cmp), tol):
        diffs.append("stderr")
    return diffs


def gen_cases(fz):
    rnd = random.Random(fz.get("seed", 1))
    alphabet = fz.get("alphabet", "abcdefghijklmnopqrstuvwxyz0123456789 -+.,")
    cases = []
    for i in range(int(fz.get("count", 0))):
        n = rnd.randint(0, int(fz.get("max_lines", 8)))
        lines = []
        for _ in range(n):
            if fz.get("words"):
                # command-shaped line: WORD tok tok ...; tokens mix ints and junk
                toks = [rnd.choice(fz["words"])]
                lo, hi = fz.get("ints", [-1000, 1000])
                for _ in range(rnd.randint(0, int(fz.get("max_ints_per_line", 5)))):
                    if rnd.random() < float(fz.get("junk_ratio", 0.15)):
                        toks.append("".join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 4))).strip() or "x")
                    else:
                        toks.append(str(rnd.randint(lo, hi)))
                lines.append(" ".join(toks))
            elif fz.get("ints"):
                lo, hi = fz["ints"]
                k = rnd.randint(1, int(fz.get("max_ints_per_line", 5)))
                lines.append(" ".join(str(rnd.randint(lo, hi)) for _ in range(k)))
            else:
                ln = rnd.randint(0, int(fz.get("max_len", 40)))
                lines.append("".join(rnd.choice(alphabet) for _ in range(ln)))
        stdin = "\n".join(lines) + ("\n" if lines else "")
        cases.append({"name": f"fuzz-{i}", "args": list(fz.get("args", [])), "stdin": stdin})
    return cases


def shrink(runner, old, new, case, cmp, budget=200):
    """ddmin-style: remove line chunks, then characters, while still diverging."""
    def diverges(stdin):
        return bool(compare(runner.run(old + case["args"], stdin), runner.run(new + case["args"], stdin), cmp))

    for unit in ("lines", "chars"):
        parts = case["stdin"].splitlines(True) if unit == "lines" else list(case["stdin"])
        n = 2
        while len(parts) >= 2 and budget > 0:
            chunk = max(1, len(parts) // n)
            reduced = False
            for i in range(0, len(parts), chunk):
                cand = parts[:i] + parts[i + chunk:]
                budget -= 1
                if diverges("".join(cand)):
                    parts, n, reduced = cand, max(n - 1, 2), True
                    break
                if budget <= 0:
                    break
            if not reduced:
                if chunk == 1:
                    break
                n = min(len(parts), n * 2)
        case = dict(case, stdin="".join(parts))
    return case


def timing_stats(samples):
    return {"min": min(samples), "median": statistics.median(samples), "max": max(samples)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    with open(a.config, encoding="utf-8") as fh:
        cfg = json.load(fh)
    cwd = os.path.abspath(cfg.get("cwd") or os.path.dirname(os.path.abspath(a.config)))
    cmp = cfg.get("compare", {})
    repeat = max(1, int(cfg.get("repeat", 3)))
    cases = list(cfg.get("cases", [])) + gen_cases(cfg.get("fuzz", {}))
    old, new = cfg["old"], cfg["new"]
    runner = Runner(cfg, cwd)
    report = {"cases": len(cases), "divergences": [], "timing": {}, "sizes": {}}
    old_t, new_t = [], []
    try:
        for case in cases:
            argv_extra = case.get("args", [])
            stdin = case.get("stdin", "")
            ro, rn = runner.run(old + argv_extra, stdin), runner.run(new + argv_extra, stdin)
            diffs = compare(ro, rn, cmp)
            ot, nt = [ro["time"]], [rn["time"]]
            for _ in range(repeat - 1):
                ot.append(runner.run(old + argv_extra, stdin)["time"])
                nt.append(runner.run(new + argv_extra, stdin)["time"])
            old_t.append(max(ot))
            new_t.append(max(nt))
            if diffs:
                entry = {"case": case["name"], "diffs": diffs, "args": argv_extra, "stdin": stdin,
                         "old": {k: ro[k] for k in ("code", "out", "err")},
                         "new": {k: rn[k] for k in ("code", "out", "err")}}
                if cfg.get("shrink", True) and stdin:
                    small = shrink(runner, old, new, case, cmp)
                    entry["minimal_stdin"] = small["stdin"]
                report["divergences"].append(entry)
    finally:
        runner.close()
    if old_t:
        report["timing"] = {"old": timing_stats(old_t), "new": timing_stats(new_t),
                            "max_ratio_new_over_old": (max(new_t) / max(old_t)) if max(old_t) > 0 else None,
                            "note": "observed wall time incl. process start; not a WCET bound"}
    for k, p in (cfg.get("binaries") or {}).items():
        full = os.path.join(cwd, p)
        if os.path.exists(full):
            report["sizes"][k] = os.path.getsize(full)
    lim = (cfg.get("timing") or {}).get("max_ratio")
    timing_fail = bool(lim and report["timing"].get("max_ratio_new_over_old") and
                       report["timing"]["max_ratio_new_over_old"] > lim)
    report["timing_regression"] = timing_fail
    report["verdict"] = "EQUIVALENT_ON_CORPUS" if not report["divergences"] and not timing_fail else "DIVERGENT"
    js = json.dumps(report, indent=2)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(js)
    summary = {k: report[k] for k in ("verdict", "cases", "timing_regression")}
    summary["divergences"] = len(report["divergences"])
    summary["max_ratio_new_over_old"] = report["timing"].get("max_ratio_new_over_old")
    print(json.dumps(summary, indent=2))
    return 0 if report["verdict"] == "EQUIVALENT_ON_CORPUS" else 1


if __name__ == "__main__":
    sys.exit(main())
