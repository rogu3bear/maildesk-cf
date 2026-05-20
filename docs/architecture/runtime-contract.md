# Runtime Contract

This document defines the first complete runtime shape for `maildesk-cf`.
Everything here should remain template-safe: use reserved domains, no account
IDs, no operator names, no live receipts, and no secret values.

## Components

### Email Worker

The Email Worker receives Cloudflare Email Routing events. It should:

- normalize the envelope recipient into an `InboundMessage`;
- call the Rust router contract through the compiled adapter path;
- store raw MIME content in R2 before parsing work begins;
- persist the route decision and initial message metadata in D1;
- enqueue parsing, indexing, notification, and delivery jobs;
- reject unknown domains and aliases without silently forwarding mail.

It should not own policy. If policy logic appears in TypeScript, move it back
into `crates/maildesk-router`.

The template deploy target for this Worker is `wrangler.mail-router.toml`.

### API Worker

The API Worker powers the operator desk. It should:

- enforce authentication before thread, message, or reply access;
- read route, thread, message, identity, and audit data from D1;
- create outbound reply intents only after router authorization;
- enqueue outbound send jobs instead of sending inline;
- expose health and readiness endpoints that do not leak private config.

The template deploy target for this Worker is `wrangler.toml`.

### Rust Router

The router is the authority for route decisions and reply authorization. Its
public output must be serializable, auditable, and stable enough for Workers,
the UI, and `cfctl` verification to consume.

### Storage

D1 stores queryable state. R2 stores raw MIME and attachments. Queues own async
retries. The app should never rely on a personal mailbox as the source of truth.

## Required Bindings

| Binding | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 | domains, identities, routes, threads, messages, audit events |
| `RAW_MAIL` | R2 | raw MIME bodies and attachment blobs |
| `MAIL_JOBS` | Queue | parsing, notification, indexing, outbound retries |
| policy config | secret or versioned config | deployable router policy |

The template ships placeholder `wrangler.toml` values. Production provisioning
must replace them through `cfctl` before `preflight:production` can pass.
Private instances should provision both production and preview D1/R2 resources
so Wrangler preview and targeted checks do not reuse production mail storage.

## Mail Flow

1. Cloudflare Email Routing receives `role@example.com`.
2. Email Worker converts the event into router input.
3. Rust router returns a `RouteDecision`.
4. Raw MIME is written to R2.
5. Route, message, and audit metadata are written to D1.
6. Queue jobs parse MIME and notify operators.
7. Operator opens a thread in the UI.
8. API Worker asks the router to authorize the reply identity.
9. Outbound job sends through the configured Cloudflare-first sender path.
10. Audit events record the send request, provider result, and final status.

## Failure Policy

- Unknown domain: reject and audit if possible.
- Unknown alias: reject and audit if possible.
- Empty operator set: fail preflight before deploy.
- Unauthorized operator: reject API request.
- Unauthorized reply identity: reject API request.
- R2 write failure: do not mark message accepted in D1.
- D1 write failure: enqueue no follow-up work unless recovery is explicit.
- Sender failure: retry through Queue policy and preserve audit evidence.

Fail closed first. Add manual recovery paths after the invariant is clear.
