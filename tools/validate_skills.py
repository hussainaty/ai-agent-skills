#!/usr/bin/env python3
"""Validate every SKILL.md under a directory against the Agent Skills format.

Checks (errors fail the run, warnings do not):
  - frontmatter present and parseable (simple YAML subset, no dependencies)
  - `name`: present, <= 64 chars, lowercase letters/digits/hyphens, matches folder
  - `description`: present, non-empty, <= 1024 chars
  - relative links and backticked bundled paths (scripts/, references/, ...) exist
  - name has no reserved words ("anthropic", "claude") and no XML tags (error)
  - description has no XML tags (error) and is written in third person (warning)
  - body under 500 lines (warning; move detail into references/)
  - references longer than 100 lines start with a table of contents (warning)
  - bundled files are linked from SKILL.md, not only from other references (warning)
  - no Windows-style backslash paths to bundled files (warning)
  - Python files in the skill compile

Rules follow Anthropic's "Skill authoring best practices"
(https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

Usage: python tools/validate_skills.py [ROOT ...] [--json] [--strict-name]
"""
import json
import os
import py_compile
import re
import sys
import tempfile

SKIP_DIRS = {"node_modules", ".git", ".git-upstream", "__pycache__", ".venv", "graphify-out"}
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
LINK_RE = re.compile(r"\]\(([^)\s#]+)(?:#[^)]*)?\)")
XML_RE = re.compile(r"<[A-Za-z/][^>]*>")
RESERVED = ("anthropic", "claude")
FIRST_SECOND_PERSON_RE = re.compile(r"^\s*(I |I'm |I can|You can|You should|We |Let me)", re.I)
BACKSLASH_PATH_RE = re.compile(r"\b(?:scripts|references|templates|assets)\\[\w.\\-]+")
TOC_RE = re.compile(r"^#{1,3}\s*(contents|table of contents|toc)\b", re.I | re.M)
BUNDLED_RE = re.compile(r"`((?:scripts|references|templates|assets|tests|examples)/[\w./-]+)`")


def parse_frontmatter(text):
    """Return (dict, body, error). Supports `key: value`, quoted values,
    folded `>`/`|` blocks, and one level of nested maps (e.g. metadata)."""
    if not text.startswith("---"):
        return None, text, "missing frontmatter"
    end = re.search(r"^---[ \t]*$", text[3:], re.M)
    if not end:
        return None, text, "unterminated frontmatter"
    raw = text[3:3 + end.start()]
    body = text[3 + end.end():]
    data, key, block = {}, None, None
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if block is not None and (line.startswith(" ") or line.startswith("\t")):
            if isinstance(data[key], dict):
                m = re.match(r"\s+([\w.-]+):\s*(.*)$", line)
                if m:
                    data[key][m.group(1)] = m.group(2).strip().strip("\"'")
                    continue
                if line.strip().startswith("- ") and not data[key]:
                    data[key] = []
            if isinstance(data[key], list):
                if line.strip().startswith("- "):
                    data[key].append(line.strip()[2:].strip().strip("\"'"))
                continue
            if isinstance(data[key], dict):
                continue
            data[key] = (data[key] + " " + line.strip()).strip()
            continue
        m = re.match(r"^([\w.-]+):\s*(.*)$", line)
        if not m:
            return None, body, f"unparseable frontmatter line: {line!r}"
        key, val = m.group(1), m.group(2).strip()
        if val in (">", "|", ">-", "|-"):
            data[key], block = "", key
        elif val == "":
            data[key], block = {}, key
        else:
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            data[key], block = val, None
    for k, v in list(data.items()):
        if v == {} or v == []:
            data[k] = ""
    return data, body, None


