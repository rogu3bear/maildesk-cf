# Script Ownership

`maildesk-cf` scripts are template tools. They must be reusable, avoid secret
logging, and keep live mutation behind explicit operator action.

| Script | Class | Owner Contract |
| --- | --- | --- |
| `scripts/ci.sh` | gated | Full local CI lane for template changes. Runs install, format, lint, typecheck, and template checks. |
| `scripts/check-template.sh` | gated | Public template hygiene check. Verifies required files, reserved examples, router tests, policy fixture, typecheck, preflight, and verifier. |
| `scripts/preflight.ts` | gated | Template and production input validation. Production mode must fail on missing Cloudflare/cfctl inputs or placeholder resource IDs. |
| `scripts/check-maildesk-closeout.ts` | operator-receipt | Runs the non-mutating production closeout gate over production preflight, the compact receipt summary, and sender-domain ack dry-run state. Can refresh sender-domain ack previews in plan mode before dry-run, clean up duplicate active or expired local preview records, emit aggregate protected-action handoffs, and redact sensitive JSON dry-run details for shareable reports. Fails when instance, edge, or mail readiness remains unproven. |
| `scripts/verify-maildesk.ts` | gated | Non-mutating readiness verifier for policy, desired state, and optional live evidence. |
| `scripts/receipt-maildesk.ts` | operator-receipt | Runs non-mutating collection, verification, proof planning, and optional compact summary persistence into ignored receipt artifacts. Can require sender-domain ack readiness from a reviewed manifest without applying it. |
| `scripts/collect-live-evidence.ts` | operator-readback | Reads available Cloudflare/cfctl state into ignored evidence files. Must not mutate account state. |
| `scripts/plan-mail-proofs.ts` | operator-planning | Converts verifier gaps into targeted proof steps. Does not send mail or mutate Cloudflare. |
| `scripts/refresh-sender-domain-ack-manifest.ts` | operator-planning | Reruns sender-domain proof-plan preview commands with `cfctl --plan` and writes an ack manifest. Must not apply preview operations. |
| `scripts/apply-sender-domain-ack-manifest.ts` | protected-apply | Dry-runs reviewed sender-domain ack commands by default. Requires `--execute --confirm-ack-plan` before applying any `cfctl --ack-plan` operation, plus `--confirm-bulk-ack-plan` when more than one selected ack would apply. |
| `scripts/send-mail-probes.ts` | protected-probe | Dry-runs targeted probes by default. Requires explicit `--execute --confirm-live-send` before sending mail or calling the reply API, plus `--confirm-bulk-live-send` when more than one selected probe would execute. |
| `scripts/init.sh` | template-generation | Renames the template for a new project checkout. Should not copy private local state. |

## Mutation Boundary

Account mutation belongs to `cfctl`. Scripts may call cfctl readbacks, produce
plans, or validate inputs, but they must not bypass the control-plane flow for
Cloudflare resource changes.
