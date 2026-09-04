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

if [[ "$#" -ne 1 || "${#PROJECT_NAME}" -gt 48 || ! "${PROJECT_NAME}" =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "project name must be 1-48 lowercase kebab-case characters, for example acme-maildesk" >&2
  exit 64
fi

replace_in_file() {
  local file="$1"
  # Dotted names are stable schema filenames and cfctl operation IDs, not
  # project/resource names. Their consumers and files keep the public namespace.
  perl -0pi -e "s/(?<![a-z0-9-])maildesk-cf(?!\.)/${PROJECT_NAME}/g" "${file}"
}

# Validate the complete copy before any substitution. The 48-character prefix
# leaves room for the longest generated resource suffix, -routing-health.
TARGETS=(
  "${ROOT_DIR}/Cargo.toml"
  "${ROOT_DIR}/README.md"
  "${ROOT_DIR}/.env.example"
  "${ROOT_DIR}/wrangler.toml"
  "${ROOT_DIR}/wrangler.mail-router.toml"
  "${ROOT_DIR}/deploy/ui/wrangler.toml"
  "${ROOT_DIR}/wrangler.mail-outbound.toml"
  "${ROOT_DIR}/wrangler.routing-health.toml"
  "${ROOT_DIR}/wrangler.d1-preview.toml"
  "${ROOT_DIR}/config/desired-state.example.json"
  "${ROOT_DIR}/docs/architecture/template-standard.md"
  "${ROOT_DIR}/docs/architecture/runtime-contract.md"
  "${ROOT_DIR}/docs/architecture/rust-router-contract.md"
  "${ROOT_DIR}/docs/operations/cfctl-contract.md"
  "${ROOT_DIR}/docs/operations/getting-started.md"
  "${ROOT_DIR}/docs/operations/preflight.md"
  "${ROOT_DIR}/docs/roadmap.md"
  "${ROOT_DIR}/ops/cfctl/maildesk-cf.surface.md"
  "${ROOT_DIR}/package.json"
  "${ROOT_DIR}/workers/mail-api/src/index.ts"
  "${ROOT_DIR}/workers/mail-router/src/index.ts"
  "${ROOT_DIR}/apps/maildesk-ui/README.md"

)
REQUIRED_CONTRACTS=(
  "${ROOT_DIR}/ops/cfctl/maildesk-cf.desired-state.schema.json"
  "${ROOT_DIR}/.cfctl/operations/d1-migrations.toml"
  "${ROOT_DIR}/.cfctl/operations/d1-policy-projections.toml"
)
for file in "${TARGETS[@]}" "${REQUIRED_CONTRACTS[@]}"; do
  if [[ ! -f "$file" || ! -r "$file" || ! -w "$file" ]]; then
    echo "required template input is missing or not writable: ${file#"$ROOT_DIR"/}" >&2
    exit 65
  fi
  parent="$file"
  while [[ "$parent" != "$ROOT_DIR" ]]; do
    if [[ -L "$parent" ]]; then
      echo "template inputs must not traverse symlinks" >&2
      exit 65
    fi
    parent="$(dirname "$parent")"
  done
  if [[ "$file" == *wrangler*.toml ]]; then
    if ! bun -e '
      const config = Bun.TOML.parse(await Bun.file(process.argv[1]).text());
      function unbound(value) {
        if (!value || typeof value !== "object") return true;
        return Object.entries(value).every(([key, item]) => {
          if (["account_id", "zone_id", "route", "routes", "env"].includes(key)) return false;
          if (["database_id", "preview_database_id"].includes(key)) return item === "00000000-0000-0000-0000-000000000000";
          return unbound(item);
        });
      }
      process.exit(unbound(config) ? 0 : 1);
    ' "$file" 2>/dev/null; then
      echo "initialize a fresh placeholder template, not provider-bound configuration" >&2
      exit 65
    fi
  fi
done
for file in "${TARGETS[@]}"; do
  replace_in_file "$file"
done

echo "Initialized template identifiers for ${PROJECT_NAME}."
echo "AGENTS.md was left unchanged; review it deliberately for clone-specific agent doctrine."
echo "Next: review the legacy web-desk config, the three root relay configs, and the D1-only preview config, then provision resources with cfctl."
