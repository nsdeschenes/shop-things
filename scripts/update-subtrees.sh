#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -ne 2 ]]; then
  echo 'Usage: scripts/update-subtrees.sh effect <upstream-revision>' >&2
  exit 2
fi

case "$1" in
  effect) upstream=https://github.com/Effect-TS/effect.git ;;
  *) echo "Unknown reference repository: $1" >&2; exit 2 ;;
esac

operation=add
if [[ -d "repos/$1" ]]; then
  operation=pull
fi

git subtree "$operation" --prefix="repos/$1" "$upstream" "$2" --squash
