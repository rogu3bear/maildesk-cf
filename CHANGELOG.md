# Changelog

Notable changes to `maildesk-cf` are recorded here. The project follows
Semantic Versioning once a release is tagged.

## [0.1.0] - 2026-08-05

### Added

- A Cargo-Leptos public site and operator desk with responsive navigation,
  explicit loading and failure states, and protected thread and reply routes.
- Cloudflare Access JWT verification for operator routes, with bounded JWKS
  caching, timeouts, and failure cooldowns.
- D1, R2, Queue, and outbound-provider adapters for the operator workflow,
  backed by Rust routing and reply-identity policy.
- Template-safe Cloudflare UI and Access desired-state documentation, build
  scripts, and release-readiness guidance.

### Changed

- Worker and UI behavior now preserve a single policy-authorized reply identity
  and expose delivered, retry-scheduled, failed, and recovery-required outbound
  transitions through the operator audit trail.
- The local CI gate now tests the full Rust workspace with all features and
  verifies the generated edge UI artifact.

### Fixed

- Thread-detail navigation now resolves through the intended Leptos route.
- External Access and outbound-provider calls now have explicit time bounds so
  unavailable dependencies do not leave operator requests hanging indefinitely.
- Retryable Resend failures now use bounded Queue retries with the stable
  provider idempotency key; ambiguous Cloudflare Email Service outcomes require
  deliberate operator recovery and are never replayed automatically. Incomplete
  claims also fail into recovery when sender configuration changes providers.

### Security

- Operator pages require cryptographically verified Cloudflare Access claims;
  injected identity headers alone are not trusted.
- Production preflight fails closed on placeholder resource identifiers and
  missing Access configuration.

[0.1.0]: https://github.com/rogu3bear/maildesk-cf/releases/tag/v0.1.0
