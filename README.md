# maildesk-cf

`maildesk-cf` is a standalone Cloudflare-edge mail-routing template.

It gives teams a reusable starting point for domain-consistent operator delivery:
mail arrives through Cloudflare Email Routing, routing policy is decided by a
Rust core, state is stored on Cloudflare, and replies are sent from approved
domain identities.

## Positioning

`maildesk-cf` is an optional extension in a Cloudflare-native stack:

- use it alone when you need a mail desk;
- use `cfctl` to provision and verify Cloudflare account state;
- use `leptos-cf` conventions when building the operator UI;
- keep the router core independent, testable, and reusable.

It supports two explicit operator-delivery modes: `inbox_relay`, which wraps
mail for an existing operator inbox and relays ordinary replies from the public
route identity, and the legacy `web_desk` alternative. It is not a private
mailbox, Gmail add-on, marketing sender, CRM, ticket system, or helpdesk clone.

## Core Loop

1. A message arrives at `role@example.com`.
2. Cloudflare Email Routing invokes the inbound Worker.
3. The Worker converts the event into a Rust router input.
4. The router returns a policy-backed route decision.
5. In `inbox_relay`, Maildesk generates one bannered delivery per authorized
   operator with an opaque reply address; D1 stores only the token hash.
6. The original MIME is parsed ephemerally and is not retained after successful
   processing. R2 is a bounded relay/recovery spool only.
7. The operator replies normally from the existing inbox.
8. Maildesk re-authenticates the operator and asks the Rust router to authorize
   the original public identity.
9. A durable Queue job sends the reply through Cloudflare Email Service.
10. Body-free D1 audit and route-health state record each distinct evidence plane.

## Repository Shape

Bots can use an optional [read-only Maildesk MCP adapter](docs/operations/bot-mcp.md)
for their authorized routes and existing delivery-status evidence. The existing
mailbox connector remains the content path. The MCP example is disabled and provides no send,
message-content, activation or email-trigger capability.

