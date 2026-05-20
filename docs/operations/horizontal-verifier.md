# Horizontal Verifier

The horizontal verifier is the local command surface for proving that the mail
desk is one coherent system instead of a pile of individually green checks.

Run it with the template fixtures:

```bash
bun run verify:maildesk
```

Run it in a private instance with explicit inputs:

```bash
bun run verify:maildesk -- \
  --policy config/policy.local.json \
  --desired-state config/desired-state.local.json \
  --evidence var/maildesk-live-evidence.json \
  --json
```

## Receipt Shape

The command emits one row per domain and reports:

- configured operators;
- configured reply identities;
- local policy versus desired-state agreement;
- Cloudflare zone readback status;
- Email Routing role and personal alias wiring status;
- R2 runtime policy hash agreement;
- Worker binding readiness;
- D1 and Queue readiness;
- inbound proof status;
- outbound sender readiness.

Template mode intentionally reports live Cloudflare checks as `not_checked`.
That is not a failure. It means the public template can prove local coherence
without credentials while private instances can add live evidence gathered by
`cfctl`.

Use `--require-live` when the evidence file is meant to prove production
readiness and any non-`ok` live status should fail the command.

## Evidence Contract

The optional evidence file is JSON. It should be generated from `cfctl`,
Wrangler readbacks, provider readbacks, and targeted probes. A minimal shape is:

```json
{
  "zones": ["example.com"],
  "email_routing": {
    "example.com": {
      "role_aliases": ["founders", "security"],
      "personal_aliases": ["operator-a", "operator-b"]
    }
  },
  "r2_policy_sha256": "<sha256-of-local-policy-json>",
  "readyz": {
    "ok": true,
    "checks": [
      { "name": "db_binding", "ok": true },
      { "name": "raw_mail_binding", "ok": true },
      { "name": "mail_jobs_binding", "ok": true },
      { "name": "policy_config", "ok": true },
      { "name": "db_query", "ok": true }
    ]
  },
  "sender_domains": {
    "example.com": "verified"
  },
  "inbound_proofs": {
    "example.com": { "status": "ok" }
  }
}
```

The verifier does not send mail and does not mutate Cloudflare. Broad live
sends remain outside the default verification path.
