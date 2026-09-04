# Governed dark deployment

Inbox relay is deployed as two separately reviewed plan sets because identifiers
returned by new D1, R2, and Queue resources must be read back before exact Worker
configs and downstream operations can be planned. A single bundle containing
placeholder identifiers is invalid.

## Source-owned inputs

- `.cfctl/operations/d1-migrations.toml` closes the ordered migration directory,
  Wrangler version, schema assertions, bookmark requirement, and recovery
  capability for two explicit operations: production D1 and isolated preview
  D1. The preview operation uses the non-deployable `wrangler.d1-preview.toml`.
- `.cfctl/operations/d1-policy-projections.toml` closes the body-free count and
  digest readback contract. Projection SQL remains a private mode-0600 staged
  file and never enters plan JSON.
- `ops/cfctl/relay-spool-lifecycle.example.json` is the complete desired
  lifecycle replacement for `relay-spool/`. It must be planned only after a
  fresh complete prior lifecycle snapshot is preserved.
- `bun run plan:dark` emits a source-bound blueprint. It creates no operation
  ID, conveys no approval, performs no provider read, and applies nothing.

The projection digest is the SHA-256 of the deterministic semantic projection
before its final three body-free receipt rows are appended. The staged SQL has
its own independent private-stage digest in cfctl. D1 readback must match the
policy, desired-state, semantic-projection, and route-count selectors supplied
to the exact projection plan.

## Installed Access contract

`bun run plan:dark -- --installed-access` and
`bun run check:cfctl-provisioning -- --installed-access --json` inspect the
selected `CFCTL_BIN` (or cfctl on PATH) with non-performing `catalog show` calls.
The default offline blueprint leaves this dependency `not_checked`. Missing,
blocked or incompatible mutation schemas remain a named blocker; metadata
compatibility alone never establishes account authority or a PlanV2 operation.

The four exact capabilities are:

- `access-applications-create-owned-self-hosted-whole-host`
- `access-applications-update-owned-self-hosted-whole-host`
- `access-policies-create-operator-group-allow-policy`
- `access-policies-update-operator-group-allow-policy`

Create the application with the catalog's closed explicit fields, a single
public destination whose `uri` is the bare desired hostname, and `policies: []`.
Its empty policy set is initially deny-all. Read back and retain the exact
returned `app_id` before planning the separate operator-group allow policy.
Application updates retain existing policy references. Policy requests use
`name`, `decision`, `include: [{group: {id: <operator-group-id>}}]`, empty
`exclude`/`require`, and explicit precedence; names/groups are body fields,
not invented API selectors. Inspect the current schema for all required fields
and bounds before materializing a private body. No generic Access create/update
or collection replacement substitutes for these owned operations.

The catalog admission is only the capability gate. Fresh complete ownership
inventory, authenticated receipt continuity, exact account/app/policy IDs,
unchanged unrelated policies, approval and post-change readback remain required.
An older installed cfctl may lack the create capability even when its provider
source checkout implements it; only the explicitly checked executable counts.

## Required planning sequence

1. Verify the exact installed cfctl build, catalog hash, profile, credential
   generation, and registered clean repository head.
2. Resolve, inspect, and guide every capability named by the blueprint.
3. Perform fresh account and zone reads, preserving exact prior-state snapshots
   and rollback targets.
4. Create independent child plans for isolated resource creation, including
   distinct production and preview D1 databases. Compile the
   bootstrap plan set, but do not approve or run it without separate authority.
5. Only after authorized bootstrap apply and exact identifier readback, generate
   ignored mode-0600 root configs, including
   `wrangler.d1-preview.production.toml`. Rehearse all migrations against that
   D1-only preview target before planning the production migration operation.
   Materialize the preview config without placing its database identifier in
   argv or output:

   ```bash
   printf '%s' "$MAILDESK_D1_PREVIEW_DATABASE_ID" | bun run materialize:d1-preview-config
   ```

   Populate `MAILDESK_D1_PREVIEW_DATABASE_ID` only from the exact governed
   bootstrap/readback transaction. The materializer creates the ignored file
   exclusively at mode 0600, reports only content digests, and refuses to
   overwrite an operator-owned config.
6. Generate the private immutable policy object and projection SQL, then create
   migration, upload, projection, Worker, consumer, Access, lifecycle, and reply
   routing child plans.
7. Compile and verify the second plan set. Every child retains its own approval,
   operation ID, expiration, provider preconditions, and rollback transaction.

Dark acceptance requires both relay switches disabled, exact deployed SHA and
bindings, an active policy/R2 digest match, no Queue or DLQ backlog, an empty
spool with the seven-day lifecycle, whole-host Access, and no changed website
mail route. Provider acceptance, inbox receipt, external reply receipt, and
`mail_ready` remain later evidence planes.

This source phase does not authorize credential minting, Cloudflare apply, DNS
or sender-domain mutation, route changes, or live email probes.
