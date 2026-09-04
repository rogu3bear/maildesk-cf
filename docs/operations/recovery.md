# Relay recovery

Use this procedure for inbox relay. It is an operator procedure for interpreting
durable states and selecting a safe next action, not permission to send mail or
edit database rows. The release owner names a responder before activation.
Start from the routing-health dashboard's Exceptions section and its route,
policy revision and bounded error. Keep bodies, attachment bytes, opaque reply
tokens and operator addresses out of incident logs and receipts.

## First response

1. Record the affected route/policy revision, delivery or attempt identifier,
   first failure time and known provider message IDs in the private incident
   record. Record whether the exception is inbound or reply processing.
2. Determine the incident's spool deadline from receipt time and the configured
   lifecycle (the public default is seven days). Respond before that deadline;
   it is a retention ceiling, not permission to wait seven days. Do not extend
   retention or export content without a separately authorized policy decision.
3. Check cfctl health and inspect the applicable read/recovery capability:

   ```bash
   cfctl version --json
   cfctl doctor --json
   cfctl agents doctor --json
   cfctl resolve "read Maildesk current state without mutation" --json
   ```

   Inspect the resolved capability with `cfctl catalog show` and `cfctl guide`.
   Bind every read to the exact profile, account and target identifiers. Collect
   only the bounded evidence needed below. Discovery is not a live read. A
   missing capability or unsupported projection is a named blocker; preserve
   the incident and request the needed cfctl surface rather than issuing raw
   SQL or unreviewed API calls.
4. If further processing could increase impact, prepare an exact Worker change
   through cfctl to disable the affected relay switch. Review and approve that
   plan under the incident authority. A disabled ingress switch does not erase
   already accepted Queue jobs or retract mail; separately inspect backlog and
   in-flight attempts. Never use a blanket purge or claim reset as containment.

## State-to-action matrix

These are durable state distinctions. A Queue job or R2 object alone cannot
establish the state or authorize a send.

| Evidence | What is established | Permitted recovery path | Completion evidence |
|---|---|---|---|
| Recipient `pending`, no successful send claim | That recipient has not crossed the provider boundary | Normal identical provider redelivery can resume only from the exact retained payload after active policy, route, generation and atomic claim checks. Repair availability first; do not manufacture a new claim. | Recipient becomes `provider_accepted`, with the provider result and complete recipient projection; receipt remains a separate check. |
| Recipient `pending`, payload missing or digest/key mismatch | Unsent recipient cannot be reconstructed safely from the recovery artifact | Preserve the claim and classify the missing/tampered content. Check retention and storage availability. Restore only an independently verified exact artifact through a supported, separately approved operation. If unavailable, record `content_unavailable`; any replacement communication is a separately authorized new message, not replay of this claim. | Either exact-artifact recovery completes, or incident records unresolved/lost content without claiming delivery. |
| Recipient `sending` or `recovery_required`, provider result absent | Provider effect may have happened | Reconcile the exact provider/message identity and recipient receipt; no automatic resend and no reset to `pending`. An approved, supported reconciliation operation may attach proven results. If provider evidence cannot resolve it, retain `outcome_unknown`. | Exact accepted/failed evidence, or an explicitly unresolved incident; no fabricated delivery. |
| Aggregate `partial_delivery` | At least one recipient is accepted; others have distinct states | Inspect each recipient. Do not resend accepted recipients. Apply the pending or ambiguous row above independently. A single successful recipient does not make the route complete. | Complete recipient set reconciled; aggregate projection agrees with every recipient. |
| Recipients accepted, route-health/audit projection failed | Provider acceptance can be durable even though aggregate/UI state is stale | Restore D1/Queue availability. Normal exact inbound redelivery or the already accepted result Queue job can finish projection. The consumer verifies the full claim before cleanup and never sends from a result job. | Complete aggregate projection plus idempotent spool cleanup; no extra provider call. |
| Reply `receiving` or `queued`, no outbound send claim | Authenticated bytes were accepted locally; Queue acceptance may be the remaining step | Identical authenticated operator redelivery may resume Queue admission under the same attempt ID/digest. Consumer rechecks active operator authorization and the exact spool. | Queue job consumed and an explicit terminal result recorded. Queue acceptance alone is not send proof. |
| Reply spool unavailable or policy unavailable | Consumer cannot safely authorize/construct the reply | `recovery_required` is terminal for this consumption attempt. Repair the dependency, preserve its identity and use only a supported approved recovery operation. Never copy arbitrary body bytes into the claim. Missing/expired content may be unrecoverable. | Exact recovery result or explicit unresolved/content-unavailable outcome. |
| Outbound Cloudflare claim exists with no terminal result | The transition may have crossed the provider boundary | Redelivery records recovery-required and acknowledges without another send. Reconcile provider/recipient evidence under the same identity. No automatic replay, including switching to another provider. | Proven terminal result or explicit `outcome_unknown`. |
| Outbound terminal result exists, D1 projection or cleanup failed | The recorded provider outcome survives the local failure | Normal Queue redelivery repeats only idempotent projection and cleanup. It does not call the provider again. | Projection and cleanup finish; provider call count remains unchanged. |
| Retryable idempotent Resend failure in an explicitly configured legacy integration | Provider contract supports the stable message-ID idempotency key | Existing bounded retries may proceed only while the provider matches the original claim. Exhaustion reaches the configured DLQ; an ambiguous/non-idempotent claim is never converted into a retry. | Terminal audit, or a DLQ incident with retained evidence. |

`recipient_pending` is used for a retained unsent recipient in recovery output.
It must not be interpreted as `provider_outcome_unknown`. The aggregate may
still require recovery. Missing retained content does not justify recreating or
resending an already accepted recipient.

## Resolve or keep explicitly unresolved

A reconciliation must identify the exact source claim, policy and generation,
provider/recipient evidence and permitted state change. If cfctl produces a
plan, inspect its operation ID, content hash, target, diff and verification;
approve only that plan, run it once and inspect status plus targeted readback.
If execution is uncertain, retain the operation ID and follow the guide's
recovery path. Never rerun a consumed plan to see whether it works.

The runtime deliberately provides no “force resend” or raw database repair
button. When no supported reconciliation capability can represent a proposed
change, keep the incident blocked at that exact operation and request the
capability owner. Do not substitute a dashboard edit, arbitrary D1 update,
manual Queue injection, deleted audit row or new message ID. An unresolved
external outcome is an honest terminal assessment of the incident, not a
claim that the mail job completed.

For an intentionally new communication after an unresolved/lost original,
obtain explicit recipient and sender authorization, label it as a replacement,
and record its separate identity and receipt. It cannot retroactively qualify
the original attempt.

Close the incident only when its outcome, remaining recipient exceptions,
spool disposition, and any independent replacement are explicit. Provider
acceptance, inbox receipt and external reply receipt remain separate fields.
Do not mark mail-ready from a provider response or a cleared error alone.

## Local rehearsal

`bun run test:workers` covers admission, partial recipients, missing/tampered
spools, ambiguous send suppression, accepted-result projection and cleanup
redelivery. `tests/workers/inbox-relay.test.ts` exercises actual ingress with
fault-injected D1/R2/Queue boundaries; `tests/workers/mail-api.test.ts` exercises
consumer claims and terminal projection. These tests do not read an account or
send mail. Follow [acceptance-criteria.md](../acceptance-criteria.md) for the
release proof map; use one expressly authorized targeted canary for later live
receipt qualification.
