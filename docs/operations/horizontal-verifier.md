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

That remains a no-mutation workflow. It fails the receipt only when Cloudflare
Email Service sender-domain blockers are missing exact ack commands. Resend
sender-domain blockers are provider-readback blockers and do not have
`cfctl --ack-plan` commands.

Run the closeout gate when the next question is whether the instance can be
called done:

```bash
bun run check:maildesk-closeout -- \
  --env-file .dev.vars \
  --summary var/proof/maildesk-receipt-require-ack-ready-summary.local.json \
  --ack-manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --refresh-acks \
  --purge-duplicate-previews \
  --purge-expired-previews \
  --redact-sensitive \
  --json
```

That command is non-mutating. It runs production preflight, reads the compact
receipt summary, optionally refreshes the sender-domain ack manifest in
`cfctl --plan` mode, dry-runs the reviewed sender-domain ack manifest, and
exits non-zero until `instance-ready`, `edge-ready`, and `mail-ready` are all
proven. Use `--env-file .dev.vars` when production-only values live in the
ignored repo-local env file instead of the shell environment. Protected applies
and live mail probes are reported as blockers; they are not executed by the
closeout gate.

The closeout JSON includes an aggregate `protected_actions` handoff. It records
how many sender-domain applies, inbound probes, and outbound reply probes are
waiting, whether the corresponding dry-run is ready, and which confirmation
flags are required for the next protected command. This handoff is count-only;
redacted output does not include domains, addresses, operation IDs, or
`cfctl --ack-plan` commands.

The closeout JSON also includes `protected_command_handoff`, a sanitized set of
argv arrays for the next protected command. Cloudflare sender-domain commands
call `apply:maildesk-acks` with the reviewed manifest and default to
`--limit 1`. Probe commands call `send:maildesk-probes` with placeholder values
such as `<probe-provider>`, `<verified-sender>`, `<maildesk-api-url>`,
`<reply-api-token>`, and `<proof-recipient>` that must be replaced before any
live send. The handoff does not include domains, addresses, operation IDs,
tokens, or raw `cfctl --ack-plan` commands.

Use `--purge-duplicate-previews` when `--refresh-acks` has been run repeatedly.
The cleanup is local `cfctl` preview-ledger hygiene: it removes duplicate active
preview records after fresh previews are captured, without applying
sender-domain changes.

Use `--purge-expired-previews` when `cfctl doctor` reports expired preview
records. The cleanup removes only expired local preview-ledger records; it does
not apply sender-domain changes.

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

The refresher executes only the Cloudflare
`cfctl apply sender_domain enable ... --plan` commands already present in the
proof plan, stores the preview receipts, and constructs protected `--ack-plan`
commands for review. A Resend sender-domain blocker will not appear in this
manifest; repair it in Resend and recollect provider readback instead.

Dry-run the reviewed sender-domain apply handoff before any protected apply:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --json
```

Applying sender-domain ack commands is a protected action. It requires both
`--execute` and `--confirm-ack-plan`, and it defaults to one apply at a time
unless `--all` or a larger `--limit` is passed. Applying more than one selected
ack operation also requires `--confirm-bulk-ack-plan`:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --execute \
  --confirm-ack-plan \
  --limit 1
```

For a deliberately batched repair, add the bulk confirmation only after
reviewing the selected manifest entries:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-ack-manifest.local.json \
  --execute \
  --confirm-ack-plan \
  --confirm-bulk-ack-plan \
  --limit 2
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

Collect live evidence from explicitly bound readback tools:

```bash
CFCTL_BIN=/path/to/cfctl \
MAILDESK_CFCTL_PROFILE=<account-bound-profile> \
MAILDESK_READYZ_URL=https://maildesk.example.workers.dev/readyz \
bun run collect:maildesk-evidence -- --out var/maildesk-live-evidence.json
```

When `MAILDESK_CFCTL_PROFILE` is set, the collector resolves that exact profile
to its configured account and uses only governed `cfctl call` operations. The
v2 read set is explicit and bounded: exact-zone lookup, named Email Routing
rules, the separate catch-all rule, Email Routing settings, root MX records, Workers and each Worker’s deployed settings, D1
databases, R2 buckets, Queues and the target Queue’s consumers, and—for
Cloudflare Email Service candidates—sending subdomains. Worker settings are
compared with the checked-in role-specific Wrangler contracts; Queue consumer
target, batch size, concurrency, retries, and DLQ are compared with the outbound
Wrangler contract. Resource-name presence alone never proves a binding or
consumer relationship. Every call carries the same `--profile` and `--account`
binding. The collector accepts a result only
when its `ResultEnvelopeV2` names the expected capability, profile, and account,
declares `schema_version: 2`, reports `performed: true`, has no error, and succeeded.
The local profile/account envelope must likewise be schema v2, successful,
non-performing, and error-free before it can authorize any live call. It stores only bounded
receipt fields and evidence hashes alongside the normalized Maildesk evidence;
it does not copy raw provider responses into the receipt metadata.

