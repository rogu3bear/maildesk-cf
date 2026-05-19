#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  scripts/init.sh <project-name>

Example:
  scripts/init.sh acme-maildesk

This rewrites template identifiers for a new project checkout. It does not
provision Cloudflare resources; use cfctl for account state.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PROJECT_NAME="${1:-}"
if [[ -z "${PROJECT_NAME}" ]]; then
  usage >&2
  exit 64
fi

if [[ ! "${PROJECT_NAME}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]]; then
  echo "project name must be lowercase kebab-case, for example acme-maildesk" >&2
  exit 64
fi

replace_in_file() {
  local file="$1"
  perl -0pi -e "s/(?<![a-z0-9-])maildesk-cf(?![a-z0-9-])/${PROJECT_NAME}/g" "${file}"
}

replace_in_file "${ROOT_DIR}/Cargo.toml"
replace_in_file "${ROOT_DIR}/README.md"
replace_in_file "${ROOT_DIR}/wrangler.toml"
replace_in_file "${ROOT_DIR}/docs/architecture/template-standard.md"
replace_in_file "${ROOT_DIR}/docs/operations/cfctl-contract.md"
replace_in_file "${ROOT_DIR}/ops/cfctl/maildesk-cf.surface.md"
replace_in_file "${ROOT_DIR}/workers/mail-api/src/index.ts"
replace_in_file "${ROOT_DIR}/workers/mail-router/src/index.ts"
replace_in_file "${ROOT_DIR}/apps/maildesk-ui/README.md"

echo "Initialized template identifiers for ${PROJECT_NAME}."
echo "Next: review wrangler.toml placeholders, then provision resources with cfctl."
