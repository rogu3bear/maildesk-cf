# maildesk-cf

`maildesk-cf` is a standalone Cloudflare-edge mail desk template.

It gives teams a reusable starting point for domain-consistent shared inboxes:
mail arrives through Cloudflare Email Routing, routing policy is decided by a
Rust core, state is stored on Cloudflare, and replies are sent from approved
domain identities.

## Positioning

`maildesk-cf` is an optional extension in a Cloudflare-native stack:

- use it alone when you need a mail desk;
- use `cfctl` to provision and verify Cloudflare account state;
- use `leptos-cf` conventions when building the operator UI;
- keep the router core independent, testable, and reusable.

It is not a private mailbox configuration, a Gmail add-on, a marketing sender,
or a generic helpdesk clone.

## Core Loop

1. A message arrives at `role@example.com`.
2. Cloudflare Email Routing invokes the inbound Worker.
3. The Worker converts the event into a Rust router input.
4. The router returns a policy-backed route decision.
5. Metadata is stored in D1.
6. Raw MIME and attachments are stored in R2.
7. Queue jobs handle parsing, notifications, and delivery work.
8. Operators reply through the app.
9. Outbound mail is sent from an allowed domain identity.
10. The audit log records the decision and delivery attempt.

## Repository Shape

```text
maildesk-cf/
  apps/
    maildesk-ui/        # Leptos-compatible operator UI placeholder
  crates/
    maildesk-router/    # Rust routing and identity policy core
  workers/
    mail-router/        # Cloudflare Email Worker adapter
    mail-api/           # HTTP API and outbound adapter placeholder
  migrations/           # D1 schema
  ops/
    cfctl/              # cfctl desired-state and surface notes
  config/
    policy.example.json # documentation-safe policy fixture
  docs/
    architecture/       # architecture and threat model
    operations/         # setup and verification runbooks
  scripts/
    check-template.sh   # local template hygiene checks
```

## Required Dependency

`cfctl` is required for production provisioning and verification. It should own:

- Email Routing rules;
- Worker deployment and bindings;
- D1 databases and migrations;
- R2 buckets;
- Queues;
- secrets;
- DNS and sender authentication records;
- verification receipts.

This template may include `wrangler.toml` placeholders for local development,
but account mutation should flow through `cfctl`.

## Router Contract

The Rust router is the template's product core. It owns the deployable policy
shape, route decisions, and reply authorization. Workers and UI surfaces should
adapt around that typed contract rather than duplicating routing behavior in
provider glue.

Start with [docs/architecture/rust-router-contract.md](docs/architecture/rust-router-contract.md)
before changing inbound routing, outbound identity, or policy validation.

The full runtime shape is described in
[docs/architecture/runtime-contract.md](docs/architecture/runtime-contract.md).
Domain-consistent replies are covered in
[docs/architecture/outbound-identity.md](docs/architecture/outbound-identity.md).

## Runtime Targets

- Cloudflare Workers
- Cloudflare Email Routing
- Cloudflare Email Service
- D1
- R2
- Queues

The HTTP API Worker uses `wrangler.toml`. The inbound Email Worker uses
`wrangler.mail-router.toml`. Production resource creation should still be
driven by `cfctl`; these files document and typecheck the app-side bindings.

Optional fallback sender adapters can be added later. The default path should
remain Cloudflare-first.

## Build

Current local checks:

```bash
bun install
cargo test
cargo clippy --all-targets -- -D warnings
bun run typecheck
CFCTL_BIN=/path/to/cfctl bun run receipt:maildesk -- --summary var/maildesk-receipt-summary.json
CFCTL_BIN=/path/to/cfctl bun run collect:maildesk-evidence -- --out var/maildesk-live-evidence.json
bun run verify:maildesk
bun run plan:maildesk-proofs -- --receipt var/maildesk-receipt.json
bun run check:maildesk-closeout -- --summary var/maildesk-receipt-summary.json --redact-sensitive --json
bun run apply:maildesk-acks -- --manifest var/proof/maildesk-sender-domain-ack-manifest.local.json --json
bun run send:maildesk-probes -- --from proof@example.com --json
bun run preflight:template
bash scripts/check-template.sh
cargo run --bin maildesk-policy-check -- config/policy.example.json
```

These checks verify the Rust router and template hygiene. They do not prove live
Cloudflare account state.

`bun run verify:maildesk` emits the horizontal domain matrix for policy,
desired-state, and optional live evidence. See
[docs/operations/horizontal-verifier.md](docs/operations/horizontal-verifier.md).
`bun run receipt:maildesk` runs the non-mutating collect, verify, and proof-plan
workflow and writes the receipt artifacts under `var/`. Pass
`--summary <path>` to persist the compact readiness handoff JSON. Pass
`--ack-manifest <path> --require-ack-ready` when the receipt should also prove
that every sender-domain blocker has an exact reviewed ack command.
`bun run collect:maildesk-evidence` builds that optional evidence file from
available readbacks without mutating Cloudflare.
`bun run plan:maildesk-proofs` turns receipt gaps into a minimal proof plan.
`bun run check:maildesk-closeout` joins production preflight, the compact
receipt summary, and sender-domain ack dry-run state into one non-mutating
closeout gate. It exits non-zero until instance, edge, and mail readiness are
actually proven. Pass `--refresh-acks` when the closeout should refresh the
sender-domain ack manifest in `cfctl --plan` mode before dry-running it. Pass
`--redact-sensitive` with `--json` for shareable summaries that keep counts and
blocker kinds without printing sender domains or ack commands. Pass
`--purge-duplicate-previews` after repeated `--refresh-acks` runs to clean up
duplicate active local `cfctl` preview records after the new previews are
captured.
`bun run refresh:maildesk-acks` reruns sender-domain preview commands from that
plan in `cfctl --plan` mode and writes an ack manifest without applying it.
`bun run apply:maildesk-acks` dry-runs reviewed sender-domain ack commands by
default and requires `--execute --confirm-ack-plan` before it applies any
`cfctl --ack-plan` operation.
`bun run send:maildesk-probes` dry-runs targeted inbound probes by default and
requires `--execute --confirm-live-send` before it sends mail or calls the
reply API.

## De-Templating

After cloning or generating a new project:

```bash
scripts/init.sh acme-maildesk
```

Then review [docs/operations/getting-started.md](docs/operations/getting-started.md).
For production, follow
[docs/operations/production-rollout.md](docs/operations/production-rollout.md)
and [docs/operations/deliverability.md](docs/operations/deliverability.md).

## Preflight

Use template preflight while developing the public template:

```bash
bun run preflight:template
```

Before provisioning a real Cloudflare account, copy `.env.example` to a local
ignored environment file or export equivalent variables, then run:

```bash
bun run preflight:production
```

Production preflight checks required Cloudflare/cfctl inputs, policy validity,
and placeholder Cloudflare resource IDs before any account mutation.

See [docs/operations/preflight.md](docs/operations/preflight.md) for the exact
variable contract.

## Roadmap

The template roadmap is tracked in [docs/roadmap.md](docs/roadmap.md). Planned
items there are not complete just because the repository has placeholders.

## Template Hygiene

This repository should not contain personal names, private domains, personal
email addresses, local machine paths, account IDs, tokens, or generated live
receipts. Use reserved documentation examples such as:

- `example.com`
- `example.net`
- `example.org`
- `operator@example.com`

## First Milestone

The first milestone is deliberately narrow:

- buildable Rust router crate;
- policy tests for role aliases and reply identities;
- D1 schema skeleton;
- Worker adapter skeletons;
- `cfctl` provisioning contract draft;
- template hygiene check.

Everything else should build on that foundation.
