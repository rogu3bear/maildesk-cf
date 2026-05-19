#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== public template files"
for file in AGENTS.md README.md .env.example package.json tsconfig.json scripts/preflight.ts docs/roadmap.md docs/architecture/template-standard.md docs/architecture/rust-router-contract.md docs/architecture/runtime-contract.md docs/operations/cfctl-contract.md docs/operations/preflight.md ops/cfctl/maildesk-cf.surface.md config/policy.example.json; do
  test -s "${ROOT_DIR}/${file}"
  echo "ok ${file}"
done

echo "== local strategy files"
for file in NORTH_STAR.md ANCHOR.md CLAUDE.md; do
  if [[ -e "${ROOT_DIR}/${file}" ]]; then
    echo "local-only ${file}"
  fi
done

echo "== personal data scan"
scan_output="$(
  grep -RInE \
    -e '/Users/' \
    -e 'CLOUDFLARE_ACCOUNT_ID=[A-Za-z0-9]' \
    -e 'CLOUDFLARE_API_TOKEN=[A-Za-z0-9]' \
    --exclude-dir=target \
    --exclude-dir=var \
    --exclude-dir=node_modules \
    --exclude=AGENTS.md \
    --exclude=CLAUDE.md \
    --exclude=NORTH_STAR.md \
    --exclude=ANCHOR.md \
    --exclude=Cargo.lock \
    --exclude=check-template.sh \
    "${ROOT_DIR}" || true
)"
if [[ -n "${scan_output}" ]]; then
  echo "${scan_output}"
  echo "personal or production-specific data found" >&2
  exit 1
fi

echo "== reserved examples"
grep -RInE 'example\.com|example\.net|example\.org' \
  --exclude-dir=target \
  --exclude-dir=var \
  --exclude-dir=node_modules \
  "${ROOT_DIR}" >/dev/null

echo "== rust tests"
cargo test --manifest-path "${ROOT_DIR}/Cargo.toml"

echo "== example policy"
cargo run --manifest-path "${ROOT_DIR}/Cargo.toml" --bin maildesk-policy-check -- \
  "${ROOT_DIR}/config/policy.example.json"

echo "== worker typecheck"
if [[ -d "${ROOT_DIR}/node_modules" ]]; then
  (cd "${ROOT_DIR}" && bun run typecheck)
  (cd "${ROOT_DIR}" && bun run preflight:template)
else
  echo "node_modules missing; run bun install before worker typecheck and preflight"
fi

echo "template check passed"
