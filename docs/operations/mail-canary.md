# Route canary

The optional `mail-canary` Worker reads every enabled route in the active
policy once an hour. It loads the immutable R2 policy through the existing
active-policy loader and compares D1 route membership and routing fields with
decisions from the Rust router. That configuration read is the full-inventory
check. It does not require a fresh mailbox receipt on every path.

Each path keeps the last independent proof in `route_proof_ledger`: the
configuration read from this run, plus the newest recorded inbox, reply, and
edge receipt already stored for that path. The canary copies those receipts; it
does not invent them. Each run also selects a bounded rotation, default 3 and
at most 8, of the non-sink paths whose inbox or reply proof is missing or
oldest, and stores that selection in `mail_canary_probe_rotation`. The protected
probe workflow is what sends those probes. This Worker does not.

Missing rows, revision drift, incomplete coverage, disabled processing, and
delivery failures cannot produce a current configuration result. A path with an
older or missing independent proof stays `configuration_current` when the
configuration read passed. Intentional sink routes require an explicit excluded
disposition and are not probe candidates. Route IDs, domains, aliases, kinds
and default reply identities must agree with the immutable policy; matching
counts and revision labels alone cannot pass.

It sends one body-free notification on the first check, on aggregate status
changes, and every 24 hours while the aggregate result is unchanged. Recovery
produces a notification too. The message reports receipt coverage: configuration
reads, independent proofs inside the window, recorded proofs, and the size of
the probe rotation. Reports contain counts and bounded issue codes; they
contain no mail subjects, bodies, attachments, or operator identities.

`receipts_current` means every non-sink path has an independent inbox proof and
an independent reply proof inside the configured age limit. `configuration_current`
means the configuration read passed while at least one of those proofs is older
or missing. Neither status is a live provider inventory read or a new probe, and
neither establishes that every mailbox receives mail now. Provider configuration
checks remain with `receipt:maildesk`; controlled mailbox probes remain with the
instance's protected acceptance workflow.

## External heartbeat

`mail-heartbeat` is a separate scheduled Worker. It binds the same relay D1
database and has no Email binding, no route, and no policy bucket. Once an hour,
when enabled, it POSTs a body-free ready ping to the configured HTTPS URL only
if the notification attempt is idle, a notification has been accepted before,
and a configuration ledger row was written inside the heartbeat age (default 2
hours). A dead database, a stale configuration read, or a notification left
`sending` or `uncertain` produces no ping. The operator's external monitor is
what alerts on a missed ping. This Worker cannot email, so a dead sender cannot
hide by failing to send the canary message. The public example stays disabled.

## Deployment

Use `wrangler.mail-canary.toml` as the template for a private production config.
It has no HTTP route, Queue consumer, raw-mail bucket or inbox-reading scope.
Its bindings are the existing relay D1 database, immutable policy bucket, and
Cloudflare Email Service. It remains disabled in the public example.

1. Build and qualify the current source with `bun run ci`. The existing closed
   Worker bundle builder includes the canary and its dependency manifest.
2. Import the accepted reusable mechanism into the private instance under its
   existing provider-import contract. Preserve its migration numbering and
   private overlays; choose its next unused migration number for
   `0009_mail_canary.sql` if that number is already occupied there.
3. Select a verified public **role** sender from an active, non-sink route and
   an explicit notification recipient. The canary refuses undeclared senders.
4. Bind production D1/R2 resource names and IDs. Set the proof age (default
   24 hours, supported 1–720) and the probe batch (default 3, supported 1–8),
   and set the two canary processing declarations to match the actual deployed
   router switches. These declarations are configuration inputs, not live
   switch readback. Keep the heartbeat disabled until the canary has completed
   one accepted notification and a configuration ledger write.
5. Pass the instance's production preflight and resolve exact deployment,
   migration, Email binding and cron capabilities through cfctl. Use one
   reviewed PlanV2 lifecycle per effect through the registered release owner.
   Do not use raw Wrangler deployment as a substitute.
6. Apply the state migration, deploy disabled, read back the bindings and
   hourly trigger, then enable the canary through an exact reviewed plan.
7. Observe the first `canary_notification_provider_accepted` audit receipt
   and separately confirm the notification in the configured recipient inbox.
   A mocked local sender or provider acceptance does not establish inbox receipt.

When native cfctl lacks a needed deployment/trigger surface, follow
`ops/cfctl/mail-canary.desired-state.md`; the desired state is preparation only.

## Notification recovery

The singleton `mail_canary_state` row atomically claims a notification before
sending. Concurrent cron invocations cannot send that claimed attempt twice.
After provider acceptance, a D1 transaction records its message ID and the
body-free report in the audit log, and updates the last successful report hash
and notification time.

A transport exception, interrupted attempt, or persistence failure may happen
after provider acceptance. A `sending` or `uncertain` state stops further sends;
it must not be automatically cleared. Inspect the attempt ID, provider evidence
and audit state through governed reads. Reconcile the accepted outcome, or
approve a new retry after proving that the earlier attempt was not accepted.
Preserve the original receipt and operation identity.

Missing D1 access prevents safe notification claims and prevents a ledger write.
Failure of Email Service can prevent email alerts and leaves the attempt
`uncertain`, which stops the external heartbeat ping. Disabling the canary
stops its reads and sends immediately without deleting state or receipts.
Disabling the heartbeat stops only the external ping.
