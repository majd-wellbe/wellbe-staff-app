#!/bin/bash
# Copies the Apps Script (and its node test mock + fixture) from a git revision into tests/.gs
# so tests compare against a fixed version. Usage: snapshot.sh [rev]   (default HEAD)
set -e
REV=${1:-HEAD}; ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); OUT=$(cd "$(dirname "$0")/.." && pwd)/.gs
rm -rf "$OUT"; mkdir -p "$OUT/tests"
for f in $(git -C "$ROOT" ls-tree --name-only $REV server/ | grep '\.gs$'); do git -C "$ROOT" show $REV:$f > "$OUT/$(basename $f)"; done
for f in mock.js fixture.js; do git -C "$ROOT" show $REV:server/tests/$f > "$OUT/tests/$f"; done
echo "Apps Script snapshot from $REV: $(ls "$OUT"/*.gs | wc -l) files"
