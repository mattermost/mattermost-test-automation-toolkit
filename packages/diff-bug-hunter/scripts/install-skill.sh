#!/usr/bin/env bash
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
#
# Install the /hunt and /verify skills into a repository's .claude/skills/.
#
# usage: install-skill.sh [--copy] [--force] [--skill hunt|verify|all] <target-repo>
#   default  symlink to this package (stays current; local only, so it is added to .git/info/exclude)
#   --copy   copy the skill (a vendored snapshot you can commit)
#   --force  replace an existing, different install
#   --skill  install one skill (default: all)
set -euo pipefail

usage() { sed -n '5,11s/^# \{0,1\}//p' "$0"; exit "${1:-2}"; }

mode=link force=0 target="" which=all
while [ $# -gt 0 ]; do
  case "$1" in
    --copy) mode=copy ;;
    --force) force=1 ;;
    --skill) shift; which=${1:-}; case "$which" in hunt|verify|all) ;; *) usage ;; esac ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$target" ] || usage; target=$1 ;;
  esac
  shift
done
[ -n "$target" ] || usage

skills_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.claude/skills" && pwd -P)
root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null) || { echo "$target is not a git repository" >&2; exit 1; }
if [ "$which" = all ]; then names="hunt verify"; else names=$which; fi

install_one() {
  local name=$1 src="$skills_dir/$1" dest="$root/.claude/skills/$1"
  [ -f "$src/SKILL.md" ] || { echo "skill not found at $src" >&2; return 1; }
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ "$mode" = link ] && [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
      echo "already installed: $dest -> $src"
      return 0
    fi
    if [ "$force" -ne 1 ]; then
      echo "$dest already exists; rerun with --force to replace it" >&2
      return 1
    fi
    rm -rf "$dest"
  fi
  mkdir -p "$(dirname "$dest")"
  if [ "$mode" = link ]; then
    ln -s "$src" "$dest"
    local exclude
    exclude="$(git -C "$root" rev-parse --git-path info/exclude)"
    case "$exclude" in /*) ;; *) exclude="$root/$exclude" ;; esac
    mkdir -p "$(dirname "$exclude")"
    grep -qxF "/.claude/skills/$name" "$exclude" 2>/dev/null || echo "/.claude/skills/$name" >> "$exclude"
    echo "linked $dest -> $src (ignored via $exclude)"
  else
    mkdir -p "$dest"
    (cd "$src" && tar --exclude=__pycache__ -cf - .) | (cd "$dest" && tar -xf -)
    echo "copied $name to $dest (commit it to share)"
  fi
}

status=0
for name in $names; do
  install_one "$name" || status=1
done
[ "$status" -eq 0 ] && echo "start Claude Code in $root and run: /hunt <pr_number>  or  /verify <what to check>"
exit "$status"
