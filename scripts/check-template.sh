#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== public template files"
for file in README.md docs/architecture/template-standard.md docs/operations/cfctl-contract.md ops/cfctl/maildesk-cf.surface.md; do
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
  -e 'adapteros|mlnavigator|auchshop|jkca|donella|james|scopic|/Users/star|privaterelay|icloud' \
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

echo "template check passed"
