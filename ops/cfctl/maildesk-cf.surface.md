# maildesk-cf cfctl Surface Draft

This draft describes the desired `cfctl` extension surface for `maildesk-cf`.

## Commands

```bash
cfctl maildesk-cf init --domain example.com
cfctl maildesk-cf diff --domain example.com
cfctl maildesk-cf provision --plan
cfctl maildesk-cf provision --ack-plan <operation-id>
cfctl maildesk-cf verify --domain example.com
cfctl maildesk-cf snapshot
```

## Inputs

- domain allowlist;
- alias policy;
- operator policy;
- outbound identity policy;
- D1 database name;
- R2 bucket name;
- Queue name;
- Worker script names;
- sender provider mode.

## Desired State Shape

The first version should be able to consume a file with these sections:

```text
project:
  name
  account_id
domains:
  name
  role_aliases
  personal_aliases
workers:
  mail_router_script
  mail_api_script
storage:
  d1_database
  r2_raw_mail_bucket
  queue
sender:
  mode
  authenticated_domains
```

The exact serialization can evolve, but plan/apply/verify should preserve these
boundaries.

`config/desired-state.example.json` is the current template fixture for this
shape.

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

Until this surface exists, agents must use existing `cfctl` primitive surfaces
for DNS records, Worker scripts, Worker routes, D1, R2, Queues, secrets, and
Email Routing rather than bypassing `cfctl`.
