# UI and Access Desired-State Extension

Status: design contract; not yet a complete cfctl v2 capability workflow.

The Cargo-Leptos UI adds account state that the current public
`maildesk-cf` desired-state schema does not model. Production must not bypass
`cfctl` with a direct Wrangler or dashboard mutation while this gap exists.

## Required provider surface

Extend the `maildesk-cf` lifecycle desired state with:

- `workers.ui.script_name` and `workers.ui.config`;
- the UI Worker's D1, R2, Queue producer, static-asset, and custom-domain
  bindings;
- exactly one Maildesk-owned Access application, selected by its stable
  application name plus the production routing-health hostname, whose protected
  path set is `all_routes`, including static assets;
- exactly one Maildesk-owned allow policy, selected by its stable policy name
  plus the approved operator group, without authority over any unrelated policy;
- readback of the Access team origin and application audience into the
  deployment secret/configuration contract;
- `workers_dev = false` and a verified custom route for production; and
- an R2 lifecycle rule for raw MIME and attachments once the owner approves
  the retention period.

The UI Worker still validates the Access JWT cryptographically for every route;
an edge policy by itself is not the application authorization boundary.

## Required lifecycle commands

The implemented surface must support the normal governed flow:

```text
cfctl version --json
cfctl doctor --json
cfctl agents doctor --json
cfctl resolve "read the exact Maildesk Access application and route state without mutation" --json
cfctl catalog show <resolved-capability-id> --json
cfctl guide <resolved-capability-id> --json
cfctl call <resolved-capability-id> --profile <profile-id> --account <account-id> <exact-selectors> --json
```

Any write must create a PlanV2 operation through the exact resolved capability,
then pass `plans show`, separate approval, `plans run`, `plans status`, and
capability-specific readback.

Application collection readback must resolve zero or one exact owned match by
application name plus hostname. Policy collection readback within that exact
application must resolve zero or one exact owned match by policy name plus
operator group. Duplicate exact matches, partial selector overlaps, or any
ambiguous existing candidate fail before plan creation. Update operations use
the resolved `app_id` and `policy_id`; selector-only updates are forbidden.

Create and update are separate operations. Create rollback deletes only the
new provider-returned owned object ID. Update rollback restores the exact fresh
prior owned-object snapshot. Every unrelated application and every unrelated
policy remains outside reconciliation authority; unrelated policy bytes,
semantics, and ordering must be identical after the operation. Collection-wide
replacement or deletion is forbidden.

Provider identity continuity is byte-exact across the full transaction. An
application create binds the provider-returned `app_id` to status, rollback,
the managed-policy parent, and exact-ID verification. An application update
binds the admitted `app_id` to prior state, plan, review, approval, apply,
status, rollback, the managed-policy parent, and verification. A policy create
binds the retained parent `app_id` through every operation stage and binds the
provider-returned `policy_id` to status, rollback, and verification. A policy
update binds the admitted `app_id` plus `policy_id` tuple through prior state,
plan, review, approval, apply, status, rollback, and verification. Missing or
unequal IDs—including selector-equivalent objects with different provider
IDs—fail closed before plan readiness, live mutation readiness, post-apply
success, or edge readiness.

The preview must enumerate the UI Worker, route, Access application and
policies, bindings, and lifecycle rule as distinct deltas. Acknowledgment of an
older or partial plan must fail closed.

## Verification receipt

Post-apply readback must prove:

- the exact resolved `app_id` still names the desired owned application and
  covers every route on the production routing-health hostname;
- the exact resolved `policy_id` under that `app_id` still names the desired
  owned allow policy and approved operator group;
- all unrelated policy content hashes and ordering remain unchanged;
- the UI Worker receives the expected D1, R2, Queue, and asset bindings;
- the Worker has the Access team origin and application audience without
  exposing either as a secret value in receipts;
- `workers.dev` exposure is disabled;
- the configured R2 lifecycle matches the owner-approved retention period; and
- the previous Worker version and route rollback target are recorded; and
- Access create rollback retains only the newly returned object ID, while
  Access update rollback retains the exact prior owned-object snapshot.

Missing or mismatched exact-ID readback, ownership ambiguity, or unrelated
policy drift keeps readiness false.

## Closure condition

This design note is superseded only when canonical cfctl v2 capabilities,
PlanV2 workflows, and readback model these fields and focused tests
prove plan/apply/readback behavior. Until then, the UI/Access production plan is
blocked rather than silently split across control planes.
