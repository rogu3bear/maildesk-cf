# Preflight

`maildesk-cf` has two preflight modes.

## Template Mode

Template mode must pass in a fresh public checkout after dependencies install:

```bash
bun install
bun run preflight:template
bash scripts/check-template.sh
```

It verifies:

- Bun, Rust, Cargo, and TypeScript tooling are available;
- required source files exist;
- `config/policy.example.json` validates through the Rust router;
- reserved example domains remain present;
- Worker TypeScript compiles.

Template mode must not require real Cloudflare credentials.

## Production Mode

Production mode is for a de-templated private instance:

```bash
bun run preflight:production
```

It verifies the template checks plus production-only requirements.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | production | Cloudflare account target for `cfctl` and Workers |
| `CLOUDFLARE_API_TOKEN` | production auth option | scoped API token used by the control plane |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | production auth option | global-key lane used by older or emergency `cfctl` setups |
| `CFCTL_BIN` | optional | override path to `cfctl`; defaults to `cfctl` |
| `MAILDESK_API_TOKEN` | production | bearer token for the reply API |
| `MAILDESK_PROOF_API_TOKEN` | optional | secondary bearer token for receipt/proof runs without rotating the primary API token |
| `MAILDESK_OUTBOUND_MODE` | optional | `disabled`, `cloudflare_email_service`, or `resend`; defaults to `disabled` |
| `MAILDESK_VERIFIED_SENDER_DOMAINS` | required when outbound is enabled | comma-separated sender domains approved by provider readback |
| `RESEND_API_KEY` | required for `resend` mode | Resend API key stored as a Worker secret |
| `MAILDESK_PROJECT_NAME` | production | de-templated project/resource prefix |
| `MAILDESK_POLICY_PATH` | optional | policy file to validate; defaults to local policy in production |

Production mode requires one Cloudflare auth option: either `CLOUDFLARE_API_TOKEN`
or both `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL`. Prefer scoped tokens for
normal operation; the key/email path exists so `cfctl` can still run an
explicitly selected global/emergency lane.

Production mode also fails if `wrangler.toml` still contains placeholder
Cloudflare resource IDs. That is intentional. Placeholder IDs are acceptable in
the public template and unacceptable before real provisioning.

Outbound mode is deliberately explicit. `disabled` proves inbound and reply
authorization without sending mail. `cloudflare_email_service` requires a
Worker `send_email` binding named `EMAIL`, and `resend` requires a Worker
secret named `RESEND_API_KEY`. Both enabled modes require
`MAILDESK_VERIFIED_SENDER_DOMAINS`; build it from provider readback, not from
the local policy alone.

## Policy Files

Use `config/policy.example.json` for public documentation and CI. Use
`config/policy.local.json` in private instances for real domains and operators.
Local policy files are ignored by default.

Before any Cloudflare mutation, run:

```bash
cargo run --bin maildesk-policy-check -- "${MAILDESK_POLICY_PATH:-config/policy.local.json}"
```

## Control Plane

Passing production preflight does not mutate Cloudflare. It only proves the
local checkout is ready for the `cfctl` plan/apply/verify flow.

Cloudflare account writes should still follow:

```bash
cfctl doctor
cfctl maildesk-cf provision --file config/desired-state.local.json --plan
cfctl maildesk-cf provision --file config/desired-state.local.json --ack-plan <operation-id>
cfctl maildesk-cf verify --file config/desired-state.local.json
```
