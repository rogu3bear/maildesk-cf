# maildesk-cf cfctl Surface

This document describes the `cfctl` extension surface for `maildesk-cf` and
the remaining component surfaces that a production instance may need.

## Commands

```bash
cfctl maildesk-cf init --domain example.com
cfctl maildesk-cf verify --file config/desired-state.example.json
cfctl maildesk-cf diff --file config/desired-state.example.json
cfctl maildesk-cf provision --file config/desired-state.example.json --plan
cfctl maildesk-cf provision --file config/desired-state.example.json --ack-plan <operation-id>
```

## Inputs

- domain allowlist;
- alias policy;
- operator policy;
- outbound identity policy;
- D1 database name;
- immutable-policy and temporary-spool R2 bucket names;
- outbound and dead-letter Queue names;
- relay-router, relay-outbound, and routing-health Worker script names;
- sender provider mode.

## Desired State Shape

The first version should be able to consume a file with these sections:

```text
project:
  name
  account_id_env
domains:
  name
  role_aliases
  personal_aliases
workers:
  relay_router:
    script_name
    config
  relay_outbound:
    script_name
    config
  routing_health:
    script_name
    config
storage:
  d1_database
  d1_preview_database
  r2_policy_bucket
  r2_spool_bucket
  queue
  dead_letter_queue
operator_delivery:
  mode
  inbound_processing_mode
  reply_processing_mode
  reply_domain
  reply_token_ttl_days
  spool_retention_days
  max_encoded_message_bytes
  banner_mode
sender:
  mode
  candidate_domains
```

These role names are the canonical serialization. Provisioning, plan
compilation, evidence collection, and verification must consume this same
shape; a legacy Worker or raw-mail storage vocabulary is not accepted as an
independent authority.

`config/desired-state.example.json` is the current template fixture for this
shape.
`ops/cfctl/maildesk-cf.desired-state.schema.json` is the public schema contract
for the fixture. Keep it small and template-safe: real account IDs, private
domains, secrets, preview receipts, and applied operation ids belong in ignored
local files or `cfctl` state, not tracked source.

The repo-local proof hook is:

```bash
bun run check:cfctl-provisioning
```

It validates the desired-state file and prints the lifecycle handoff. It does
not call live `cfctl`, acknowledge previews, or mutate Cloudflare.

## Outputs

- preview artifact;
- applied operation receipt;
- resource inventory snapshot;
- verification report.

## Plan/Verify Invariants

- no apply without a plan and acknowledged operation id;
- no broad live email tests by default;
- no secret values in receipts;
- explicit drift status per domain and binding;
- deterministic resource names from the de-templated project name unless
  overridden.

## Rule

Use `cfctl maildesk-cf` for lifecycle readback and planning. When the plan
emits component operations, use the named primitive `cfctl` surface for the
actual preview/ack flow rather than bypassing `cfctl`.

Sender provider mode must be one of `disabled`, `cloudflare_email_service`, or
`resend`, matching the runtime `MAILDESK_OUTBOUND_MODE` values.

Current component surfaces include Email Routing rules and Cloudflare Email
Service sender domains. Cloudflare sender-domain authentication is previewed
through:

```bash
cfctl apply sender_domain enable --zone example.com --name example.com --plan
```

Cloudflare writes still require a reviewed preview receipt and explicit
`--ack-plan <operation-id>`. Resend sender-domain verification is provider
readback, not a `cfctl sender_domain` write.
