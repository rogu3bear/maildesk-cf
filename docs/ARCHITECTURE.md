# Architecture

## System Context

`maildesk-cf` accepts mail at Cloudflare's edge, applies framework-free Rust
policy, persists bounded metadata and raw artifacts, and exposes an
Access-protected Leptos operator desk. `cfctl` is the account-state authority;
the runtime never provisions its own Cloudflare resources.

The public repository is the reusable template authority. Account identifiers,
domains, operators, credentials, and live receipts belong to ignored private
configuration or provider secret stores.

## Layer Map & Dependency Rule

| Layer | Owning surfaces | May depend on | Must not own |
|---|---|---|---|
| Policy core | `crates/maildesk-router` | Rust data types and serialization | Cloudflare bindings, SQL, HTTP, UI state |
| Inbound/outbound adapters | `workers/mail-router`, `workers/mail-api` | router WASM contract, typed jobs, Cloudflare bindings | alias or reply-identity policy |
| Operator application adapter | `src/server` | router crate, operator-scoped D1 rows, Queue binding | account provisioning or provider truth |
| Presentation | `src/app.rs`, `style/` | typed server-function responses | authorization decisions or live-readiness inference |
| Control plane | `ops/cfctl`, `scripts/` | desired state, `cfctl`, bounded provider readback | runtime request handling |

Dependencies point inward toward the router contract. Provider events and
stored rows are translated at adapter boundaries; a UI selection is never
authorization by itself.

## Data & Storage Decisions

- D1 stores normalized, queryable route, thread, message-metadata, identity,
  and audit state.
- R2 stores raw MIME and future attachment blobs; operator pages expose only
  metadata until a reviewed content policy exists.
- Queue jobs carry bounded work references and explicit identity fields.
- Audit detail excludes message bodies, BCC, custom headers, raw provider
  responses, and credentials.
- Stable delivery or message identifiers are idempotency inputs. A provider
  result is distinct from a queued job.

## Decision Log

| Date | Decision | Consequence |
|---|---|---|
| 2026-08-05 | Keep router policy framework-free | Authorization remains testable without Cloudflare credentials |
| 2026-08-05 | Reconstruct reply decisions only from operator-scoped D1 rows | The server cannot authorize a thread the Access identity could not query |
| 2026-08-05 | Keep public and operator routes in one Leptos Worker with an Access shim | Protected path matching and JWT verification are release-critical adapter contracts |
| 2026-08-05 | Retry only idempotent provider effects; surface ambiguous effects for deliberate recovery | Resend retries reuse the message ID key; Cloudflare Email Service is never replayed after an uncertain outcome |

## Current Boundary Risks

- Rust and TypeScript both recognize the `/desk` protected-path boundary; a
  shared contract fixture remains P1 work.
- D1 query authorization is source-tested and bounded but lacks a local
  binding-level fixture.
- The outbound consumer retries transient Resend failures with bounded backoff
  and records retry scheduling. Ambiguous Cloudflare Email Service outcomes and
  interrupted non-idempotent claims become explicit recovery-required events.
