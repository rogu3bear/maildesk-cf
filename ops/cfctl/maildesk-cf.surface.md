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
  d1_preview_database
  r2_raw_mail_bucket
  r2_raw_mail_preview_bucket
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

Use `cfctl maildesk-cf` for lifecycle readback and planning. When the plan
emits component operations, use the named primitive `cfctl` surface for the
actual preview/ack flow rather than bypassing `cfctl`.

Current component surfaces include Email Routing rules and Email Sending sender
domains. Sender-domain authentication is previewed through:

```bash
cfctl apply sender_domain enable --zone example.com --name example.com --plan
```

Cloudflare writes still require a reviewed preview receipt and explicit
`--ack-plan <operation-id>`.
