---
artifact: okr-set
mode: Guided
status: draft
created: 2026-08-05
---

# Operator Desk Production OKRs

## Context

- **Scope:** product initiative
- **Cycle:** launch window; dates to be established before scoring
- **OKR type:** learning with committed safety and operational-health guardrails
- **Empowerment signal:** mixed — the stack and production intent are committed, while implementation bets may change if evidence does not move
- **Strategic intent:** turn the existing routing and provisioning substrate into a trustworthy operator workflow without collapsing template, instance, edge, and mail readiness
- **source_of_truth:** not yet established; the launch owner must nominate the live OKR tracker before cycle start

## Objective

### Make domain mail understandable and safe to operate from one calm edge-native desk

## Key Results

### KR1 — Operators complete the core triage-to-authorized-reply workflow

- **Metric definition:** percentage of observed target-operator sessions that can open an assigned thread, identify the routing and reply identity, compose a response, and reach the protected send gate without assistance
- **Baseline:** recommended-to-measure; no operator UI exists
- **Target:** placeholder pending the first five baseline sessions; do not score until owner sets it
- **Deadline:** end of the named launch window
- **Evidence source:** moderated task sessions and product event ledger
- **Owner:** Product and operator-experience maintainers
- **Indicator class:** leading
- **Confidence:** low — no behavioral baseline exists

### KR2 — The desk reduces time-to-understand an actionable mail state

- **Metric definition:** median elapsed time from desk load to correctly identifying the highest-priority actionable thread and its current readiness or failure state
- **Baseline:** recommended-to-measure
- **Target:** placeholder pending instrumented baseline
- **Deadline:** end of the named launch window
- **Evidence source:** server-timing/event instrumentation plus moderated session notes
- **Owner:** Product and engineering
- **Indicator class:** leading
- **Confidence:** low

### KR3 — Safety and evidence invariants hold for every production interaction

- **Metric definition:** count of unauthorized data reads, unauthorized reply attempts accepted, secret-bearing logs, identity mismatches, or readiness overclaims
- **Baseline:** expected zero; must be verified, not assumed
- **Target:** zero observed violations across local security proof and the production verification window
- **Deadline:** continuous through launch close
- **Evidence source:** security tests, audit-event queries, cfctl verification, and targeted live readback
- **Owner:** Security and engineering
- **Indicator class:** guardrail
- **Confidence:** medium — repository controls exist, but the UI surface is new

## Initiatives as Bets

| Initiative | KRs | Assumption |
| --- | --- | --- |
| Leptos Router shell with public explanation and protected desk | KR1, KR2 | A clear task hierarchy reduces time-to-understand without hiding evidence |
| Authenticated thread, identity, and audit projections | KR1, KR3 | Server-derived projections can keep sensitive data and authorization out of browser-owned state |
| Explicit readiness ladder and identity-before-send composer | KR1, KR3 | Visible proof state prevents mistaken readiness and sender selection |
| Local accessibility, security, and exact-tree release gates | KR2, KR3 | Fail-closed proof catches trust regressions before production |

## Guardrails and Health Checks

- KR3 is a separate committed guardrail and must never be averaged into adoption or speed results.
- No broad live email smoke test is an acceptable success metric.
- Page performance, queue health, and error rates remain operational-health checks even when the learning objective is met.

## Alignment Notes

- Parent strategy: `NORTH_STAR.md` and `docs/architecture/template-standard.md`.
- Provider: the public `maildesk-cf` template owns reusable source and contracts.
- Consumer: a private instance owns real identities, domains, account IDs, secrets, deployment receipts, and final live proof.
- Dependencies: Cloudflare Access posture, real D1/R2/Queue bindings, current `cfctl` capability resolution, and a nominated measurement owner.

## Disclosure

This OKR set frames pre-committed Leptos and production work as outcome bets. If the work ships but the metrics do not move, that is learning rather than proof of product success. Delivery status and outcome status remain separate.

## Quality Audit

| Criterion | Rating | Rationale / recommendation |
| --- | --- | --- |
| Strategic fit | pass | Directly tied to the repo's operator-desk milestone and readiness doctrine |
| Objective quality | pass | Names a user and safety state, not a project |
| KR outcome quality | pass | Measures task success, understanding, and safety rather than feature shipment |
| Measurement quality | risk | Baselines and targets need an owner and initial sessions before cycle start |
| Product influence | pass | The team controls workflow, projections, and safeguards |
| Focus | pass | One objective and three KRs |
| Guardrails | pass | Safety/evidence is explicit and separate |
| Alignment | pass | Public provider, private consumer, and Cloudflare dependencies are named |
| Operating rhythm | risk | Launch window and check-in cadence remain unset |
| Integrity | pass | No fabricated values or compensation coupling |
| Empowered-team disclosure | pass | Included for mixed signal |

## Open Questions

- Who owns the live OKR tracker and instrumentation?
- What launch-window dates determine observation and score timing?
- Which five operators form the first baseline cohort?

## Suggested Next Step

Nominate the source-of-truth tracker and cohort, then measure the KR1 and KR2 baselines before committing numeric targets.
