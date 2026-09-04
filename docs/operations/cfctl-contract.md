# cfctl Contract

`cfctl` is a required operational dependency for `maildesk-cf`.

The app may ship placeholders and local development config, but production
provisioning must flow through `cfctl` so account state has hash-bound plans and
verification receipts.

## Current Surface

The current cfctl v2 surface is capability-driven. Begin with non-performing
health and resolution commands:

```bash
cfctl version --json
cfctl doctor --json
cfctl agents doctor --json
cfctl resolve "read Maildesk current state for config/desired-state.example.json without mutation" --json
cfctl resolve "plan one Maildesk desired-state delta for config/desired-state.example.json without applying it" --json
```

The surface consumes a desired-state file generated from the same policy shape
validated by `maildesk-policy-check`. `cfctl` owns account resources; the
application owns runtime behavior.

The template fixture is `config/desired-state.example.json`.
The schema is `ops/cfctl/maildesk-cf.desired-state.schema.json`.

Before asking `cfctl` to plan account mutation, prove the checkout-side lane
input locally:

```bash
bun run check:cfctl-provisioning
```

That hook validates the desired-state file and emits a typed v2 discovery and
PlanV2 lifecycle handoff. It is non-mutating and does not replace `cfctl` live
readback.

## Resources To Own

- Email Routing rules for configured aliases.
- Email Worker deployment and bindings.
- API/UI Worker deployment and bindings.
- D1 database and migrations.
- D1 preview database for the separately identified, D1-only migration rehearsal.
- R2 bucket for raw MIME and attachments.
- R2 preview bucket for non-production checks.
- Queue for async mail jobs.
- Cloudflare Email Service sender posture when `sender.mode` is
  `cloudflare_email_service`.
- DNS records for SPF, DKIM, DMARC, MTA-STS, and TLS reporting when configured.

The desired-state fixture may include preview storage resources, but production
`wrangler.toml` files must bind only production storage. `cfctl` verification
should catch accidental preview bindings before deploy.
- `wrangler.d1-preview.toml` is not a Worker deployment configuration: it has
  exactly one D1 binding and no `main`, assets, routes, R2, or Queue authority.
  Its ignored production counterpart is used only by
  `maildesk-cf.d1-preview-migrations-apply`.
- Worker secrets and identity policy config.
- Sender-domain authentication and outbound identity verification status.

## Verification Bar

Verification should avoid broad live sends. Prefer:

- Email Routing rule readback;
- Worker binding readback;
- D1 migration state;
- R2 bucket existence;
- Queue existence;
- DNS record reads;
- provider sender-domain status reads from the active sender mode;
- outbound identity readback for every configured reply identity;
- one explicit targeted send only when a human asks for delivery proof.

The app-side command `bun run verify:maildesk` consumes the same desired-state
and policy shape and can consume a live evidence file. Treat it as the local
receipt format that complements capability-specific `cfctl call` live readback.

Verification output should distinguish:

- missing resource;
- wrong binding;
- DNS/authentication drift;
- Email Routing alias drift;
- sender-domain drift;
- policy/config drift;
- optional live-send proof not requested.

## Current State

This repo contains the app-side desired-state contract and placeholders. The
control plane resolves each bounded intent to an explicit capability. Mutating
`cfctl call` operations create PlanV2 records; they do not apply Cloudflare
changes. Review the immutable operation with `cfctl plans show`, then use the
separate approve/run/status lifecycle only after explicit authorization.
Resend sender-domain setup remains provider-side readback and is never converted
into a Cloudflare mutation.

The reviewed continuity anchor is `result.plan_v2.content_hash`. Persist that
hash with the exact operation, profile, account, selectors, and request body.
Before approval, `cfctl plans show` must return the same PlanV2 content hash and
the same nested input pins. Outer envelope evidence belongs to the command that
emitted it and is not a substitute for the stored PlanV2 hash.

What remains outside this checkout:

- install or update `cfctl` with the required v2 catalog capabilities;
- copy `config/desired-state.example.json` to an ignored local file with a real
  account and domain;
- run version, doctor, and agents-doctor health checks;
- resolve the bounded intent and bind every live call to an explicit profile,
  account, capability, and exact selectors;
- review the immutable PlanV2 operation before approval and execution;
- run capability-specific readback and targeted mail proof after mutation.

## One credential and read contract

Production preflight and collection require `MAILDESK_CFCTL_PROFILE` and an
explicit desired account. Every Cloudflare live read carries that same profile
and account. `--cfctl` selects an executable first, then `CFCTL_BIN`, then
`cfctl` on PATH. A healthy globally selected profile cannot substitute for the
requested profile. Credentials stay with cfctl; Maildesk does not read Keychain,
rotate tokens independently, or require a second environment token.

Full collection uses the registered, committed
`.cfctl/operations/d1-evidence.toml` `maildesk_v1` projection and the existing
`r2-get-private-object-digest` capability. The operation pack owns the production
config, binding and Wrangler pin; cfctl validates its clean workspace authority
and exact account/database selectors before reading. Register the adopted
repository with `cfctl workspace add` using its current command help, commit the
operation declaration, and inspect `cfctl catalog show <operation-id> --json`
before collection. Missing capability or unavailable credential is a failed
transaction with a receipt; fix the reported contract/profile and rerun. There
is no raw SQL, remote Wrangler or object-body fallback.

The projection supplies only its approved relay table map, audit counters and
independent policy digests/keys. A valid zero counter is distinct from malformed
or unavailable evidence. R2 returns a bounded hash and object identity without
returning policy bytes to Maildesk. Domain-scoped canary collection skips this
account-wide private projection and leaves it unverified.

Database audit and route-health rows do not independently prove inbox receipt
or an outward reply. Collection therefore leaves those proof fields absent
unless an existing explicit external evidence source supplies them. Follow the
mail-proof workflow and recovery runbook to obtain the missing evidence; never
mark production acceptance green from these aggregate reads. `transaction_complete`
means the selected reads completed, while `complete`, acceptance and mail
readiness retain their separate requirements.