def check_skill(path, strict_name=False):
    errors, warnings = [], []
    folder = os.path.basename(os.path.dirname(path))
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read().lstrip("﻿")
    fm, body, err = parse_frontmatter(text)
    if err:
        return [err], warnings
    name = fm.get("name", "")
    desc = fm.get("description", "")
    if not isinstance(name, str) or not name:
        errors.append("missing name")
    else:
        if len(name) > 64:
            errors.append(f"name longer than 64 chars ({len(name)})")
        if not NAME_RE.match(name):
            (errors if strict_name else warnings).append(f"name {name!r} is not lowercase-hyphen")
        if name != folder and name.lower().replace(" ", "-") != folder:
            (errors if strict_name else warnings).append(f"name {name!r} != folder {folder!r}")
        if XML_RE.search(name):
            errors.append("name contains an XML tag")
        for word in RESERVED:
            if word in name.lower():
                (errors if strict_name else warnings).append(f"name contains reserved word {word!r}")
    if not isinstance(desc, str) or not desc.strip():
        errors.append("missing description")
    elif len(desc) > 1024:
        errors.append(f"description longer than 1024 chars ({len(desc)})")
    else:
        if XML_RE.search(desc):
            errors.append("description contains an XML tag")
        if len(desc) < 40:
            warnings.append("description is very short; say what it does and when to use it")
        if FIRST_SECOND_PERSON_RE.match(desc):
            warnings.append("description should be third person (\"Processes X...\", not \"I/You can...\")")
    lines = body.count("\n")
    if lines > 500:
        warnings.append(f"body is {lines} lines (>500); move detail into references/")
    base = os.path.dirname(path)
    in_fence = False
    for i, line in enumerate(body.splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        targets = [m.group(1) for m in LINK_RE.finditer(line)]
        targets += [m.group(1) for m in BUNDLED_RE.finditer(line)]
        for t in targets:
            if re.match(r"^[a-z]+:", t) or t.startswith("/") or t.startswith("~") or "<" in t or "*" in t:
                continue
            target = os.path.normpath(os.path.join(base, t.rstrip("/")))
            if not os.path.exists(target):
                errors.append(f"broken reference {t!r}")
    if BACKSLASH_PATH_RE.search(body):
        warnings.append("backslash path to a bundled file; use forward slashes")
    linked = {os.path.normpath(os.path.join(base, m.group(1))) for m in LINK_RE.finditer(body)}
    linked |= {os.path.normpath(os.path.join(base, m.group(1))) for m in BUNDLED_RE.finditer(body)}
    ref_dir = os.path.join(base, "references")
    if os.path.isdir(ref_dir):
        for fn in sorted(os.listdir(ref_dir)):
            ref = os.path.join(ref_dir, fn)
            if not fn.endswith(".md") or not os.path.isfile(ref):
                continue
            with open(ref, encoding="utf-8", errors="replace") as f:
                ref_text = f.read()
            if ref_text.count("\n") > 100 and not TOC_RE.search(ref_text[:3000]):
                warnings.append(f"references/{fn} is over 100 lines without a table of contents")
            if os.path.normpath(ref) not in linked and f"references/{fn}" not in body:
                warnings.append(f"references/{fn} is not linked from SKILL.md (keep references one level deep)")
    tmp = tempfile.mkdtemp()
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn.endswith(".py"):
                p = os.path.join(root, fn)
                try:
                    py_compile.compile(p, cfile=os.path.join(tmp, "x.pyc"), doraise=True)
                except py_compile.PyCompileError as e:
                    errors.append(f"python compile error in {os.path.relpath(p, base)}: {e.msg.strip().splitlines()[-1]}")
    return sorted(set(errors)), sorted(set(warnings))


def find_skills(roots):
    for r in roots:
        for root, dirs, files in os.walk(r):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            if "SKILL.md" in files:
                yield os.path.join(root, "SKILL.md")


def main(argv):
    as_json = "--json" in argv
    strict = "--strict-name" in argv
    roots = [a for a in argv if not a.startswith("--")] or ["."]
    report, n_err = [], 0
    for p in find_skills(roots):
        errs, warns = check_skill(p, strict)
        n_err += len(errs)
        report.append({"skill": p.replace("\\", "/"), "errors": errs, "warnings": warns})
    if as_json:
        print(json.dumps(report, indent=2))
    else:
        for r in report:
            status = "FAIL" if r["errors"] else ("warn" if r["warnings"] else "ok")
            print(f"{status:4}  {r['skill']}")
            for e in r["errors"]:
                print(f"      error: {e}")
            for w in r["warnings"]:
                print(f"      warn:  {w}")
        print(f"\n{len(report)} skills, {sum(1 for r in report if r['errors'])} failing, {n_err} errors")
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
