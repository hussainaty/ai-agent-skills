#!/usr/bin/env python3
"""Self-contained tests for the verified-code-translation scripts.

  python tests/test_scripts.py                 # host-only tests
  VCT_DOCKER_IMAGE=vct-toolbox:local python tests/test_scripts.py
                                               # also exercise pair containers

The Docker image needs `sh` and `python3`.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts")
sys.path.insert(0, SCRIPTS)
import depgraph  # noqa: E402
import scale_policy  # noqa: E402

PY = sys.executable


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(textwrap.dedent(text).lstrip("\n"))
    return path


class DepgraphTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        write(self.d, "py/app/__init__.py", "")
        write(self.d, "py/app/util.py", "def clamp(x):\n    return x\n")
        write(self.d, "py/app/a.py", "from app import b\nfrom app.util import clamp\n")
        write(self.d, "py/app/b.py", "from . import c\n")
        write(self.d, "py/app/c.py", "import app.a\n")
        write(self.d, "py/app/bank.py", """
            import threading
            L1 = threading.Lock()
            L2 = threading.Lock()
            def t():
                with L1:
                    with L2:
                        pass
            def u():
                with L2:
                    with L1:
                        pass
            """)
        write(self.d, "c/x.h", '#include "y.h"\n')
        write(self.d, "c/y.h", '#include "x.h"\n')
        write(self.d, "c/x.c", '#include "x.h"\nint x(void) { return 1; }\n')
        write(self.d, "c/y.c", '#include "y.h"\nint y(void) { return 2; }\n')
        write(self.d, "c/locks.c", """
            #include <pthread.h>
            pthread_mutex_t m1, m2;
            void f1(void) {
                pthread_mutex_lock(&m1);
                pthread_mutex_lock(&m2);
                pthread_mutex_unlock(&m2);
                pthread_mutex_unlock(&m1);
            }
            void f2(void) {
                pthread_mutex_lock(&m2);
                pthread_mutex_lock(&m1);
                pthread_mutex_unlock(&m1);
                pthread_mutex_unlock(&m2);
            }
            void f3(void) {
                pthread_mutex_lock(&m1);
                pthread_mutex_lock(&m1);
            }
            """)
        write(self.d, "rs/src/net.rs", """
            use std::sync::Mutex;
            async fn tick(m: &Mutex<u32>) {
                let g = m.lock();
                other().await;
            }
            """)
        self.plan = depgraph.analyze(self.d)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_cycles_found_and_ordered(self):
        groups = sorted(tuple(c["units"]) for c in self.plan["cycles"])
        self.assertIn(("c/x", "c/y"), groups)
        self.assertIn(("py/app/a", "py/app/b", "py/app/c"), groups)
        wave_of = {t["id"]: w["wave"] for w in self.plan["waves"] for t in w["tasks"]}
        self.assertLess(wave_of["py/app/util"], wave_of["py/app/a+py/app/b+py/app/c"])

    def test_every_dependency_scheduled_earlier(self):
        wave_of = {t["id"]: w["wave"] for w in self.plan["waves"] for t in w["tasks"]}
        for w in self.plan["waves"]:
            for t in w["tasks"]:
                for d in t["depends_on"]:
                    self.assertLess(wave_of[d], w["wave"], f"{t['id']} scheduled before its dependency {d}")

    def test_cut_edges_break_cycle(self):
        for c in self.plan["cycles"]:
            cut = {(e["from"], e["to"]) for e in c["cut_edges"]}
            sub = {u: {v: 1 for v in self.plan["edges"][u] if v in c["units"] and (u, v) not in cut}
                   for u in c["units"]}
            sccs = depgraph.tarjan_scc(set(c["units"]), sub)
            self.assertTrue(all(len(s) == 1 for s in sccs), f"cut set leaves a cycle: {sccs}")

    def test_lock_hazards(self):
        lock_sets = sorted(tuple(c["locks"]) for c in self.plan["lock_order"]["cycles"])
        self.assertIn(("L1", "L2"), lock_sets)
        self.assertIn(("m1", "m2"), lock_sets)
        kinds = {h["kind"] for h in self.plan["lock_order"]["hazards"]}
        self.assertEqual(kinds, {"self-reacquire", "lock-held-across-await"})

    def test_large_cycle_needs_break_first(self):
        plan = depgraph.analyze(self.d, atomic_scc_max=2)
        strategies = {tuple(c["units"]): c["strategy"] for c in plan["cycles"]}
        self.assertEqual(strategies[("py/app/a", "py/app/b", "py/app/c")], "break-before-translate")


class ScalePolicyTest(unittest.TestCase):
    def test_frontier_caps_parallelism(self):
        d = scale_policy.decide({"active_pairs": 0, "ready_tasks": 3, "in_flight_tasks": 0,
                                 "config": {"max_pairs": 64}})
        self.assertEqual((d["action"], d["target_pairs"]), ("scale_up", 1))  # x2 rule from 0 -> 1
        d = scale_policy.decide({"active_pairs": 2, "ready_tasks": 3, "in_flight_tasks": 2,
                                 "config": {"max_pairs": 64}})
        self.assertEqual((d["action"], d["target_pairs"]), ("scale_up", 4))

    def test_sequential_section_releases_pairs(self):
        d = scale_policy.decide({"active_pairs": 4, "ready_tasks": 0, "in_flight_tasks": 1})
        self.assertEqual((d["action"], d["target_pairs"]), ("scale_down", 1))

    def test_high_rejection_pauses(self):
        d = scale_policy.decide({"active_pairs": 8, "ready_tasks": 10, "in_flight_tasks": 8,
                                 "window": {"reviews": 10, "rejects": 7}})
        self.assertEqual(d["action"], "pause")

    def test_conflicts_shrink(self):
        d = scale_policy.decide({"active_pairs": 8, "ready_tasks": 10, "in_flight_tasks": 8,
                                 "window": {"reviews": 10, "rejects": 1, "commits": 8, "merge_conflicts": 2}})
        self.assertEqual(d["action"], "scale_down")

    def test_host_cap(self):
        d = scale_policy.decide({"active_pairs": 2, "ready_tasks": 20, "in_flight_tasks": 2,
                                 "host": {"cpu_free": 2.0}, "config": {"cpu_per_pair": 2.0}})
        self.assertEqual(d["target_pairs"], 3)
        self.assertEqual(d["limiting_factor"], "cpu")

    def test_liveness_never_holds_at_zero(self):
        # Regression: 0 pairs + ready work + middling reject rate used to "hold" forever.
        d = scale_policy.decide({"active_pairs": 0, "ready_tasks": 2, "in_flight_tasks": 0,
                                 "window": {"reviews": 10, "rejects": 5}})
        self.assertEqual((d["action"], d["target_pairs"]), ("scale_up", 1))

    def test_cooldown_holds(self):
        d = scale_policy.decide({"active_pairs": 2, "ready_tasks": 5, "in_flight_tasks": 2,
                                 "ticks_since_last_change": 0})
        self.assertEqual(d["action"], "hold")


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def run_audit(self, *args):
        p = subprocess.run([PY, os.path.join(SCRIPTS, "audit.py")] + list(args), capture_output=True, text=True)
        return p.returncode, json.loads(p.stdout)

    def test_rust_rules(self):
        write(self.d, "a.rs", """
            fn f(v: &mut Vec<u8>, x: u64) -> u8 {
                debug_assert!(v.pop().is_some());
                let y = x as u8;
                unsafe { std::ptr::null::<u8>().read() };
                // SAFETY: pointer comes from a live Box
                unsafe { std::ptr::null::<u8>().read() };
                todo!()
            }
            """)
        rc, res = self.run_audit("code", self.d)
        rules = [f["rule"] for f in res["findings"]]
        self.assertEqual(rc, 1)
        for r in ("debug-assert-side-effect", "trunc-cast", "unsafe-undocumented", "stub"):
            self.assertIn(r, rules)
        self.assertEqual(rules.count("unsafe-undocumented"), 1)

    def test_c_power_of_ten_strict(self):
        write(self.d, "b.c", """
            #include <stdlib.h>
            int fact(int n) {
                if (n <= 1) { return 1; }
                return n * fact(n - 1);
            }
            void g(void) {
                char *p = malloc(4);
                free(p);
            }
            """)
        rc, res = self.run_audit("code", self.d, "--profile", "strict")
        rules = {f["rule"] for f in res["findings"] if f["severity"] == "error"}
        self.assertEqual(rc, 1)
        self.assertTrue({"recursion", "dynamic-alloc"} <= rules, rules)

    def test_long_justification(self):
        write(self.d, "c.rs", "fn f() {\n" + "".join("    // this workaround is fine because\n" for _ in range(7)) + "}\n")
        rc, res = self.run_audit("code", self.d)
        self.assertIn("long-justification", [f["rule"] for f in res["findings"]])

    def test_api_doc_block_is_not_justification(self):
        # Regression from the live E2E run: a 9-line header contract comment was
        # wrongly rejected under --profile strict.
        write(self.d, "api.h", "/* Each entry must be NUL-terminated.\n" + "".join(
            " * contract line %d about buffer sizes and return codes.\n" % i for i in range(8)) + " */\nint f(void);\n")
        rc, res = self.run_audit("code", self.d, "--profile", "strict")
        self.assertNotIn("long-justification", [f["rule"] for f in res["findings"]])

    def test_asm_push_pop(self):
        write(self.d, "d.s", "f:\n  push %rbx\n  ret\ng:\n  push %rbx\n  pop %rbx\n  ret\n")
        rc, res = self.run_audit("code", self.d, "--profile", "strict")
        hits = [f for f in res["findings"] if f["rule"] == "push-pop-imbalance"]
        self.assertEqual(len(hits), 1)

    def test_test_inventory(self):
        write(self.d, "old/t.test.ts", "test('a', () => {});\ntest('b', () => {});\n")
        write(self.d, "new/t.test.ts", "test('a', () => {});\ntest.skip('b', () => {});\n")
        p = subprocess.run([PY, os.path.join(SCRIPTS, "audit.py"), "tests", "--before",
                            os.path.join(self.d, "old"), "--after", os.path.join(self.d, "new")],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertIn("skips added", p.stdout)


class DifftestTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        write(self.d, "old.py", """
            import sys
            for line in sys.stdin:
                p = line.split()
                if len(p) == 3 and p[0] == "mod":
                    try:
                        a, b = int(p[1]), int(p[2])
                    except ValueError:
                        print("error: bad number"); continue
                    print("error: div0" if b == 0 else a % b)
            """)
        # "new" mimics a C translation: truncated modulo instead of floor modulo.
        write(self.d, "new.py", """
            import sys, math
            for line in sys.stdin:
                p = line.split()
                if len(p) == 3 and p[0] == "mod":
                    try:
                        a, b = int(p[1]), int(p[2])
                    except ValueError:
                        print("error: bad number"); continue
                    print("error: div0" if b == 0 else int(math.fmod(a, b)))
            """)
        shutil.copy(os.path.join(self.d, "old.py"), os.path.join(self.d, "same.py"))

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def cfg(self, new_script, **extra):
        c = {"old": [PY, "old.py"], "new": [PY, new_script], "repeat": 1,
             "cases": [{"name": "pos", "args": [], "stdin": "mod 7 3\n"}],
             "fuzz": {"count": 25, "seed": 3, "words": ["mod"], "ints": [-9, 9], "max_lines": 6,
                      "max_ints_per_line": 2, "junk_ratio": 0.1}}
        c.update(extra)
        path = os.path.join(self.d, "cfg.json")
        with open(path, "w") as fh:
            json.dump(c, fh)
        return path

    def run_diff(self, cfgpath):
        out = os.path.join(self.d, "report.json")
        p = subprocess.run([PY, os.path.join(SCRIPTS, "difftest.py"), cfgpath, "--out", out],
                           capture_output=True, text=True)
        return p.returncode, json.load(open(out))

    def test_equivalent(self):
        rc, rep = self.run_diff(self.cfg("same.py"))
        self.assertEqual((rc, rep["verdict"]), (0, "EQUIVALENT_ON_CORPUS"))

    def test_divergence_found_and_shrunk(self):
        rc, rep = self.run_diff(self.cfg("new.py"))
        self.assertEqual(rc, 1)
        self.assertTrue(rep["divergences"])
        minimal = rep["divergences"][0]["minimal_stdin"]
        self.assertEqual(len(minimal.strip().splitlines()), 1, minimal)  # one line suffices
        a, b = minimal.split()[1:3]
        self.assertTrue((int(a) < 0) != (int(b) < 0), minimal)  # sign mismatch is the trigger

    @unittest.skipUnless(os.environ.get("VCT_DOCKER_IMAGE"), "set VCT_DOCKER_IMAGE to run")
    def test_docker_isolated(self):
        cfg = self.cfg("new.py", old=["python3", "old.py"], new=["python3", "new.py"],
                       docker={"image": os.environ["VCT_DOCKER_IMAGE"], "cpus": "1", "memory": "256m"})
        rc, rep = self.run_diff(cfg)
        self.assertEqual(rc, 1)
        self.assertTrue(rep["divergences"])


MOCK_IMPL = r'''
import os, re, sys
prompt = open(sys.argv[1], encoding="utf-8").read()
unit = re.search(r"translation unit `([^`]+)`", prompt).group(1)
first = "## Findings from previous attempts (fix every blocker/major)\nnone" in prompt
name = unit.replace("/", "_").replace("+", "__")
os.makedirs("port", exist_ok=True)
body = "fn f() {}\n"
if unit.endswith("b") and first:
    body = "fn f() { todo!() }\n"          # stub on first try -> audit rejects
if unit.endswith("never"):
    body = "fn f() {} // BUG\n"            # reviewer always rejects -> escalates
open(os.path.join("port", name + ".rs"), "w").write(body)
if unit.endswith("c"):
    open("bash.exe.stackdump", "w").write("crash")  # tool-crash artifact must not fail the task
print("wrote", name)
'''
MOCK_REVIEW = r'''
import sys
prompt = open(sys.argv[1], encoding="utf-8").read()
if "BUG" in prompt.split("## Proposed translation (diff)")[1].split("## Porting guide")[0]:
    print('{"verdict": "reject", "findings": [{"severity": "blocker", "issue": "BUG marker"}]}')
else:
    print('{"verdict": "accept", "findings": []}')
'''


class OrchestratorTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.repo = os.path.join(self.d, "repo")
        os.makedirs(self.repo)
        for n in ("a", "b", "c", "never"):
            write(self.repo, f"src/{n}.py", f"# {n}\n")
        write(self.repo, "PORTING.md", "Port to Rust.\n")
        for cmd in (["init", "-q", "-b", "main"], ["add", "-A"],
                    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]):
            subprocess.run(["git", "-C", self.repo] + cmd, check=True, capture_output=True)
        write(self.d, "impl.py", MOCK_IMPL)
        write(self.d, "rev.py", MOCK_REVIEW)
        task = lambda i, deps: {"id": f"src/{i}", "units": [f"src/{i}"], "files": [f"src/{i}.py"],
                                "loc": 1, "depends_on": deps, "cyclic": False, "concurrency_review": False}
        self.plan = os.path.join(self.d, "plan.json")
        json.dump({"waves": [
            {"wave": 0, "parallel_width": 2, "tasks": [task("a", []), task("never", [])]},
            {"wave": 1, "parallel_width": 2, "tasks": [task("b", ["src/a"]), task("c", ["src/a"])]}]},
            open(self.plan, "w"))

    def tearDown(self):
        subprocess.run(["git", "-C", self.repo, "worktree", "prune"], capture_output=True)
        shutil.rmtree(self.d, ignore_errors=True)

    def run_orch(self, extra=(), reviewer="rev.py"):
        impl = f'"{PY}" "{os.path.join(self.d, "impl.py")}" "{{prompt_file}}"'
        rev = f'"{PY}" "{os.path.join(self.d, reviewer)}" "{{prompt_file}}"'
        cmd = [PY, os.path.join(SCRIPTS, "orchestrate.py"), "--repo", self.repo, "--plan", self.plan,
               "--target-root", "port", "--implementer", impl, "--reviewer", rev, "--guide", "PORTING.md",
               "--reviewers", "2", "--max-attempts", "2", "--tick", "0.2", "--run-dir",
               os.path.join(self.d, "run")] + list(extra)
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        events = [json.loads(l) for l in open(os.path.join(self.d, "run", "journal.jsonl"))]
        return p, events

    def check(self, p, events):
        state = json.load(open(os.path.join(self.d, "run", "state.json")))["tasks"]
        self.assertEqual(state["src/a"]["status"], "accepted")
        self.assertEqual(state["src/c"]["status"], "accepted")
        self.assertEqual(state["src/b"]["status"], "accepted")
        self.assertEqual(state["src/b"]["attempts"], 1, "stub should fail audit once, then pass")
        self.assertEqual(state["src/never"]["status"], "escalated")
        self.assertEqual(p.returncode, 1)
        kinds = [e["event"] for e in events]
        self.assertIn("audit_failed", kinds)
        self.assertIn("escalated_to_human", kinds)
        self.assertIn("artifact_removed", kinds)  # stackdump removed, src/c still accepted
        self.assertEqual(kinds.count("container_created"), kinds.count("container_removed"))
        acc = [e for e in events if e["event"] == "accepted"]
        self.assertTrue(all(e["source_files"] and e["target_files"] for e in acc))  # traceability
        files = sorted(os.listdir(os.path.join(self.repo, "port")))
        self.assertEqual(files, ["src_a.rs", "src_b.rs", "src_c.rs"])
        log = subprocess.run(["git", "-C", self.repo, "log", "--oneline"], capture_output=True, text=True).stdout
        self.assertEqual(log.count("merge port of"), 3)

    MECHANICS = ["--reject-pause", "0.95", "--reject-shrink", "0.9"]

    def test_host_mode(self):
        self.check(*self.run_orch(self.MECHANICS))

    def test_resume_does_not_collide_with_old_branches(self):
        # Regression from the live E2E resume: leftover vct/<run>/<unit>-a<n> branches made
        # `git worktree add -b` fail, and each failure burned an attempt as task_error.
        for name in ("src_a-a0", "src_c-a0", "src_b-a0", "src_b-a1"):
            subprocess.run(["git", "-C", self.repo, "branch", f"vct/fixed/{name}"], check=True, capture_output=True)
        p, events = self.run_orch(self.MECHANICS + ["--run-id", "fixed"])
        self.assertNotIn("task_error", [e["event"] for e in events])

    def test_pause_when_most_reviews_reject(self):
        write(self.d, "rev_reject.py",
              "print('{\"verdict\": \"reject\", \"findings\": [{\"severity\": \"major\", \"issue\": \"x\"}]}')\n")
        p, events = self.run_orch(reviewer="rev_reject.py")  # every review rejects
        kinds = [e["event"] for e in events]
        self.assertIn("stopped_for_process_fix", kinds)
        self.assertEqual(kinds.count("container_created"), kinds.count("container_removed"))
        self.assertNotEqual(p.returncode, 0)

    @unittest.skipUnless(os.environ.get("VCT_DOCKER_IMAGE"), "set VCT_DOCKER_IMAGE to run")
    def test_docker_pairs_scale(self):
        p, events = self.run_orch(self.MECHANICS + ["--image", os.environ["VCT_DOCKER_IMAGE"],
                                   "--gate", "ls port/*.rs", "--max-pairs", "4"])
        self.check(p, events)
        created = [e for e in events if e["event"] == "container_created"]
        self.assertTrue(all(e["docker"] for e in created))
        self.assertGreaterEqual(len(created), 2, "should scale beyond one pair for a 2-wide wave")
        self.assertTrue(any(e["event"] == "gate" for e in events))


if __name__ == "__main__":
    unittest.main(verbosity=2)
