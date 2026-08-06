# UI and Access Desired-State Extension

Status: design contract; not yet an implemented `cfctl maildesk-cf` surface.

The Cargo-Leptos UI adds account state that the current public
`maildesk-cf` desired-state schema does not model. Production must not bypass
`cfctl` with a direct Wrangler or dashboard mutation while this gap exists.

## Required provider surface

Extend the `maildesk-cf` lifecycle desired state with:

- `workers.ui.script_name` and `workers.ui.config`;
- the UI Worker's D1, R2, Queue producer, static-asset, and custom-domain
  bindings;
- an Access application whose protected path set is exactly `/desk` and
  `/desk/*`;
- one or more explicit Access policies for the approved operator group;
- readback of the Access team origin and application audience into the
  deployment secret/configuration contract;
- `workers_dev = false` and a verified custom route for production; and
- an R2 lifecycle rule for raw MIME and attachments once the owner approves
  the retention period.

Public `/` and `/architecture` routes are outside the protected path set. The
UI Worker still validates the Access JWT cryptographically; an edge policy by
itself is not the application authorization boundary.

## Required lifecycle commands

The implemented surface must support the normal governed flow:

```text
cfctl doctor
cfctl maildesk-cf verify --file <private-desired-state>
cfctl standards access
cfctl classify access apply
cfctl guide access apply
cfctl maildesk-cf provision --file <private-desired-state> --plan
cfctl maildesk-cf provision --file <private-desired-state> --ack-plan <operation-id>
cfctl maildesk-cf verify --file <private-desired-state>
```

The preview must enumerate the UI Worker, route, Access application and
policies, bindings, and lifecycle rule as distinct deltas. Acknowledgment of an
older or partial plan must fail closed.

## Verification receipt

Post-apply readback must prove:

- public routes return the deployed source version without an Access challenge;
- `/desk` and `/desk/*` are covered by the intended Access application;
- the UI Worker receives the expected D1, R2, Queue, and asset bindings;
- the Worker has the Access team origin and application audience without
  exposing either as a secret value in receipts;
- `workers.dev` exposure is disabled;
- the configured R2 lifecycle matches the owner-approved retention period; and
- the previous Worker version and route rollback target are recorded.

## Closure condition

This design note is superseded only when the canonical `cfctl maildesk-cf`
schema, planner, apply path, and verifier model these fields and focused tests
prove plan/apply/readback behavior. Until then, the UI/Access production plan is
blocked rather than silently split across control planes.
