# cfctl Contract

`cfctl` is a required operational dependency for `maildesk-cf`.

The app may ship placeholders and local development config, but production
provisioning must flow through `cfctl` so account state has previews, acks, and
verification receipts.

## Desired Future Surface

The eventual first-class surface could look like:

```bash
cfctl maildesk-cf init --domain example.com
cfctl maildesk-cf diff --domain example.com
cfctl maildesk-cf provision --plan
cfctl maildesk-cf provision --ack-plan <operation-id>
cfctl maildesk-cf verify --domain example.com
cfctl maildesk-cf snapshot
```

The surface should accept a desired-state file generated from the same policy
shape validated by `maildesk-policy-check`. `cfctl` owns account resources; the
application owns runtime behavior.

The template fixture is `config/desired-state.example.json`.

## Resources To Own

- Email Routing rules for configured aliases.
- Email Worker deployment and bindings.
- API/UI Worker deployment and bindings.
- D1 database and migrations.
- R2 bucket for raw MIME and attachments.
- Queue for async mail jobs.
- Cloudflare Email Service sender posture.
- DNS records for SPF, DKIM, DMARC, MTA-STS, and TLS reporting when configured.
- Worker secrets and identity policy config.

## Verification Bar

Verification should avoid broad live sends. Prefer:

- Email Routing rule readback;
- Worker binding readback;
- D1 migration state;
- R2 bucket existence;
- Queue existence;
- DNS record reads;
- provider sender-domain status reads;
- one explicit targeted send only when a human asks for delivery proof.

Verification output should distinguish:

- missing resource;
- wrong binding;
- DNS/authentication drift;
- Email Routing alias drift;
- sender-domain drift;
- policy/config drift;
- optional live-send proof not requested.

## Current State

This repo currently contains the app-side contract and placeholders. A
first-class `cfctl` surface still needs to be added in the control-plane repo.
