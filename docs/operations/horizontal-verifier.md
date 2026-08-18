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

When a reviewed sender-domain PlanV2 manifest exists, include it in the same
receipt run:

```bash
bun run receipt:maildesk -- \
  --plan-manifest var/proof/maildesk-sender-domain-plan-manifest.local.json \
  --require-plan-ready \
  --summary var/proof/maildesk-receipt-require-plan-ready-summary.local.json
```

That remains a no-mutation workflow. It fails the receipt only when Cloudflare
Email Service sender-domain blockers are missing exact unexpired PlanV2
operation IDs. Resend sender-domain blockers are provider-readback blockers and
do not have Cloudflare plan operations.

Run the closeout gate when the next question is whether the instance can be
called done:

```bash
bun run check:maildesk-closeout -- \
  --env-file .dev.vars \
  --summary var/proof/maildesk-receipt-require-plan-ready-summary.local.json \
  --plan-manifest var/proof/maildesk-sender-domain-plan-manifest.local.json \
  --refresh-acks \
  --redact-sensitive \
  --json
```

That command is non-mutating. It runs production preflight, reads the compact
receipt summary, optionally refreshes the sender-domain PlanV2 manifest, dry-runs
the reviewed PlanV2 lifecycle, and
exits non-zero until `instance-ready`, `edge-ready`, and `mail-ready` are all
proven. Use `--env-file .dev.vars` when production-only values live in the
ignored repo-local env file instead of the shell environment. Protected applies
and live mail probes are reported as blockers; they are not executed by the
closeout gate.

The closeout JSON includes an aggregate `protected_actions` handoff. It records
how many sender-domain applies, inbound probes, and outbound reply probes are
waiting, whether the corresponding dry-run is ready, and which confirmation
flags are required for the next protected command. This handoff is count-only;
redacted output does not include domains, addresses, operation IDs, or raw
approval/execution commands.

The closeout JSON also includes `protected_command_handoff`, a sanitized set of
argv arrays for the next protected command. Cloudflare sender-domain commands
call `apply:maildesk-acks` with the reviewed PlanV2 manifest and default to
`--limit 1`. Probe commands call `send:maildesk-probes` with placeholder values
such as `<probe-provider>`, `<verified-sender>`, `<maildesk-api-url>`,
`<reply-api-token>`, and `<proof-recipient>` that must be replaced before any
live send. The handoff does not include domains, addresses, operation IDs,
tokens, or raw cfctl lifecycle commands.

PlanV2 has no ambient preview-cleanup lane. Retire a specific unwanted draft
only by reviewing its exact operation ID and using the governed `plans cancel`
lifecycle; the closeout gate never searches for or bulk-retires plans.

Use `--redact-sensitive` for JSON that may be copied into an issue, PR, or
status report. The redacted form preserves readiness, aggregate dry-run counts,
and blocker kinds, but omits per-domain sender-domain plan details and raw
cfctl lifecycle commands.

To refresh that manifest from the current proof plan without applying anything:

```bash
bun run refresh:maildesk-acks -- \
  --plan var/maildesk-proof-plan.json \
  --out var/proof/maildesk-sender-domain-plan-manifest.local.json \
  --profile "$MAILDESK_CFCTL_PROFILE"
```

The refresher accepts only typed sender-domain plan requests from the proof
plan. It resolves the exact profile account, reads one active zone ID through
`zones-get`, and creates a capability-bound PlanV2 operation with
`performed:false`. The manifest retains `result.plan_v2.content_hash` and the
exact profile, account, zone selector, capability, and request-body pins. The
executor requires `plans show` to reproduce those PlanV2 bytes before approval;
it does not expect the show command to repeat the creation envelope's evidence.
A Resend sender-domain blocker will not appear in this manifest; repair it in
Resend and recollect provider readback instead.

Dry-run the reviewed sender-domain apply handoff before any protected apply:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-plan-manifest.local.json \
  --json
```

Executing a sender-domain PlanV2 operation is a protected action. It requires
both `--execute` and `--confirm-plan`, and it defaults to one operation at a
time unless `--all` or a larger `--limit` is passed. Executing more than one
selected operation also requires `--confirm-bulk-plan`:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-plan-manifest.local.json \
  --execute \
  --confirm-plan \
  --limit 1
```

For a deliberately batched repair, add the bulk confirmation only after
reviewing the selected manifest entries:

