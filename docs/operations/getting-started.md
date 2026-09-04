# Getting Started

This guide is for a new project created from the `maildesk-cf` template.

## Tool prerequisites

Install Bun, Rust/Cargo with `wasm32-unknown-unknown`, and `wasm-pack` before
running local checks. Full UI/release proof additionally needs cargo-leptos
0.3.5 and worker-build 0.7.5. The UI wrapper resolves the exact wasm-bindgen CLI
version from Cargo.lock and installs it in the ignored repository-local
`var/cargo-tools` directory if absent; this requires network/tool installation
permission on a fresh machine. No sibling checkout or private strategy file is
required. Dependency lockfiles and build manifests bind resolved versions.

Install cfctl through its supported public distribution before account work.
Use `cfctl version --json`, `cfctl doctor --json`, and
`cfctl agents doctor --json`; import credentials only through the account-bound
`cfctl auth import-api-token` protected-input interface. See `AGENTS.md` for
standing token-lifecycle authority. The public template includes no credentials
or external rotation engine.

## 1. Initialize Names

```bash
scripts/init.sh acme-maildesk
```

Use a 1–48 character lowercase kebab-case project name. Initialization refuses
missing, non-writable or symlinked inputs and provider-bound Wrangler configs
before changing files. The script rewrites template
identifiers in public source files. Stable dotted schema filenames and cfctl
operation IDs retain their public namespace. It does not provision Cloudflare resources.

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
bun run check:cfctl-provisioning -- --installed
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

## 7. Understand supported recovery

New instances use inbox relay, not a new mailbox/composer. Read
[recovery.md](recovery.md) before enabling either processing switch. Test local
[acceptance criteria](../acceptance-criteria.md) first; any live canary needs an
exact target and separate provider, inbox and reply receipts.
