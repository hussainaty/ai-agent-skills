#!/usr/bin/env bash
# Symlink the claude-browser-stack skills into ~/.claude/skills/
# Re-runnable: replaces existing links of the same name.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
SKILLS_DST="$HOME/.claude/skills"

mkdir -p "$SKILLS_DST"

for skill in "$SKILLS_SRC"/*/; do
  name="$(basename "$skill")"
  dst="$SKILLS_DST/$name"
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    echo "  replacing existing: $name"
    rm -rf "$dst"
  fi
  ln -s "$skill" "$dst"
  echo "  linked: $name"
done

echo
echo "Done. Skills linked into $SKILLS_DST"
echo "Next: 'npm install -g agent-browser && agent-browser install' (engine),"
echo "and 'npm install -g chrome-remote-interface' (for /watchall and /watchconsole)."
