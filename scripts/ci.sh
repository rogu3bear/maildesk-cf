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

step "bun run typecheck"
bun run typecheck

step "bun run build:ui"
bun run build:ui

step "bun run test:workers"
bun run test:workers

step "bun run test:scripts"
bun run test:scripts

step "scripts/check-template.sh"
bash scripts/check-template.sh

printf '\nlocal CI OK\n'
