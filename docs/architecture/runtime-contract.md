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
Dark deployment requires both `MAILDESK_INBOUND_RELAY_MODE=disabled` and
`MAILDESK_REPLY_RELAY_MODE=disabled`. A separately reviewed receipt canary first
enables inbound processing while replies remain disabled; reply processing is
enabled only through a later exact Worker plan after inbox receipt is proven.
The deprecated combined `MAILDESK_RELAY_PROCESSING_MODE` input exists only for
compatibility when neither split switch is supplied and must not be used for a
dark deployment or staged canary.

The reserved reply-domain path runs before ordinary alias lookup. It requires a
live, unexpired relay; matching envelope and visible operator identity; an
aligned cryptographically verified DKIM signature whose signed headers include
`From`; and a fresh Rust `authorize_reply` decision.
The external destination is always loaded from D1, never from reply headers.

### Queue-only outbound Worker

The outbound Worker consumes durable reply jobs. It should:

- have no public HTTP route or `workers.dev` origin;
- load only the exact active policy revision;
- send only after cryptographic operator and Rust policy authorization;
- preserve idempotency and bounded recovery state;
- delete temporary MIME after terminal provider acceptance.

In `inbox_relay`, its Queue consumer parses the temporary operator-reply spool,
constructs a public-identity outbound job, records body-free state, and removes
the spool on terminal provider acceptance. The inbox-relay deploy target is
`deploy/mail-outbound/wrangler.toml`. The generic `wrangler.toml` web-desk
target may retain its legacy shared-token `POST /api/replies` route, disabled
unless `MAILDESK_REPLY_API_MODE=token` is set explicitly. Private inbox-relay
deployments do not expose that surface.

### Leptos UI Worker

The Cargo-Leptos Worker serves routing health. For every protected path it must
validate the Cloudflare Access application
JWT signature, issuer, audience, and expiry against the account JWKS before the
Rust server trusts the email claim. Header presence alone is not
authentication. `MAILDESK_ACCESS_TEAM_DOMAIN` and `MAILDESK_ACCESS_AUD` are
required production inputs; local template preview bypasses Access only when
`MAILDESK_UI_AUTH_MODE=preview` is set explicitly.

The inbox-relay deploy target is `deploy/routing-health/wrangler.toml`, which
binds only D1 and static assets and keeps `workers_dev = false`. `desk_only`
remains a generic template option; private instances select `all_routes` so the
application verifies Access on `/`, `/architecture`, `/desk`, APIs, and static
assets rather than relying only on edge policy.

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
| `DB` | D1 | policy projection, relays, route health, proofs, and body-free audit events |
| `POLICY_STORE` | R2 | immutable digest-addressed private policy revisions |
| `RELAY_SPOOL` | R2 | bounded temporary inbound recovery and operator-reply MIME |
| `MAIL_JOBS` | Queue | durable outbound relay jobs from router to outbound Worker |
| `EMAIL` | Email Service | operator delivery and authenticated public-identity replies |

The template ships placeholder D1 identifiers. Production provisioning must
replace them through `cfctl` before `preflight:production` can pass. Preview
resources belong in explicit preview/dev flows, not in the production deploy
path. Inbox-relay production policy is an immutable
`config/policy/<sha256>.json` object selected by the active D1 policy pointer;
the Worker fails closed when the pointer, revision metadata, object key, bytes,
or expected counts disagree. Inline `MAILDESK_POLICY_JSON` remains only a
legacy non-inbox development input.

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
