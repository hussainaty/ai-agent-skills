#!/usr/bin/env python3
"""Wave-ordered translation loop with isolated implementer/reviewer pairs.

For every task of the dependency plan (depgraph.py), in wave order:

  worktree -> implementer -> path guard -> static audit -> gate in container
           -> N independent reviewers (diff only, "assume it is wrong")
           -> merge (serialised) | retry with findings | escalate to a human

Each active pair owns one Docker "pair container" (network disabled, CPU /
memory / PID limits, its own build cache) where build and test gates run.
Every tick, scale_policy.decide() adds pair containers when the ready
frontier grows and removes them when work is sequential, reviews are being
rejected, merges conflict, or the host is saturated.

Agents are external commands (Claude Code headless, Codex, a local model, or
a mock) given as templates with {prompt_file} {out_file} {workdir}
placeholders. Implementer and reviewers never share context: each call gets
a fresh prompt file, and reviewers see only the diff plus the source unit.

Git discipline (Bun lesson): agents never run stash/reset/checkout on shared
state; the orchestrator commits explicit paths only and merges one at a time.

Usage (see SKILL.md for a full example):
  orchestrate.py --repo REPO --plan plan.json --target-root port/ \
      --implementer "claude -p ... < {prompt_file} > {out_file}" \
      --reviewer    "claude -p ... < {prompt_file} > {out_file}" \
      [--image rust:1-slim --gate "cargo build --quiet"] [--reviewers 2] \
      [--max-pairs 8] [--max-attempts 3] [--profile strict] [--state run/state.json]
"""
import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scale_policy  # noqa: E402

SKILL_DIR = os.path.dirname(HERE)
TEMPLATES = os.path.join(SKILL_DIR, "templates")
FORBIDDEN_AGENT_GIT = re.compile(r'\bgit\s+(stash|reset|checkout\s+\.|clean|rebase|push)\b')


def ln_is_untracked(status_lines, path):
    return any(l.startswith("??") and l[3:].strip().strip('"') == path for l in status_lines)


def slug(text, n):
    return re.sub(r'[^\w]', '_', text)[:n]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def sh(cmd, cwd=None, check=True, timeout=None, env=None):
    p = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True,
                       text=True, timeout=timeout, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {cmd}\n{p.stdout}\n{p.stderr}")
    return p


def git(repo, *args, check=True):
    return sh(["git", "-C", repo] + list(args), check=check)


def read(path, default=""):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return default


def fill(template, **kw):
    out = template
    for k, v in kw.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


def extract_verdict(text):
    """Take the last JSON object containing a 'verdict' key."""
    best = None
    for m in re.finditer(r'\{', text):
        depth = 0
        for j in range(m.start(), len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[m.start():j + 1])
                        if isinstance(obj, dict) and "verdict" in obj:
                            best = obj
                    except ValueError:
                        pass
                    break
    return best


class PairContainer:
    """A sandbox for one implementer/reviewer pair's builds and tests."""

    def __init__(self, orch, idx):
        self.orch, self.idx = orch, idx
        self.name = f"vct-{orch.run_id}-pair{idx}"
        self.busy = False
        self.retire = False
        self.cid = None
        if orch.args.image:
            cmd = ["docker", "run", "-d", "--rm", "--name", self.name, "--network", "none",
                   "--cpus", str(orch.args.pair_cpus), "--memory", orch.args.pair_memory,
                   "--pids-limit", "512", "--security-opt", "no-new-privileges",
                   "-e", "CARGO_TARGET_DIR=/tmp/target", "-e", "CARGO_NET_OFFLINE=true",
                   "-v", f"{orch.worktree_root}:/wt", orch.args.image, "sleep", "infinity"]
            self.cid = sh(cmd).stdout.strip()
        orch.journal("container_created", pair=self.name, docker=bool(self.cid))

    def exec(self, workdir, command, timeout):
        if self.cid:
            rel = os.path.relpath(workdir, self.orch.worktree_root).replace(os.sep, "/")
            return sh(["docker", "exec", "-w", f"/wt/{rel}", self.cid, "sh", "-c", command],
                      check=False, timeout=timeout)
        return sh(command, cwd=workdir, check=False, timeout=timeout)

    def destroy(self):
        if self.cid:
            sh(["docker", "rm", "-f", self.cid], check=False)
        self.orch.journal("container_removed", pair=self.name)


