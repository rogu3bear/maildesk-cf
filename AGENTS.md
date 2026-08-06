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

1. `cfctl doctor`
2. current-state read with `cfctl list|get|snapshot|verify`
3. `cfctl standards <surface>` when available
4. `cfctl classify <surface> <operation>`
5. `cfctl guide <surface> <operation>`
6. `cfctl apply ... --plan`
7. inspect and record the `operation_id`
8. `cfctl apply ... --ack-plan <operation_id>`
9. targeted verification

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
- R2 stores raw MIME bodies and attachment blobs.
- Queues handle parsing, notification, indexing, and outbound retries.
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

## Initial Milestone

The first milestone is not a full helpdesk. It is:

- buildable Rust router crate;
- policy fixture and tests;
- Email Worker adapter skeleton;
- D1 schema skeleton;
- R2/Queue binding contract;
- operator UI placeholder;
- `cfctl` provisioning contract draft;
- local checks proving the template is clean and buildable.

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

## Cloudflare Token Doctrine

<!-- Canonical across the operator's Cloudflare repos. Rotation: scripts/rotate-secrets.sh -->

- **One minter: `CF_DEV_TOKEN`** in the operator's shared credential env (not
  committed) — an account-owned (`cfat_`/`cfut_`) token scoped to `Account API
  Tokens: Write` + `Account Settings: Read` only. It stays on the operator's
  machine and never enters CI. The Global API Key (`CF_GLOBAL_TOKEN` /
  `X-Auth-Email` + `X-Auth-Key`) flow is **forbidden** for minting.
- **Every runtime and deploy credential is a short-lived, purpose-scoped child**
  minted from `CF_DEV_TOKEN` via `POST /accounts/{id}/tokens`. Children go to
  CI / Worker / Pages secret stores and the repo-local `.env` (gitignored); the
  minter stays on the operator's machine. This repo's child lives in `.env` as
  `CLOUDFLARE_API_TOKEN` (with `CLOUDFLARE_API_TOKEN_ID` tracked for revocation).
- **Rotate with `./scripts/rotate-secrets.sh`** — it delegates to the operator's
  shared rotation engine (raw `curl`, no cfctl / no keychain, so it runs
  unattended): mint a fresh child from the repo's declared scope (scripts/cf-rotate.conf) →
  verify → write it to `.env` → record state → queue the old id for revocation. `--dry-run` previews
  without minting. All Cloudflare calls force `curl -4` (the minter may carry an
  IPv4-only allowlist; IPv6 egress returns Cloudflare error 9109).
- **Auto-rotation** runs via a user launchd agent that invokes the rotator on a
  schedule and sweeps prior children; unattended runs mint while the login
  session is active.
- **cfctl caveat (2026-07):** cfctl's keychain secret store is broken on this
  machine (`errSecAuthFailed` on any profile write), so `cfctl keys mint` and
  other authenticated cfctl operations are unavailable — the raw-`curl` rotator
  is the working path. Use cfctl for no-auth reads (catalog / docs / doctor) only
  until the keychain bug is fixed.
- Secret values never appear in argv, stdout, logs, or committed files — only in
  the repo `.env` (gitignored) and the platform secret stores.
