#!/usr/bin/env bash
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
#
# Install the /hunt skill into a repository's .claude/skills/hunt.
#
# usage: install-skill.sh [--copy] [--force] <target-repo>
#   default  symlink to this package (stays current; local only, so it is added to .git/info/exclude)
#   --copy   copy the skill (a vendored snapshot you can commit)
#   --force  replace an existing, different .claude/skills/hunt
set -euo pipefail

usage() { sed -n '5,10s/^# \{0,1\}//p' "$0"; exit "${1:-2}"; }

mode=link force=0 target=""
while [ $# -gt 0 ]; do
  case "$1" in
    --copy) mode=copy ;;
    --force) force=1 ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$target" ] || usage; target=$1 ;;
  esac
  shift
done
[ -n "$target" ] || usage

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.claude/skills/hunt" && pwd -P)
[ -f "$src/SKILL.md" ] || { echo "skill not found at $src" >&2; exit 1; }
root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null) || { echo "$target is not a git repository" >&2; exit 1; }
dest="$root/.claude/skills/hunt"

if [ -e "$dest" ] || [ -L "$dest" ]; then
  if [ "$mode" = link ] && [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    echo "already installed: $dest -> $src"
    exit 0
  fi
  if [ "$force" -ne 1 ]; then
    echo "$dest already exists; rerun with --force to replace it" >&2
    exit 1
  fi
  rm -rf "$dest"
fi

mkdir -p "$(dirname "$dest")"
if [ "$mode" = link ]; then
  ln -s "$src" "$dest"
  exclude="$(git -C "$root" rev-parse --git-path info/exclude)"
  case "$exclude" in /*) ;; *) exclude="$root/$exclude" ;; esac
  mkdir -p "$(dirname "$exclude")"
  grep -qxF "/.claude/skills/hunt" "$exclude" 2>/dev/null || echo "/.claude/skills/hunt" >> "$exclude"
  echo "linked $dest -> $src (ignored via $exclude)"
else
  mkdir -p "$dest"
  (cd "$src" && tar --exclude=__pycache__ -cf - .) | (cd "$dest" && tar -xf -)
  echo "copied skill to $dest (commit it to share)"
fi
echo "start Claude Code in $root and run: /hunt <pr_number>"
