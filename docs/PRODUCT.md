# Product

## Vision

Give small technical teams one calm, Cloudflare-native place to understand why
shared-domain mail reached them, use the correct reply identity, and distinguish
source intent, deployed state, and actual mail outcomes.

## MVP Definition

The MVP is a public, buildable template plus a private operator instance: a Rust
router, Cloudflare adapters, D1/R2/Queue contracts, an Access-protected Leptos
desk, identity-authorized reply queueing, audit evidence, and governed `cfctl`
provisioning. It deliberately excludes a full mailbox client, rich MIME display,
large-team helpdesk features, broad provider fallbacks, and commercial upsells.

## Outcome Roadmap

| Outcome / problem | Job served | Priority | Status |
|---|---|---|---|
| Operator can reach every declared page at desktop and mobile widths | Repeated triage | P0 | Done locally; five-route rendered review |
| Only the authorized reply identity looks actionable | Safe reply identity | P0 | Done locally; server remains final authority |
| Access identity and private thread scope are proven live | Confidential triage | P0 | Blocked on least-privilege Access read capability and private readback |
| Outbound failures have a reviewed retry or deliberate-recovery state machine | Trustworthy completion | P0 | Done locally; bounded Resend retry and Cloudflare recovery state |
| Incomplete outbound transitions are visible without exposing content | Accountable operations | P0 | Done in thread audit; desk-level count remains P1 |
| Desk evidence panel consumes runtime readiness truth | Honest readiness | P1 | Backlog |
| Operator-scoped D1 queries have a local binding fixture | Safe projection changes | P1 | Backlog |
| INP/LCP/CLS meet the documented targets | Fast repeated use | P1 | Awaiting deployed field baseline |

## Opportunity Solution Tree Notes

- Outcome: no unauthorized mail access → verified Access JWT, protected path
  contract, same-origin mutation gate, operator-scoped D1 queries.
- Outcome: no incorrect sender identity → visible immutable identity, router
  authorization, provider-domain verification, auditable result.
- Outcome: no false reassurance → four proof planes, precise queued/attempted/
  delivered language, provider readback, incomplete-transition recovery.

## Hook Model

Trigger: assigned shared-domain mail needs judgment → Action: open the attention
queue and inspect route context → Variable reward: resolve a real external
question with the right identity → Investment: leave an auditable thread state.
The weakest phase is the trigger because notification and recovery views are not
implemented; no engagement mechanic should be added before that operational gap.

## Activation & Retention Plan

| Friction / moment | Fix | Owner | Status |
|---|---|---|---|
| Private setup can appear complete before Access/provider proof | Keep four readiness planes and governed preflight | Product + Operations | In progress |
| Single identity looked selectable | Render policy output as read-only | Engineering | Done locally |
| Thread route was unreachable | Correct segmented Leptos route | Engineering | Done locally |
| Recovery-required sends lack a desk-level aggregate | Add a non-content recovery count above the existing thread audit action | Engineering + Operations | P1 backlog |

## Discovery Cadence

Run one observed operator session weekly after the private instance is available.
Alternate a cold triage/reply task with a failure/recovery task; record only
behavioral findings and pre-committed experiment results, never mail content.
