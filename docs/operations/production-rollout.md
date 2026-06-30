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
cargo run --bin maildesk-policy-check -- config/policy.local.json
```

The policy should be the source for both Worker runtime config and `cfctl`
Email Routing desired state.

## 3. Cloudflare Provisioning

Provision through `cfctl`, using plan and acknowledge phases for mutations:

```bash
cfctl doctor
cfctl maildesk-cf provision --file config/desired-state.local.json --plan
cfctl maildesk-cf provision --file config/desired-state.local.json --ack-plan <operation-id>
cfctl maildesk-cf verify --file config/desired-state.local.json
```

Keep desired state in ignored private files and verify every mutation with
readback. If the composite plan emits component commands, run those through the
named primitive surface. For example:

```bash
cfctl apply email.routing_rule upsert --zone example.com \
  --name founders@example.com \
  --service maildesk-cf-router \
  --plan
cfctl apply sender_domain enable --zone example.com --name example.com --plan
```

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

Set or source the required variables, then run:

```bash
bun run preflight:production
```

Production preflight must fail on placeholder Cloudflare IDs, missing auth,
missing project name, or invalid policy. Treat that failure as useful. It is
the system refusing to pretend.

## 6. Deploy

Deploy the API Worker and Email Worker only after preflight passes and resource
readback matches desired state. Keep API and Email Worker deploys separate so
inbound routing can be rolled forward without changing the operator API.

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

The public template defaults to `MAILDESK_OUTBOUND_MODE=disabled`. To enable
Cloudflare sending, add a Wrangler `send_email` binding named `EMAIL` only
after Cloudflare Email Service readback proves the sender domain is available.
To enable Resend, set `MAILDESK_OUTBOUND_MODE=resend` and store
`RESEND_API_KEY` as a Worker secret. In either case,
`MAILDESK_VERIFIED_SENDER_DOMAINS` must contain only domains verified by the
active sender provider.
