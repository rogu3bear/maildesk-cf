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
cfctl version --json
cfctl doctor --json
cfctl agents doctor --json
cfctl resolve "read Maildesk current state for config/desired-state.example.json without mutation" --json
```

`bun run check:cfctl-provisioning` is local and non-mutating. It proves the
desired-state file satisfies the app-side contract before live capability
resolution or account planning.

Resolve and guide each required capability. Bind live calls to an explicit
profile and account. For a mutation, inspect the resulting operation with
`cfctl plans show`; approval, execution, status, and verification remain
separate steps. Never substitute ad hoc Cloudflare API calls.

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
