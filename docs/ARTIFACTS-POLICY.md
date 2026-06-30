# Artifact Policy

`maildesk-cf` is a public template. Runtime evidence, generated builds, local
dependencies, and account-specific receipts must stay out of tracked source.

## Classified Paths

| Path | Class | Policy |
| --- | --- | --- |
| `var/` | operator runtime and proof evidence | Ignored. May contain generated receipts, live evidence readbacks, proof plans, and local cargo-gate logs. Do not commit contents. |
| `target/` | Rust build output | Ignored. Rebuild from source. |
| `node_modules/` | JavaScript dependency install | Ignored. Recreate with `bun install`. |
| `reports/` | optional generated reports | Ignored if created by local tools. Treat as evidence artifacts, not template source. |

## Receipts

Live receipts must not be committed. Store them under `var/` or another ignored
operator-controlled path. Public examples should use reserved documentation
domains only.

## Release Evidence

Template proof may cite commands and generated file paths, but source changes
should include only reusable code, docs, fixtures, schemas, and configuration
with placeholder resource IDs.
