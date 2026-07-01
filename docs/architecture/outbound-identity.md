# Outbound Identity

`maildesk-cf` treats reply identity as a product invariant, not as a mail
client preference.

Inbound forwarding can place a message in an operator mailbox, but it cannot
make that mailbox automatically send a reply from the original recipient
domain. The desk needs an outbound sender path that is explicitly authorized
for each domain identity.

## Identity Model

The router policy separates three concepts:

- operator: the human mailbox allowed to work a route;
- route identity: the address that received the message;
- reply identity: the approved `From` address for a response.

For role aliases, the default reply identity should usually be the role address
that received the message, such as `founders@example.com`. The policy can also
allow personal identities such as `operator-a@example.com` when the domain
story should become a one-to-one thread.

For personal aliases, the reply identity should match the personal alias. A
message to `operator-a@example.com` routes to that operator only and should not
become a shared role thread by default.

## Why Mailbox Forwarding Is Not Enough

Forwarding delivers inbound mail to an operator. It does not safely rewrite an
operator's outbound mail after they press reply in a separate mailbox provider.
Doing that without an approved sender path breaks the audit trail and can fail
SPF, DKIM, DMARC, or provider policy checks.

The supported pattern is:

1. inbound Email Worker routes and forwards the message;
2. the desk stores the route decision and default reply identity;
3. the operator replies from the desk or an approved integration surface;
4. the API Worker authorizes the operator and identity through the router;
5. an outbound job sends through an authenticated sender adapter;
6. the audit log records the provider result.

The API route for this is `POST /api/replies`. It accepts only authenticated
requests using `Authorization: Bearer <MAILDESK_API_TOKEN>` or
`x-maildesk-token: <MAILDESK_API_TOKEN>`, then re-loads policy before queueing
the outbound job.

## Sender Adapter Order

The default sender strategy is Cloudflare-first:

1. Cloudflare Email Service, when the account supports the needed outbound
   sender behavior.
2. A policy-gated provider adapter, such as Resend, only for domains whose
   sender authentication is verified.
3. No send. The API must reject or hold the reply if no authorized sender path
   exists for the requested identity.

Do not silently fall back to a personal mailbox. A fallback that changes the
visible sender domain is a product failure, even if the message technically
sends.

Runtime sender mode is selected with `MAILDESK_OUTBOUND_MODE`:

- `disabled`: authorize and audit the request, but do not send. This is the
  public-template default and does not require sender-domain provider readback.
- `cloudflare_email_service`: send through a Worker `send_email` binding named
  `EMAIL`; sender-domain readiness comes from Cloudflare Email Service readback
  through `cfctl`.
- `resend`: send through Resend using the `RESEND_API_KEY` Worker secret;
  sender-domain readiness comes from Resend provider readback.

Enabled modes also require `MAILDESK_VERIFIED_SENDER_DOMAINS`, a
comma-separated allowlist produced from provider readback. The router may allow
an identity, but the sender adapter must still refuse domains that are not
verified by the configured provider.

`config/desired-state*.json` uses the same literal mode values as runtime:
`disabled`, `cloudflare_email_service`, or `resend`. Production preflight must
fail when desired state and `MAILDESK_OUTBOUND_MODE` disagree.

## Authorization Bar

Before queueing an outbound reply, the API must know:

- the thread route decision;
- the authenticated operator;
- the requested reply identity, if any;
- the domain's configured sender mode;
- whether that sender identity is verified for outbound use.

The router decides whether the operator may use the identity. The sender adapter
decides whether the provider can send it. Both checks are required.

## Audit Events

Every outbound reply should emit auditable state transitions:

- `outbound_reply_requested`;
- `outbound_reply_authorized`;
- `outbound_reply_send_attempted`;
- `outbound_reply_delivered` or `outbound_reply_failed`.

Provider message IDs are evidence. Raw provider credentials are never evidence
and must not be logged.
