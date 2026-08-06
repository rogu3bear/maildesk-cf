---
artifact: acceptance-criteria
version: "1.0"
created: 2026-08-05
status: draft
---

# Acceptance Criteria: Trustworthy Operator Desk Vertical Slice

## Story Context

The first release joins a public Leptos explanation surface to an authenticated operator desk that can present bounded thread state, show routing and reply identity, queue an authorized response, and separate source, local, deploy, and live evidence. Real production configuration remains private and Cloudflare mutation remains governed by cfctl.

## Happy Path

### AC-1: Authenticated Desk Entry

**Given** a request carrying a valid operator identity from the configured access boundary, **when** the operator opens `/desk`, **then** the server returns the desk shell and only data authorized for that operator.

### AC-2: Thread Understanding

**Given** an authorized thread with messages and a route decision, **when** the operator selects it, **then** the detail view shows bounded messages, participants, route kind, default reply identity, and current state.

### AC-3: Authorized Reply Queue

**Given** an authorized operator, route, and reply identity, **when** the operator submits a non-empty reply, **then** the server re-authorizes the identity, queues one reply intent, and reports queued—not delivered—with a stable message reference.

### AC-4: Audit Confirmation

**Given** queue processing records authorization, attempt, and provider result, **when** the operator views the audit timeline, **then** each event is ordered and labeled independently.

## Edge Cases

### AC-5: Empty Desk

**Given** the operator has no accessible threads, **when** the desk loads, **then** a useful empty state appears with readiness context and no fabricated example mail.

### AC-6: Partial Inbound Persistence

**Given** metadata exists but parsed content or raw storage is unavailable, **when** the thread opens, **then** the available metadata remains visible and the missing artifact is labeled with a recovery-oriented state.

### AC-7: Role and Personal Identity Distinction

**Given** role and personal aliases are both configured, **when** the composer opens, **then** role aliases default to the role identity and personal aliases default to the matching personal identity.

## Error States

### AC-8: Missing Operator Identity

**Given** no trusted operator identity is present, **when** `/desk` or an operator server function is requested, **then** access fails closed without returning thread or configuration data.

### AC-9: Unauthorized Thread

**Given** an authenticated operator who is not authorized for a route, **when** they request a thread on that route, **then** the response is indistinguishable from a missing resource and no sensitive existence signal is exposed.

### AC-10: Unauthorized Reply Identity

**Given** a requested From identity outside router policy, **when** the reply is submitted, **then** the server rejects it, queues no job, preserves the draft locally where safe, and explains that the identity is unavailable.

### AC-11: Dependency Failure

**Given** D1, R2, Queue, policy, or sender readiness fails, **when** an affected action is attempted, **then** the UI names the unavailable capability, keeps unaffected read-only context, and offers a safe retry or diagnostic path.

## Non-Functional Criteria

### AC-12: Accessibility

**Given** keyboard-only use, visible focus requirements, 200% zoom, or reduced-motion preference, **when** any primary route and action is used, **then** all content and controls remain operable, discernible, and unclipped without motion-dependent meaning.

### AC-13: Security Headers and Request Policy

**Given** any production document or server-function response, **when** it is returned, **then** CSP, anti-framing, no-sniff, referrer, cache, method, content-type, origin, and bounded-body policies meet the accepted security contract.

### AC-14: Sensitive Data Minimization

**Given** operational logging, audit detail, or an error response, **when** it is emitted, **then** it contains no secret values and no unnecessary raw message content.

### AC-15: Performance

**Given** a production build and representative bounded data, **when** the public shell and desk are measured, **then** the nominated performance budget and Core Web Vitals targets are recorded and met before launch; missing baselines block performance claims.

### AC-16: Proof Integrity

**Given** source, local tests, a deploy result, and live readback, **when** readiness is communicated, **then** each evidence class stays distinct and `mail-ready` is shown only after a targeted end-to-end mail proof.

## Notes

- Cloudflare Access is the recommended operator identity authority but remains an assumption pending owner confirmation.
- HTML email rendering and attachment previews are out of scope for the first vertical slice.
- Production deploy and any targeted live send require separate exact-operation approval.
