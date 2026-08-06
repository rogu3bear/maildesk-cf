---
artifact: user-stories
version: "1.0"
created: 2026-08-05
status: draft
---

# User Stories: Production Operator Desk

## US-001 — Understand What Needs Attention

### Story Header

| Field | Value |
| --- | --- |
| ID | US-001 |
| Persona | Edge Mail Operator |
| Priority | P0 |
| Epic/Feature | Operator desk |
| Estimate | Medium |

### User Story Statement

**As an** edge mail operator, **I want** a prioritized view of conversations and operational exceptions **so that** I can act on the most important state without reconstructing it from multiple Cloudflare surfaces.

### Context & Background

The desk must lead with actionable mail and blocked evidence, not decorative message totals. The first release may show an explicit preview/empty state until authenticated thread reads are connected.

### Acceptance Criteria

**Given** an authenticated operator with accessible threads, **when** the desk loads, **then** the operator sees an ordered list with subject, route identity, participant, state, and last activity.

**Given** no accessible threads, **when** the desk loads, **then** it shows a useful empty state and current readiness without inventing mail.

**Given** a required dependency is unavailable, **when** the desk loads, **then** the failure identifies the affected proof plane and provides a safe retry or diagnostic action.

### Design Notes

- Use a calm split-pane desk with attention states encoded by text and shape as well as color.
- Keep raw content out of overview cards.

### Technical Notes

- Query scope must derive from authenticated operator identity.
- Bound the list and paginate or cursor before production volume.

### Dependencies

| Dependency | Type | Status |
| --- | --- | --- |
| Cloudflare Access identity contract | Auth | Open |
| Thread projection | API/server boundary | Planned |

### Out of Scope

- Full-text search
- Assignment automation
- SLA analytics

### Open Questions

- [ ] Which statuses constitute “needs attention” for the first private instance?

## US-002 — Review a Conversation and Its Route

### Story Header

| Field | Value |
| --- | --- |
| ID | US-002 |
| Persona | Edge Mail Operator |
| Priority | P0 |
| Epic/Feature | Thread detail |
| Estimate | Medium |

### User Story Statement

**As an** edge mail operator, **I want** to read a bounded conversation alongside its routing decision **so that** I understand what arrived, where it was stored, and which identity story the reply must preserve.

### Context & Background

Message content is sensitive. The detail view should expose only the authorized thread and progressively disclose operational evidence.

### Acceptance Criteria

**Given** an operator authorized for a route, **when** they open its thread, **then** the desk shows ordered messages, participants, route kind, and default reply identity.

**Given** an operator not authorized for the route, **when** they request the thread, **then** access fails closed without revealing whether sensitive content exists.

**Given** raw MIME or parsed content is unavailable, **when** metadata exists, **then** the view explains the partial state and preserves recovery evidence.

### Design Notes

- Message bodies use a readable measure and no ambient preview outside the thread.
- Evidence lives in a collapsible rail, not mixed into the conversation.

### Technical Notes

- Use prepared D1 statements and bounded message counts.
- HTML mail must be sanitized or rendered as text until a safe renderer exists.

### Dependencies

| Dependency | Type | Status |
| --- | --- | --- |
| US-001 | Story | Planned |
| Message parser/sanitizer | Runtime | Not complete |

### Out of Scope

- Remote images
- Attachment preview
- Arbitrary HTML rendering

### Open Questions

- [ ] Should the first release render plain text only?

## US-003 — Compose With an Authorized Identity

### Story Header

| Field | Value |
| --- | --- |
| ID | US-003 |
| Persona | Edge Mail Operator |
| Priority | P0 |
| Epic/Feature | Reply composer |
| Estimate | Medium |

### User Story Statement

**As an** edge mail operator, **I want** the composer to default to the router-authorized reply identity **so that** I preserve the original domain story without relying on memory or convention.

### Context & Background

The identity selector is a security control, not decoration. The server must authorize the operator, route, and requested identity before a reply job is accepted.

### Acceptance Criteria

**Given** an authorized operator opens a thread, **when** the composer appears, **then** the policy-selected identity is visible and selected by default.

**Given** the operator requests another allowed identity, **when** authorization succeeds, **then** the composer clearly reflects the approved identity.

**Given** an identity is not allowed, **when** the operator attempts to use it, **then** the request is rejected and no job is queued.

### Design Notes

- Keep From identity adjacent to the primary action.
- Separate “Queue reply” from delivery status.

### Technical Notes

- Reuse the Rust router authorization path through the existing API boundary.
- Persist/queue before sending; delivery is asynchronous.

### Dependencies

| Dependency | Type | Status |
| --- | --- | --- |
| Router reply authorization | Domain contract | Ready |
| Authenticated operator context | Auth | Open |

### Out of Scope

- Rich text editing
- Scheduled send
- Bulk replies

### Open Questions

- [ ] Which sender mode is enabled in the private launch instance?

## US-004 — Inspect Readiness and Audit Evidence

### Story Header

| Field | Value |
| --- | --- |
| ID | US-004 |
| Persona | Edge Mail Operator |
| Priority | P0 |
| Epic/Feature | Trust and operations |
| Estimate | Small |

### User Story Statement

**As an** edge mail operator, **I want** readiness and audit evidence labeled by proof plane **so that** I know whether a state is source intent, local proof, deployed edge state, or targeted mail proof.

### Context & Background

The product uses four readiness levels and must not collapse them into one green badge.

### Acceptance Criteria

**Given** any readiness result, **when** it is displayed, **then** its evidence class, timestamp or freshness, and unresolved blockers are visible.

**Given** a reply is queued, **when** the operator inspects audit history, **then** authorization, send attempt, and delivery/failure remain distinct events.

**Given** no live readback exists, **when** readiness is shown, **then** the product labels it unverified rather than inferring success from source configuration.

### Design Notes

- Use a four-step evidence rail with explicit labels.
- Never rely on green/red alone.

### Technical Notes

- Audit detail must avoid secrets and unnecessary message content.
- Live cfctl receipts remain external evidence; tracked docs must not embed them.

### Dependencies

| Dependency | Type | Status |
| --- | --- | --- |
| Readiness endpoint | API | Ready |
| Audit projection | API/server boundary | Planned |

### Out of Scope

- Editing Cloudflare resources from the desk
- Broad mail probes

### Open Questions

- [ ] Which live evidence metadata can be safely projected into the desk?

## INVEST Review

Each story produces an independently reviewable user capability, stays negotiable on implementation, connects to operator value, has bounded first-release scope, and carries observable pass/fail criteria. US-003 depends on authenticated context but remains separable from visual implementation.
