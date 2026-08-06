# Reliability

## Service-Level Posture

No production traffic baseline or SLO is established. The first release bar is
therefore invariant-based: fail closed on authentication and reply identity,
bound external calls, make queued/attempted/delivered states distinct, and keep
recovery evidence when work does not complete.

## Dependency Contract

| Dependency | Bound/failure behavior | Retry/idempotency | Proof |
|---|---|---|---|
| Cloudflare Access JWKS | 5 s fetch timeout; 30 s refresh cooldown; 10 min cache; invalid or unavailable verification fails closed | JOSE caches keys by team origin | Worker unit tests + production authenticated readback |
| D1 | bounded result sets and operator-scoped joins; errors return generic client failure and server-only context | stable audit dedupe keys suppress repeated effects | Rust characterization + Worker unit tests + live readback |
| R2 | inbound raw write occurs before persistence jobs; failure is explicit job metadata | delivery ID prevents same-day key overwrite | Worker unit tests + targeted probe |
| Queue | submission failure is reported; completed claims are deduplicated | bounded per-message retry with audited attempt numbers | Worker unit tests + Queue/provider audit readback |
| Cloudflare Email Service | binding/configuration errors fail; uncertain provider calls require recovery | no automatic replay after an ambiguous or interrupted claim | Worker unit tests + targeted provider proof |
| Resend | 10 s request timeout; verified-domain gate; response body is excluded from audit | message ID is the provider idempotency key; transient failures retry with bounded backoff | Worker unit tests + targeted provider proof |
| `cfctl` | production preflight requires a healthy lane and governed plan/apply/readback | mutation uses operation IDs and acknowledged plans | script tests + provider receipt |

## Failure and Recovery Semantics

- Access uncertainty returns 401, 403, or 503 before Leptos receives an
  operator identity.
- Unknown persisted route kinds, malformed route addresses, unauthorized
  operators, and unauthorized reply identities fail before Queue submission.
- `queued` means accepted by Queue, not sent.
- `outbound_reply_send_attempted` is recorded before the provider call.
- `outbound_reply_retry_scheduled` records a bounded idempotent Resend retry.
- `outbound_reply_delivered`, `outbound_reply_failed`, or
  `outbound_reply_recovery_required` records the terminal observed state.
- A durable claim without a result is resumed only when the provider contract
  is idempotent and the configured provider still matches the claimed provider;
  otherwise it becomes recovery-required and is not replayed.

## Operational Signals

The API Worker exposes `/healthz` for process reachability and `/readyz` for
binding/configuration checks. Release proof additionally requires production
preflight and targeted authenticated/provider readback; endpoint success alone
does not establish mail readiness.

Recommended alerts remain unimplemented, so the template does not claim a
production reliability SLO:

- Access verification 5xx/timeout rate;
- Queue age and failed-delivery/dead-letter depth;
- D1/R2 binding failures;
- outbound claims without result events;
- provider failure rate by sender mode, excluding content.

## Production Evidence Gaps

- Add a desk-level summary that counts recovery-required outbound transitions;
  thread audit history already exposes the action without message content.
- Bind alert thresholds to observed traffic after the private instance exists.
