#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== public template files"
for file in README.md docs/architecture/template-standard.md docs/operations/cfctl-contract.md ops/cfctl/maildesk-cf.surface.md config/policy.example.json; do
  test -s "${ROOT_DIR}/${file}"
  echo "ok ${file}"
done

echo "== local strategy files"
for file in NORTH_STAR.md ANCHOR.md AGENTS.md CLAUDE.md; do
  if [[ -e "${ROOT_DIR}/${file}" ]]; then
    echo "local-only ${file}"
  fi
done

echo "== personal data scan"
if rg -n \
  -e '/Users/' \
  -e 'CLOUDFLARE_ACCOUNT_ID=[A-Za-z0-9]' \
  -e 'CLOUDFLARE_API_TOKEN=[A-Za-z0-9]' \
  "${ROOT_DIR}" \
  --glob '!target/**' \
  --glob '!var/**' \
  --glob '!AGENTS.md' \
  --glob '!CLAUDE.md' \
  --glob '!NORTH_STAR.md' \
  --glob '!ANCHOR.md' \
  --glob '!Cargo.lock' \
  --glob '!scripts/check-template.sh'
then
  echo "personal or production-specific data found" >&2
  exit 1
fi

echo "== reserved examples"
rg -n 'example\.com|example\.net|example\.org' "${ROOT_DIR}" >/dev/null

echo "== rust tests"
cargo test --manifest-path "${ROOT_DIR}/Cargo.toml"

echo "== example policy"
cargo run --manifest-path "${ROOT_DIR}/Cargo.toml" --bin maildesk-policy-check -- \
  "${ROOT_DIR}/config/policy.example.json"

echo "template check passed"
