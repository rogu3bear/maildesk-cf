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
- [x] `cfctl` surface draft.

## Milestone 1: Deployable Edge Skeleton

- [ ] Compile router for Worker consumption or expose a stable adapter crate.
- [x] Email Worker accepts Cloudflare email events into the edge job contract.
- [x] Email Worker writes raw MIME to R2.
- [ ] Email Worker persists accepted inbound metadata in D1.
- [x] API Worker exposes health and readiness endpoints.
- [x] Queue consumer records job audit events.
- [ ] Queue consumer parses MIME and records parse status.
- [ ] API Worker exposes authenticated thread and identity endpoints.
- [ ] `cfctl` can provision required D1, R2, Queue, Worker, DNS, and Email
      Routing resources.

## Milestone 2: Operator Desk

- [ ] Leptos-compatible shell with route list, thread view, message view, reply
      composer, and audit panel.
- [ ] Reply composer defaults to the policy-selected identity.
- [ ] API Worker validates operator and reply identity through the Rust router.
- [ ] Outbound reply jobs are persisted before send.
- [ ] Delivery results update audit events.

## Milestone 3: Production Hardening

- [ ] `cfctl maildesk-cf verify` reads live Cloudflare state and reports drift.
- [ ] DNS authentication checks cover SPF, DKIM, DMARC, MTA-STS, and TLS
      reporting when configured.
- [ ] Email deliverability verification avoids broad smoke sends.
- [ ] Recovery tools exist for stuck queue jobs and partial inbound writes.
- [ ] Access control and audit events have security review coverage.

## Alignment Dependencies

### cfctl

`cfctl` needs a first-class `maildesk-cf` surface before production
provisioning can be called template-native.

Required surfaces:

- desired-state schema for domains, aliases, operators, identities, bindings,
  and sender mode;
- plan/apply/verify lifecycle;
- DNS and Email Routing readback;
- D1, R2, Queue, Worker, and secret provisioning;
- verification receipt that avoids broad live sends.

### leptos-cf

`leptos-cf` needs an extension-app contract that `maildesk-cf` can follow
without vendoring the framework.

Required surfaces:

- app shell conventions for optional extension apps;
- Worker/API boundary conventions;
- auth/session expectations for operator UIs;
- typed config and binding patterns;
- guidance for sharing Rust domain crates with edge adapters.
