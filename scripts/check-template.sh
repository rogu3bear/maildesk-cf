#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== public template files"
for file in AGENTS.md README.md .env.example package.json tsconfig.json wrangler.toml deploy/mail-router/wrangler.toml deploy/mail-outbound/wrangler.toml deploy/routing-health/wrangler.toml scripts/build-router-wasm.ts scripts/preflight.ts scripts/check-cfctl-provisioning.ts scripts/check-relay-topology.ts scripts/compile-dark-plan.ts scripts/wrangler-config.ts scripts/check-maildesk-closeout.ts scripts/collect-live-evidence.ts scripts/plan-mail-proofs.ts scripts/receipt-maildesk.ts scripts/refresh-sender-domain-ack-manifest.ts scripts/apply-sender-domain-ack-manifest.ts scripts/send-mail-probes.ts scripts/verify-maildesk.ts workers/shared/router.ts docs/ARTIFACTS-POLICY.md docs/SCRIPT-OWNERSHIP.md docs/roadmap.md docs/architecture/adr/0001-rust-router-worker-authority.md docs/architecture/template-standard.md docs/architecture/rust-router-contract.md docs/architecture/runtime-contract.md docs/architecture/outbound-identity.md docs/operations/cfctl-contract.md docs/operations/dark-deployment.md docs/operations/deliverability.md docs/operations/horizontal-verifier.md docs/operations/production-rollout.md ops/cfctl/maildesk-cf.surface.md ops/cfctl/maildesk-cf.desired-state.schema.json ops/cfctl/relay-spool-lifecycle.example.json config/policy.example.json config/desired-state.example.json .cfctl/operations/d1-migrations.toml .cfctl/operations/d1-policy-projections.toml; do
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
# Scan tracked files plus new, non-ignored files that could enter the next
# commit. A gitignored `.env` (which legitimately holds local credentials) is
# excluded, while a moved config is covered before it is staged. `--no-messages`
# suppresses only paths deleted by the current diff; matching content still
# fails the gate. Doctrine files that may reference the operator's own context
# are excluded via pathspec.
scan_output="$(
  git -C "${ROOT_DIR}" ls-files -z --cached --others --exclude-standard \
    ':!:AGENTS.md' ':!:CLAUDE.md' ':!:NORTH_STAR.md' ':!:ANCHOR.md' \
    ':!:Cargo.lock' ':!:scripts/check-template.sh' \
  | xargs -0 grep --no-messages -InE \
      -e '/Users/' \
      -e 'CLOUDFLARE_ACCOUNT_ID=[A-Za-z0-9]' \
      -e 'CLOUDFLARE_API_TOKEN=[A-Za-z0-9]' \
      -e 'mlnavigator\.com' \
      -e 'windowdrop\.pro' \
    || true
)"
if [[ -n "${scan_output}" ]]; then
  echo "${scan_output}"
  echo "personal or production-specific data found" >&2
  exit 1
fi

echo "== reserved examples"
grep -RInE 'example\.com|example\.net|example\.org' \
  --exclude-dir=.git \
  --exclude-dir=.wrangler \
  --exclude-dir=target \
  --exclude-dir=generated \
  --exclude-dir=var \
  --exclude-dir=node_modules \
  "${ROOT_DIR}" >/dev/null

echo "== rust router authority"
if grep -RInE \
  -e 'function routeAddress' \
  -e 'const roleAlias = domainPolicy\.role_aliases' \
  -e 'interface RouterPolicy' \
  "${ROOT_DIR}/workers/mail-api/src" \
  "${ROOT_DIR}/workers/mail-router/src"; then
  echo "Worker-local mail policy logic found; use workers/shared/router.ts" >&2
  exit 1
fi

echo "== rust tests"
cargo test --manifest-path "${ROOT_DIR}/Cargo.toml"

echo "== example policy"
cargo run --manifest-path "${ROOT_DIR}/Cargo.toml" --package maildesk-router --bin maildesk-policy-check -- \
  "${ROOT_DIR}/config/policy.example.json"

echo "== worker typecheck"
if [[ -d "${ROOT_DIR}/node_modules" ]]; then
  (cd "${ROOT_DIR}" && bun run typecheck)
  (cd "${ROOT_DIR}" && bun run preflight:template)
  (cd "${ROOT_DIR}" && bun run check:cfctl-provisioning -- --json >/dev/null)
  (cd "${ROOT_DIR}" && bun run verify:maildesk -- --json >/dev/null)
else
  echo "node_modules missing; run bun install before worker typecheck and preflight"
fi

echo "template check passed"
