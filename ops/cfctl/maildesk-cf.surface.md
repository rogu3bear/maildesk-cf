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

## Outputs

- preview artifact;
- applied operation receipt;
- resource inventory snapshot;
- verification report.

## Rule

Until this surface exists, agents must use existing `cfctl` primitive surfaces
for DNS records, Worker scripts, Worker routes, D1, R2, Queues, secrets, and
Email Routing rather than bypassing `cfctl`.