```text
maildesk-cf/
  src/                  # Leptos Router UI and Cloudflare SSR adapter
  style/                # public-site and operator-desk design system
  assets/               # template-safe icons, manifest, and edge headers
  crates/
    maildesk-router/    # Rust routing and identity policy core
  workers/
    mail-router/        # Cloudflare Email Worker adapter
    mail-api/           # HTTP API and outbound adapter placeholder
    shared/router.ts    # TypeScript boundary around the Rust WASM router
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

The generic legacy web-desk Worker remains available through `wrangler.toml`.
Inbox relay uses three isolated deployment targets: the Email router at
`wrangler.mail-router.toml`, the queue-only outbound consumer at
`wrangler.mail-outbound.toml`, and the D1-plus-assets routing-health UI
at `wrangler.routing-health.toml`. Production resource creation remains
governed by `cfctl`; these files document and typecheck the app-side binding
boundary. The D1-only `wrangler.d1-preview.toml` is not deployable as a Worker;
it gives preview migration rehearsal a separate governed config and operation
identity without binding preview storage to any production Worker.

The routing-health dashboard exposes declared provider state and proof status,
never subjects, message bodies, attachments, thread history, or a composer.

An optional [route canary](docs/operations/mail-canary.md) reads every active
route's configuration hourly, records the last independent proof per path, and
selects a few rotating inbox and reply probes without sending them. Body-free
email alerts report that coverage. `wrangler.mail-heartbeat.toml` is a separate
Worker with no Email binding; it pings an external monitor when the ledger is
fresh. Both examples stay disabled. Current receipts, live provider
configuration, and new mailbox probe results remain separate evidence.
When `MAILDESK_OPERATOR_DELIVERY_MODE=inbox_relay`, `/desk/thread/:id` and web
reply submission fail closed. The legacy shared-token `POST /api/replies` surface is disabled by default with
`MAILDESK_REPLY_API_MODE=disabled`. The existing Google-hosted operator inbox
is the normal human reading and reply path. Enable `token` mode only for an
explicitly service-bound generic web-desk integration.

For a dark deployment, keep both `MAILDESK_INBOUND_RELAY_MODE=disabled` and
`MAILDESK_REPLY_RELAY_MODE=disabled`. This allows bindings and route-health
state to be proven before the separately reviewed canary first enables inbound
processing and later enables reply processing. The deprecated single switch is
accepted only when neither split switch is supplied.

Optional fallback sender adapters can be added later. The default path should
remain Cloudflare-first.

## Build

The Worker build requires `wasm-pack`, `cargo-leptos`, `worker-build`, the Rust
`wasm32-unknown-unknown` target, Bun, and Cargo. The build wrappers resolve the
locked `wasm-bindgen` ABI and install its matching CLI under ignored local
tooling state so generated JavaScript and WASM stay compatible.

UI builds pin `cargo-leptos` to `0.3.11` and `worker-build` to `0.7.5`.
The UI wrapper validates the selected version and prefers the ignored
`var/cargo-tools/cargo-leptos-0.3.11/bin/cargo-leptos` executable when present.
Cargo-leptos 0.3.5 hardcodes a separate frontend target; 0.3.11 supports the
declared `front-target-dir = "CARGO_TARGET_DIR"`. All compilation uses the
repository's `target/`, including the frontend, SSR Worker and Rust router.
`wasm-pack --out-dir` selects final bindings under `generated/`, not a compiler
cache. Dev/test profiles disable debug information and incremental sessions for
workspace crates as well as dependencies, while retaining host dynamic-library
structure. New custom profiles must inherit these settings unless a specific
diagnostic contract requires otherwise.

Combined CI reuses its completed Worker build only after verifying every
recorded input, the Worker filename inventory, Rust source inventory, tool
versions and final output hashes. Standalone `check:mail-worker-bundles` still
rebuilds the complete closure. A changed or missing input refuses reuse.

Compiler intermediates are disposable after the entire build/test/package
operation settles. Final products under `build/`, `generated/` and `target/site`
are separate from compiler cache. Ordinary `ci`, `build:ui`, `build:router-wasm`,
`build:mail-workers`, `check:mail-worker-bundles`, `check:ui`, `test:workers`,
`test:scripts`, `typecheck`, preflight aliases and `check:template` package commands
enter `scripts/build-workflow.py`.
Build-then-test and build-then-typecheck keep their consumers inside one operation.

On a host with the qualified installed Disk Guard preservation API, enable this
local lifecycle in ignored `var/build-cache-retirement.json`:

```json
{
  "schema": "maildesk-local-cache-lifecycle/v1",
  "authorization_ref": "existing-operator-instruction",
  "resource_request": "var/native-resource-request.json",
  "pin_dispositions": []
}
```

The reference must identify real authorization to retire ordinary compiler cache.
Use the existing complete resource request and its unchanged growth estimate.
`pin_dispositions` contains only exact independently authorized dispositions for
this target; an empty list preserves all pins. Never derive permission by copying
the live policy's pins. A new pin or changed pin identity holds cleanup instead
of inheriting an older approval. The actual policy and dispositions are rechecked
inside the held installed exclusion for every fresh transaction.
Configured standalone package commands own admission and automatically qualify
retirement after success; no additional cleanup arguments are needed. Each run
keeps a fresh record under `var/proof/build-lifecycle-*`. Without local activation,
template builds retain their original behavior and report that cleanup is not
configured. Direct `bash scripts/ci.sh`, `bash scripts/build-ui-edge.sh` and
`bash scripts/check-template.sh` calls also select this boundary. Their internal
calls remain in the enclosing CI lifetime. TypeScript build functions are components.
Custom encompassing commands can use the explicit outer workflow:

```bash
python3 -B scripts/build-and-retire.py \
  --resource-request var/native-resource-request.json \
  --receipt-dir var/proof/fresh-ci-retirement \
  --authorization-ref existing-operator-instruction \
  --pin-dispositions var/approved-pin-dispositions.json \
  -- bash scripts/ci.sh
