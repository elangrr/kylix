#!/usr/bin/env bash
# Prepare the packages for deployment under a namespace.
#
#   scripts/stage.sh <namespace> [outdir]
#
# Copies the production files (no tests, no mocks) of every deployable package
# into <outdir> (default .deploy/<namespace>), with the placeholder namespace
# replaced by <namespace>. It sends nothing: deploy each directory yourself with
# `gnokey maketx addpkg -pkgdir <dir> -pkgpath <path>`, in the order printed.
#
# <namespace> is a registered name (nym-kylix000) or your own g1... address.
set -euo pipefail

PLACEHOLDER="nym-kylix000"
NS="${1:?usage: scripts/stage.sh <namespace> [outdir]}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${2:-$ROOT/.deploy/$NS}"

# Deployment order: each package after the ones it imports.
PKGS=(p/ring r/kylix r/kylixdemo r/adapters/sinopia3 r/adapters/nsnft)

rm -rf "$OUT"
for pkg in "${PKGS[@]}"; do
  mkdir -p "$OUT/$pkg"
  for f in "$ROOT/$pkg"/*.gno "$ROOT/$pkg/gnomod.toml"; do
    case "$f" in *_test.gno | *_filetest.gno) continue ;; esac
    sed "s#$PLACEHOLDER#$NS#g" "$f" >"$OUT/$pkg/$(basename "$f")"
  done
done

echo "Staged under $OUT. Deploy in this order:"
for pkg in "${PKGS[@]}"; do
  path="$(sed -n 's/^module = "\(.*\)"/\1/p' "$OUT/$pkg/gnomod.toml")"
  bytes="$(cat "$OUT/$pkg"/*.gno | wc -c)"
  echo "  $path  ($bytes bytes of source)  -pkgdir $OUT/$pkg"
done