A missing profile, denied call, malformed envelope, binding mismatch, missing
required zone, or partial capability set makes the collector exit nonzero after
writing `cfctl_readback.complete: false`. Catalog-declared page and cursor
metadata is part of that contract: absent or malformed metadata, a nonterminal
page, or a continuation cursor is rejected rather than silently truncated; the
receipt retains only bounded page/item counts or cursor presence. The verifier does not allow partial
D1, `/readyz`, or provider evidence to turn that incomplete governed readback
into `live_evidence_present: true`. When no profile is configured, the public
template remains non-mutating and reports that governed Cloudflare readback was
not attempted rather than launching an ambient or legacy profile lane.
Evidence presence is content-aware: empty arrays and objects do not count, and
the collector omits `d1` unless at least one valid table or audit-count entry
was actually normalized. This keeps failed or empty Wrangler output from
impersonating an independent live read when the optional cfctl lane is absent.
Active-policy and inbound/outbound proof maps are also runtime-validated before
they establish presence; a fully shaped but semantically mismatched receipt may
be present evidence and still classify as drift, while an empty or partial
nested object is not evidence.
`/readyz` likewise counts only when it contains an overall boolean and a
nonempty array of typed `{ name, ok, detail? }` checks. A valid negative health
response is present evidence and may report drift; malformed or empty runtime
JSON is omitted by the collector and does not establish presence.

Email Routing aliases count as wired only when the matching rule invokes the
configured Maildesk Worker. A direct `forward` action is completed provider
evidence but is not Maildesk routing evidence: it cannot establish the opaque
reply address, bannered operator delivery, or Rust routing boundary and is
therefore normalized as a missing Maildesk alias rather than accepted wiring.
Catch-all is read from its dedicated provider endpoint and reported as its own
edge field; local desired-state agreement cannot substitute for an enabled
catch-all rule that targets the exact Maildesk Worker.

Routing evidence follows `inbound_mx_provider`. Cloudflare-routed domains use
the named-rule, settings, and catch-all capabilities above. Google Workspace
and generic external domains still use Cloudflare zone and root-MX readback,
but Cloudflare Email Routing fields are explicitly `not_applicable` and are
excluded from that provider’s readiness conjunction. Their role and personal
route wiring remains `not_checked` until a provider-native adapter supplies
typed configuration evidence; inbox or delivery receipts do not substitute for
that control-plane relationship.

`/readyz` is read when `MAILDESK_READYZ_URL` is set, and D1 schema/audit counts
remain available through the configured Wrangler read lane. Sender-domain
readback follows desired-state `sender.mode`: `cloudflare_email_service` uses
the governed sending-subdomain capability, `resend` uses the Resend CLI when
available, and `disabled` skips outbound sender-provider readback. The collector
never invokes legacy `cfctl list ...` or `cfctl maildesk-cf verify` text, sends
mail, selects a global profile, or mutates Cloudflare.

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

Dry-run mode is local and does not require Resend. Send only when the sender
identity is verified, the transport is explicit, and the target set is
intentional:

```bash
bun run send:maildesk-probes -- \
  --inbound-provider resend \
  --execute \
  --confirm-live-send \
  --from proof@example.com \
  --domain example.com
```

The probe executor defaults to dry-run and a limit of one target. Use
`--limit <n>` or `--all` only for a deliberate proof pass. Executing more than
one selected probe requires both `--confirm-live-send` and
`--confirm-bulk-live-send`.

Dry-run an outbound reply proof from a plan:

```bash
bun run send:maildesk-probes -- --kind outbound --to proof@example.com --domain example.com --json
```

Executing outbound proof requires the deployed reply API URL and token:

```bash
bun run send:maildesk-probes -- \
  --kind outbound \
  --execute \
  --confirm-live-send \
  --api-url https://maildesk.example.workers.dev \
  --api-token "$MAILDESK_API_TOKEN" \
  --to proof@example.com \
  --domain example.com
```

