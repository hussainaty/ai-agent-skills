#!/usr/bin/env python3
"""Decide whether to add, keep, or remove implementer/reviewer container pairs.

Pure function + CLI. The orchestrator calls decide() every tick. The rules
encode published evidence rather than "more agents is better":

- Parallelism is capped by the ready frontier of the dependency DAG: a wave
  with N independent tasks can use at most N pairs (sequential work degrades
  with more agents; Kim et al. 2025, arXiv:2512.08296).
- Rising review-rejection or merge-conflict rates mean errors are being
  amplified, so pairs are removed and the process (porting guide/prompts)
  is fixed instead of the output (Bun 2026 port write-up).
- Scale-up is at most x2 per step, with a cooldown, to prevent flapping.
- Host CPU, memory, disk and budget are hard caps (Bun: one slow grep froze
  disk I/O for minutes; tests were isolated with cgroups).

Usage:
  scale_policy.py STATE.json      # prints a decision JSON
"""
import json
import math
import sys

DEFAULTS = {
    "min_pairs": 0,
    "max_pairs": 64,
    "cpu_per_pair": 2.0,          # cores reserved for one pair's builds/tests
    "mem_gb_per_pair": 4.0,
    "disk_gb_per_pair": 5.0,
    "cost_per_unit_estimate": None,
    "reject_rate_pause": 0.60,    # most reviews fail: stop and fix the process
    "reject_rate_shrink": 0.40,
    "reject_rate_grow_max": 0.25,
    "conflict_rate_shrink": 0.10,
    "io_wait_shrink": 0.30,       # fraction of time the host waits on disk
    "cooldown_ticks": 2,
    "min_samples": 4,             # decisions on rates need this many reviews
}


def decide(state, cfg=None):
    c = dict(DEFAULTS)
    c.update(cfg or {})
    c.update(state.get("config", {}))
    active = int(state.get("active_pairs", 0))
    ready = int(state.get("ready_tasks", 0))            # tasks whose deps are all accepted
    in_flight = int(state.get("in_flight_tasks", active))
    host = state.get("host", {})
    m = state.get("window", {})                          # recent sliding window
    reviews = int(m.get("reviews", 0))
    rejects = int(m.get("rejects", 0))
    conflicts = int(m.get("merge_conflicts", 0))
    commits = int(m.get("commits", 0))
    since_change = int(state.get("ticks_since_last_change", 99))
    budget_left = state.get("budget_left")

    reject_rate = rejects / reviews if reviews else 0.0
    conflict_rate = conflicts / max(1, commits + conflicts)

    caps = {"max_pairs": c["max_pairs"]}
    if "cpu_free" in host:
        caps["cpu"] = active + math.floor(host["cpu_free"] / c["cpu_per_pair"])
    if "mem_free_gb" in host:
        caps["mem"] = active + math.floor(host["mem_free_gb"] / c["mem_gb_per_pair"])
    if "disk_free_gb" in host:
        caps["disk"] = active + math.floor(host["disk_free_gb"] / c["disk_gb_per_pair"])
    if budget_left is not None and c.get("cost_per_unit_estimate"):
        caps["budget"] = math.floor(budget_left / c["cost_per_unit_estimate"])
    # Useful parallelism: never more pairs than work that can actually start.
    caps["frontier"] = ready + in_flight
    hard_cap = max(c["min_pairs"], min(caps.values()))
    limiting = min(caps, key=caps.get)

    def out(action, target, reason):
        target = max(c["min_pairs"], min(int(target), hard_cap if action != "pause" else target))
        return {"action": action, "target_pairs": target, "delta": target - active,
                "reason": reason, "reject_rate": round(reject_rate, 3),
                "conflict_rate": round(conflict_rate, 3), "hard_cap": hard_cap,
                "limiting_factor": limiting}

    enough = reviews >= c["min_samples"]
    if enough and reject_rate >= c["reject_rate_pause"]:
        return out("pause", 0, "most reviews reject: stop spawning, fix PORTING.md / prompts "
                   "(fix the process, not the code), then resume with a trial batch")
    if active > hard_cap:
        return out("scale_down", hard_cap, f"above hard cap ({limiting})")
    if host.get("io_wait", 0) >= c["io_wait_shrink"] and active > 1:
        return out("scale_down", max(1, active // 2), "disk I/O saturated; halve pairs and ban slow global commands")
    if commits + conflicts >= c["min_samples"] and conflict_rate >= c["conflict_rate_shrink"] and active > 1:
        return out("scale_down", max(1, active - max(1, active // 4)),
                   "merge conflicts rising: pairs are touching shared files; tighten task boundaries")
    if enough and reject_rate >= c["reject_rate_shrink"] and active > 1:
        return out("scale_down", max(1, active - max(1, active // 4)),
                   "rejection rate high: fewer pairs while the porting guide is corrected")
    if ready == 0 and active > in_flight:
        return out("scale_down", in_flight, "no ready tasks: release idle pairs (sequential section of the DAG)")
    if active == 0 and ready > 0 and hard_cap >= 1:
        # Liveness: with zero pairs the metrics window can never change, so a
        # "hold" here would starve the run forever.
        return out("scale_up", 1, "liveness: ready work and no pairs; keep one pair running")
    if since_change < c["cooldown_ticks"]:
        return out("hold", active, "cooldown after last change")
    if ready > 0 and (not enough or reject_rate <= c["reject_rate_grow_max"]):
        want = in_flight + ready
        target = min(want, max(1, active * 2), hard_cap)
        if target > active:
            return out("scale_up", target, f"{ready} ready task(s) waiting; growth capped at x2 per step")
    return out("hold", active, "steady state")


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        state = json.load(fh)
    print(json.dumps(decide(state), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
