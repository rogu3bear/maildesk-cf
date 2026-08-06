# Remove Technical Debt Plan

## Context

- Evaluated: 2026-08-05
- Applicability verdict: deferred in favor of `improve-code-quality`
- Repository profile: young, approximately 13,000 source/test/script lines, active tests, and no proposed big-bang rewrite
- Retained guardrails: cover before modifying, pin found bugs, use one debt ledger, avoid rewrites, and keep structural and behavioral commits separate

## Phase Status

| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1 | working-with-legacy-code | deferred: covered by improve-code-quality Phase 1 | TESTING.md + TECH-DEBT.md | 2026-08-05 |
| 2 | refactoring-patterns | deferred: routed to improve-code-quality Phase 3 | TECH-DEBT.md | 2026-08-05 |
| 3 | clean-code | deferred: routed to improve-code-quality Phase 2 | TECH-DEBT.md | 2026-08-05 |
| 4 | software-design-philosophy | deferred: routed to improve-code-quality Phase 4 | TECH-DEBT.md | 2026-08-05 |
| 5 | clean-architecture | deferred: routed to improve-code-quality Phase 5 | ARCHITECTURE.md | 2026-08-05 |
| 6 | pragmatic-programmer | deferred: routed to improve-code-quality Phase 6 | TECH-DEBT.md | 2026-08-05 |
| 7 | release-it | deferred: routed to improve-code-quality Phase 7 | RELIABILITY.md | 2026-08-05 |
| 8 | domain-driven-design | deferred: no monolith or context-carving need | ARCHITECTURE.md | 2026-08-05 |

Statuses: pending · in-progress · awaiting-evidence · done · deferred: reason · skipped: reason

## Key Decisions

| Date | Phase | Decision | Rationale |
|---|---|---|---|
| 2026-08-05 | Applicability | Do not run a parallel legacy-code transformation journey | It would duplicate the correct young-prototype path and create competing trackers |
| 2026-08-05 | Guardrail | Preserve the no-rewrite and single-purpose-change rules | Those protections remain useful regardless of repository age |

## Next Actions

- [ ] Reassess only if age, churn, tangling, or fear-driven rewrite pressure materially changes (Repository owner, future review).
