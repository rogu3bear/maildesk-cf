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

## Reply invariant

The reply-domain Worker accepts a message only when the relay is active, the
envelope and RFC 5322 sender resolve to the same current operator, Cloudflare's
authentication results contain aligned SPF or DKIM, and Rust authorizes that
operator for the stored route identity. The recipient and public sender come
only from the relay row.

Duplicate operator messages use `(relay, normalized operator Message-ID)` as the
idempotency boundary. Either current operator may make a distinct reply during
the 90-day relay lifetime; v1 has no assignment or conversation lock.

## Content and evidence

Encoded operator deliveries and outbound replies are capped at 5 MiB. MIME is
parsed ephemerally. R2 is a temporary spool with a seven-day lifecycle ceiling,
and terminal provider acceptance deletes the object early. D1 and the dashboard
never store or show subjects, bodies, attachments, or thread history.

Evidence advances independently through `declared`, `local_policy_valid`,
`edge_verified`, `provider_accepted`, `inbox_verified`, and `reply_verified`.
`mail_ready` is a derived claim allowed only after inbox and reply receipts;
deployment and provider acceptance do not imply it.