```

Use the existing admitted resource request unchanged and a fresh proof directory.
The authorization reference records a real instruction; it creates no permission.
Run this outer workflow outside an inherited reservation. Before any new
classification it records the admitted command's exit, drains both captured
streams to EOF, independently observes all known producer generations using
kernel birth identities, and observes natural unlock of the exact reservation
inode bound before launch. A stream closing does not prove its producer stopped.
Unknown queries, identity drift and settlement deadlines retain cache; the owner
never kills a consumer, scrubs a token or abandons a writer to force completion.
Only the source-bound ordinary producer chains qualify for automatic retirement;
arbitrary commands retain cache even after an observed zero exit. The owner then
checks settled source and qualifies exact Cargo dependency
payloads and associated metadata using fingerprints and available regeneration
inputs. Unhashed workspace libraries and codegen objects additionally require
native Cargo target metadata. Build-script executables require their exact
Cargo fingerprint and dep-info; their generated outputs and diagnostics remain.
Signed binaries and delivered site assets remain
protected. It acquires held provider exclusion and existing Cargo
locks, checks current open consumers and complete hardlink sets, and preserves
locks, products, diagnostics, unknown files and protected evidence. No mutable
provider source, broad target removal or global cleaner is used.

Operation failure retains outputs for diagnosis. A held, partial or interrupted
retirement never replays its journal. Inspect it with
`python3 -B scripts/build_cache_retirement.py reconcile --plan /absolute/plan.json --journal /absolute/journal.jsonl`;
any remaining effect needs a fresh qualified plan. Unsupported provider or
open-file coverage holds retirement. Allocated-byte reduction and filesystem
free-space changes are recorded separately; concurrent activity can affect the
latter. APFS allocated blocks are measurements; preservation compares exact
content, identity, permissions, links and modification time independently.
Standalone build commands leave retirement to their encompassing
operation, never between router generation and bundling.

Nested package commands forward the validated reservation and custody descriptors
and defer cleanup to the real outer lifetime. A command under an external guard
without a matching repository outer operation retains cache and returns status 78
after a successful build. The actual external outer owner must adopt the same
outside-guard lifecycle before launch; an already-active guard cannot be
retrofitted from its nested child. The repository-owned route uses the existing
installed preservation API and needs no provider callback or installation. Never clear
an inherited token or release another operation's lifetime to force cleanup.
Retirement requires a settled committed source candidate; dirty source and failed
operations remain evidence holds.

Current local checks:

```bash
bun install
bun run build:ui
bun run build:mail-workers
bun run check:mail-worker-bundles
cargo test --workspace --all-features
cargo clippy --all-targets -- -D warnings
bun run typecheck
bun run sync:route-policy
CFCTL_BIN=/path/to/cfctl bun run receipt:maildesk -- --summary var/maildesk-receipt-summary.json
CFCTL_BIN=/path/to/cfctl bun run collect:maildesk-evidence -- --out var/maildesk-live-evidence.json
bun run verify:maildesk
bun run check:cfctl-provisioning
bun run plan:dark
bun run plan:maildesk-proofs -- --receipt var/maildesk-receipt.json
bun run check:maildesk-closeout -- --env-file .dev.vars --summary var/maildesk-receipt-summary.json --redact-sensitive --json
bun run apply:maildesk-acks -- --manifest var/proof/maildesk-sender-domain-plan-manifest.local.json --json
bun run send:maildesk-probes -- --from proof@example.com --json
bun run preflight:template
bash scripts/check-template.sh
cargo run --package maildesk-router --bin maildesk-policy-check -- config/policy.example.json
```

These checks verify the Rust router and template hygiene. They do not prove live
Cloudflare account state.

For a local edge-rendered preview of the public site and empty operator state:

```bash
bunx wrangler dev --config wrangler.routing-health.toml --local --port 8788 \
  --var MAILDESK_UI_AUTH_MODE:preview
