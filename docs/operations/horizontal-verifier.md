# Horizontal Verifier

The horizontal verifier is the local command surface for proving that the mail
desk is one coherent system instead of a pile of individually green checks.

Run the full non-mutating receipt workflow:

```bash
bun run receipt:maildesk
```

That command collects live evidence when credentials and readback tools are
available, writes `var/maildesk-live-evidence.json`, writes
`var/maildesk-receipt.json`, writes `var/maildesk-proof-plan.json`, and prints a
short readiness summary. Add `--summary var/maildesk-receipt-summary.json` when
that compact handoff should be persisted beside the full artifacts.

When a reviewed sender-domain preview manifest exists, include it in the same
receipt run:

```bash
bun run receipt:maildesk -- \
  --ack-manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --require-ack-ready \
  --summary var/proof/maildesk-receipt-require-ack-ready-summary.local.json
```

That remains a no-mutation workflow. It fails the receipt only when
sender-domain blockers are missing exact ack commands.

Run the closeout gate when the next question is whether the instance can be
called done:

```bash
bun run check:maildesk-closeout -- \
  --summary var/proof/maildesk-receipt-require-ack-ready-summary.local.json \
  --ack-manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --refresh-acks \
  --purge-duplicate-previews \
  --redact-sensitive \
  --json
```

That command is non-mutating. It runs production preflight, reads the compact
receipt summary, optionally refreshes the sender-domain ack manifest in
`cfctl --plan` mode, dry-runs the reviewed sender-domain ack manifest, and
exits non-zero until `instance-ready`, `edge-ready`, and `mail-ready` are all
proven. Protected applies and live mail probes are reported as blockers; they
are not executed by the closeout gate.

Use `--purge-duplicate-previews` when `--refresh-acks` has been run repeatedly.
The cleanup is local `cfctl` preview-ledger hygiene: it removes duplicate active
preview records after fresh previews are captured, without applying
sender-domain changes.

Use `--redact-sensitive` for JSON that may be copied into an issue, PR, or
status report. The redacted form preserves readiness, aggregate dry-run counts,
and blocker kinds, but omits per-domain sender-domain ack details and
`cfctl --ack-plan` commands.

To refresh that manifest from the current proof plan without applying anything:

```bash
bun run refresh:maildesk-acks -- \
  --plan var/maildesk-proof-plan.json \
  --out var/proof/maildesk-sender-domain-ack-manifest.local.json
```

The refresher executes only the `cfctl apply sender_domain enable ... --plan`
commands already present in the proof plan, stores the preview receipts, and
constructs protected `--ack-plan` commands for review.

Dry-run the reviewed sender-domain apply handoff before any protected apply:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --json
```

Applying sender-domain ack commands is a protected action. It requires both
`--execute` and `--confirm-ack-plan`, and it defaults to one apply at a time
unless `--all` or a larger `--limit` is passed:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --execute \
  --confirm-ack-plan \
  --limit 1
```

For template-only or offline receipt checks, skip live collection:

```bash
bun run receipt:maildesk -- --skip-collect
```

Run the verifier only with the template fixtures:

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

Dry-run the first targeted inbound probe from a plan:

```bash
bun run send:maildesk-probes -- --from proof@example.com --json
```

Send only when the sender identity is verified and the target set is intentional:

```bash
bun run send:maildesk-probes -- --execute --from proof@example.com --domain example.com
```

The probe executor defaults to dry-run and a limit of one target. Use
`--limit <n>` or `--all` only for a deliberate proof pass.

Dry-run an outbound reply proof from a plan:

```bash
bun run send:maildesk-probes -- --kind outbound --to proof@example.com --domain example.com --json
```

Executing outbound proof requires the deployed reply API URL and token:

```bash
bun run send:maildesk-probes -- \
  --kind outbound \
  --execute \
  --api-url https://maildesk.example.workers.dev \
  --api-token "$MAILDESK_API_TOKEN" \
  --to proof@example.com \
  --domain example.com
```

For proof-only runs and production closeout preflight, prefer a deployed
`MAILDESK_PROOF_API_TOKEN` over rotating the primary `MAILDESK_API_TOKEN`.

## Receipt Shape

The command emits one row per domain and reports:

- configured operators;
- configured reply identities;
- route-level recipient, reply identity, allowed reply identity, and wiring
  details;
- sender-domain provider status;
- root-domain MX records and classified inbound MX provider;
- inbound and outbound audit evidence references;
- local policy versus desired-state agreement;
- Cloudflare zone readback status;
- Email Routing role and personal alias wiring status;
- root-domain MX readiness for Cloudflare Email Routing;
- R2 runtime policy hash agreement;
- Worker binding readiness;
- D1 and Queue readiness;
- inbound proof status;
- outbound sender readiness.
- outbound reply audit proof status.

JSON output also includes `gaps`: one machine-readable entry for every non-`ok`
field, classified as `local`, `edge`, or `mail` readiness work. Gaps include a
short `detail` string when live evidence can explain the blocker, such as a
Google Workspace root MX set blocking a Cloudflare Email Routing proof or a
sender provider still reporting a domain as pending.

Template mode intentionally reports live Cloudflare checks as `not_checked`.
That is not a failure. It means the public template can prove local coherence
without credentials while private instances can add live evidence gathered by
`cfctl`.

Domains default to Cloudflare Email Routing at the root MX. If a private
instance intentionally keeps a primary mailbox domain on another provider, set
`inbound_mx_provider` on that domain in desired state, for example
`google_workspace`. The verifier then treats the external MX set as intentional
edge state. When `--google-admin` or `GOOGLE_ADMIN_BIN` points at a compatible
Google Workspace control-plane CLI, the evidence collector also reads the
external group membership and records it as inbound proof. Without that external
proof, proof planning still blocks Cloudflare inbound proof probes for that
domain because the Worker cannot receive root-domain mail.

When live `zones` evidence is present, every Cloudflare-held zone is included in
the receipt. A held zone missing from local policy or desired state is reported
as drift instead of being silently ignored.

Use `--require-live` when the evidence file is meant to prove production
readiness and any non-`ok` live status should fail the command.

`edge_ready` covers Cloudflare-held zones, Email Routing aliases, root-domain MX
readiness for Cloudflare Email Routing, R2 policy, Worker bindings, and D1/Queue
reachability. `mail_ready` is stricter: it also requires inbound proof, outbound
sender readiness, and outbound reply audit proof.

`bun run plan:maildesk-proofs` turns `mail_ready` gaps into the next safe
operator action. Sender-domain readiness gaps remain blocked actions because
they require Cloudflare mutation, but the JSON plan includes the `cfctl`
preview command, protected `--ack-plan` command template, and follow-up verify
command so a reviewed handoff can stay inside the control-plane flow.
When a reviewed preview receipt has already been built, pass it with
`--ack-manifest <path>` to copy exact, unexpired sender-domain `ack_command`
values into the proof plan without applying them.
Add `--require-ack-ready` when the handoff should fail unless every
sender-domain blocker has an exact operation id and ack command.

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
  "dns_mx": {
    "example.com": [
      "route1.mx.cloudflare.net",
      "route2.mx.cloudflare.net",
      "route3.mx.cloudflare.net"
    ]
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
