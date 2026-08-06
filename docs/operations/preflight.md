# Preflight

`maildesk-cf` has two preflight modes.

## Template Mode

Template mode must pass in a fresh public checkout after dependencies install:

```bash
bun install
bun run preflight:template
bash scripts/check-template.sh
```

Together, template preflight and `scripts/check-template.sh` verify:

- Bun, Rust, Cargo, and TypeScript tooling are available;
- required source files exist;
- the public `cfctl maildesk-cf` desired-state schema and fixture validate;
- `config/policy.example.json` validates through the Rust router;
- reserved example domains remain present;
- Worker TypeScript compiles.

Template mode must not require real Cloudflare credentials.

## Production Mode

Production mode is for a de-templated private instance:

```bash
bun run preflight:production -- --env-file .dev.vars
```

It verifies the template checks plus production-only requirements. You may also
export the variables directly in the shell and run `bun run preflight:production`.
The explicit env-file path must point inside the repository, fills missing
variables without overriding existing shell values, and does not print secret
values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | production account option | Cloudflare account target for `cfctl` and Workers |
| `CLOUDFLARE_API_TOKEN` | production auth option | scoped API token used by the control plane |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | production auth option | global-key lane used by older or emergency `cfctl` setups |
| `CF_DEV_TOKEN` or `CF_GLOBAL_TOKEN` | production auth option | `cfctl` lane token used by cfctl-native setups |
| `CFCTL_BIN` | optional | override path to `cfctl`; defaults to `cfctl` |
| `MAILDESK_DESIRED_STATE_PATH` | optional | desired-state file to read; defaults to local desired state in production |
| `MAILDESK_REPLY_API_MODE` | production | `disabled` by default; `token` only for an explicitly service-bound legacy reply integration |
| `MAILDESK_API_TOKEN` or `MAILDESK_PROOF_API_TOKEN` | token reply API only | bearer token required only when `MAILDESK_REPLY_API_MODE=token`; proof-only closeout may use the secondary token without rotating the primary token |
| `MAILDESK_ACCESS_TEAM_DOMAIN` | production | HTTPS Access team origin used to fetch rotating JWKS, such as `https://team-name.cloudflareaccess.com` |
| `MAILDESK_ACCESS_AUD` | production | immutable audience tag for the Access application protecting `/desk*` |
| `MAILDESK_OUTBOUND_MODE` | optional | `disabled`, `cloudflare_email_service`, or `resend`; defaults to `disabled` and must match selected desired-state `sender.mode` |
| `MAILDESK_VERIFIED_SENDER_DOMAINS` | required for `cloudflare_email_service` or `resend` | comma-separated sender domains approved by the active provider readback |
| `RESEND_API_KEY` or `RESEND` | required for `resend` mode | Resend API key; `RESEND_API_KEY` is the preferred Worker secret name and `RESEND` is accepted as a local compatibility alias |
| `MAILDESK_PROJECT_NAME` | production project option | de-templated project/resource prefix |
| `MAILDESK_POLICY_PATH` | optional | policy file to validate; defaults to local policy in production |

Production mode requires one Cloudflare auth option: `CLOUDFLARE_API_TOKEN`,
`CF_DEV_TOKEN`, `CF_GLOBAL_TOKEN`, or both `CLOUDFLARE_API_KEY` and
`CLOUDFLARE_EMAIL`. In cfctl-native environments, a healthy `cfctl doctor`
lane also satisfies the Cloudflare account/auth proof because the account
selector and credential source live in the operator's `cfctl` configuration.
Prefer scoped tokens for normal operation; the key/email path exists so
`cfctl` can still run an explicitly selected global/emergency lane.

Production mode also requires a project/resource prefix. Set
`MAILDESK_PROJECT_NAME`, or put `project.name` in the selected desired-state
file. The account target can come from `CLOUDFLARE_ACCOUNT_ID`, a literal
`project.account_id` in ignored desired state, an env name referenced by
`project.account_id_env`, or the healthy `cfctl doctor` lane described above.

Production mode also fails if `wrangler.toml`, `wrangler.mail-router.toml`, or
`wrangler.ui.toml` still contains placeholder Cloudflare resource IDs. That is
intentional. Placeholder IDs are acceptable in the public template and
unacceptable before real provisioning.

The Access team origin and application audience are mandatory because the UI
Worker verifies the application JWT cryptographically. Supplying only the
Access-injected email header is never sufficient production authentication.

Outbound mode is deliberately explicit. Desired state and runtime use the same
three values: `disabled`, `cloudflare_email_service`, and `resend`.
Production preflight fails if `MAILDESK_OUTBOUND_MODE` disagrees with
`sender.mode` in the selected desired-state file.

`disabled` proves inbound and reply authorization without sending mail and does
not require sender-domain provider readback. `cloudflare_email_service`
requires a Worker `send_email` binding named `EMAIL` in `wrangler.toml` and
`MAILDESK_VERIFIED_SENDER_DOMAINS` built from Cloudflare Email Service readback.
`resend` requires a Resend API key from `RESEND_API_KEY` or the local
compatibility alias `RESEND`, plus `MAILDESK_VERIFIED_SENDER_DOMAINS` built
from Resend provider readback.

## Policy Files

Use `config/policy.example.json` for public documentation and CI. Use
`config/policy.local.json` in private instances for real domains and operators.
Local policy files are ignored by default.

Before any Cloudflare mutation, run:

```bash
cargo run --package maildesk-router --bin maildesk-policy-check -- "${MAILDESK_POLICY_PATH:-config/policy.local.json}"
```

## Control Plane

Passing production preflight does not mutate Cloudflare. It only proves the
local checkout is ready for the `cfctl` plan/apply/verify flow.

Cloudflare account writes should still follow:

```bash
bun run check:cfctl-provisioning -- --desired-state config/desired-state.local.json
cfctl doctor
cfctl maildesk-cf provision --file config/desired-state.local.json --plan
cfctl maildesk-cf provision --file config/desired-state.local.json --ack-plan <operation-id>
cfctl maildesk-cf verify --file config/desired-state.local.json
```
