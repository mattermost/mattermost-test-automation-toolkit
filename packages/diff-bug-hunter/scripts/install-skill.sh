#!/usr/bin/env bash
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
#
# Install the /hunt and /verify skills into a repository's .claude/skills/.
#
# usage: install-skill.sh [--copy] [--force] [--skill hunt|verify|all] <target-repo>
#   default  symlink to this package (stays current; local only, so it is added to .git/info/exclude)
#   --copy   copy the skill (a vendored snapshot you can commit); an identical copy counts as installed
#   --force  replace an existing, different install
#   --skill  install one skill (default: all)
set -euo pipefail

# Repository-location variables from a hook or `git rebase -x` would point git at another repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

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
exclude=$(git -C "$root" rev-parse --git-path info/exclude)
case "$exclude" in /*) ;; *) exclude="$root/$exclude" ;; esac
if [ "$which" = all ]; then names="hunt verify"; else names=$which; fi

# Each step ends in `|| return 1`: install_one runs inside `||` below, where bash ignores `set -e`.
exclude_add() {
  mkdir -p "$(dirname "$exclude")" || return 1
  grep -qxF "$1" "$exclude" 2>/dev/null || echo "$1" >> "$exclude" || return 1
}

exclude_remove() {
  [ -f "$exclude" ] || return 0
  local tmp
  tmp=$(mktemp) || return 1
  grep -vxF "$1" "$exclude" > "$tmp" || true
  cat "$tmp" > "$exclude" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
}

install_one() {
  local name=$1 src="$skills_dir/$1" dest="$root/.claude/skills/$1" entry="/.claude/skills/$1"
  [ -f "$src/SKILL.md" ] || { echo "skill not found at $src" >&2; return 1; }
  if [ "$mode" = link ] && [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    exclude_add "$entry" || return 1
    echo "already installed: $dest -> $src"
    return 0
  fi
  if [ "$mode" = copy ] && [ -d "$dest" ] && [ ! -L "$dest" ] && diff -rq -x __pycache__ "$src" "$dest" >/dev/null 2>&1; then
    exclude_remove "$entry" || return 1
    echo "already installed: $dest (identical copy)"
    return 0
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ "$force" -ne 1 ]; then
      echo "$dest already exists; rerun with --force to replace it" >&2
      return 1
    fi
    rm -rf "$dest" || return 1
  fi
  mkdir -p "$(dirname "$dest")" || return 1
  if [ "$mode" = link ]; then
    ln -s "$src" "$dest" || return 1
    exclude_add "$entry" || return 1
    echo "linked $dest -> $src (ignored via $exclude)"
  else
    mkdir -p "$dest" || return 1
    (cd "$src" && tar --exclude=__pycache__ -cf - .) | (cd "$dest" && tar -xf -) || return 1
    exclude_remove "$entry" || return 1  # a vendored copy is meant to be committed
    echo "copied $name to $dest (commit it to share)"
  fi
}

status=0
for name in $names; do
  install_one "$name" || status=1
done
if [ "$status" -eq 0 ]; then
  echo "start Claude Code in $root and run: /hunt <pr_number>  or  /verify <what to check>"
else
  echo "install failed; see the errors above" >&2
fi
exit "$status"
