# cfctl Contract

`cfctl` is a required operational dependency for `maildesk-cf`.

The app may ship placeholders and local development config, but production
provisioning must flow through `cfctl` so account state has previews, acks, and
verification receipts.

## Current Surface

The first-class lifecycle surface in `cfctl` is file-driven:

```bash
cfctl maildesk-cf init --domain example.com
cfctl maildesk-cf verify --file config/desired-state.example.json
cfctl maildesk-cf diff --file config/desired-state.example.json
cfctl maildesk-cf provision --file config/desired-state.example.json --plan
cfctl maildesk-cf provision --file config/desired-state.example.json --ack-plan <operation-id>
```

The surface consumes a desired-state file generated from the same policy shape
validated by `maildesk-policy-check`. `cfctl` owns account resources; the
application owns runtime behavior.

The template fixture is `config/desired-state.example.json`.

## Resources To Own

- Email Routing rules for configured aliases.
- Email Worker deployment and bindings.
- API/UI Worker deployment and bindings.
- D1 database and migrations.
- D1 preview database for non-production checks.
- R2 bucket for raw MIME and attachments.
- R2 preview bucket for non-production checks.
- Queue for async mail jobs.
- Cloudflare Email Service sender posture.
- DNS records for SPF, DKIM, DMARC, MTA-STS, and TLS reporting when configured.

The desired-state fixture may include preview storage resources, but production
`wrangler.toml` files must bind only production storage. `cfctl` verification
should catch accidental preview bindings before deploy.
- Worker secrets and identity policy config.
- Sender-domain authentication and outbound identity verification status.

## Verification Bar

Verification should avoid broad live sends. Prefer:

- Email Routing rule readback;
- Worker binding readback;
- D1 migration state;
- R2 bucket existence;
- Queue existence;
- DNS record reads;
- provider sender-domain status reads;
- outbound identity readback for every configured reply identity;
- one explicit targeted send only when a human asks for delivery proof.

The app-side command `bun run verify:maildesk` consumes the same desired-state
and policy shape and can consume a live evidence file. Treat it as the local
receipt format that complements `cfctl maildesk-cf verify` live readback.

Verification output should distinguish:

- missing resource;
- wrong binding;
- DNS/authentication drift;
- Email Routing alias drift;
- sender-domain drift;
- policy/config drift;
- optional live-send proof not requested.

## Current State

This repo contains the app-side contract and placeholders. The control-plane
repo now exposes a first-class `maildesk-cf` lifecycle surface, and component
plans may point at primitive `cfctl` surfaces such as `email.routing_rule` and
`sender_domain` for preview-gated writes. Do not run `--ack-plan` until the
operator has reviewed the preview receipt and explicitly chosen to mutate
Cloudflare.
