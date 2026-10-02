#!/usr/bin/env python3
"""Build, verify, and install the portable Team Agent Skills pack."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Iterable


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_AUTHORING_SOURCE = PACKAGE_ROOT.parent / ".agents" / "skills"
SKILLS_ROOT = PACKAGE_ROOT / "skills"
MANIFEST_PATH = PACKAGE_ROOT / "manifest.json"
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Version-control metadata, caches, and dependencies are never part of a skill.
IGNORED_NAMES = {".git", ".git-upstream", ".hg", ".svn", "__pycache__", "node_modules", ".venv", ".DS_Store", "Thumbs.db"}
IGNORED_SUFFIXES = (".pyc", ".pyo")
COPY_IGNORE = shutil.ignore_patterns(*IGNORED_NAMES, *("*" + suffix for suffix in IGNORED_SUFFIXES))


def is_skill_file(path: Path, directory: Path) -> bool:
    relative = path.relative_to(directory)
    return path.is_file() and not any(part in IGNORED_NAMES for part in relative.parts) and not path.name.endswith(IGNORED_SUFFIXES)


def remove_tree(path: Path) -> None:
    """Delete a directory, clearing read-only bits (Git object files on Windows)."""
    def make_writable(function, target, _error):
        os.chmod(target, stat.S_IWRITE)
        function(target)
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=make_writable)
    else:
        shutil.rmtree(path, onerror=make_writable)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def skill_directories(root: Path) -> list[Path]:
    if not root.is_dir():
        fail(f"skills directory does not exist: {root}")
    return sorted(
        (path for path in root.iterdir() if path.is_dir() and (path / "SKILL.md").is_file()),
        key=lambda path: path.name,
    )


def frontmatter(skill_file: Path) -> dict[str, str]:
    lines = skill_file.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        fail(f"missing YAML frontmatter: {skill_file}")
    result: dict[str, str] = {}
    block_key: str | None = None
    block_lines: list[str] = []
    for line in lines[1:]:
        if line.strip() == "---":
            if block_key:
                result[block_key] = " ".join(block_lines).strip()
            return result
        if line[:1].isspace():
            if block_key:
                block_lines.append(line.strip())
            continue
        if block_key:
            result[block_key] = " ".join(block_lines).strip()
            block_key = None
            block_lines = []
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            fail(f"invalid frontmatter line in {skill_file}: {line}")
        key, value = line.split(":", 1)
        value = value.strip()
        if value in {">", ">-", ">+", "|", "|-", "|+"}:
            block_key = key.strip()
            block_lines = []
            continue
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        result[key.strip()] = value
    fail(f"unterminated YAML frontmatter: {skill_file}")


def content_bytes(path: Path) -> bytes:
    """File bytes with CRLF normalised to LF for text files, so the same skill
    hashes identically from a Windows (CRLF) and a Linux/macOS (LF) checkout.
    Files containing NUL bytes are treated as binary and hashed verbatim."""
    data = path.read_bytes()
    return data if b"\0" in data else data.replace(b"\r\n", b"\n")


def tree_digest(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted((item for item in directory.rglob("*") if is_skill_file(item, directory)), key=lambda item: item.relative_to(directory).as_posix()):
        digest.update(path.relative_to(directory).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(content_bytes(path)).digest())
    return digest.hexdigest()


def inspect_skills(root: Path) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for directory in skill_directories(root):
        metadata = frontmatter(directory / "SKILL.md")
        name = metadata.get("name", "")
        description = metadata.get("description", "")
        if name != directory.name:
            fail(f"skill name must match directory: {directory.name} has {name or 'no name'}")
        if not NAME_PATTERN.fullmatch(name) or len(name) > 64:
            fail(f"invalid standard skill name: {name}")
        if not description or len(description) > 1024:
            fail(f"description must be 1–1024 characters: {directory / 'SKILL.md'}")
        items.append({"name": name, "description": description, "tree_sha256": tree_digest(directory)})
    return items


def build(source: Path) -> None:
    source = source.expanduser().resolve()
    skills = inspect_skills(source)
    # Building from the pack's own skills/ only refreshes the manifest. Without
    # this guard each skill would be deleted and then copied from itself.
    in_place = source == SKILLS_ROOT.resolve()
    SKILLS_ROOT.mkdir(parents=True, exist_ok=True)
    expected = {item["name"] for item in skills}
    for existing in [] if in_place else skill_directories(SKILLS_ROOT):
        if existing.name not in expected:
            remove_tree(existing)
    for item in [] if in_place else skills:
        destination = SKILLS_ROOT / item["name"]
        if destination.exists():
            remove_tree(destination)
        shutil.copytree(source / item["name"], destination, ignore=COPY_IGNORE)
    manifest = {
        "format": "agentskills.io",
        "version": 1,
        "skills": skills,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"built {len(skills)} skills from {source}")


def load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        fail(f"manifest does not exist: {MANIFEST_PATH}")
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"invalid manifest: {error}")


def verify() -> list[dict[str, str]]:
    current = inspect_skills(SKILLS_ROOT)
    manifest = load_manifest()
    if manifest.get("format") != "agentskills.io" or manifest.get("version") != 1:
        fail("manifest has an unsupported format or version")
    if manifest.get("skills") != current:
        fail("manifest does not match the packaged skills; run build")
    print(f"verified {len(current)} skills")
    return current


def select_skills(skills: list[dict[str, str]], requested: Iterable[str] | None) -> list[dict[str, str]]:
    by_name = {item["name"]: item for item in skills}
    if not requested:
        return skills
    selected: list[dict[str, str]] = []
    for name in requested:
        if name not in by_name:
            fail(f"unknown skill: {name}")
        if by_name[name] not in selected:
            selected.append(by_name[name])
    return selected


def installation_root(target: str, root: Path) -> Path:
    root = root.expanduser().resolve()
    suffixes = {
        "claude-code": (".claude", "skills"),
        "coder": (".agents", "skills"),
        "opencode": (".opencode", "skills"),
        "hermes": ("skills",),
        "generic": (),
    }
    return root.joinpath(*suffixes[target])


def install(target: str, root: Path, requested: Iterable[str] | None, dry_run: bool, force: bool) -> None:
    skills = select_skills(verify(), requested)
    destination_root = installation_root(target, root)
    conflicts = []
    for item in skills:
        destination = destination_root / item["name"]
        if destination.exists() and tree_digest(destination) != item["tree_sha256"]:
            conflicts.append(destination)
    if conflicts and not force:
        fail("conflicting installed skills: " + ", ".join(str(path) for path in conflicts) + "; rerun with --force to replace them")
    verb = "would install" if dry_run else "installing"
    print(f"{verb} {len(skills)} skills into {destination_root}")
    if dry_run:
        return
    destination_root.mkdir(parents=True, exist_ok=True)
    for item in skills:
        source = SKILLS_ROOT / item["name"]
        destination = destination_root / item["name"]
        if destination.exists():
            if tree_digest(destination) == item["tree_sha256"]:
                print(f"current: {item['name']}")
                continue
            remove_tree(destination)
        shutil.copytree(source, destination, ignore=COPY_IGNORE)
        print(f"installed: {item['name']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    build_parser = actions.add_parser("build", help="copy workspace skills into this pack and write its manifest")
    build_parser.add_argument("--source", type=Path, default=DEFAULT_AUTHORING_SOURCE)
    actions.add_parser("verify", help="validate standard metadata and packaged hashes")
    actions.add_parser("list", help="list packaged skills")
    install_parser = actions.add_parser("install", help="copy selected skills into a runtime-specific location")
    install_parser.add_argument("--target", choices=("claude-code", "coder", "opencode", "hermes", "generic"), required=True)
    install_parser.add_argument("--root", type=Path, required=True, help="project root, Hermes profile directory, or direct generic skills root")
    install_parser.add_argument("--skill", action="append", help="skill name to install; repeat to select several")
    install_parser.add_argument("--dry-run", action="store_true")
    install_parser.add_argument("--force", action="store_true", help="replace conflicting copies in the selected target")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.action == "build":
        build(args.source)
    elif args.action == "verify":
        verify()
    elif args.action == "list":
        for skill in verify():
            print(f"{skill['name']}: {skill['description']}")
    else:
        install(args.target, args.root, args.skill, args.dry_run, args.force)


if __name__ == "__main__":
    main()
