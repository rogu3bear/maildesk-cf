# Inbox Reply Relay

`inbox_relay` is Maildesk's routing-only operator-delivery mode. It uses an
existing operator inbox as the reading and composition surface without exposing
that inbox identity to the external correspondent.

## Inbound invariant

The Rust router selects all operator destinations and the public reply identity.
The Email Worker generates a 256-bit lowercase token, stores only its SHA-256
hash, and sends a separately addressed message to each operator. Text and HTML
alternatives carry the same route banner. The opaque address is the only place
the raw token exists.

Cloudflare direct forwarding is deliberately unavailable for relay-enabled
routes: its custom-header surface cannot safely replace `Reply-To` or prepend
the operator banner.

Before any operator send, the Worker claims a stable SHA-256 fingerprint over
the normalized envelope and exact raw MIME, plus one hashed recipient row for
each policy-selected operator. Each operator delivery uses a deterministic
Message-ID. Before D1 activation, R2 receives one bounded, immutable delivery
payload per hashed recipient. A repeated provider invocation may use that exact
payload only after D1 atomically advances the same-policy recipient from
`pending` to `sending`; it never repeats a recipient already claimed as
`sending`, `provider_accepted`, or `recovery_required`. Because Cloudflare Email
Service provides no idempotency key, an interrupted `sending` transition is
explicitly `recovery_required` and requires provider reconciliation or manual
recovery. Possessing a token or an R2 object never bypasses the D1 claim.

An inbound-result Queue job is projection assistance, not provider authority.
Before it can advance route health or delete recovery data, the consumer
requires its delivery, relay, thread, route, policy, raw-spool key, complete
recipient set, per-recipient payload keys, durable states, provider IDs, and
bounded errors to match the D1 claim exactly. Cleanup keys are then derived from
D1 and are deleted only after the durable delivery projection succeeds. The
raw-spool pointer remains durable cleanup authority until every idempotent R2
deletion succeeds. A body-free digest receipt is recorded before that pointer
is cleared, so Queue redelivery can either complete cleanup after a transient
storage failure or recognize an exact terminal replay without repeating a
provider send.

An all-`pending` claim may be retired automatically only when its policy
revision is no longer active and D1 atomically proves that no recipient crossed
the provider-send boundary. Each attempt has a token-hash-qualified R2 key, so
delayed cleanup of the retired attempt cannot delete a replacement spool. The
replacement route is then evaluated under the current policy. A same-policy
`pending` recipient is provably unsent and may resume from its exact recovery
payload under the active-policy, enabled-route, recipient-state, and spool-key
guards. Every `sending` or terminal recipient remains preserved for explicit
reconciliation rather than being reset speculatively.

## Reply invariant

The reply-domain Worker accepts a message only when the relay is active, the
envelope and RFC 5322 sender resolve to the same current operator, the raw reply
has a cryptographically verified and aligned DKIM signature that signs `From`,
and Rust authorizes that operator for the stored route identity. Sender-supplied
authentication-result headers never authorize a reply. The recipient and public
sender come only from the relay row.

The Worker hashes the exact DKIM-authenticated RFC 822 bytes and atomically
stores that digest with the relay-attempt spool key. The Queue job carries the
same key and digest. Before parsing or outbound delivery, the consumer hashes
the fetched R2 bytes, requires the Queue pair to match the D1 claim, and fails
closed on any key, digest, or generation mismatch; authenticated content
therefore cannot be substituted after the
authorization boundary.

Duplicate operator messages use `(relay, normalized operator Message-ID)` as the
idempotency boundary. Either current operator may make a distinct reply during
the 90-day relay lifetime; v1 has no assignment or conversation lock.

## Content and evidence

Encoded operator deliveries and outbound replies are capped at 5 MiB. MIME is
parsed ephemerally. R2 temporarily holds the original inbound MIME plus one
generated operator-delivery recovery payload per pending recipient, all under
the same seven-day lifecycle ceiling. Recipient provider acceptance deletes its
payload early; terminal aggregate processing deletes the original MIME. D1 and
the dashboard never store or show subjects, bodies, attachments, or thread
history.

Inbound attachments are preserved in the separately addressed operator
delivery. Operator-authored outbound attachments fail closed in this milestone:
opaque binary formats cannot be proven free of private operator identities by a
byte scan. A later format-aware attachment policy may enable explicitly
supported formats without weakening the privacy boundary.

Evidence advances independently through `declared`, `local_policy_valid`,
`edge_verified`, `provider_accepted`, `inbox_verified`, and `reply_verified`.
`mail_ready` is a derived claim allowed only after inbox and reply receipts;
deployment and provider acceptance do not imply it.

Operator procedure: [recovery.md](../operations/recovery.md) maps these durable
states to allowed actions and retention deadlines. Local acceptance is defined
in [acceptance-criteria.md](../acceptance-criteria.md).
