# Positioning and product boundary

Maildesk is an identity-preserving Cloudflare inbox relay for operators who
already read and compose in an existing inbox. Mail enters through a declared
route, Rust selects its operators and public reply identity, and an ordinary
operator reply is authenticated and relayed under that identity. The web
surface reports routing health and distinct proof states.

## Alternatives and specific value

Ordinary alias forwarding may already be sufficient. Maildesk is appropriate
when explicit role/personal identity policy, account-owned infrastructure and
body-free delivery/recovery evidence justify operating a relay. A generic
helpdesk offers its own inbox and workflow; this template deliberately keeps
the existing operator inbox. This is a product hypothesis, not validated demand.

Rust routing is locally testable. cfctl owns account mutations and their
receipts. Stable D1 claims distinguish unsent work from ambiguous sends; R2
retains bounded recovery content. None of these alone establishes inbox receipt.

## Supported and compatibility modes

`inbox_relay` is the supported starting point for new instances. Its dashboard
has no composer, message bodies, attachments or thread history. Outbound
attachments are rejected by the current policy; an adopter must assess that
limit before deployment. Inbound attachments are forwarded to the operator.

`web_desk` and its explicit token API remain compatibility surfaces. They are
not advertised as the primary relay journey and are not silently enabled.

## Message and evidence

Route domain mail into the inbox you use. Reply under the right public identity.
Know whether work was queued, accepted, received, or needs recovery.

Use “Open routing health” for the relay dashboard. Use “provider accepted” only
for provider evidence; reserve mail-ready for the required inbox and reply
receipts. An ambiguous result should point to the recovery runbook, not promise
that retrying is safe.

No customer result, testimonial, time-saving figure, market advantage, or
conversion claim is established by this repository. The next product test is a
fresh operator completing the public setup and recovery walkthrough.
