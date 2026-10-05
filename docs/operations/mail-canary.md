# Route canary

The optional `mail-canary` Worker checks every enabled route in the active
policy once an hour. It loads the immutable R2 policy through the existing
active-policy loader, compares the D1 route count with the revision's expected
count, and checks independent edge, inbox and reply receipt freshness for each
route. Missing rows, revision drift, incomplete coverage, disabled processing,
stale proofs and delivery failures cannot produce a current receipt result.
Intentional sink routes require an explicit excluded disposition.

It sends one body-free notification on the first check, on aggregate status
changes, and every 24 hours while the aggregate result is unchanged. Recovery
produces a notification too. Reports contain counts and bounded issue codes;
they contain no mail subjects, bodies, attachments or operator identities.

`receipts_current` means the selected policy's route receipts satisfy the
configured age limit. The canary does not perform Cloudflare control-plane
inventory reads or send a new inbound/reply probe. It cannot establish that
every mailbox receives mail now. Quiet routes without recent independent
receipts remain `unverified`, rather than being declared down or healthy.
Provider configuration checks remain with `receipt:maildesk`; controlled
mailbox probes remain with the instance's protected acceptance workflow.

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
   24 hours, supported 1–720), and set the two canary processing declarations
   to match the actual deployed router switches. These declarations are
   configuration inputs, not live switch readback.
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

Missing D1 access prevents safe notification claims. Failure of Email Service
can prevent email alerts. Detect these limits through the external heartbeat
expectation and provider monitoring; this Worker cannot guarantee an email
alert when its own database or sender is unavailable. Disabling the canary
stops reads and sends immediately without deleting state or receipts.
