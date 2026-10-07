#!/usr/bin/env python3
"""Build one private Markdown profile per client from a CRM export.

    python build_profiles.py --inspect crm.xlsx
    python build_profiles.py crm.xlsx --out ../private/clients \
        --name-col "Client" --skip "Phone,Email" [--sheet CRM] [--header-row 4] \
        [--analysis analysis.json]

analysis.json maps a client name to the profile fields:
    {"Acme": {"archetype": "...", "decision_unit": "...", "needs": "...",
              "risks": "...", "pitch": "...", "scope": "..."}}

The script refuses to write inside a git work tree, and it never copies the
columns listed in --skip. It reads .xlsx (needs openpyxl) or .csv.
"""
import argparse
import csv
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

FIELDS = [("archetype", "Archetype"), ("decision_unit", "Decision unit"), ("needs", "Needs"),
          ("risks", "Deal risks"), ("pitch", "Recommended pitch"), ("scope", "Scope control")]
SENSITIVE_HINTS = re.compile(r"phone|mobile|tel|whats|e-?mail|national|\bid\b|address|iban|card", re.I)


def load_rows(path: Path, sheet: str | None, header_row: int | None) -> tuple[list[str], list[list]]:
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
    else:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ws = wb[sheet] if sheet else wb.worksheets[0]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
    if header_row is None:
        header_row = next(i + 1 for i, r in enumerate(rows) if sum(c not in (None, "") for c in r) >= 3)
    header = [str(c).strip() if c is not None else "" for c in rows[header_row - 1]]
    return header, [r for r in rows[header_row:] if any(c not in (None, "") for c in r)]


def inside_git(path: Path) -> bool:
    probe = path if path.exists() else path.parent
    while not probe.exists():
        probe = probe.parent
    r = subprocess.run(["git", "-C", str(probe), "rev-parse", "--is-inside-work-tree"],
                       capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == "true"


def slug(text: str) -> str:
    return re.sub(r"[^\w]+", "-", text.lower()).strip("-")[:40] or "client"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("crm", type=Path)
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--sheet")
    ap.add_argument("--header-row", type=int)
    ap.add_argument("--name-col")
    ap.add_argument("--skip", default="", help="comma-separated columns never copied")
    ap.add_argument("--analysis", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--allow-git", action="store_true",
                    help="write inside a git work tree anyway (only if the folder is git-ignored)")
    a = ap.parse_args(argv)

    header, rows = load_rows(a.crm, a.sheet, a.header_row)
    if a.inspect:
        print(f"{len(rows)} rows; columns:")
        for h in header:
            print(f"  {'[sensitive?] ' if SENSITIVE_HINTS.search(h) else ''}{h}")
        return 0
    if not (a.out and a.name_col):
        ap.error("--out and --name-col are required to build profiles")
    if inside_git(a.out) and not a.allow_git:
        print(f"refusing: {a.out} is inside a git work tree; choose a private folder", file=sys.stderr)
        return 2
    skip = {s.strip() for s in a.skip.split(",") if s.strip()}
    flagged = [h for h in header if SENSITIVE_HINTS.search(h) and h not in skip]
    if flagged:
        print(f"note: these columns look sensitive and are not in --skip: {flagged}", file=sys.stderr)
    analysis = json.loads(a.analysis.read_text(encoding="utf-8")) if a.analysis else {}
    name_idx = header.index(a.name_col)

    out = a.out / "profiles"
    out.mkdir(parents=True, exist_ok=True)
    index = [f"# Client profiles (PRIVATE)\n\nBuilt {date.today()} from `{a.crm.name}`.\n",
             "| # | Client | Archetype |", "|---|---|---|"]
    for n, row in enumerate(rows, 1):
        name = str(row[name_idx]).strip()
        info = analysis.get(name, {})
        fname = f"{n:02d}-{slug(name)}.md"
        lines = [f"# {name}", "", "## Profile (analysis)", ""]
        lines += [f"- **{label}:** {info.get(key, 'TODO')}" for key, label in FIELDS]
        lines += ["", "## CRM facts", ""]
        for h, v in zip(header, row):
            if h and h not in skip and v not in (None, ""):
                lines.append(f"- **{h}:** {v.date() if hasattr(v, 'date') else v}")
        (out / fname).write_text("\n".join(lines) + "\n", encoding="utf-8")
        index.append(f"| {n} | [{name}](profiles/{fname}) | {info.get('archetype', '')} |")
    (a.out / "README.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} profiles to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
