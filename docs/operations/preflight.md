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
| `CLOUDFLARE_API_TOKEN` | production | scoped API token used by the control plane |
| `CFCTL_BIN` | optional | override path to `cfctl`; defaults to `cfctl` |
| `MAILDESK_PROJECT_NAME` | production | de-templated project/resource prefix |
| `MAILDESK_POLICY_PATH` | optional | policy file to validate; defaults to local policy in production |

Production mode also fails if `wrangler.toml` still contains placeholder
Cloudflare resource IDs. That is intentional. Placeholder IDs are acceptable in
the public template and unacceptable before real provisioning.

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
cfctl maildesk-cf provision --plan
cfctl maildesk-cf provision --ack-plan <operation-id>
cfctl maildesk-cf verify --domain example.com
```
