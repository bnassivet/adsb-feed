#!/usr/bin/env bash
# Link this repo's tracked skills into the .claude/skills/ paths Claude Code reads.
#
# Skills live in `skills/` -- a normal, tracked directory -- rather than under
# `.claude/`, which is gitignored. Trying to commit them in place needs a
# three-line .gitignore negation per skill (git will not descend into an
# excluded directory, so the parent has to be re-included first), which does not
# scale and is easy to get subtly wrong.
#
# Links, not copies: editing skills/<name>/SKILL.md takes effect immediately and
# there is no second copy to drift.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/skills"

# Each skill may name its destination in `.install-path`, relative to the repo
# root. That preserves *scope*: a directory-scoped skill only triggers for work
# under its directory, which is the right behaviour for one that is about a
# single app. Without the file a skill installs repo-wide.
dest_for() {
  local name="$1" f="$SRC/$1/.install-path"
  if [ -f "$f" ]; then
    echo "$REPO/$(tr -d '[:space:]' < "$f")"
  else
    echo "$REPO/.claude/skills/$name"
  fi
}

skills() {
  [ -d "$SRC" ] || return 0
  for d in "$SRC"/*/; do [ -d "$d" ] && basename "$d"; done
}

case "${1:-help}" in

install)
  n=0
  for name in $(skills); do
    dest="$(dest_for "$name")"
    mkdir -p "$(dirname "$dest")"
    # A stale link or an old real directory would shadow the tracked source.
    [ -L "$dest" ] && rm "$dest"
    if [ -e "$dest" ]; then
      echo "  SKIP $name -- $dest exists and is not a symlink; remove it first" >&2
      continue
    fi
    ln -s "$SRC/$name" "$dest"
    echo "  linked $name -> ${dest#"$REPO"/}"
    n=$((n + 1))
  done
  echo "$n skill(s) installed. Restart Claude Code if they do not appear."
  ;;

uninstall)
  for name in $(skills); do
    dest="$(dest_for "$name")"
    if [ -L "$dest" ]; then
      rm "$dest"
      echo "  unlinked $name"
    fi
    # Tidy the .claude/skills dir if we emptied it, but never .claude itself --
    # it holds settings that are none of our business.
    rmdir "$(dirname "$dest")" 2>/dev/null
  done
  ;;

status)
  rc=0
  for name in $(skills); do
    dest="$(dest_for "$name")"
    rel="${dest#"$REPO"/}"
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$SRC/$name" ]; then
      echo "  ok       $name -> $rel"
    elif [ -L "$dest" ]; then
      echo "  STALE    $name -> $rel points at $(readlink "$dest")"
      rc=1
    elif [ -e "$dest" ]; then
      echo "  CONFLICT $name -- $rel exists but is not our symlink"
      rc=1
    else
      echo "  missing  $name -- run: scripts/install-skills.sh install"
      rc=1
    fi
  done
  exit $rc
  ;;

*)
  cat <<USAGE
usage: install-skills.sh <install|uninstall|status>

Skills are tracked in skills/ and symlinked into .claude/skills/, which is
gitignored. Run 'install' once per checkout.

Available: $(skills | tr '\n' ' ')
USAGE
  ;;
esac
