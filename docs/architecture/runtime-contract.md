# Runtime Contract

This document defines the first complete runtime shape for `maildesk-cf`.
Everything here should remain template-safe: use reserved domains, no account
IDs, no operator names, no live receipts, and no secret values.

## Components

### Email Worker

The Email Worker receives Cloudflare Email Routing events. In `inbox_relay` it should:

- normalize the envelope recipient into an `InboundMessage`;
- call the Rust router contract through the compiled adapter path;
- parse MIME ephemerally, prepend equivalent text and HTML routing banners, and
  submit one new Email Service message per policy-selected operator;
- set `Reply-To` to `r+<opaque-token>@<reply-domain>` and persist only the
  SHA-256 token hash;
- retain raw MIME in R2 only for bounded relay or recovery work;
- persist the route decision and initial message metadata in D1;
- enqueue parsing, indexing, notification, and delivery jobs;
- reject unknown domains and aliases without silently forwarding mail.

It should not own policy. If policy logic appears in TypeScript, move it back
into `crates/maildesk-router`.

The template deploy target for this Worker is `deploy/mail-router/wrangler.toml`.
`MAILDESK_RELAY_PROCESSING_MODE` defaults to `disabled`; while disabled, the
Worker fails closed before routing, D1/R2 writes, Queue work, operator delivery,
or opaque-token reply processing. A dark candidate remains unattached to live
Email Routing rules, and a separately reviewed canary changes this mode to
`enabled` only when the intended route is attached.

The reserved reply-domain path runs before ordinary alias lookup. It requires a
live, unexpired relay; matching envelope and visible operator identity; aligned
Cloudflare SPF or DKIM results; and a fresh Rust `authorize_reply` decision.
The external destination is always loaded from D1, never from reply headers.

### API Worker

The API Worker powers the operator desk. It should:

- enforce authentication before thread, message, or reply access;
- read body-free route-health and audit data from D1;
- create outbound reply intents only after router authorization;
- enqueue outbound send jobs instead of sending inline;
- expose health and readiness endpoints that do not leak private config.

In `inbox_relay`, its Queue consumer parses the temporary operator-reply spool,
constructs a public-identity outbound job, records body-free state, and removes
the spool on terminal provider acceptance. The template deploy target for this
Worker is `wrangler.toml`.
Its legacy shared-token `POST /api/replies` route is disabled unless
`MAILDESK_REPLY_API_MODE=token` is set explicitly. Human replies should use the
Access-authenticated Leptos server-function path. Token mode is appropriate
only behind a service boundary that binds the credential to one integration;
the token itself is not an operator identity.

### Leptos UI Worker

The Cargo-Leptos Worker serves public explanatory routes and the operator desk.
For `/desk*` in production it must validate the Cloudflare Access application
JWT signature, issuer, audience, and expiry against the account JWKS before the
Rust server trusts the email claim. Header presence alone is not
authentication. `MAILDESK_ACCESS_TEAM_DOMAIN` and `MAILDESK_ACCESS_AUD` are
required production inputs; local template preview bypasses Access only when
`MAILDESK_UI_AUTH_MODE=preview` is set explicitly.

The template deploy target for this Worker is `deploy/ui/wrangler.toml`, which keeps
`workers_dev = false` so an alternate public origin cannot bypass the Access
application on the production hostname.

### Rust Router

The router is the authority for route decisions and reply authorization. Its
public output must be serializable, auditable, and stable enough for Workers,
the UI, and `cfctl` verification to consume.

The TypeScript Workers load the router as an in-process WebAssembly module.
`workers/shared/router.ts` owns transport translation only; alias lookup,
recipient selection, reply defaults, and authorization remain Rust decisions.
Generated WASM is rebuilt before each Worker bundle and is not committed.

### Storage

D1 stores queryable route, relay, idempotency, health, and body-free audit state.
R2 stores temporary relay/recovery MIME only in `inbox_relay`; successful
processing deletes it early and lifecycle policy provides a seven-day ceiling.
Queues own async delivery and redelivery; provider retry policy must remain explicit.

## Required Bindings

| Binding | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 | domains, identities, routes, threads, messages, audit events |
| `RAW_MAIL` | R2 | raw MIME bodies and attachment blobs |
| `MAIL_JOBS` | Queue | parsing, notification, indexing, and outbound attempt delivery |
| `EMAIL` | Email Service | operator delivery and authenticated public-identity replies |
| policy config | secret or versioned config | deployable router policy |

The template ships placeholder `wrangler.toml` values. Production provisioning
must replace them through `cfctl` before `preflight:production` can pass.
Private instances should provision both production and preview D1/R2 resources
so Wrangler preview and targeted checks do not reuse production mail storage.
Top-level Worker configs should bind production resources only; preview resources
belong in explicit preview/dev flows, not in the production deploy path.
Runtime policy may be supplied inline through `MAILDESK_POLICY_JSON` for small
fixtures, but production instances should store policy JSON in R2 at
`MAILDESK_POLICY_R2_KEY` so larger multi-domain policies do not hit Worker text
binding limits.

## Mail Flow

1. Cloudflare Email Routing receives `role@example.com`.
2. Email Worker converts the event into router input.
3. Rust router returns a `RouteDecision`.
4. Email Worker stores relay metadata and sends a bannered copy to each operator.
5. Operator replies to the opaque relay address from the existing inbox.
6. Email Worker validates token, identity, authentication, and Rust authorization.
7. The reply MIME enters a temporary R2 spool and a durable Queue job.
8. API Worker derives the external destination and public identity only from D1.
9. Outbound job sends through the configured sender mode.
10. Terminal success deletes the spool; D1 retains body-free audit and proof state.

## Failure Policy

- Unknown domain: reject and audit if possible.
- Unknown alias: reject and audit if possible.
- Empty operator set: fail preflight before deploy.
- Unauthorized operator: reject API request.
- Unauthorized reply identity: reject API request.
- One accepted operator delivery and one definitive failure: accept inbound and
  record `partial_delivery`.
- All definitive failures: reject inbound. Ambiguous outcomes: accept, preserve
  a recovery spool, and record `recovery_required` without automatic replay.
- Malformed or encoded messages over 5 MiB: reject clearly; never use direct
  forwarding as a fallback for relay routes.
- Raw MIME storage must provide R2 a known-length body, such as an
  `ArrayBuffer`, rather than passing the Email Worker raw stream through
  directly.
- D1 write failure: enqueue no follow-up work unless recovery is explicit.
- Sender failure: retry transient Resend failures with bounded Queue backoff and
  the stable message ID idempotency key. Preserve a terminal failed audit result
  after exhaustion or a non-retryable response.
- Ambiguous Cloudflare Email Service failure: preserve a recovery-required
  terminal audit result and do not replay the provider side effect.
- Queue redelivery: acquire the stable audit claim before any external send;
  a repeated completed claim must not repeat the provider side effect. A Resend
  claim without a result may resume through the stable idempotency key; any
  other incomplete claim becomes an explicit recovery-required condition. The
  claimed provider mode is durable audit state; configuration drift must never
  move an incomplete claim across providers.
- Audit detail: store message and provider identifiers, statuses, counts, and
  bounded error metadata; do not copy message bodies, BCC, custom headers, raw
  provider responses, or credentials into D1 audit JSON.

Fail closed first. Add manual recovery paths after the invariant is clear.
