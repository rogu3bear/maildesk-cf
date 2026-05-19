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
cfctl doctor
cfctl maildesk-cf provision --plan
cfctl maildesk-cf provision --ack-plan <operation-id>
cfctl maildesk-cf verify --domain example.com
```

If the first-class `maildesk-cf` surface is not available yet, use the existing
primitive `cfctl` surfaces for DNS records, Worker scripts, D1, R2, Queues,
secrets, and Email Routing.

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
bun run preflight:production
```

See [preflight.md](preflight.md) for the full variable contract.

## 5. Avoid Broad Email Tests

For deliverability and reputation, do not use broad live-send smoke tests as
normal verification. Prefer provider state reads, DNS reads, binding reads, and
one explicit targeted delivery test only when needed.
