# Template Standard

`maildesk-cf` should be judged as a template before it is judged as an app.
Every feature should answer two questions:

1. Can another team copy this into a new Cloudflare account?
2. Can an agent provision and verify it without learning hidden local context?

## Strategic Shape

The long-term strategy is a three-part Cloudflare-native ecosystem:

- `cfctl`: account control plane and proof system;
- `leptos-cf`: compatible app/runtime pattern;
- `maildesk-cf`: optional mail desk extension.

`maildesk-cf` should be independently useful. It should not require users to
adopt the whole ecosystem at once.

## Layering

### Rust Router

The Rust router is the core domain package. It owns policy decisions and should
compile and test without Cloudflare.

It should not know about D1 SQL, R2 object keys, Worker request objects, or
dashboard state.

The router contract is documented in
[rust-router-contract.md](rust-router-contract.md). Behavior changes should
start there, then flow outward to Workers, API handlers, UI actions, and
`cfctl` surfaces.

### Edge Adapters

Workers adapt Cloudflare events to router inputs and persist router outputs.
They should be thin, explicit, and easy to replace.

### Storage

D1 stores normalized queryable state. R2 stores large opaque mail artifacts.
Queues perform asynchronous work and retries.

### Control Plane

`cfctl` provisions and verifies account resources. If `cfctl` lacks a needed
surface, document the desired surface in `ops/cfctl/` before adding ad hoc
automation.

## Identity Policy

Inbound and outbound identity are related but not identical.

- Role aliases route to one or more operators.
- Personal aliases route to exactly one operator.
- Outbound identities must be explicitly allowed.
- The UI should default to the identity that preserves the original domain
  story.

## Build Lanes

Use separate lanes so the template can grow without hiding risk:

- router lane: Rust policy, validation, and reply authorization;
- adapter lane: Cloudflare Email Worker and API Worker translation code;
- storage lane: D1 schema, R2 object contract, Queue jobs, and migrations;
- control-plane lane: `cfctl` desired state, plans, and verification receipts;
- UI lane: Leptos-compatible operator workflow and access control.

The router lane should remain independently buildable. If it cannot be tested
without Cloudflare credentials, the boundary has drifted.

## Public Template Versus Private Instance

The public template contains only reserved examples and reusable conventions.
Private instances should keep production domains, operator identities, account
IDs, tokens, and live receipts in ignored local files or secret stores.

Anything that improves the reusable mechanism belongs here first. Anything that
names a real operator, real domain, or real account belongs in a private
instance or a control-plane secret.

## Template Hygiene

Use reserved examples only:

- `example.com`
- `example.net`
- `example.org`
- `operator@example.com`

Do not commit personal names, private domains, local home paths, tokens, account
IDs, or live operation receipts.