class Orchestrator:
    def __init__(self, args):
        self.args = args
        self.repo = os.path.abspath(args.repo)
        self.run_dir = os.path.abspath(args.run_dir)
        os.makedirs(self.run_dir, exist_ok=True)
        self.run_id = args.run_id or uuid.uuid4().hex[:6]
        self.worktree_root = os.path.join(self.run_dir, "worktrees")
        os.makedirs(self.worktree_root, exist_ok=True)
        self.lock = threading.RLock()
        self.merge_lock = threading.Lock()
        self.journal_path = os.path.join(self.run_dir, "journal.jsonl")
        with open(args.plan, encoding="utf-8") as fh:
            self.plan = json.load(fh)
        self.tasks = {}
        for w in self.plan["waves"]:
            for t in w["tasks"]:
                self.tasks[t["id"]] = dict(t, wave=w["wave"], status="pending", attempts=0, findings=[])
        for t in self.tasks.values():
            if t.get("loc", 1) == 0:  # e.g. empty __init__.py: nothing to port
                t["status"] = "accepted"
                t["note"] = "empty unit (0 LOC after comment stripping); auto-accepted"
        self.state_path = args.state or os.path.join(self.run_dir, "state.json")
        if os.path.exists(self.state_path):  # resume
            saved = json.load(open(self.state_path, encoding="utf-8"))
            for tid, st in saved.get("tasks", {}).items():
                if tid in self.tasks:
                    self.tasks[tid].update({k: st[k] for k in ("status", "attempts", "findings") if k in st})
                    if self.tasks[tid]["status"] == "in_progress":
                        self.tasks[tid]["status"] = "pending"
        self.integration = args.branch
        self.pairs = []
        self.window = []  # recent events: ("review", ok) / ("commit",) / ("conflict",)
        self.ticks_since_change = 99
        self.base_head = git(self.repo, "rev-parse", self.integration).stdout.strip()

    # ---------- bookkeeping ----------
    def journal(self, event, **kw):
        rec = {"ts": now(), "event": event}
        rec.update(kw)
        with self.lock:
            with open(self.journal_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")

    def save(self):
        with self.lock:
            tmp = self.state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"run_id": self.run_id, "tasks": self.tasks}, fh, indent=1)
            os.replace(tmp, self.state_path)

    def ready(self):
        done = {k for k, t in self.tasks.items() if t["status"] == "accepted"}
        return [t for t in self.tasks.values()
                if t["status"] == "pending" and all(d in done for d in t["depends_on"])]

    def metrics(self):
        w = self.window[-self.args.window:]
        return {"reviews": sum(1 for e in w if e[0] == "review"),
                "rejects": sum(1 for e in w if e[0] == "review" and not e[1]),
                "commits": sum(1 for e in w if e[0] == "commit"),
                "merge_conflicts": sum(1 for e in w if e[0] == "conflict")}

    def host(self):
        du = shutil.disk_usage(self.run_dir)
        cores = os.cpu_count() or 2
        used = len([p for p in self.pairs if not p.retire]) * self.args.pair_cpus
        return {"cpu_free": max(0.0, cores * self.args.host_cpu_fraction - used),
                "disk_free_gb": du.free / 1e9}

    # ---------- scaling ----------
    def rescale(self):
        with self.lock:
            active = [p for p in self.pairs if not p.retire]
            in_flight = sum(1 for p in active if p.busy)
            state = {"active_pairs": len(active), "ready_tasks": len(self.ready()),
                     "in_flight_tasks": in_flight, "window": self.metrics(), "host": self.host(),
                     "ticks_since_last_change": self.ticks_since_change,
                     "config": {"max_pairs": self.args.max_pairs, "min_pairs": 0,
                                "cpu_per_pair": self.args.pair_cpus,
                                "reject_rate_pause": self.args.reject_pause,
                                "reject_rate_shrink": self.args.reject_shrink}}
            d = scale_policy.decide(state)
            self.ticks_since_change += 1
            if d["action"] in ("scale_up",) and d["target_pairs"] > len(active):
                for _ in range(d["target_pairs"] - len(active)):
                    self.pairs.append(PairContainer(self, len(self.pairs)))
                self.ticks_since_change = 0
            elif d["action"] in ("scale_down", "pause") and d["target_pairs"] < len(active):
                surplus = len(active) - d["target_pairs"]
                for p in sorted(active, key=lambda p: p.busy):
                    if surplus == 0:
                        break
                    p.retire = True
                    surplus -= 1
                self.ticks_since_change = 0
            for p in [p for p in self.pairs if p.retire and not p.busy]:
                p.destroy()
                self.pairs.remove(p)
            if d["action"] != "hold":
                self.journal("scale", **d)
            return d

    # ---------- one task ----------
    def run_task(self, pair, task):
        tid = task["id"]
        safe = re.sub(r'[^\w.-]+', '_', tid)[:60]
        # Unique per attempt: a resumed run must never collide with branches or
        # worktrees left by an earlier run (that used to burn attempts as task_error).
        tag = f"{safe}-a{task['attempts']}-{uuid.uuid4().hex[:6]}"
        branch = f"vct/{self.run_id}/{tag}"
        wt = os.path.join(self.worktree_root, tag)
        try:
            with self.merge_lock:
                head = git(self.repo, "rev-parse", self.integration).stdout.strip()
                git(self.repo, "worktree", "add", "-q", "-b", branch, wt, head)
            accepted = self._attempt(pair, task, wt, head)
        except Exception as exc:  # infrastructure failure: record and requeue
            self.journal("task_error", task=tid, error=str(exc)[:2000])
            accepted = None
        finally:
            git(self.repo, "worktree", "remove", "--force", wt, check=False)
        with self.lock:
            if accepted:
                task["status"] = "accepted"
            else:
                task["attempts"] += 1
                task["status"] = "escalated" if task["attempts"] >= self.args.max_attempts else "pending"
                if task["status"] == "escalated":
                    self.journal("escalated_to_human", task=tid, findings=task["findings"][-10:])
            pair.busy = False
            self.save()

    def _run_agent(self, template, prompt, workdir, tag):
        pdir = os.path.join(self.run_dir, "prompts")
        os.makedirs(pdir, exist_ok=True)
        stamp = f"{tag}-{uuid.uuid4().hex[:8]}"
        pf, of = os.path.join(pdir, stamp + ".md"), os.path.join(pdir, stamp + ".out")
        with open(pf, "w", encoding="utf-8") as fh:
            fh.write(prompt)
        cmd = template.format(prompt_file=pf, out_file=of, workdir=workdir)
        p = sh(cmd, cwd=workdir, check=False, timeout=self.args.agent_timeout)
        out = read(of) or p.stdout
        return p.returncode, out, pf

    def _attempt(self, pair, task, wt, base):
        tid = task["id"]
        guide = "\n\n".join(read(os.path.join(self.repo, g)) for g in self.args.guide)
        src_listing = "\n".join(f"- {f}" for f in task["files"])
        impl_prompt = fill(read(os.path.join(TEMPLATES, "implementer.md")),
                           unit=tid, files=src_listing, target_root=self.args.target_root,
                           guide=guide or "(no porting guide supplied)",
                           deps=", ".join(task["depends_on"]) or "none",
                           findings=json.dumps(task["findings"][-10:], indent=1) if task["findings"] else "none",
                           concurrency="YES - preserve lock order and atomicity exactly" if task.get("concurrency_review") else "no",
                           cyclic="YES - translate all listed units together" if task.get("cyclic") else "no")
        rc, out, pf = self._run_agent(self.args.implementer, impl_prompt, wt, "impl-" + slug(tid, 30))
        self.journal("implementer_done", task=tid, rc=rc, prompt=pf)
        if FORBIDDEN_AGENT_GIT.search(out):
            self.journal("agent_git_violation", task=tid)
        # Path guard: only the target tree may change.
        status = git(wt, "status", "--porcelain", "--untracked-files=all").stdout.splitlines()
        changed = [ln[3:].strip().strip('"') for ln in status if ln.strip()]
        # Tool crash artifacts (e.g. MSYS bash.exe.stackdump) are environment
        # noise, not implementer output: remove and journal, don't fail the task.
        junk = [c for c in changed if ln_is_untracked(status, c)
                and any(fnmatch.fnmatch(os.path.basename(c), g) for g in self.args.ignore_artifact)]
        for c in junk:
            try:
                os.remove(os.path.join(wt, c))
            except OSError:
                pass
        if junk:
            self.journal("artifact_removed", task=tid, files=junk)
            changed = [c for c in changed if c not in junk]
        tr = self.args.target_root.rstrip("/") + "/"
        outside = [c for c in changed if not c.replace("\\", "/").startswith(tr)]
        if outside:
            task["findings"].append({"severity": "blocker", "issue": f"implementer modified files outside {tr}: {outside[:10]}"})
            self._record_review(False)
            return False
        if not changed:
            task["findings"].append({"severity": "blocker", "issue": "implementer produced no changes"})
            self._record_review(False)
            return False
        git(wt, "add", "--", *changed)
        git(wt, "-c", "user.name=vct-implementer", "-c", "user.email=vct@localhost",
            "commit", "-q", "-m", f"port: {tid} (attempt {task['attempts']})")
        # Static audit (cheap, deterministic) before any reviewer tokens are spent.
        audit_out = os.path.join(self.run_dir, "audit-%s-a%d.json" % (slug(tid, 40), task["attempts"]))
        paths = [os.path.join(wt, c) for c in changed if os.path.exists(os.path.join(wt, c))]
        audit_findings = []
        for pth in paths:
            a = sh([sys.executable, os.path.join(HERE, "audit.py"), "code", pth,
                    "--profile", self.args.profile], check=False)
            try:
                audit_findings += [f for f in json.loads(a.stdout)["findings"] if f["severity"] == "error"]
            except ValueError:
                pass
        with open(audit_out, "w", encoding="utf-8") as fh:
            json.dump(audit_findings, fh, indent=1)
        if audit_findings:
            task["findings"] += [{"severity": "blocker", "issue": f"{f['rule']}: {f['message']}",
                                  "file": os.path.relpath(f["file"], wt), "line": f["line"]} for f in audit_findings]
            self.journal("audit_failed", task=tid, count=len(audit_findings))
            self._record_review(False)
            return False
        # Build/test gate inside the pair container.
        if self.args.gate:
            g = pair.exec(wt, self.args.gate.replace("{unit}", tid), timeout=self.args.gate_timeout)
            self.journal("gate", task=tid, rc=g.returncode, pair=pair.name)
            if g.returncode != 0:
                task["findings"].append({"severity": "blocker", "issue": "gate failed",
                                         "evidence": (g.stdout + g.stderr)[-3000:]})
                self._record_review(False)
                return False
        # Independent adversarial reviewers: diff + source only.
        diff = git(wt, "diff", f"{base}..HEAD").stdout
        src = "\n\n".join(f"### {f}\n```\n{read(os.path.join(self.repo, f))}\n```" for f in task["files"])
        review_prompt = fill(read(os.path.join(TEMPLATES, "reviewer.md")), unit=tid, source=src,
                             diff=diff[: self.args.max_diff_chars], guide=guide or "(none)",
                             concurrency="YES" if task.get("concurrency_review") else "no")
        verdicts = []
        for r in range(self.args.reviewers):
            rc, out, pf = self._run_agent(self.args.reviewer, review_prompt, wt,
                                          "rev%d-%s" % (r, slug(tid, 30)))
            v = extract_verdict(out) or {"verdict": "reject", "findings": [
                {"severity": "blocker", "issue": "reviewer returned no parseable verdict"}]}
            blocking = [f for f in v.get("findings", []) if f.get("severity") in ("blocker", "major")]
            ok = v.get("verdict") == "accept" and not blocking
            verdicts.append({"reviewer": r, "ok": ok, "findings": v.get("findings", []), "prompt": pf})
            self._record_review(ok)
        self.journal("reviews", task=tid, verdicts=[{k: x[k] for k in ("reviewer", "ok")} for x in verdicts],
                     findings=[f for x in verdicts for f in x["findings"]][:20])
        if not all(x["ok"] for x in verdicts):
            task["findings"] += [f for x in verdicts if not x["ok"] for f in x["findings"]]
            return False
        # Serialised merge into the integration branch.
        with self.merge_lock:
            commit = git(wt, "rev-parse", "HEAD").stdout.strip()
            m = git(self.repo, "merge", "--no-ff", "-q", "-m", f"merge port of {tid}", commit, check=False)
            if m.returncode != 0:
                git(self.repo, "merge", "--abort", check=False)
                with self.lock:
                    self.window.append(("conflict",))
                task["findings"].append({"severity": "blocker", "issue": "merge conflict; task boundaries overlap"})
                self.journal("merge_conflict", task=tid)
                return False
            merged = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        with self.lock:
            self.window.append(("commit",))
        self.journal("accepted", task=tid, commit=commit, merge=merged, source_files=task["files"],
                     target_files=changed, reviewers=self.args.reviewers, attempts=task["attempts"] + 1)
        return True

    def _record_review(self, ok):
        with self.lock:
            self.window.append(("review", ok))

    # ---------- main loop ----------
    def run(self):
        cur = git(self.repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        if cur != self.integration:
            raise SystemExit(f"repo must have integration branch '{self.integration}' checked out (found {cur})")
        self.journal("run_start", run_id=self.run_id, tasks=len(self.tasks), base=self.base_head)
        threads = []
        paused_ticks = 0
        idle_ticks = 0
        try:
            while True:
                with self.lock:
                    open_tasks = [t for t in self.tasks.values() if t["status"] in ("pending", "in_progress")]
                if not open_tasks and not any(p.busy for p in self.pairs):
                    break
                d = self.rescale()
                if d["action"] == "pause":
                    paused_ticks += 1
                    if paused_ticks >= self.args.pause_ticks_limit:
                        self.journal("stopped_for_process_fix", reason=d["reason"])
                        print("PAUSED: " + d["reason"], file=sys.stderr)
                        break
                else:
                    paused_ticks = 0
                with self.lock:
                    ready = self.ready()
                    idle = [p for p in self.pairs if not p.busy and not p.retire]
                    for p, t in zip(idle, ready):
                        p.busy = True
                        t["status"] = "in_progress"
                        th = threading.Thread(target=self.run_task, args=(p, t), daemon=True)
                        threads.append(th)
                        th.start()
                    blocked = not ready and not any(p.busy for p in self.pairs)
                if blocked and any(t["status"] == "pending" for t in self.tasks.values()):
                    self.journal("blocked", reason="pending tasks depend on escalated tasks")
                    break
                # Watchdog: nothing running and nothing started for many ticks = stall.
                with self.lock:
                    running = any(p.busy for p in self.pairs)
                idle_ticks = 0 if running else idle_ticks + 1
                if idle_ticks >= self.args.stall_ticks:
                    self.journal("stalled", reason="no pair busy for %d ticks" % idle_ticks, scale=d)
                    print("STALLED: no progress; see journal", file=sys.stderr)
                    break
                time.sleep(self.args.tick)
        finally:
            for th in threads:
                th.join(timeout=self.args.agent_timeout)
            for p in list(self.pairs):
                p.destroy()
            self.pairs.clear()
            self.save()
        summary = {}
        for t in self.tasks.values():
            summary[t["status"]] = summary.get(t["status"], 0) + 1
        self.journal("run_end", summary=summary)
        print(json.dumps({"run_id": self.run_id, "summary": summary, "journal": self.journal_path}, indent=2))
        return 0 if set(summary) <= {"accepted"} else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--target-root", required=True, help="the only directory agents may modify")
    ap.add_argument("--implementer", required=True)
    ap.add_argument("--reviewer", required=True)
    ap.add_argument("--branch", default="main")
    ap.add_argument("--guide", action="append", default=[], help="PORTING.md / HAZARDS.md / OWNERSHIP.tsv (repo-relative)")
    ap.add_argument("--image", default=None, help="Docker image for pair containers (omit = no container)")
    ap.add_argument("--gate", default=None, help="build/test command run in the pair container")
    ap.add_argument("--reviewers", type=int, default=2)
    ap.add_argument("--max-pairs", type=int, default=8)
    ap.add_argument("--max-attempts", type=int, default=3)
    ap.add_argument("--profile", choices=["default", "strict"], default="default")
    ap.add_argument("--pair-cpus", type=float, default=1.0)
    ap.add_argument("--pair-memory", default="2g")
    ap.add_argument("--host-cpu-fraction", type=float, default=0.75)
    ap.add_argument("--agent-timeout", type=int, default=1800)
    ap.add_argument("--gate-timeout", type=int, default=900)
    ap.add_argument("--max-diff-chars", type=int, default=120000)
    ap.add_argument("--window", type=int, default=20)
    ap.add_argument("--tick", type=float, default=2.0)
    ap.add_argument("--pause-ticks-limit", type=int, default=3)
    ap.add_argument("--reject-pause", type=float, default=0.60,
                    help="review rejection rate that stops the run for a process fix")
    ap.add_argument("--reject-shrink", type=float, default=0.40)
    ap.add_argument("--ignore-artifact", action="append", default=["*.stackdump", "core", "*.dmp"],
                    help="untracked tool-crash files removed instead of failing the path guard")
    ap.add_argument("--stall-ticks", type=int, default=30, help="stop if no pair is busy for this many ticks")
    ap.add_argument("--run-dir", default=".vct-run")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--state", default=None)
    a = ap.parse_args(argv)
    return Orchestrator(a).run()


if __name__ == "__main__":
    sys.exit(main())
