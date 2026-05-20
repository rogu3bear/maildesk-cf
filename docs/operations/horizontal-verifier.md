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

Collect a best-effort live evidence file from local readback tools:

```bash
CFCTL_BIN=/path/to/cfctl \
MAILDESK_READYZ_URL=https://maildesk.example.workers.dev/readyz \
bun run collect:maildesk-evidence -- --out var/maildesk-live-evidence.json
```

The collector reads Cloudflare state through `cfctl`, sender domains through the
Resend CLI when available, `/readyz` when `MAILDESK_READYZ_URL` is set, and D1
schema/audit counts through Wrangler when a D1 database is configured. It does
not send mail and does not mutate Cloudflare.

Plan the remaining proof work from a receipt:

```bash
bun run verify:maildesk -- --evidence var/maildesk-live-evidence.json --json \
  > var/maildesk-receipt.json
bun run plan:maildesk-proofs -- --receipt var/maildesk-receipt.json --json
```

The proof planner does not send mail. It converts mail-readiness gaps into a
minimal set of targeted inbound probes, outbound reply probes, and blocked
provider repairs.

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
- outbound reply audit proof status.

JSON output also includes `gaps`: one machine-readable entry for every non-`ok`
field, classified as `local`, `edge`, or `mail` readiness work.

Template mode intentionally reports live Cloudflare checks as `not_checked`.
That is not a failure. It means the public template can prove local coherence
without credentials while private instances can add live evidence gathered by
`cfctl`.

When live `zones` evidence is present, every Cloudflare-held zone is included in
the receipt. A held zone missing from local policy or desired state is reported
as drift instead of being silently ignored.

Use `--require-live` when the evidence file is meant to prove production
readiness and any non-`ok` live status should fail the command.

`edge_ready` covers Cloudflare-held zones, Email Routing aliases, R2 policy,
Worker bindings, and D1/Queue reachability. `mail_ready` is stricter: it also
requires inbound proof, outbound sender readiness, and outbound reply audit
proof.

Email Routing evidence may include more rules than the policy requires. The
verifier checks that every expected alias is present and tolerates extra
Cloudflare rules so adjacent account routing does not create false drift.

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
  "d1": {
    "tables": ["audit_events", "messages", "threads", "alias_routes", "identities", "operators"],
    "audit_event_counts": {
      "inbound_email_received": 1,
      "outbound_reply_delivered": 1
    }
  },
  "sender_domains": {
    "example.com": "verified"
  },
  "inbound_proofs": {
    "example.com": {
      "status": "ok",
      "envelope_to": "founders@example.com",
      "route_kind": "role_alias",
      "forwarded_to": ["operator-a@example.com", "operator-b@example.com"],
      "forward_errors": [],
      "default_reply_identity": "founders@example.com",
      "raw_r2_key": "raw/2026-05-20/example.eml",
      "audit_event_at": "2026-05-20T00:00:00Z"
    }
  },
  "outbound_proofs": {
    "example.com": {
      "status": "delivered",
      "from_identity": "founders@example.com",
      "provider": "resend",
      "provider_message_id": "provider-message-id",
      "audit_event_at": "2026-05-20T00:00:00Z"
    }
  }
}
```

Inbound proof is policy-checked. A bare `status: ok` is not enough: the proof
must identify the routed mailbox, forwarded operators, reply identity, stored
raw mail key, and absence of forward errors.

D1 proof is stricter when present. `/readyz` proves the binding can query; the
optional `d1.tables` readback proves the audit schema actually exists. When
`d1` evidence is supplied, the verifier requires the core audit/routing tables.

Outbound proof is separate from sender-domain readiness. `sender_domains` proves
the provider can send for the domain; `outbound_proofs` proves an actual
authorized reply path produced audit evidence.

The verifier does not send mail and does not mutate Cloudflare. Broad live sends
remain outside the default verification path.