```bash
bun run apply:maildesk-acks -- \
  --manifest var/proof/maildesk-sender-domain-plan-manifest.local.json \
  --execute \
  --confirm-plan \
  --confirm-bulk-plan \
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

The default collection mode is `full_desired_state` with the
`inventory_v1` acceptance profile. A successful inventory transaction reports
`transaction_complete: true`, but it deliberately keeps legacy `complete`,
`coverage.acceptance_complete`, `edge_ready`, and `mail_ready` false. Inventory
proves the implemented resource reads; it does not impersonate dark-deployment
acceptance.

Use a repository-local scope manifest, or one beside an explicitly selected
desired-state fixture, for a bounded canary observation:

```json
{
  "schema_version": 1,
  "mode": "canary",
  "profile": "inventory_v1",
  "domains": ["example.com", "example.net"]
}
```

```bash
bun run collect:maildesk-evidence -- \
  --desired-state config/desired-state.local.json \
  --scope-manifest var/proof/maildesk-read-scope.local.json \
  --out var/maildesk-live-evidence.json
```

Canary collection reads only the explicit selected domains, preserves their
observations, hashes the selected domain inventory into the coverage contract,
and marks every unselected desired domain `not_checked`. It may establish
`live_evidence_present: true`, but it always reports
`coverage.desired_scope_complete: false`,
`coverage.acceptance_complete: false`, legacy `complete: false`, and
`edge_ready: false`. Unselected domains are excluded from aggregate provider
gap counts; local policy-versus-desired-state failures remain visible.

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
writing `cfctl_readback.transaction_complete: false` and legacy
`complete: false`. The bound receipt, failed capability ID, unattempted
capability IDs, desired-state digest, and scope counts remain available without
granting readiness. Catalog-declared page and cursor
metadata is part of that contract: malformed metadata, a declared nonterminal
page, or a continuation cursor is rejected rather than silently truncated.
Email Routing rules are the narrower typed case: cfctl owns the provider page
probes and returns one complete, versioned `EmailRoutingRuleSetV1` projection.
The collector accepts only schema version 1, the fixed 50-item page size, at
most 100 pages, a rule count that fits the completed-page capacity, and typed
rules whose count is exact. It never requests provider pages or consumes raw
matcher and action values. Instead it hashes each expected full alias locally,
compares only `field: "to"` identities, and retains only matched expected
aliases plus Worker topology. Incomplete projections, legacy raw rule arrays,
invalid matcher hashes, suppressed Worker targets, or inconsistent counts are
malformed evidence. Other absent pagination metadata remains malformed.
The verifier does not allow partial
D1, `/readyz`, or provider evidence to turn a failed governed transaction into
`live_evidence_present: true`. A successful canary transaction is present
evidence, but its coverage contract prevents it from authorizing readiness.
When no profile is configured, the public
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

The `dark_acceptance_v1` profile is fail-closed. Its contract explicitly names
Access application and policy readback, R2 spool lifecycle, exact Worker
deployment and route identity, Queue and DLQ backlog, spool emptiness, and the
readiness endpoint as required acceptance surfaces. Surfaces not implemented
by this collector are emitted as typed blockers and keep
`coverage.acceptance_complete` false. A missing readiness URL is never silently
treated as dark acceptance. The compatibility field `complete` can become true
only for a full desired-state, transaction-complete, dark-acceptance-complete
readback. Legacy evidence containing only `required`, `attempted`, and
`complete` cannot establish `edge_ready` or `mail_ready`.

Live-evidence output is always created or tightened to mode `0600`. It may
contain private domain and account metadata even though it contains no token or
message body, so it must remain ignored and local.

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
uses only explicit v2 capability calls, sends no mail, selects no ambient
profile, and performs no Cloudflare mutation.

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
includes a typed create-sending-subdomain request and a capability-specific
verify request. Resend sender-domain readiness gaps remain blocked until Resend
readback reports the domain as verified; they do not create Cloudflare plans.
`disabled` mode does not create sender-domain repair work. When a reviewed plan
receipt has already been built, pass it with `--plan-manifest <path>` to bind
exact, unexpired operation IDs and lifecycle argv arrays into the proof plan
without approving or running them. Add `--require-plan-ready` when the handoff
should fail unless every Cloudflare sender-domain blocker has an exact PlanV2
operation.

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
