# Testing

## Test Strategy

Maildesk uses a risk-shaped pyramid:

1. Pure Rust tests own routing, policy validation, reply authorization, and server-boundary normalization.
2. Bun Worker tests pin Cloudflare adapter behavior, persistence ordering, fail-closed Access verification, and protected-action confirmation gates.
3. Build and template checks pin the Leptos/WASM integration and public-template hygiene.
4. Production preflight and targeted live readback remain separate from source and local-test proof.

A green local safety gate requires formatting, warnings-as-errors, all-feature Rust tests, TypeScript typechecking, Worker tests, script tests, and template hygiene. Tests must use reserved example data and must not require Cloudflare credentials.

Phase 1 pinch points are the Rust router authorization function, the UI Access adapter, the Rust Worker admission boundary, and the server-side reply-input normalization immediately before D1/Queue effects.

## Safety Net Map

| Module | Pinned behaviors | Test files | Gaps |
|---|---|---|---|
| `crates/maildesk-router` | route matching, policy validation, operator membership, default and requested reply identity, typed adapter errors | inline Rust tests in `crates/maildesk-router/src/lib.rs` | No known gap in the first-release identity contract |
| `workers/ui/access.ts` | protected path boundary, strict team origin, missing config/assertion rejection, verified email replacement, invalid JWT/identity rejection | `tests/workers/ui-access.test.ts` | Real JWKS fetch is intentionally outside local tests; cache behavior is not characterized |
| `src/lib.rs` | CSP nonce policy, protected route boundary, same-origin POST gate, rejection of unvalidated Access headers | inline Rust tests in `src/lib.rs` | Full Worker request/response integration remains build-level only |
| `src/server/desk.rs` | bounded input normalization, stored-row mapping, fail-closed route reconstruction, and router authorization before Queue submission | inline Rust tests in `src/server/desk.rs` plus router tests | Live D1/Queue integration remains a separate deployment/readback plane |
| inbound and legacy reply Workers | policy adaptation, persistence ordering, audit behavior, reply-mode gating | `tests/workers/mail-router.test.ts`, `tests/workers/mail-api.test.ts` | Live D1/R2/Queue behavior remains a deployment/readback proof plane |
| operational scripts | preflight, cfctl desired-state validation, proof planning, protected acknowledgments, targeted probe confirmation | `tests/scripts/*.test.ts` | Provider mutation and live mail probes are intentionally excluded from local CI |

## Characterization Backlog

- [x] Pin `src/server/desk.rs` mailbox, identifier, subject, body, and stored-row normalization (high risk, P0).
- [x] Pin the pure reconstruction of the router decision used by reply authorization before extracting it (high risk, P0).
- [ ] Add a contract test that the TypeScript and Rust protected-path predicates accept the same boundary cases (medium risk, P1).
- [ ] Add a bounded D1 fixture/integration lane for operator-scoped thread projection (high risk, P1; requires a template-safe Worker test seam).

## CI Gates

```bash
bun run ci
```

The canonical local CI must include:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --all-features
bun run typecheck
bun run test:workers
bun run test:scripts
bash scripts/check-template.sh
```

On this host, the normal cargo wrapper may be unable to start `sccache` inside a restricted sandbox. The exact-tree repository gate passed with `CARGO_GATE_BYPASS=1 RUSTC_WRAPPER=`; this changes only the host execution wrapper, not the checks executed by `bun run ci`.
