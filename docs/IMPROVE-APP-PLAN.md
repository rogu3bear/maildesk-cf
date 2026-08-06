# Improve App Plan

## Context

- Started: 2026-08-05
- App: Leptos web operator desk for triaging shared-domain mail and authorizing replies
- Job hypothesis: understand why a message arrived, what identity is safe, and what action is proven
- Roughest and highest-risk flow: Access admission through identity authorization and reply queueing
- Evidence: local rendered desktop/mobile review and automated route/state tests; no operator analytics, recordings, or support data
- Platform: web on Cloudflare Workers
- Upsell surfaces: none; no pricing, scarcity, or social-proof claims are authorized
- Entry condition: begin Phase 1 after the code-quality safety net and production boundaries are credible

## Phase Status

| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1 | jobs-to-be-done | done | CUSTOMER.md | 2026-08-05 |
| 2 | ux-heuristics | done | DESIGN.md, EXPERIMENTS.md | 2026-08-05 |
| 3 | design-everyday-things | done | DESIGN.md, EXPERIMENTS.md | 2026-08-05 |
| 4 | refactoring-ui | done | DESIGN.md, EXPERIMENTS.md | 2026-08-05 |
| 5 | microinteractions | done | DESIGN.md, EXPERIMENTS.md | 2026-08-05 |
| 6 | made-to-stick | done | POSITIONING.md, EXPERIMENTS.md | 2026-08-05 |
| 7 | influence-psychology | skipped: no paywall, upgrade, scarcity, or social-proof surface | POSITIONING.md, EXPERIMENTS.md | 2026-08-05 |
| 8 | high-perf-browser | awaiting-evidence | DESIGN.md, EXPERIMENTS.md | 2026-08-05 |
| 9 | steve-jobs-design-review | done: local experience passes; release does not | PRODUCT.md, DESIGN.md, EXPERIMENTS.md | 2026-08-05 |

Statuses: pending · in-progress · awaiting-evidence · done · deferred: reason · skipped: reason

## Key Decisions

| Date | Phase | Decision | Rationale |
|---|---|---|---|
| 2026-08-05 | Ordering | Run product experience after the code-quality and reliability boundary | A polished unsafe flow is not a completed product |
| 2026-08-05 | Scope | Skip persuasion psychology | The first release has no commercial decision surface and must not invent one |
| 2026-08-05 | Evidence | Permit only Phase 1–3 findings to authorize UI or copy changes | Existing product claims and visual work are provisional pending operator evidence |
| 2026-08-05 | 1 | Treat emotional certainty as the weakest dimension and repeated triage as the Little Hire | The product can perform a local action while still overstating provider or recovery truth |
| 2026-08-05 | 2 | Fix every severity-4 truth/identity issue now and ledger live integration separately | Wrong sender expectations and false retry/readiness claims are release-consequence defects |
| 2026-08-05 | 3 | Replace the single-option selector with an immutable policy result | The server currently authorizes one identity; a choice control is a false affordance |
| 2026-08-05 | 4 | Stay inside the established editorial control-room system | Existing tokens, hierarchy, and responsive grid are coherent; visual proof should tune rather than redesign |
| 2026-08-05 | 5 | Polish reply authorization and desk refresh before decorative motion | They are repeated operator actions and carry meaningful state |
| 2026-08-05 | 6 | Make each operator screen state one actionable truth | Concrete state language is more valuable than architecture vocabulary inside the workflow |
| 2026-08-05 | 8 | Hold performance at awaiting-evidence until rendered and field baselines exist | Asset/build success cannot establish INP, LCP, or CLS |
| 2026-08-05 | 4 | Treat every declared route as its own visual-review page | The pass found the thread path encoded as one static segment and therefore unreachable |
| 2026-08-05 | 9 | Verdict: locally polished, not release-ready | Five routes pass desktop/mobile layout review, but Access readback, outbound recovery, alerts, and field performance remain unproven |
| 2026-08-05 | 9 | Cut false choices and false retry language; add no new feature surface | Subtraction protects the core job better than expanding a template before its private proof exists |

## Next Actions

- [x] Confirm the product-free job statement and emotional certainty as the weakest dimension (Product, Phase 1).
- [x] Audit the core operator flow and fix severity-4 identity/truth issues (Product/Design, Phases 2–3).
- [x] Record every shipped experience change as a pre-committed experiment (Product, all phases).
- [x] Complete desktop/mobile rendered review of every route (Design, Phases 4–5).
- [ ] Capture INP/LCP/CLS baselines on the deployed private instance (Engineering, Phase 8).
- [x] Run the final cold review and disposition the cut list (Product, Phase 9).
