# Rust Router Contract

The Rust router is the stable product boundary for `maildesk-cf`.

Cloudflare Workers, API handlers, UI actions, and `cfctl` provisioning should
all treat the router as the authority for mail policy. Edge code may translate
events and persist results, but it should not invent routing behavior.

## Owned By The Router

- domain and alias lookup;
- role alias versus personal alias classification;
- operator recipient selection;
- default reply identity selection;
- allowed reply identity checks;
- policy validation before deployment;
- serializable decisions that Workers can store and audit.

## Not Owned By The Router

- Cloudflare Email Routing event parsing;
- MIME parsing;
- D1 SQL;
- R2 object naming;
- Queue retry policy;
- UI session handling;
- sender-provider API calls.

Those concerns belong in adapters around the router.

## Worker Adapter

Both Workers call this crate through the generated WebAssembly package. Rust
exports JSON adapter functions for route decisions and reply authorization;
`workers/shared/router.ts` translates field names and validates the response
shape without reimplementing policy.

Generated WASM and the two role-specific closed Worker bundles are build
artifacts and are not tracked. Build the deployment closure with:

```bash
bun run build:mail-workers
```

The build records every imported TypeScript/package input, the Rust source and
lockfiles, generated WASM bytes, and the exact builder versions in each
role-specific artifact manifest. Wrangler runs
`bun run check:mail-worker-bundles` as a verification-only build command: it
reproduces the closure in ignored staging and fails on any byte drift without
changing the artifact that `cfctl` already hashed. The build must run before
Worker typechecking, tests, or governed deployment planning.
See [ADR 0001](adr/0001-rust-router-worker-authority.md) for the alternatives
and deployment boundary.

## Required Build Behavior

Every generated project should keep these checks green:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo run --package maildesk-router --bin maildesk-policy-check -- config/policy.example.json
bun run build:mail-workers
```

Private instances should run the same policy checker against their ignored
local policy file before any Cloudflare mutation.

## Policy Validation Rules

A policy is deployable only when:

- at least one domain is configured;
- every configured domain has at least one alias;
- every role alias routes to one or more operators;
- every role alias default reply identity is allowed for that route;
- every personal alias routes to exactly one operator;
- every personal alias reply identity matches its alias address.

The first release should prefer explicit rejection over permissive fallback.
Unknown aliases, unknown domains, unauthorized operators, and unauthorized reply
identities must fail closed.

## Reply Identity Strategy

Inbound routing and outbound identity are related, but separate.

For role aliases, default replies should come from the role identity, such as
`founders@example.com`, while policy may allow specific operators to reply from
approved personal identities.

For personal aliases, replies should come from the same personal alias. This
preserves thread continuity and keeps domain identity consistent without making
personal aliases behave like shared inboxes.

## Agent Rule

When adding features, update the router contract first if behavior changes.
Then adapt Workers, UI, storage, and `cfctl` surfaces around the new typed
decision shape. Do not bury policy in TypeScript glue because it is faster in
the moment.