```

Preview mode is local-only. Production must keep `workers_dev = false`, retain
`MAILDESK_UI_AUTH_MODE = "access"`, and provide
`MAILDESK_ACCESS_TEAM_DOMAIN` plus `MAILDESK_ACCESS_AUD` so the Worker can
validate the Access JWT signature, issuer, audience, and expiry. Generic public
deployments may select `MAILDESK_UI_ACCESS_SCOPE=desk_only`; private routing
instances select `all_routes`, which protects the entire hostname including
static assets in both the edge adapter and Rust server.

The Worker gates build the Rust router and one closed upload artifact per mail
Worker. Generated WASM and role bundles stay ignored under `generated/`; each
Wrangler target verifies the already-built artifact against the complete
source closure without rewriting it after planning. See
[ADR 0001](docs/architecture/adr/0001-rust-router-worker-authority.md) for the
boundary and trade-offs.

`bun run verify:maildesk` emits the horizontal domain matrix for policy,
desired-state, and optional live evidence. See
[docs/operations/horizontal-verifier.md](docs/operations/horizontal-verifier.md).
`bun run check:cfctl-provisioning` validates the public desired-state fixture
and emits the non-performing cfctl v2 discovery plus PlanV2 lifecycle handoff.
It proves this checkout has a provisioning-lane input; it does not install
`cfctl`, supply account credentials, approve a plan, run a plan, or mutate
Cloudflare.
`bun run plan:dark` emits the two-stage, source-hash-bound dark-deployment
blueprint described in
[docs/operations/dark-deployment.md](docs/operations/dark-deployment.md). It
does not create child operation IDs or perform any Cloudflare action.
`bun run receipt:maildesk` runs the non-mutating collect, verify, and proof-plan
workflow and writes the receipt artifacts under `var/`. Pass
`--summary <path>` to persist the compact readiness handoff JSON. The receipt,
proof plan, and summary carry one body-free Git HEAD/tree/dirty binding so a
protected consumer can reject stale, mismatched, or uncommitted candidates. Pass
`--plan-manifest <path> --require-plan-ready` when the receipt should also prove
that every Cloudflare sender-domain blocker has an exact reviewed PlanV2
operation.
`bun run collect:maildesk-evidence` builds that optional evidence file from
available readbacks without mutating Cloudflare. Sender-domain readback follows
the desired-state sender mode: Cloudflare Email Service uses `cfctl` evidence,
Resend uses Resend provider readback, and `disabled` skips outbound provider
readback.
`bun run plan:maildesk-proofs` turns receipt gaps into a minimal proof plan.
`bun run check:maildesk-closeout` joins production preflight, the compact
receipt summary, and sender-domain PlanV2 dry-run state into one non-mutating
closeout gate. It exits non-zero until instance, edge, and mail readiness are
actually proven. Pass `--env-file .dev.vars` when production-only values live
in the ignored local env file instead of the shell environment. Pass
`--refresh-acks` when the closeout should refresh the sender-domain PlanV2
manifest before dry-running it. Pass `--redact-sensitive`
with `--json` for shareable summaries that keep counts and blocker kinds
without printing sender domains or operation lifecycle commands. PlanV2 does
not expose an ambient preview-cleanup lane; an unwanted draft is retired only
through its exact reviewed operation ID. Closeout JSON also
includes aggregate `protected_actions` counts, required confirmation flags, and
sanitized `protected_command_handoff` argv arrays for the next sender-domain
apply and live-probe handoffs.
`bun run refresh:maildesk-acks` resolves exact zones and creates Cloudflare
Email Service sender-domain PlanV2 operations from typed proof-plan requests;
it never approves or runs them. Resend sender-domain blockers do not produce
Cloudflare plans. `bun run apply:maildesk-acks` dry-runs reviewed PlanV2
lifecycles by default and requires `--execute --confirm-plan` before it invokes
show/approve/run/status for one operation. More than one selected operation also
requires `--confirm-bulk-plan`.
`bun run send:maildesk-probes` dry-runs targeted inbound probes locally by
default and requires `--execute --confirm-live-send --inbound-provider resend`
before it sends mail through Resend. Its reply-API proof mode additionally
requires an explicitly enabled, service-bound legacy API and the reply API
flags before it queues an outbound proof. Sending more than one selected probe also requires
`--confirm-bulk-live-send`.

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
bun run preflight:production -- --env-file .dev.vars
```

Production preflight checks the installed read-capability contract, required
Cloudflare/cfctl inputs, policy validity,
and placeholder Cloudflare resource IDs before any account mutation.
The env-file loader accepts only repo-local files, fills missing variables, and
does not print secret values.

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

## Current Acceptance

New instances follow the inbox-relay journey. Existing `web_desk` integrations
retain their explicit compatibility mode; they do not define the new-instance
roadmap. The [acceptance criteria](docs/acceptance-criteria.md) bind clean-copy
setup, capability compatibility, identity authorization and recovery to direct
checks. The [recovery runbook](docs/operations/recovery.md) distinguishes safely
unsent work, ambiguous sends and accepted results whose cleanup failed.

Before provisioning, check the installed catalog without reading account state:

```bash
bun run check:cfctl-provisioning -- --installed --desired-state config/desired-state.example.json --json
```

A passing result establishes the consumed read-capability contract only.
Mutation planning, account permissions, deployment and mail receipts remain
separate gates. Production preflight includes this compatibility check.

## Explicit ordinary reply activation

The current [inbox relay contract](docs/architecture/inbox-reply-relay.md) separates
single-use canary qualification from durable explicit ordinary-route activation.
Mode switches alone grant no authority. Ordinary processing is disabled by
default; activation and claim-ID recovery proposals perform no provider effect.
