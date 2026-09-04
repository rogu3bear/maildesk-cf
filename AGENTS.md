# AGENTS.md

This repo is a public template standard. Treat every tracked file as something
future users and future agents will copy into their own Cloudflare account
work.

<!-- forest-alignment:start -->
## Forest Alignment

- When an enclosing workspace `AGENTS.md` is present, inherit its cross-repo
  rules; this repo's local doctrine remains authoritative for product, runtime,
  build, and release specifics.
- Work in the exact checkout or worktree; preserve unrelated dirty work. Bind
  review and release proof to the full SHA, report dirty state, and keep source,
  local test/build, merge, deploy/apply, and authenticated live readback distinct.
- Cross-repo changes keep this repo's branch/PR, proof, publication, and deploy
  decisions independent. Name interface providers and consumers, and retain
  compatibility through consumer cutover.
- Design work follows shared Design Routing while preserving local product
  language, tokens, components, and accessibility constraints. Implementation
  and rendered review remain with their owning lanes; do not create a parallel
  design authority.
<!-- forest-alignment:end -->

## Purpose

`maildesk-cf` is an independent Cloudflare-edge mail desk that requires `cfctl`
for provisioning and verification. It is compatible with `leptos-cf` app
patterns, but it must work as a standalone app.

The long-term strategy is not to build a private mailbox. The long-term
strategy is to build a reusable extension template that proves a broader
Cloudflare-native stack:

- `cfctl` for account state;
- Rust for the mail router and policy core;
- Cloudflare Workers, D1, R2, Queues, and Email Service for runtime;
- Leptos-compatible UI structure for operators.

## Start Every Session

Before non-trivial work:

```bash
pwd
git status --short --branch 2>/dev/null || true
ls -1 AGENTS.md README.md docs/architecture/template-standard.md
```

If the directory is not a git repository, say so explicitly. Do not invent
branch, commit, or PR state.

Read the public contracts before architecture changes:

- `AGENTS.md`
- `README.md`
- `docs/architecture/template-standard.md`
- `docs/architecture/rust-router-contract.md`

Private checkouts may add ignored local strategy files such as `NORTH_STAR.md`,
`ANCHOR.md`, or `CLAUDE.md`. Those files are useful for one operator's local
strategy, but they are not required for the public template and must not contain
assumptions that tracked code needs to compile or run.

## Proof Class

Treat work as `authority-class` when it touches:

- Cloudflare resources;
- DNS or email authentication;
- inbound or outbound mail delivery;
- secrets;
- persisted email content;
- auth, access control, or audit logs.

Use a compact receipt for substantial work:

```text
Mode: <class>
Objective: <one sentence>
Scope: <files/surfaces>
Live state: <repo/git/control-plane state>
Dirty-tree adoption: <classification>
Proof bar: <commands/checks>
Stop condition: <done/blocker>
```

## Cloudflare Control Plane

Governance status: `cfctl-native`.

`cfctl` is required. Account-level Cloudflare mutation must go through the
operator's configured `cfctl` installation, not through raw dashboard steps,
ad hoc API scripts, or unreviewed `wrangler` commands.

Required mutation flow:

1. `cfctl version --json`
2. `cfctl doctor --json` and `cfctl agents doctor --json`
3. `cfctl resolve "<bounded intent>" --json`
4. inspect the selected contract with `cfctl catalog show <capability-id> --json`
5. load `cfctl guide <capability-id> --json`
6. run read calls with the exact capability, profile, account, selectors, and `--json`
7. for a write, create one hash-bound plan with `cfctl call <capability-id> ... --json`
8. inspect `cfctl plans show <operation-id> --json`
9. after separate approval, use `cfctl plans approve`, `cfctl plans run`, and `cfctl plans status`
10. perform the capability-specific targeted readback

If a needed `cfctl` surface does not exist yet, add an `ops/cfctl/` desired
state or design note that explains the intended surface. Do not bypass the
control-plane model silently.

## Rust Router Standard

The mail router is the core product boundary. Keep it Rust-first and testable
without Cloudflare.

The Rust router should own:

