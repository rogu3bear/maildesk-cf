# Getting Started

This guide is for a new project created from the `maildesk-cf` template.

## 1. Initialize Names

```bash
scripts/init.sh acme-maildesk
```

Use a lowercase kebab-case project name. The script rewrites template
identifiers in public source files. It does not provision Cloudflare resources.

## 2. Review Policy

Start with the Rust router policy model in `crates/maildesk-router`.
Copy `config/policy.example.json` to `config/policy.local.json` for local
experiments. Local policy files are ignored so template users do not
accidentally publish private domains or operator addresses.

Define:

- domains;
- role aliases;
- personal aliases;
- operator addresses;
- default reply identities;
- allowed reply identities.

The router should pass tests before edge adapters are connected.

## 3. Provision With cfctl

Use `cfctl` for Cloudflare account resources:

```bash
bun run check:cfctl-provisioning
cfctl doctor
cfctl maildesk-cf provision --file config/desired-state.example.json --plan
cfctl maildesk-cf provision --file config/desired-state.example.json --ack-plan <operation-id>
cfctl maildesk-cf verify --file config/desired-state.example.json
```

`bun run check:cfctl-provisioning` is local and non-mutating. It proves the
desired-state file is a valid input to the `cfctl maildesk-cf` lifecycle before
any live account planning.

Review the provision plan before acknowledging it. If the plan emits component
commands for DNS, Email Routing, sender domains, Worker scripts, D1, R2,
Queues, or secrets, run those through the named primitive `cfctl` surface rather
than using ad hoc Cloudflare API calls.

## 4. Run Local Checks

```bash
bun install
bun run preflight:template
cargo test
bun run typecheck
bash scripts/check-template.sh
```

These checks prove local template hygiene and router behavior. They do not
prove live Cloudflare account state.

Before a real deployment, export production variables or use a local ignored
environment file, then run:

```bash
bun run preflight:production -- --env-file .dev.vars
```

See [preflight.md](preflight.md) for the full variable contract.

## 5. Roll Out Production Carefully

Use [production-rollout.md](production-rollout.md) as the release runbook.
Use [deliverability.md](deliverability.md) as the mail-authentication and probe
strategy. Use
[../architecture/outbound-identity.md](../architecture/outbound-identity.md)
before enabling replies from domain identities.

## 6. Avoid Broad Email Tests

For deliverability and reputation, do not use broad live-send smoke tests as
normal verification. Prefer provider state reads, DNS reads, binding reads, and
one explicit targeted delivery test only when needed.
