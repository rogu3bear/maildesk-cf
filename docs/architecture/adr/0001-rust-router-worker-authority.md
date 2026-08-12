# ADR 0001: Run Router Policy In Workers Through Rust WASM

- Status: accepted
- Date: 2026-07-09

## Context

`maildesk-cf` defines the Rust router as the authority for alias matching,
recipient selection, reply identity, and outbound authorization. The initial
Worker skeleton duplicated those decisions in TypeScript, so the documented
boundary and the deployed boundary could drift independently.

The router is pure domain logic. Cloudflare event parsing, bindings, storage,
queues, and sender-provider calls remain edge-adapter concerns.

## Decision

Compile `crates/maildesk-router` to an in-process WebAssembly module and import
it from both TypeScript Workers.

- Rust exports string-in/string-out JSON adapter functions for inbound routing
  and reply authorization.
- `workers/shared/router.ts` is the only TypeScript translation boundary. It
  maps Worker-shaped fields to the Rust contract and validates the returned
  envelope; it does not make policy decisions.
- Generated WASM and glue stay ignored. `scripts/build-router-wasm.ts`
  recreates them before typechecking, Worker tests, and Wrangler bundling.
- Adapter errors preserve stable kinds and human-readable Rust errors. Invalid
  policy or adapter output fails closed.
- Both Workers retain TypeScript for Cloudflare APIs, persistence, forwarding,
  queue handling, and sender adapters.

Wrangler imports `.wasm` as a compiled module in Workers. The build script
patches the `wasm-bindgen` entrypoint to instantiate that module in workerd and
the generated file path under Bun tests. This follows Cloudflare's documented
WASM-in-JavaScript integration and its required `wasm-bindgen` glue adjustment:

- <https://developers.cloudflare.com/workers/languages/rust/>
- <https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/>

## Alternatives Considered

### Keep parallel TypeScript policy implementations

Rejected. It makes the Rust core advisory, duplicates security-sensitive
authorization logic, and requires permanent cross-language parity work.

### Deploy the router as a separate Rust Worker

Rejected for this boundary. A service binding would add latency, provisioning,
and a new runtime failure mode to pure in-process computation.

### Rewrite both edge adapters in Rust

Deferred. It would broaden this architectural correction into a full runtime
migration without improving the policy boundary further.

## Consequences

- `wasm-pack`, `wasm-bindgen`, and the `wasm32-unknown-unknown` target are build
  requirements.
- The pinned `wasm-bindgen` library and generated glue must move together.
- The Worker bundle grows by the router module; current dry runs remain small
  at about 70 KiB gzipped per Worker.
- Router changes now reach both inbound and outbound runtime paths through one
  implementation and one testable contract.
- Cloudflare mutation, deployment, and live mail proof remain outside this ADR.

## Proof

```bash
bun run build:router-wasm
bun run test:workers
cargo test -p maildesk-router
bunx wrangler deploy --dry-run --config wrangler.toml
bunx wrangler deploy --dry-run --config deploy/mail-router/wrangler.toml
```
