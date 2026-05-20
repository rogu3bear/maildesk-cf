# Deliverability

Mail delivery should be verified mostly through configuration reads, not broad
test blasts.

`maildesk-cf` is for operational mail such as shared role aliases and
domain-consistent replies. It should not behave like a marketing sender, and it
should not train reputation systems with noisy smoke tests.

## Required Domain Posture

For every domain that receives or sends mail, verify:

- MX records point at the intended inbound provider;
- SPF authorizes the intended outbound provider set;
- DKIM is enabled for every outbound provider;
- DMARC exists and is at least monitorable with reporting enabled;
- role aliases are routed intentionally;
- sender identities are verified before the API allows outbound replies.

Recommended baseline records:

```text
example.com. TXT "v=spf1 include:_spf.example-sender.invalid -all"
_dmarc.example.com. TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
```

Those strings are examples only. Real provider includes and DKIM records must
come from the provider readback or `cfctl` DNS desired state.

## First-Class Role Aliases

Each managed domain should decide whether these aliases exist:

- `abuse`;
- `dmarc`;
- `founders`;
- `info`;
- `legal`;
- `noreply`;
- `postmaster`;
- `security`.

`postmaster` and `abuse` are operationally important because providers,
registrars, and automated security systems expect them to work. If a domain is
receive-only, those aliases still need an inbound route and an operator owner.

## Verification Strategy

Prefer deterministic reads:

- `cfctl` Email Routing readback;
- `cfctl` DNS record readback;
- Worker binding readback;
- provider sender-domain status;
- D1 migration status;
- R2 bucket existence;
- Queue existence;
- policy validation through `maildesk-policy-check`.

Use live sends sparingly. A good smoke test is one targeted message to one
shared role alias on one domain, followed by provider status, audit-log, and
operator receipt checks.

## Bounce Prevention

Prevent avoidable bounces before deploy:

- reject empty operator routes in policy validation;
- fail production preflight when Cloudflare resource IDs are placeholders;
- fail production preflight when no Cloudflare auth lane is available;
- fail sends when the requested identity has no verified sender adapter;
- keep forwarding and raw-mail persistence ordered so the Email Worker does not
  consume the raw MIME stream before forwarding;
- record per-recipient forward failures without rejecting the original sender
  when the route itself is known and accepted;
- keep unknown aliases explicit instead of silently dropping mail.

## What Not To Do

Do not:

- send one probe per alias as a normal release gate;
- fake sender domains through a personal mailbox;
- rely on forwarding alone for domain-consistent replies;
- log full raw MIME into console output;
- mark a domain mail-ready when only DNS or only Worker deploy succeeded.
