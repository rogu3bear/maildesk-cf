#!/usr/bin/env bash
# Local CI — the full check suite for this repo.
#
# CI for maildesk-cf is LOCAL ONLY (no GitHub Actions). Run before pushing:
#   bun run ci
# The pre-push hook (.githooks/pre-push) runs this automatically once you set
#   git config core.hooksPath .githooks
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

step() { printf '\n==> %s\n' "$1"; }

step "bun install --frozen-lockfile"
bun install --frozen-lockfile

step "cargo fmt --check"
cargo fmt --check

step "cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets -- -D warnings

step "cargo test --workspace --all-features"
cargo test --workspace --all-features

step "build closed mail Worker bundles"
# Direct Bun execution keeps inherited host reservation descriptors intact.
bun scripts/build-mail-worker-bundles.ts

step "TypeScript typecheck"
bun node_modules/typescript/bin/tsc --noEmit

step "bun run build:ui"
bash scripts/build-ui-edge.sh

step "bun run test:workers"
bun test ./tests/workers

step "bun run test:scripts"
bun test ./tests/scripts

step "scripts/check-template.sh"
bash scripts/check-template.sh

printf '\nlocal CI OK\n'
