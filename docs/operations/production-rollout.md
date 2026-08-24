# Production Rollout

This runbook defines a high-signal path from a fresh template checkout to a
Cloudflare account that can receive, route, and prepare replies.

## Status Words

Use these words exactly:

- `template-ready`: the public checkout builds and passes template hygiene;
- `instance-ready`: local private config validates and production preflight
  passes;
- `edge-ready`: Cloudflare resources exist, bindings are correct, and routing
  readback matches policy;
- `mail-ready`: inbound route, persistence, notification, reply authorization,
  outbound send, and audit evidence are proven.

Do not call a deployment mail-ready just because a Worker deployed.

## 1. Template Proof

```bash
bun install
bun run preflight:template
cargo test
bun run typecheck
bash scripts/check-template.sh
```

This proves the public artifact is clean and buildable. It intentionally avoids
private domains, private operators, and live Cloudflare state.

## 2. Private Policy

Create an ignored policy file:

```bash
cp config/policy.example.json config/policy.local.json
```

Then configure domains, role aliases, personal aliases, operators, and reply
identities. Validate it:

```bash
cargo run --package maildesk-router --bin maildesk-policy-check -- config/policy.local.json
```

The policy should be the source for both Worker runtime config and `cfctl`
Email Routing desired state.

Compile the policy projection as a D1 import file before the governed apply:

```bash
bun run sync:route-policy -- --policy config/policy.local.json \
  --desired-state config/desired-state.local.json --out var/policy-projection.sql
```

The generated SQL intentionally omits explicit `BEGIN TRANSACTION` and
`COMMIT` statements. `wrangler d1 execute --file` supplies the D1 import
transaction; adding another transaction wrapper is rejected by remote D1. The
projection digest remains deterministic over the ordered pre-activation SQL
batch, while atomic application is an invariant of the governed Wrangler/D1
file import rather than syntax emitted by this compiler.

## 3. Cloudflare Provisioning

Provision through cfctl v2, using capability resolution and PlanV2 for each
bounded mutation:

```bash
bun run check:cfctl-provisioning -- --desired-state config/desired-state.local.json
cfctl version --json
cfctl doctor --json
cfctl agents doctor --json
cfctl resolve "read Maildesk current state for config/desired-state.local.json without mutation" --json
```

Keep desired state in ignored private files and verify every mutation with
readback. The local check proves the file satisfies the app-side contract. Use
`cfctl catalog show` and `cfctl guide` for the selected capability, then run the
exact capability/profile/account/selector-bound call. A mutating call creates a
plan. Review it with `cfctl plans show`; approval, execution, status, and
post-change readback remain separate protected steps.

## 4. Runtime Config

Small policies may use `MAILDESK_POLICY_JSON`. Production policies should use
R2:

```bash
wrangler r2 object put maildesk-cf-raw-mail/config/policy.json \
  --file config/policy.local.json
```

Account mutation should still be wrapped by `cfctl` in environments where the
control plane owns Cloudflare writes.

## 5. Production Preflight

Put the required variables in the ignored repo-local env file or export them in
the shell, then run:

```bash
bun run preflight:production -- --env-file .dev.vars
```

Production preflight must fail on placeholder Cloudflare IDs in the Worker
configs selected by desired state, missing auth, missing project name, or
invalid policy. Keep real resource IDs in ignored production configs and point
the ignored desired-state file at those exact configs; do not replace the
tracked template placeholders. Treat a preflight failure as useful. It is the
system refusing to pretend.

## 6. Deploy

Deploy the UI, API/Queue, and Email Workers only after preflight passes and
resource readback matches desired state. Keep the targets separate so inbound
routing can be rolled forward without changing the operator surface. Keep the
legacy token reply API disabled unless an explicit service boundary and scoped
credential have been reviewed.

After deploy, verify:

- API `/readyz`;
- Email Routing rule points at the Email Worker;
- D1 tables exist;
- R2 policy object exists;
- Queue binding exists;
- one targeted inbound probe only when delivery proof is needed.

## 7. Outbound Reply Readiness

Before enabling replies, verify each sending domain has:

- sender authentication;
- verified reply identities;
- router authorization;
- sender adapter configuration;
- audit logging for send attempts and provider results.

If any item is missing, keep inbound forwarding enabled but do not claim
domain-consistent outbound replies are complete.

The public template defaults to `sender.mode=disabled` and
`MAILDESK_OUTBOUND_MODE=disabled`. In that mode, outbound proof gaps are not
sender-domain repair work because no provider is selected.

To enable Cloudflare sending, set both desired-state `sender.mode` and
`MAILDESK_OUTBOUND_MODE` to `cloudflare_email_service`, add a Wrangler
`send_email` binding named `EMAIL`, and populate
`MAILDESK_VERIFIED_SENDER_DOMAINS` only after Cloudflare Email Service readback
proves the sender domain is available.

To enable Resend, set both desired-state `sender.mode` and
`MAILDESK_OUTBOUND_MODE` to `resend`, store `RESEND_API_KEY` as a Worker secret,
and build `MAILDESK_VERIFIED_SENDER_DOMAINS` from Resend domain readback.
Production preflight also accepts `RESEND` as a local compatibility alias for
existing ignored environment files. Resend sender-domain blockers are repaired
in Resend and refreshed through provider readback; they do not use a Cloudflare
PlanV2 mutation.
