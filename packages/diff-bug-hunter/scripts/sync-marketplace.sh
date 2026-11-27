#!/usr/bin/env bash
# Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
# See LICENSE.txt for license information.
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") [--allow-branch] <marketplace-checkout>" >&2
  exit 2
}

ALLOW_BRANCH=0
MARKETPLACE_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-branch)
      ALLOW_BRANCH=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    -*)
      usage
      ;;
    *)
      if [[ -n "$MARKETPLACE_DIR" ]]; then
        usage
      fi
      MARKETPLACE_DIR="$1"
      shift
      ;;
  esac
done

[[ -n "$MARKETPLACE_DIR" ]] || usage
[[ -d "$MARKETPLACE_DIR" ]] || { echo "error: marketplace directory does not exist: $MARKETPLACE_DIR" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(git -C "$PKG_DIR" rev-parse --show-toplevel)"
MANIFEST="$PKG_DIR/plugin-manifest.txt"
SKILLS_SRC="$PKG_DIR/.claude/skills"
PLUGIN_TEMPLATE="$PKG_DIR/plugin/plugin.json"
README_SRC="$PKG_DIR/plugin/README.md"

if [[ "$ALLOW_BRANCH" -eq 0 ]]; then
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- packages/diff-bug-hunter || \
     ! git -C "$REPO_ROOT" diff --cached --quiet -- packages/diff-bug-hunter; then
    echo "error: packages/diff-bug-hunter has uncommitted tracked changes (commit or pass --allow-branch)" >&2
    exit 1
  fi
  if git -C "$REPO_ROOT" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
    HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    MAIN_SHA="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
    if [[ "$HEAD_SHA" != "$MAIN_SHA" ]]; then
      echo "error: HEAD ($HEAD_SHA) is not origin/main ($MAIN_SHA); pass --allow-branch for local testing" >&2
      exit 1
    fi
  fi
fi

MARKETPLACE_ABS="$(cd "$MARKETPLACE_DIR" && pwd)"
PLUGIN_DST="$MARKETPLACE_ABS/plugins/diff-bug-hunter"
STAGE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$STAGE_DIR/skills" "$PLUGIN_DST/.claude-plugin" "$PLUGIN_DST/skills"

while IFS= read -r rel || [[ -n "$rel" ]]; do
  rel="${rel#"${rel%%[![:space:]]*}"}"
  rel="${rel%"${rel##*[![:space:]]}"}"
  [[ -z "$rel" || "$rel" == \#* ]] && continue
  src="$SKILLS_SRC/$rel"
  [[ -f "$src" ]] || { echo "error: missing allowlisted file: $src" >&2; exit 1; }
  dst="$STAGE_DIR/skills/$rel"
  mkdir -p "$(dirname "$dst")"
  cp -p "$src" "$dst"
done < "$MANIFEST"

# Verify staged Python files close cleanly over shipped siblings in the source tree and exclude eval scripts
# before mutating the destination marketplace checkout.
python3 - "$STAGE_DIR/skills" "$SKILLS_SRC" <<'PY'
import ast, pathlib, sys
stage_dir = pathlib.Path(sys.argv[1])
src_dir = pathlib.Path(sys.argv[2])
py_files = sorted(stage_dir.rglob("*.py"))
forbidden = {"eval_bugs", "skeptic_eval"}
errors = []
for p in py_files:
    rel_parent = p.relative_to(stage_dir).parent
    shipped_in_dir = {sib.stem for sib in p.parent.glob("*.py")}
    src_parent = src_dir / rel_parent
    source_pool = {sib.stem for sib in src_parent.glob("*.py")} if src_parent.is_dir() else set()
    tree = ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name.split(".", 1)[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names = [node.module.split(".", 1)[0]]
            elif node.level > 0:
                names = [alias.name.split(".", 1)[0] for alias in node.names]
        for name in names:
            if name in forbidden:
                errors.append(f"{p.relative_to(stage_dir)} imports excluded module {name!r}")
            elif name in source_pool and name not in shipped_in_dir:
                errors.append(f"{p.relative_to(stage_dir)} imports un-manifested local module {name!r}")
if errors:
    for err in errors:
        print(err, file=sys.stderr)
    sys.exit(1)
PY

hash_plugin() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
h = hashlib.sha256()
for sub in ("skills", "README.md"):
    p = root / sub
    if p.is_file():
        exe = b"1" if (p.stat().st_mode & 0o111) else b"0"
        h.update(sub.encode() + b"\0" + exe + b"\0" + p.read_bytes() + b"\0")
    elif p.is_dir():
        for f in sorted(x for x in p.rglob("*") if x.is_file() and "__pycache__" not in x.parts and not x.name.endswith(".pyc")):
            exe = b"1" if (f.stat().st_mode & 0o111) else b"0"
            h.update(f.relative_to(root).as_posix().encode() + b"\0" + exe + b"\0" + f.read_bytes() + b"\0")
print(h.hexdigest())
PY
}

BEFORE_HASH="$(hash_plugin "$PLUGIN_DST")"
RECORDED_HASH=""
if [[ -f "$PLUGIN_DST/SOURCE" ]]; then
  RECORDED_HASH="$(awk -F= '$1=="content_hash"{print $2}' "$PLUGIN_DST/SOURCE" | tr -d '[:space:]')"
fi

rsync -a --delete --exclude='__pycache__' --exclude='*.pyc' "$STAGE_DIR/skills/" "$PLUGIN_DST/skills/"
cp "$README_SRC" "$PLUGIN_DST/README.md"

AFTER_HASH="$(hash_plugin "$PLUGIN_DST")"

PLUGIN_JSON="$PLUGIN_DST/.claude-plugin/plugin.json"
if [[ ! -f "$PLUGIN_JSON" ]]; then
  cp "$PLUGIN_TEMPLATE" "$PLUGIN_JSON"
elif [[ "$BEFORE_HASH" != "$AFTER_HASH" ]] || [[ -n "$RECORDED_HASH" && "$RECORDED_HASH" != "$AFTER_HASH" ]]; then
  python3 - "$PLUGIN_JSON" <<'PY'
import json, os, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
parts = str(data.get("version", "0.1.0")).split(".")
if len(parts) == 3 and all(x.isdigit() for x in parts):
    parts[2] = str(int(parts[2]) + 1)
    data["version"] = ".".join(parts)
tmp = p.with_suffix(".json.tmp")
tmp.write_text(json.dumps(data, indent=2) + "\n")
os.replace(tmp, p)
PY
fi

TOOLKIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
SOURCE_TMP="$PLUGIN_DST/SOURCE.tmp"
cat > "$SOURCE_TMP" <<EOF
repository=https://github.com/mattermost/mattermost-test-automation-toolkit
commit=$TOOLKIT_SHA
source_path=packages/diff-bug-hunter
content_hash=$AFTER_HASH
EOF
mv "$SOURCE_TMP" "$PLUGIN_DST/SOURCE"

if command -v claude >/dev/null 2>&1; then
  claude plugin validate "$PLUGIN_DST"
fi

echo "Synced diff-bug-hunter plugin to $PLUGIN_DST (toolkit commit ${TOOLKIT_SHA:0:12})"
