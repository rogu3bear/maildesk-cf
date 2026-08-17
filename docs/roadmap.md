# Roadmap

This roadmap keeps the template honest. A checked item should have code,
documentation, and local proof. A planned item should not be described as
complete elsewhere.

## Milestone 0: Template Foundation

- [x] Public scrubbed `AGENTS.md`.
- [x] Bun-based TypeScript toolchain.
- [x] Rust router crate with tests.
- [x] Policy validation CLI.
- [x] Template and production preflight split.
- [x] D1 schema skeleton.
- [x] Email Worker and API Worker skeletons.
- [x] Separate API Worker and Email Worker Wrangler targets.
- [x] Shared TypeScript edge contract for readiness and queue jobs.
- [x] Template desired-state fixture for the cfctl v2 capability contract.
- [x] `cfctl` surface contract.
- [x] Production rollout, deliverability, and outbound identity runbooks.

## Milestone 1: Deployable Edge Skeleton

- [x] Compile the Rust router to WebAssembly and use it for inbound route
      decisions and outbound reply authorization in both Workers.
- [x] Email Worker accepts Cloudflare email events into the edge job contract.
- [x] Email Worker writes raw MIME to R2.
- [x] Email Worker forwards accepted inbound mail to policy-selected operators.
- [x] Email Worker persists accepted inbound metadata in D1.
- [x] API Worker exposes health and readiness endpoints.
- [x] Queue consumer records job audit events.
- [ ] Queue consumer parses MIME and records parse status.
- [ ] API Worker exposes authenticated thread and identity endpoints.
- [x] API Worker exposes a token-gated reply queue endpoint.
- [x] Public cfctl v2 provisioning lane has a desired-state schema,
      template fixture, local proof hook, and PlanV2/readback handoff for D1,
      R2, Queue, Worker, DNS, and Email Routing resources.

## Milestone 2: Operator Desk

- [ ] Leptos-compatible shell with route list, thread view, message view, reply
      composer, and audit panel.
- [ ] Reply composer defaults to the policy-selected identity.
- [x] API Worker validates operator and reply identity through the route policy.
- [ ] Outbound reply jobs are persisted before send.
- [x] Sender adapter can send authorized replies through configured provider
      modes.
- [x] Delivery results update audit events.

## Milestone 3: Production Hardening

- [x] Explicit profile/account-bound cfctl v2 capabilities read live Cloudflare
      state and report drift.
- [x] Local horizontal verifier emits a per-domain policy/readiness receipt.
- [ ] DNS authentication checks cover SPF, DKIM, DMARC, MTA-STS, and TLS
      reporting when configured.
- [ ] Email deliverability verification avoids broad smoke sends.
- [ ] Recovery tools exist for stuck queue jobs and partial inbound writes.
- [ ] Access control and audit events have security review coverage.

## Alignment Dependencies

### cfctl

`cfctl` has cataloged v2 capabilities and PlanV2 lifecycle commands. Production
provisioning is template-native when each component operation remains
capability-bound and plan-gated through `cfctl`.

Required surfaces:

- checked in this repo: desired-state schema for domains, aliases, Worker
  bindings, storage bindings, sender mode, and verification posture;
- checked in this repo: non-mutating local proof hook that emits the cfctl v2
  discovery, PlanV2, and readback handoff;
- blocked outside this checkout: installed `cfctl` with required catalog
  capabilities, healthy version/doctor/agents-doctor results, real account and
  domain desired state, reviewed operation ID, and post-mutation live readback;
- still owned by `cfctl`: call/plan/approve/run/status lifecycle, DNS, Email Routing,
  sender-domain readback, D1, R2, Queue, Worker, and secret provisioning;
- still required for production closeout: verification receipt that avoids
  broad live sends.

### leptos-cf

`leptos-cf` needs an extension-app contract that `maildesk-cf` can follow
without vendoring the framework.

Required surfaces:

- app shell conventions for optional extension apps;
- Worker/API boundary conventions;
- auth/session expectations for operator UIs;
- typed config and binding patterns;
- guidance for sharing Rust domain crates with edge adapters.
