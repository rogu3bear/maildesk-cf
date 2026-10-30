#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_CARGO_LEPTOS_VERSION="0.3.11"
EXPECTED_WORKER_BUILD_VERSION="0.7.5"

cd "$ROOT_DIR"
bun "$ROOT_DIR/scripts/build-root.ts"
export CARGO_TARGET_DIR="$ROOT_DIR/target"

# Keep the repository's pinned UI tool independent of host-wide CLI upgrades.
LEPTOS_TOOL_BIN="$ROOT_DIR/var/cargo-tools/cargo-leptos-$EXPECTED_CARGO_LEPTOS_VERSION/bin"
if [ -x "$LEPTOS_TOOL_BIN/cargo-leptos" ]; then
  export PATH="$LEPTOS_TOOL_BIN:$PATH"
fi

if ! cargo leptos --version >/dev/null 2>&1; then
  printf '[build-ui] cargo-leptos %s is required.\n' "$EXPECTED_CARGO_LEPTOS_VERSION" >&2
  exit 1
fi

if [ "$(cargo leptos --version | awk '{print $2}')" != "$EXPECTED_CARGO_LEPTOS_VERSION" ]; then
  printf '[build-ui] cargo-leptos %s is required.\n' "$EXPECTED_CARGO_LEPTOS_VERSION" >&2
  exit 1
fi

if ! command -v worker-build >/dev/null 2>&1; then
  printf '[build-ui] worker-build %s is required.\n' "$EXPECTED_WORKER_BUILD_VERSION" >&2
  exit 1
fi

if [ "$(worker-build --version | awk '{print $1}')" != "$EXPECTED_WORKER_BUILD_VERSION" ]; then
  printf '[build-ui] worker-build %s is required.\n' "$EXPECTED_WORKER_BUILD_VERSION" >&2
  exit 1
fi

./scripts/with-ui-wasm-bindgen-cli.sh cargo leptos build --release
bun ./scripts/hash-ui-assets.mjs
source "$ROOT_DIR/target/ui-asset-hashes.env"
./scripts/with-ui-wasm-bindgen-cli.sh worker-build --release --features ssr
bun ./scripts/write-ui-worker-shim.mjs
bun ./scripts/verify-ui-build.mjs