- alias matching;
- domain policy lookup;
- operator/recipient policy;
- reply identity selection;
- authorization decisions for outbound senders;
- normalized route decisions that edge adapters can persist or execute.

Workers should adapt Cloudflare events into router inputs. They should not
hide routing policy inside JavaScript glue or provider-specific handlers.

## Runtime Defaults

- Inbound mail enters through Cloudflare Email Routing and an Email Worker.
- D1 stores thread, participant, identity, routing, and audit metadata.
- In inbox relay, R2 is a bounded recovery spool; successful processing removes
  message content. Legacy web-desk storage remains a compatibility surface.
- Queues handle durable replies, result projection, cleanup and bounded retries.
- Cloudflare Email Service is the primary outbound sender.
- Optional sender adapters must be explicit and policy-gated.
- Personal mailbox providers may be notification/archive targets, but not the
  product source of truth.

## Template Scrubbing

Do not commit:

- personal names;
- personal or production email addresses;
- private domains;
- local home-directory paths;
- Cloudflare account IDs;
- API tokens or secret-looking values;
- generated live receipts.

Use reserved documentation examples:

- `example.com`
- `example.net`
- `example.org`
- `operator@example.com`

## Product Rules

- Preserve original domain identity on replies.
- Default replies to role identity unless policy selects a personal identity.
- Role aliases and personal aliases are different concepts.
- Avoid broad live email smoke tests.
- Prefer configuration checks, provider state reads, and single targeted probes.
- Keep audit logs for outbound messages and policy decisions.
- Never log or persist secret material.

## Compatibility With `leptos-cf`

Follow `leptos-cf`-style app discipline where it helps:

- typed config;
- explicit bindings;
- edge-first deployment posture;
- Rust workspace with clear feature boundaries;
- Leptos-compatible UI structure;
- reproducible build and verification scripts.

Do not vendor or require `leptos-cf` unless the operator explicitly approves
that coupling.

## Current Acceptance Slice

The supported new-template journey is inbox relay: receive through a declared
route, deliver to an existing authorized operator inbox, authorize an ordinary
reply under the public identity, and expose body-free routing health. See
`docs/acceptance-criteria.md` and `docs/operations/recovery.md`.

The explicit `web_desk` mode remains for existing integrations. Preserve its
auth and reply behavior; do not add shared-inbox/composer scope to the relay
milestone. Independent local template proof, account deployment, provider
acceptance, inbox receipt and reply receipt remain separate acceptance planes.

## Preflight

Use Bun for JavaScript/TypeScript tooling.

Template-safe checks:

```bash
bun install
bun run preflight:template
bash scripts/check-template.sh
```

Production checks before Cloudflare mutation:

```bash
bun run preflight:production
```

Production preflight must fail if required Cloudflare/cfctl inputs are missing,
if `wrangler.toml` still contains placeholder IDs, or if policy validation does
not pass. Do not skip it to make a deployment feel green.

## Cloudflare Credentials

Use the configured `cfctl` installation for account-pinned authentication and
credential lifecycle. This public template has no workstation-specific token
minter, external rotation script, or credential-directory dependency.

- Discover protected import with `cfctl auth import-api-token --help`.
  Import through stdin or a mode-0600 `--value-in` file, with an explicit account
  and profile. Never place secret values in arguments, output or tracked files.
- Check `cfctl version --json`, `cfctl doctor --json`, and
  `cfctl agents doctor --json`; use actual health output, not historical
  workstation failures, to select the documented recovery path.
- Load `cfctl guide --topic standing-authority --json` for recurring token
  lifecycle work. Follow its exact permission inventory and policy lifecycle;
  a standing policy requires explicit approval and grants only its recorded
  bounds. This template neither creates nor activates that policy.
- Ordinary mutations retain the capability-specific call/plan/approve/run/status
  lifecycle above. A missing capability or unhealthy secret store is a blocker
  with a governed next action, never permission to call Cloudflare directly.
- Production build adapters require the purpose-scoped deployment token named
  by preflight. Profile custody and deployment-token availability are separate
  checks; runtime bindings do not require copying an account credential into
  application code.
