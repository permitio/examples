#!/usr/bin/env bash
# Builds permitio 3.0.0 from permit-node PR #134 at a pinned commit and writes vendor/permitio-3.0.0-ffe1ccc.tgz.
set -euo pipefail
SHA=ffe1cccc0a90dd7da47d2518e0c4483e30a3cf58
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --filter=blob:none https://github.com/permitio/permit-node.git "$WORK/permit-node"
git -C "$WORK/permit-node" fetch --quiet origin pull/134/head
git -C "$WORK/permit-node" checkout --quiet --detach "$SHA"
docker run --rm -v "$WORK/permit-node:/src" -w /src node:24-slim bash -c \
  "corepack enable && pnpm install --frozen-lockfile --ignore-scripts && pnpm run build && mkdir -p out && pnpm pack --pack-destination out"
mkdir -p "$ROOT/vendor"
cp "$WORK/permit-node/out/permitio-3.0.0.tgz" "$ROOT/vendor/permitio-3.0.0-ffe1ccc.tgz"
echo "wrote vendor/permitio-3.0.0-ffe1ccc.tgz"
