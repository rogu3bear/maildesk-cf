# Technical Debt

## Debt Ledger

| Item | Location | Type | Risk | Effort | Priority | Status |
|---|---|---|---|---|---|---|
| Rust unit tests were absent from local CI | `scripts/ci.sh` | safety net | Rust authorization regressions could pass the documented gate | small | P0 | done 2026-08-05 |
| Reply server function mixed normalization, D1 projection, policy reconstruction, and Queue submission | `src/server/desk.rs` | testability / module depth | A high-consequence path was difficult to characterize without Worker bindings | medium | P0 | pure reconstruction seam extracted 2026-08-05 |
| Protected-path knowledge exists in TypeScript and Rust | `workers/ui/access.ts`, `src/lib.rs` | duplicated knowledge | Drift can expose or incorrectly block desk routes | small | P1 | contract test planned |
| Operator-scoped D1 query behavior lacks a local integration fixture | `src/server/desk.rs` | test gap | SQL regressions may appear only after deployment | medium | P1 | backlog |
| Outbound failure policy lacked a provider-specific recovery contract | `workers/mail-api/src/index.ts`, runtime docs | reliability contract | Retryable sends could be stranded or ambiguous sends replayed | medium | P0 | done 2026-08-05; bounded Resend retries and deliberate Cloudflare recovery |
| Normal cargo wrapper cannot start `sccache` in the restricted execution lane | host cargo gate | proof infrastructure | Full CI can report a tooling failure before evaluating code | external | P2 | host-lane proof required |

## Smell Inventory

| Smell | Location | Refactoring | Status |
|---|---|---|---|
| Mixed abstraction levels in authorized reply orchestration | `src/server/desk.rs::queue_reply` | Extract Function | done: route reconstruction isolated and tested |
| Duplicated protected-path predicate | Rust/TypeScript Access adapters | Introduce shared contract fixture, not a cross-language runtime dependency | planned |

## Sprout / Wrap Register

No sprouted production code is registered. New seams must be folded into the owning module once the characterization boundary is stable.

## Debt Budget & Broken-Windows Policy

Reserve 15% of each release slice for P1/P2 debt. P0 safety, authorization, or
truthfulness gaps are fixed immediately or block the release:

- P0 safety or authorization gaps block release work.
- P1 items must be fixed or explicitly dispositioned before release.
- No untracked `TODO`, `FIXME`, or commented-out bypass is accepted.
- Found behavioral quirks are pinned and ledgered before any separate fix.

## Adopted Conventions

- Fail closed on unknown identities, routes, configuration, and provider state.
- Keep router policy framework-free and independently testable.
- Keep structural and behavioral changes independently reviewable.
- Do not use `unwrap`, `expect`, `panic`, unsafe code, or secret-bearing diagnostics in production Rust.
- Bound D1 result sets and user-controlled payload sizes.
- Keep source, local proof, deployment, and authenticated live readback as separate evidence planes.
