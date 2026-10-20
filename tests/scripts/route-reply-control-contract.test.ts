import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compileRouteActivation, compileDispatchRecovery, compileRouteContainment, admitRouteActivationReadback } from "../../scripts/route-reply-control-contract";
import { candidateSha256 } from "../../scripts/git-candidate";
import { digestCanonical } from "../../scripts/operation-context";
import { authorizeReplyWithPolicy, projectPolicy, type RouterPolicy } from "../../workers/shared/router";
import { publicIdentityProfileSha256 } from "../../workers/shared/inbox-relay";

const now = Date.parse("2026-10-15T12:00:00Z");
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture() {
  const policy = { default_reply_mode: "role_first" as const, identity_profiles: { "support@example.com": {
    display_name: "Example Support", signature_profile_ref: "signature:support:v1", signature_text: "Example Support",
    sender_adapter: "cloudflare_email_service" as const } }, domains: { "example.com": { role_aliases: { support: { operators: ["operator@example.com"], reply_identity: "support@example.com" } }, personal_aliases: {} } } };
  const candidate = { head: "a".repeat(40), tree: "b".repeat(40), dirty: false };
  const context = { schema_version: 1, candidate, candidate_sha256: candidateSha256(candidate), policy_sha256: digest(JSON.stringify(policy)),
    desired_state_sha256: digest("desired"), scope_manifest_sha256: digest("scope"), runtime_artifacts_sha256: digest("runtime"), topology_sha256: digest("topology"),
    control_plane: { profile_id: "fixture", account_id: "fixture-account", database_id: "fixture-database", cfctl_build_sha256: digest("fixture-build"), capability_contract_sha256: digest("proposed-contract") } };
  const projected = projectPolicy(policy);
  if (!projected.ok) throw new Error("invalid fixture");
  return { schema_version: 1, context, policy_source_json: JSON.stringify(policy), route_id: "route:example.com:support",
    qualification: { schema_version: 1, kind: "maildesk_exact_golden_thread_readback", context_sha256: digestCanonical(context), route_id: "route:example.com:support",
      canary_admission_id: "admission:fixture", canary_transaction_sha256: digest("transaction"), inbox_proof_id: "proof:inbox", reply_proof_id: "proof:reply",
      identity_profile_sha256: `sha256:${await publicIdentityProfileSha256(projected.value.routes[0]!.identityProfile!)}`,
      operator_set_sha256: digest(JSON.stringify(["operator@example.com"])), inbox_observed_at: "2026-10-15T11:55:00Z", provider_accepted_at: "2026-10-15T11:56:00Z",
      reply_observed_at: "2026-10-15T11:57:00Z", observed_at: "2026-10-15T11:58:00Z", receipt_sha256: digest("qualification"), match_count: 1, body_free: true, verification_state: "passed" },
    owner_authorization: { effect: "activate_ordinary_route", route_id: "route:example.com:support", context_sha256: digestCanonical(context), authorized_at: "2026-10-15T11:59:00Z", expires_at: "2026-10-15T12:05:00Z", actor_sha256: digest("owner"), receipt_sha256: digest("owner-receipt") },
    compatibility: { schema_version: 1, kind: "maildesk_actual_message_compatibility", runtime_artifacts_sha256: context.runtime_artifacts_sha256, policy_sha256: context.policy_sha256,
      apple_mail_workspace_verified: true, signed_recipient_and_message_id: true, receipt_sha256: digest("offline-compatibility-fixture") }, requested_at: "2026-10-15T12:00:00Z", expires_at: null };
}

test("offline activation compilation binds Rust policy and qualified evidence but cannot activate or be inserted", async () => {
  const input = await fixture(); const proposal = compileRouteActivation(input, now);
  expect(proposal).toMatchObject({ performed: false, activation_allowed: false, execution_supported: false, integration_status: "cfctl_contract_unqualified", record_insertable: false });
  expect(proposal.record.operator_set_json).toBe('["operator@example.com"]');
  expect(proposal.record).not.toHaveProperty("status"); expect(proposal.record).not.toHaveProperty("activation_receipt_sha256");
  expect(proposal.record.qualification_valid_until).toBe("2026-10-15T12:05:00.000Z");
  const readback = { schema_version: 1, kind: "maildesk_exact_route_activation_readback", proposal_sha256: proposal.proposal_sha256,
    context_sha256: digestCanonical(proposal.context), activation_id: proposal.record.id, record_sha256: digestCanonical(proposal.record),
    activation_receipt_sha256: digest("provider-activation"), activated_at: "2026-10-15T12:00:00Z", observed_at: "2026-10-15T12:00:01Z", status: "active", match_count: 1, performed: true, body_free: true, verification_state: "passed" };
  expect(admitRouteActivationReadback(readback, proposal, now + 1000)).toMatchObject({ state: "active", activation_id: proposal.record.id });
  expect(() => admitRouteActivationReadback({ ...readback, match_count: 2 }, proposal, now + 1000)).toThrow("binding");
  expect(() => admitRouteActivationReadback({ ...readback, status: "revoked" }, proposal, now + 1000)).toThrow("binding");
});

