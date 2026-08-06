---
artifact: launch-checklist
version: "1.0"
created: 2026-08-05
status: draft
---

# Launch Checklist: maildesk-cf Operator Experience

## Launch Overview

| Field | Value |
| --- | --- |
| What | Public reusable Leptos operator template plus private Cloudflare production consumer |
| Launch Date | TBD after security and production-plan approval |
| Launch Type | Major release |
| Launch Owner | Repository owner |
| Go/No-Go Decision Maker | Repository owner |

### Key Stakeholders

| Role | Name | Contact |
| --- | --- | --- |
| Product | Repository owner | Existing project channel |
| Engineering | Implementation owner | Existing project channel |
| Design | Product/design reviewer | TBD |
| Security | Security reviewer | TBD |
| Operations | Cloudflare account owner | Existing project channel |

## Engineering Readiness

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [x] Leptos vertical slice complete | Engineering | Before go/no-go | Complete locally | Public shell plus protected desk |
| [ ] Exact-tree review complete | Engineering | Before go/no-go | Open | Bind full SHA and dirty state |
| [ ] D1 migrations compatible | Engineering | Before go/no-go | Open | Public schema and private ledger |
| [x] API/server projections documented | Engineering | Before go/no-go | Complete locally | Thread, identity, audit |
| [ ] Performance budget passes | Engineering | Before go/no-go | Open | Record baseline before claiming |

## QA & Testing

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [x] Rust, Worker, and script suites pass | Engineering | Before go/no-go | Complete locally | 56 Bun tests; Rust tests and warnings-as-errors pass |
| [x] Cargo-Leptos production build passes | Engineering | Before go/no-go | Complete locally | Hashed assets and Worker shim verified |
| [x] Route and deep-link tests pass | QA | Before go/no-go | Complete locally | Public routes return 200; protected route fails closed without Access config |
| [ ] Keyboard, zoom, contrast, reduced-motion checks pass | Design/QA | Before go/no-go | Open | Accessibility blocker |
| [ ] Security review and threat-model actions close | Security | Before go/no-go | Open | High findings block |

## Design & UX

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [ ] Message hierarchy approved | Product | Before merge | Open | One primary action per context |
| [x] Design system and responsive states verified | Design | Before go/no-go | Complete locally | Desktop and fresh 390px Safari review; no page overflow |
| [ ] Empty, loading, denied, partial, and failed states verified | QA | Before go/no-go | Open | No happy-path-only launch |
| [x] Claims remain evidence-backed | Product | Before merge | Complete locally | Hypotheses and live proof remain explicitly distinguished |

## Marketing & Communications

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [x] Public positioning and README agree | Product | Before merge | Complete locally | Identity router, not generic helpdesk |
| [ ] Screenshots reflect template-safe data | Design | Before launch | Open | Reserved domains only |
| [ ] Release notes distinguish template and private deployment | Product | Before launch | Open | No mail-ready overclaim |

## Customer Support

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [ ] Operator getting-started path updated | Product | Before launch | Open | Access, policy, bindings |
| [ ] Failure and escalation runbook updated | Operations | Before launch | Open | Queue, storage, sender |
| [ ] Recovery ownership named | Operations | Before launch | Open | No generic “contact support” |

## Legal & Compliance

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [ ] Privacy/data-retention posture reviewed | Owner | Before production | Open | Email content is sensitive |
| [ ] Open-source licensing and notices pass | Engineering | Before merge | Open | Public template |
| [ ] Accessibility posture reviewed | Design | Before launch | Open | WCAG-oriented checks |

## Operations & Infrastructure

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [ ] Private production preflight passes | Operations | Before plan | Open | No placeholder IDs |
| [ ] cfctl current-state read and capability guide complete | Operations | Before plan | Open | No mutation yet |
| [ ] D1, R2, Queue, Workers, Access, DNS bindings verified | Operations | Before deploy | Open | Live readback |
| [ ] Previous Worker version and rollback path identified | Operations | Before deploy | Open | Target-specific |
| [ ] Incident owner and observation window confirmed | Operations | Before deploy | Open | Brief tail/readback |

## Analytics & Monitoring

| Item | Owner | Due | Status | Notes |
| --- | --- | --- | --- | --- |
| [ ] KR event definitions approved | Product | Before baseline | Open | No fabricated metrics |
| [ ] Worker errors and queue failures observable | Operations | Before deploy | Open | Sensitive data excluded |
| [ ] Post-deploy health/readiness readback prepared | Operations | Before deploy | Open | Version/build provenance included |

## Go/No-Go Criteria

### Must Have (Blockers)

- [ ] Exact intended public and private trees pass their documented release gates.
- [ ] No unresolved critical/high threat and no unapproved security-policy exclusion.
- [ ] Authenticated operator scope fails closed; thread and reply authorization tests pass.
- [ ] Production preflight has no placeholder identifiers or missing required secret names.
- [ ] The cfctl plan is current, reviewed, and explicitly approved by operation ID.
- [ ] Rollback target and post-deploy verification are ready.

### Should Have

- [ ] Five operator sessions establish initial usability baselines.
- [ ] Performance budgets meet recorded targets on public and desk routes.
- [ ] Launch screenshots and release notes are ready.

### Nice to Have

- [ ] Attachment preview.
- [ ] Full-text search and analytics.

## Rollback Plan

### Trigger Conditions

- Authentication or authorization regression.
- Sensitive data exposure or incorrect reply identity.
- Sustained server error/readiness failure after deploy.
- Migration incompatibility or queue failure affecting accepted mail.

### Rollback Steps

1. Disable or withdraw the new operator route while preserving the inbound mail path.
2. Use the target-specific cfctl/Worker rollback plan for the previously verified version.
3. Verify health, readiness, bindings, and one bounded read path after rollback.
4. Record the failed evidence plane and required remediation without replaying protected actions.

### Rollback Owner

Cloudflare account owner — contact through the existing project channel.

### Rollback Time Estimate

To be measured during the staging/preview rehearsal; unknown until then.

## Check-in Schedule

| Checkpoint | Date | Attendees |
| --- | --- | --- |
| Engineering/security readiness | TBD | Product, engineering, security |
| Production plan review | After preflight | Owner, operations |
| Launch approval | Exact operation-ID review | Owner, operations |
| Post-deploy readback | Immediately after apply | Engineering, operations |
| Observation review | T+1 business day | Product, engineering, operations |

## Open Issues

| Issue | Owner | Status | Impact |
| --- | --- | --- | --- |
| Production route and Access policy unconfirmed | Owner | Open | Blocker |
| Private outbound sender mode unconfirmed | Owner | Open | Blocker for mail-ready |
| Customer/operator research absent | Product | Open | Outcome-confidence risk |
| SECURITY.md requires owner approval before write | Owner | Open | Security gate |
