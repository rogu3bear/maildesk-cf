# Script Ownership

`maildesk-cf` scripts are template tools. They must be reusable, avoid secret
logging, and keep live mutation behind explicit operator action.

| Script | Class | Owner Contract |
| --- | --- | --- |
| `scripts/ci.sh` | gated | Full local CI lane for template changes. Runs install, format, lint, typecheck, and template checks. |
| `scripts/check-template.sh` | gated | Public template hygiene check. Verifies required files, reserved examples, router tests, policy fixture, typecheck, preflight, and verifier. |
| `scripts/preflight.ts` | gated | Template and production input validation. Production mode must fail on missing Cloudflare/cfctl inputs or placeholder resource IDs. |
| `scripts/verify-maildesk.ts` | gated | Non-mutating readiness verifier for policy, desired state, and optional live evidence. |
| `scripts/receipt-maildesk.ts` | operator-receipt | Runs non-mutating collection, verification, and proof planning into ignored receipt artifacts. |
| `scripts/collect-live-evidence.ts` | operator-readback | Reads available Cloudflare/cfctl state into ignored evidence files. Must not mutate account state. |
| `scripts/plan-mail-proofs.ts` | operator-planning | Converts verifier gaps into targeted proof steps. Does not send mail or mutate Cloudflare. |
| `scripts/send-mail-probes.ts` | protected-probe | Dry-runs targeted probes by default. Requires explicit `--execute` before sending mail. |
| `scripts/init.sh` | template-generation | Renames the template for a new project checkout. Should not copy private local state. |

## Mutation Boundary

Account mutation belongs to `cfctl`. Scripts may call cfctl readbacks, produce
plans, or validate inputs, but they must not bypass the control-plane flow for
Cloudflare resource changes.
