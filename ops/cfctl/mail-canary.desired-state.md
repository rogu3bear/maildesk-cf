# Optional mail canary control-plane contract

The application owns the source and closed `mail-canary` Worker artifact.
cfctl owns the account, deployment, D1 migration, R2/Email binding and scheduled
trigger truth. This note does not create or execute operations.

Resolve a bounded intent to deploy a queue-free, HTTP-free scheduled Worker
using `wrangler.mail-canary.toml` (with a private production overlay). Inspect
the selected catalog capability and guide; pin the profile, account, artifact
set digest, existing relay D1 database and immutable policy bucket, verified
public role sender, recipient, processing declarations and hourly cron.

Required effects and readback:

- Apply the new canary-state table through the instance's governed migration
  operation; read back its schema and singleton row.
- Deploy the closed Worker artifact disabled with D1, POLICY_STORE and EMAIL;
  read back the active deployment/version identity and exact bindings.
- Configure `0 * * * *` through the governed trigger capability; read back the
  exact trigger set. Preserve unrelated schedules and resources.
- Enable only this canary with the explicit notification target; read back the
  same deployment's vars and trigger before claiming it is running.
- Read the body-free canary audit receipt and independently verify recipient
  inbox delivery. Provider acceptance and receipt are separate.

Every write retains its own hash-bound call/show/approval/run/status/readback
lifecycle. A catalog gap requires a source-owner cfctl extension or its exact
governed next action; it never authorizes raw HTTP or direct Wrangler mutation.
Rollback disables this canary's mode and removes only its named cron through
new reviewed operations. Preserve the audit and notification-attempt state.
