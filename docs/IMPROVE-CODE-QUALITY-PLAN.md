# Improve Code Quality Plan

## Context

- Started: 2026-08-05
- Product: public Cloudflare-native mail desk template with a private production consumer
- Stack: Rust, Leptos Router, Cloudflare Workers, D1, R2, Queues, Bun, and TypeScript
- Starting boundary: Access admission, operator-scoped D1 projection, and authorized reply queueing
- Worst credible failures: unauthorized access to sensitive mail or a reply sent from an unauthorized identity
- Current production status: local vertical slice; private deployment and mail-ready proof remain blocked
- Current load: no production user or request baseline; scaling phases remain requirements-gated
- Execution mode: constituent phase skills are unavailable, so the journey uses their bundled fallback briefs

## Phase Status

| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1 — Build the safety net | working-with-legacy-code | done | TESTING.md + TECH-DEBT.md (GATE) | 2026-08-05 |
| 2 — Make the code readable | clean-code | done | TECH-DEBT.md | 2026-08-05 |
| 3 — Apply named refactorings | refactoring-patterns | done | TECH-DEBT.md | 2026-08-05 |
| 4 — Reduce complexity | software-design-philosophy | done | TECH-DEBT.md | 2026-08-05 |
| 5 — Draw the architecture boundary | clean-architecture | done | ARCHITECTURE.md | 2026-08-05 |
| 6 — Lock in the habits | pragmatic-programmer | done | TECH-DEBT.md | 2026-08-05 |
| 7 — Make it survive production | release-it | awaiting-evidence | RELIABILITY.md | 2026-08-05 |
| 8 — Size for real load | system-design | deferred: no production load baseline | ARCHITECTURE.md + RELIABILITY.md | 2026-08-05 |
| 9 — Get the data layer right | ddia-systems | deferred: production concurrency requirements unknown | ARCHITECTURE.md | 2026-08-05 |
| Optional — Domain language | domain-driven-design | deferred: current bounded model is small and explicit | ARCHITECTURE.md | 2026-08-05 |

Statuses: pending · in-progress · awaiting-evidence · done · deferred: reason · skipped: reason

## Key Decisions

| Date | Phase | Decision | Rationale |
|---|---|---|---|
| 2026-08-05 | Routing | Lead with improve-code-quality; defer the legacy-debt journey | The checkout is a young implementation with an active test suite, not a large aged codebase |
| 2026-08-05 | 1 | Start at Access and authorized reply boundaries | Authentication and sender identity carry the highest consequence if broken |
| 2026-08-05 | 1 | Pin observed quirks and ledger bugs instead of silently fixing them | Structural and behavioral changes must remain independently reviewable |
| 2026-08-05 | Scope | Complete Phases 1–7; requirements-gate Phases 8–9 | Production hardening is required before launch; speculative scale machinery is not |
| 2026-08-05 | 2 | Score `queue_reply` 3/5 and fix mixed abstraction levels first | Names and guards were clear; persisted-state reconstruction obscured the authorization seam |
| 2026-08-05 | 3 | Extract `route_decision_for_thread` | The pure persisted-row adapter can now fail closed under direct tests without introducing a new service layer |
| 2026-08-05 | 4 | Add no further abstraction | The small adapter becomes easier to understand after one extraction; new service/repository layers would add indirection without hiding complexity |
| 2026-08-05 | 5 | Preserve the inward dependency rule around the router | UI and provider adapters translate facts but never authorize identities |
| 2026-08-05 | 6 | Reserve 15% of release slices for P1/P2 debt and block on P0 | The policy is concrete enough to prevent invisible backlog growth without over-planning a young codebase |
| 2026-08-05 | 7 | Make timeout and retry semantics explicit | Resend uses bounded idempotent Queue retries; ambiguous Cloudflare outcomes require deliberate recovery |

## Next Actions

- [x] Pin server-side normalization and authorization-adapter behavior (Engineering, Phase 1).
- [x] Add the complete Rust test suite to local CI (Engineering, Phase 1).
- [x] Run the exact-tree safety gate and close or ledger every gap (Engineering, Phase 1).
- [x] Complete the readability audit after the Safety Net Map covers every touched module (Engineering, Phase 2).
- [x] Prove the named refactoring against focused Rust tests (Engineering, Phase 3).
- [x] Resolve the outbound recovery release blocker with provider-specific retry and recovery semantics (Product + Engineering, Phase 7).
- [ ] Establish live alerting and provider-readback evidence (Operations, Phase 7).
