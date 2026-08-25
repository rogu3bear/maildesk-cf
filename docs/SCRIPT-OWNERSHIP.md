# Script Ownership

`maildesk-cf` scripts are template tools. They must be reusable, avoid secret
logging, and keep live mutation behind explicit operator action.

| Script | Class | Owner Contract |
| --- | --- | --- |
| `scripts/ci.sh` | gated | Full local CI lane for template changes. Runs install, format, lint, typecheck, and template checks. |
| `scripts/check-template.sh` | gated | Public template hygiene check. Verifies required files, reserved examples, router tests, policy fixture, typecheck, preflight, and verifier. |
| `scripts/env-file.ts` | helper | Repo-local `.env`/`.dev.vars` loader for scripts that need ignored private values. Must never print secret values or read files outside the repository root. |
| `scripts/preflight.ts` | gated | Template and production input validation. Production mode must fail on missing Cloudflare/cfctl inputs or placeholder resource IDs. |
| `scripts/build-mail-worker-bundles.ts` | build-proof | Produces one deterministic closed bundle per mail Worker, binds every TypeScript, package, Rust, generated-WASM, and toolchain input in a body-free manifest, and verifies the committed source closure again without mutating the reviewed artifact before Wrangler may upload it. |
| `scripts/cfctl-v2-command-contract.ts` | helper | Owns the typed capability identifiers, non-performing discovery argv, sender-domain plan request, and show/approve/run/status lifecycle. |
| `scripts/check-cfctl-provisioning.ts` | gated | Validates the schema-backed desired-state fixture and emits the non-performing cfctl v2 discovery and PlanV2 handoff. Must not perform a live read or mutation. |
| `scripts/check-domain-enrollment.ts` | gated | Validates the associated-domain universe and one explicit enrollment decision per domain, then emits only hashed domain identities and body-free decision codes. It does not infer provider or route readiness. |
| `scripts/compile-fleet-readiness.ts` | gated | Purely joins the body-free enrollment report, normalized route inventory, and route receipts into eight independent readiness planes. It performs no provider call, rejects stale or mismatched proof, and grants fleet coverage only to a complete full-policy transaction. |
| `scripts/materialize-d1-preview-config.ts` | private-config | Consumes one governed preview D1 database UUID on stdin, validates the tracked D1-only template, and creates the ignored mode-0600 production config exclusively. Must never print the database identifier or overwrite an existing config. |
| `scripts/check-maildesk-closeout.ts` | operator-receipt | Runs the non-mutating production closeout gate over production preflight, the compact receipt summary, and sender-domain PlanV2 dry-run state. Can refresh sender-domain plans before dry-run, emit aggregate protected-action handoffs and sanitized argv command handoffs, and redact sensitive JSON dry-run details for shareable reports. It never searches for, bulk-cleans, or retires plans. Fails when instance, edge, or mail readiness remains unproven. |
| `scripts/verify-maildesk.ts` | gated | Non-mutating readiness verifier for policy, desired state, and optional live evidence. |
| `scripts/receipt-maildesk.ts` | operator-receipt | Runs non-mutating collection, verification, proof planning, and optional compact summary persistence into ignored receipt artifacts. Can require Cloudflare sender-domain PlanV2 readiness from a reviewed manifest without executing it. |
| `scripts/collect-live-evidence.ts` | operator-readback | Reads available Cloudflare/cfctl state and active sender-provider state into ignored evidence files. Must not mutate account state. |
| `scripts/plan-mail-proofs.ts` | operator-planning | Converts verifier gaps into targeted proof steps and provider-specific sender repair blockers. Does not send mail or mutate Cloudflare. |
| `scripts/refresh-sender-domain-ack-manifest.ts` | operator-planning | Resolves the exact profile account and active zone, creates capability-bound sender-domain PlanV2 operations, and writes an ignored manifest. Must not approve or run plans. |
| `scripts/apply-sender-domain-ack-manifest.ts` | protected-apply | Dry-runs reviewed sender-domain PlanV2 lifecycles by default. Requires `--execute --confirm-plan` before show/approve/run/status and `--confirm-bulk-plan` when more than one selected operation would execute. |
| `scripts/send-mail-probes.ts` | protected-probe | Dry-runs targeted probes locally by default. Requires explicit `--execute --confirm-live-send` and an executable inbound provider before sending mail, or the reply API flags before calling the reply API, plus `--confirm-bulk-live-send` when more than one selected probe would execute. |
| `scripts/init.sh` | template-generation | Renames the template for a new project checkout. Should not copy private local state. |

## Mutation Boundary

Account mutation belongs to `cfctl`. Scripts may call cfctl readbacks, produce
plans, or validate inputs, but they must not bypass the control-plane flow for
Cloudflare resource changes.