test("operator-specific activation requires its selected Rust identity, exact owner scope and actual-client binding", async () => {
  const input = await fixture();
  const policy = JSON.parse(input.policy_source_json) as RouterPolicy;
  policy.default_reply_mode = "personal_first";
  const domain = policy.domains["example.com"]!;
  domain.role_aliases.support!.operators = ["operator-a@example.net", "operator-b@example.net"];
  for (const prefix of ["operator-a", "operator-b"]) {
    domain.personal_aliases[prefix] = { operator: `${prefix}@example.net`, reply_identity: `${prefix}@example.com` };
    policy.identity_profiles![`${prefix}@example.com`] = { ...policy.identity_profiles!["support@example.com"]! };
  }
  input.policy_source_json = JSON.stringify(policy);
  input.context.policy_sha256 = digest(input.policy_source_json);
  input.qualification.context_sha256 = digestCanonical(input.context);
  input.owner_authorization.context_sha256 = digestCanonical(input.context);
  input.compatibility.policy_sha256 = input.context.policy_sha256;
  input.qualification.operator_set_sha256 = digest(JSON.stringify(domain.role_aliases.support!.operators));
  const actor = "operator-a@example.net", address = "operator-a@example.com";
  const selected = authorizeReplyWithPolicy(policy, { envelopeTo: "support@example.com", operator: actor });
  if (!selected.ok || !selected.value.identityProfile) throw Error("fixture identity unavailable");
  input.qualification.identity_profile_sha256 = `sha256:${await publicIdentityProfileSha256(selected.value.identityProfile)}`;
  expect(() => compileRouteActivation(input, now)).toThrow("schema 2");
  const exact = { ...input, schema_version: 2, reply_operator: actor,
    owner_authorization: { ...input.owner_authorization, public_identity: address },
    compatibility: { ...input.compatibility, schema_version: 2, reply_operator_sha256: digest(actor), public_identity_sha256: digest(address) } };
  expect(compileRouteActivation(exact, now).record).toMatchObject({ route_id: "route:example.com:support", public_identity: address, identity_profile_ref: address });
  expect(() => compileRouteActivation({ ...exact, reply_operator: "operator-b@example.net" }, now)).toThrow("binding");
  expect(() => compileRouteActivation({ ...exact, owner_authorization: { ...exact.owner_authorization, public_identity: "operator-b@example.com" } }, now)).toThrow("owner authorization");
  expect(() => compileRouteActivation({ ...exact, compatibility: { ...exact.compatibility, reply_operator_sha256: digest("other") } }, now)).toThrow("selected operator identity");
});

test("activation rejects unsupported fields, dirty source, freshness, profile drift and missing real-client compatibility", async () => {
  const input = await fixture();
  expect(() => compileRouteActivation({ ...input, execute: true }, now)).toThrow("shape");
  const mutations = [
    (x: typeof input) => { x.qualification.reply_observed_at = "2026-10-15T11:55:30Z"; },
    (x: typeof input) => { x.qualification.identity_profile_sha256 = digest("other-profile"); },
    (x: typeof input) => { x.compatibility.apple_mail_workspace_verified = false; },
    (x: typeof input) => { x.owner_authorization.effect = "observe_inbox"; },
    (x: typeof input) => { x.context.candidate.dirty = true; x.context.candidate_sha256 = candidateSha256(x.context.candidate); },
  ];
  for (const mutate of mutations) { const copy = structuredClone(input); mutate(copy); expect(() => compileRouteActivation(copy, now)).toThrow(); }
  expect(() => compileRouteActivation(input, now + 700_000)).toThrow();
});

test("dispatch proposal accepts only a fresh known-unsent claim ID and never a caller payload or R2 key", async () => {
  const { context } = await fixture();
  const input = { schema_version: 1, context, requested_at: "2026-10-15T12:00:00Z", claim: { id: `relay-attempt:${"a".repeat(64)}`, route_id: "route:example.com:support", admission_kind: "canary", activation_id: null,
    policy_sha256: context.policy_sha256, desired_state_sha256: context.desired_state_sha256, status: "receiving", admission_status: "claimed", provider_boundary_at: null,
    expires_at: "2026-10-15T12:05:00Z", observed_at: "2026-10-15T11:59:59Z", receipt_sha256: digest("claim-read") } };
  expect(compileDispatchRecovery(input, now)).toMatchObject({ performed: false, execution_supported: false, caller_payload_allowed: false, retry_provider_send_allowed: false });
  for (const status of ["sending", "provider_accepted", "failed", "recovery_required"]) expect(() => compileDispatchRecovery({ ...input, claim: { ...input.claim, admission_status: status } }, now)).toThrow();
  expect(() => compileDispatchRecovery({ ...input, raw_r2_key: "attacker-chosen" }, now)).toThrow("shape");
});

test("route containment has no canary prerequisite and release preserves exact lineage", async () => {
  const { context, owner_authorization } = await fixture();
  const input = { schema_version: 1, context, route_id: "route:example.com:support", action: "quarantine", reason: "controller_recovery", release_of: null, source_quarantine_receipt_sha256: null,
    owner_authorization: { ...owner_authorization, effect: "quarantine_route_replies" }, requested_at: "2026-10-15T12:00:00Z" };
  expect(compileRouteContainment(input, now)).toMatchObject({ performed: false, cannot_unsend: true, replay_allowed: false });
  expect(() => compileRouteContainment({ ...input, action: "release" }, now)).toThrow();
});
