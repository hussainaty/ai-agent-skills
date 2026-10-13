#!/usr/bin/env python3
"""Recall benchmark: does the notebook keep exact values that a summary drops?

    python bench.py make DIR [--seed 7]    # write noisy files, a session script, and a quiz
    python bench.py quiz DIR               # print the quiz to paste into the session
    python bench.py grade DIR ANSWERS.txt  # score the numbered answers

Run the session in DIR/session.md twice in any agent, once with the notebook
and once without, compacting before the quiz both times. Compare the scores.
One run per arm proves nothing: repeat each arm at least three times.

Facts come from four places, so the score shows what kind of context was lost:
user (said in a prompt), tool (buried in a file), derived (computed from a
file), update (a value the user changed later). The design follows the
planted-fact benchmark in cskwork/claude-code-clm (MIT); the code is new.
Standard library only.
"""
import argparse
import json
import random
import re
import sys
from pathlib import Path


def build(seed: int):
    r = random.Random(seed)
    port, retries, line = r.randint(2000, 9000), r.randint(3, 9), r.randint(300, 900)
    request, owner, errors = f"rq-{r.randint(10000, 99999)}", r.choice(["finance", "platform", "growth"]), r.randint(21, 49)
    first, second = r.choice(["Atlas", "Borealis"]), "Cirrus"
    window = f"{r.randint(1, 4):02d}:{r.randint(10, 59)}"

    log = [f"2026-01-01T00:{i // 60 % 60:02d}:{i % 60:02d}Z INFO svc-{r.randint(1, 9)} ok req=rq-{r.randint(10000, 99999)}"
           for i in range(1500)]
    for i in r.sample(range(1500), errors):
        log[i] = log[i].replace("INFO", "ERROR").replace(" ok ", " timeout ")
    log[line - 1] = f"2026-01-01T03:17:42Z ERROR svc-gw reset req={request}"
    total = sum(" ERROR " in entry for entry in log)
    config = [f"{r.choice(['pool', 'cache', 'queue'])}_{i}: {r.randint(1, 9000)}" for i in range(600)]
    config.insert(300, f"gateway:\n  port: {port}\n  retries: {retries}\n  breaker: half-open")
    table = ["table,owner,size_mb"] + [f"t_{i},{r.choice(['ops', 'data', 'web'])},{r.randint(1, 900)}" for i in range(500)]
    table.insert(250, f"billing_lines,{owner},1312")
    files = {"app.log": "\n".join(log) + "\n", "config.yaml": "\n".join(config) + "\n", "tables.csv": "\n".join(table) + "\n"}

    steps = [
        f"We are picking a search vendor. For now the choice is {first}. Read app.log and tell me how many ERROR lines it has.",
        "Read config.yaml and report the gateway settings.",
        "Read tables.csv and tell me who owns billing_lines.",
        f"Change of plan: the vendor is {second}, not {first}. The maintenance window opens at {window}.",
        "Which line of app.log holds the ERROR with 'reset', and what request id is on it?",
        "Summarise where we stand in three lines.",
    ]
    quiz = [
        ("user", "At what time does the maintenance window open?", [re.escape(window)]),
        ("update", "Which vendor is the current choice?", [second]),
        ("update", "Which vendor was chosen first and then replaced?", [first]),
        ("tool", "What is the gateway port in config.yaml?", [rf"\b{port}\b"]),
        ("tool", "How many retries does the gateway allow?", [rf"\b{retries}\b"]),
        ("tool", "What state is the gateway breaker in?", [r"half-?open"]),
        ("tool", "Who owns billing_lines?", [owner]),
        ("tool", "What is the size in MB of billing_lines?", [r"1,?312"]),
        ("tool", "On which line of app.log is the 'reset' ERROR?", [rf"\b{line}\b"]),
        ("tool", "What request id does that line carry?", [request.replace("-", "-?")]),
        ("derived", "How many ERROR lines does app.log have in total?", [rf"\b{total}\b"]),
    ]
    return files, steps, quiz


def quiz_text(quiz) -> str:
    head = ("Answer from what you remember of this session. Use no tools and do not guess: write 'unknown' "
            f"when unsure. Reply with exactly {len(quiz)} numbered lines, 'N. answer', and nothing else.\n\n")
    return head + "\n".join(f"{i}. {q}" for i, (_, q, _) in enumerate(quiz, 1))


def grade(answer: str, quiz):
    lines = {}
    for line in answer.splitlines():
        m = re.match(r"^\s*\**(\d+)[.)]\**\s*(.*)$", line)
        if m:
            lines.setdefault(int(m.group(1)), m.group(2))
    return [bool(lines.get(i)) and all(re.search(p, lines[i], re.I) for p in patterns)
            for i, (_, _, patterns) in enumerate(quiz, 1)]


def main(argv) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("make")
    make.add_argument("dir")
    make.add_argument("--seed", type=int, default=7)
    commands.add_parser("quiz").add_argument("dir")
    grader = commands.add_parser("grade")
    grader.add_argument("dir")
    grader.add_argument("answers")
    args = parser.parse_args(argv)
    folder = Path(args.dir)
    if args.command == "make":
        files, steps, quiz = build(args.seed)
        folder.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (folder / name).write_text(text, encoding="utf-8")
        script = "\n".join(f"{i}. {step}" for i, step in enumerate(steps, 1))
        (folder / "session.md").write_text(
            "Send these prompts one at a time, then compact the context, then send the quiz.\n\n" + script + "\n",
            encoding="utf-8")
        (folder / "key.json").write_text(json.dumps({"seed": args.seed}), encoding="utf-8")
        print(f"wrote {len(files)} files, session.md and key.json to {folder}; keep key.json out of the session")
        return 0
    quiz = build(json.loads((folder / "key.json").read_text(encoding="utf-8"))["seed"])[2]
    if args.command == "quiz":
        print(quiz_text(quiz))
        return 0
    marks = grade(Path(args.answers).read_text(encoding="utf-8"), quiz)
    for kind in ("user", "update", "tool", "derived"):
        chosen = [mark for mark, (k, _, _) in zip(marks, quiz) if k == kind]
        print(f"{kind:<8} {sum(chosen)}/{len(chosen)}")
    print(f"total    {sum(marks)}/{len(marks)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