For proof-only runs and production closeout preflight, prefer a deployed
`MAILDESK_PROOF_API_TOKEN` over rotating the primary `MAILDESK_API_TOKEN`.

## Receipt Shape

The command emits one row per domain and reports:

- configured operator, reply-identity, and route-kind counts without addresses;
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
reachability. `mail_ready` is stricter: it also requires inbound proof and the
outbound proof required by the selected sender mode. In `disabled` mode,
outbound sender readiness and outbound reply proof are considered intentionally
satisfied by the disabled contract. In enabled modes, sender readiness must come
from the active provider and outbound reply proof must match that provider when
the proof records a provider name.

`bun run plan:maildesk-proofs` turns `mail_ready` gaps into the next safe
operator action. Cloudflare Email Service sender-domain readiness gaps remain
blocked actions because they require Cloudflare mutation, and the JSON plan
includes the `cfctl` preview command, protected `--ack-plan` command template,
and follow-up verify command so a reviewed handoff can stay inside the
control-plane flow. Resend sender-domain readiness gaps remain blocked until
Resend readback reports the domain as verified; they do not create Cloudflare
ack commands. `disabled` mode does not create sender-domain repair work.
When a reviewed preview receipt has already been built, pass it with
`--ack-manifest <path>` to copy exact, unexpired Cloudflare sender-domain
`ack_command` values into the proof plan without applying them.
Add `--require-ack-ready` when the handoff should fail unless every Cloudflare
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
  "active_policy": {
    "active_policy_sha256": "<d1-active-sha256>",
    "active_policy_r2_key": "config/policy/<d1-active-sha256>.json",
    "revision_r2_key": "config/policy/<d1-active-sha256>.json",
    "object_key": "config/policy/<d1-active-sha256>.json",
    "object_sha256": "<sha256-of-authenticated-r2-readback-bytes>",
    "projection_policy_sha256": "<d1-projection-state-policy-sha256>",
    "expected_domain_count": 1,
    "expected_route_count": 3,
    "projected_domain_count": 1,
    "projected_route_count": 3,
    "active_desired_state_sha256": "<sha256-of-selected-desired-state-bytes>",
    "active_projection_sha256": "<sha256-of-the-deterministic-policy-projection>"
  },
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
      "operator_count": 2,
      "policy_sha256": "<d1-active-sha256>",
      "provider_message_ids": ["provider-message-id-a", "provider-message-id-b"],
      "provider_accepted_at": "2026-05-20T00:00:00Z",
      "inbox_verified_at": "2026-05-20T00:01:00Z",
      "default_reply_identity": "founders@example.com",
      "provider": "cloudflare_email_service"
    }
  },
  "outbound_proofs": {
    "example.com": {
      "status": "delivered",
      "from_identity": "founders@example.com",
      "provider": "cloudflare_email_service",
      "provider_message_id": "provider-message-id",
      "audit_event_at": "2026-05-20T00:00:00Z"
    }
  }
}
```

Inbox-relay proof is policy-checked and body-free. A bare `status: ok` is not
enough: the proof must bind the routed mailbox, route kind, operator count,
active policy digest, public reply identity, provider message IDs, provider
acceptance timestamp, and separately verified inbox-receipt timestamp. It must
not expose operator addresses or a raw MIME object key. Google Workspace routes
use their provider-native membership and receipt evidence instead.
The verifier may consume private policy identities in memory for comparison,
but JSON and table receipts never serialize operators, allowed identities,
personal route addresses, reply identities, or Google group members. External
membership is represented by count plus a deterministic normalized-set digest;
provider payload integrity is represented by its SHA-256 receipt hash.

Active-policy evidence is equally conjunctive. D1's active pointer and revision
key must select the canonical remote R2 object; its downloaded bytes must hash
to the selected local policy; remote expected/projected counts must equal the
domain and route counts derived by the local projection compiler (including
sink and catch-all routes); and D1's active desired-state and semantic
projection digests must match the same local compiler output. Agreement among
remote fields alone is not deployment proof.

D1 proof is stricter when present. `/readyz` proves the binding can query; the
optional `d1.tables` readback proves the audit schema actually exists. When
`d1` evidence is supplied, the verifier requires the core audit/routing tables.

Outbound proof is separate from sender-domain readiness. In enabled modes,
`sender_domains` proves the active provider can send for the domain;
`outbound_proofs` proves an actual authorized reply path produced audit
evidence. In `disabled` mode those outbound checks are intentionally skipped.

The verifier does not send mail and does not mutate Cloudflare. Broad live sends
remain outside the default verification path.
