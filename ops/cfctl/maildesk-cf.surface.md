# maildesk-cf cfctl Surface

This document describes the `cfctl` extension surface for `maildesk-cf` and
the remaining component surfaces that a production instance may need.

## Commands

```bash
cfctl version --json
cfctl doctor --json
cfctl agents doctor --json
cfctl resolve "read Maildesk current state for config/desired-state.example.json without mutation" --json
cfctl resolve "plan one Maildesk desired-state delta for config/desired-state.example.json without applying it" --json
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

It validates the desired-state file and emits the typed v2 discovery and PlanV2
lifecycle handoff. It does not call live `cfctl`, approve plans, run plans, or
mutate Cloudflare.

## Outputs

- PlanV2 preview artifact;
- operation status and post-change receipt;
- resource inventory snapshot;
- verification report.

## Plan/Verify Invariants

- no execution without an exact PlanV2 operation and separate approval;
- no broad live email tests by default;
- no secret values in receipts;
- explicit drift status per domain and binding;
- deterministic resource names from the de-templated project name unless
  overridden.

## Rule

Use `cfctl resolve`, `catalog show`, and `guide` to select each capability. Live
reads and plans must use explicit profile/account bindings and exact selectors;
never substitute ambient command interpretation.

Sender provider mode must be one of `disabled`, `cloudflare_email_service`, or
`resend`, matching the runtime `MAILDESK_OUTBOUND_MODE` values.

Current component surfaces include Email Routing rules and Cloudflare Email
Service sender domains. The sender-domain planner emits a typed request for
`email-sending-subdomains-create-sending-subdomain`; the private refresher binds
the exact profile, account, and active zone before running:

```bash
printf '%s\n' '{"name":"example.com"}' | \
  cfctl call email-sending-subdomains-create-sending-subdomain \
  --selector zone_id="$MAILDESK_ZONE_ID" \
  --profile "$MAILDESK_CFCTL_PROFILE" \
  --account "$CLOUDFLARE_ACCOUNT_ID" \
  --body-stdin --json
```

That call creates a plan and must report `performed:false`. Cloudflare writes
still require `plans show`, separate approval, `plans run`, `plans status`, and
capability-specific verification. Resend sender-domain verification is provider
readback, not a Cloudflare write.

Bind review continuity to `result.plan_v2.content_hash` plus the nested
operation, capability, profile, account, selector, and body fields. `plans show`
returns the stored PlanV2; it is not required to repeat the creation command's
outer evidence array.
