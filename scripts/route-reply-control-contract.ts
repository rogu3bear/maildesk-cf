import { createHash } from "node:crypto";
import { authorizeReplyWithPolicy, projectPolicy, type RouterPolicy } from "../workers/shared/router";
import { identityProfileDigestInputV1 } from "../workers/shared/identity-profile-contract";
import { routeReference } from "./sync-route-policy";
import { admitOperationContext, canonicalJsonV1, closedObject, digest, digestCanonical, instant, object, reference, type OperationContext } from "./operation-context";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const bare = (value: string) => value.slice("sha256:".length);
const MAX_QUALIFICATION_AGE = 600_000;

export interface RouteActivationProposal {
  schema_version: 1;
  kind: "maildesk_ordinary_route_activation_proposal";
  performed: false;
  activation_allowed: false;
  execution_supported: false;
  integration_status: "cfctl_contract_unqualified";
  required_provider_effect: "activate_exact_route_authorization";
  proposal_sha256: string;
  context: OperationContext;
  record: {
    id: string; schema_version: 1; route_id: string; policy_sha256: string; desired_state_sha256: string;
    public_identity: string; identity_profile_ref: string; identity_profile_sha256: string;
    operator_set_sha256: string; operator_set_json: string; sender_adapter: string; sender_domain: string;
    runtime_artifacts_sha256: string; topology_sha256: string; qualification_kind: "golden_thread";
    canary_admission_id: string; inbox_proof_id: string; reply_proof_id: string;
    qualification_receipt_sha256: string; qualification_valid_until: string;
    owner_authorization_sha256: string; activated_by_ref: string; requested_at: string; expires_at: string | null;
  };
  compatibility_receipt_sha256: string;
  /** Deliberately absent: status, activated_at and provider activation receipt. */
  record_insertable: false;
}

/** App-owned compilation only. No cfctl call, D1 SQL, Queue client or activation
 * can be performed here. Provider installation/qualification is a separate gate.
 */
export function compileRouteActivation(input: unknown, now = Date.now()): RouteActivationProposal {
  const raw = object(input, "route activation input");
  const operatorSelected = raw.schema_version === 2;
  const value = closedObject(input, ["schema_version", "context", "policy_source_json", "route_id", "qualification", "owner_authorization", "compatibility", "requested_at", "expires_at", ...(operatorSelected ? ["reply_operator"] : [])], "route activation input");
  if ((value.schema_version !== 1 && value.schema_version !== 2) || typeof value.policy_source_json !== "string") throw new Error("route activation input version or policy is invalid");
  const context = admitOperationContext(value.context);
  if (sha(value.policy_source_json) !== bare(context.policy_sha256)) throw new Error("immutable policy bytes differ");
  const policy = JSON.parse(value.policy_source_json) as RouterPolicy;
  const projection = projectPolicy(policy);
  if (!projection.ok) throw new Error(`Rust policy projection rejected: ${projection.error.kind}`);
  const routeId = reference(value.route_id, "route ID");
  const routes = projection.value.routes.filter((route) => routeReference(route) === routeId);
  if (routes.length !== 1 || routes[0]!.routeKind === "sink") throw new Error("ordinary route requires one deliverable profiled route");
  const route = routes[0]!;
  if (!operatorSelected && route.operatorReplyIdentities) throw new Error("operator-specific activation requires schema 2 and a selected operator");
  if (operatorSelected && (typeof value.reply_operator !== "string" || value.reply_operator !== value.reply_operator.trim().toLowerCase())) throw new Error("selected operator must be a normalized mailbox");
  const selected = operatorSelected ? authorizeReplyWithPolicy(policy, {
    envelopeTo: `${route.localPart}@${route.domain}`, operator: value.reply_operator as string,
  }) : null;
  if (selected && !selected.ok) throw new Error("selected operator is not authorized for this route");
  const profile = selected?.ok ? selected.value.identityProfile : route.identityProfile;
  if (!profile) throw new Error("ordinary route requires one deliverable profiled route");
  const profileSha = sha(JSON.stringify(identityProfileDigestInputV1(profile, sha(profile.signatureText))));
  const operatorsJson = JSON.stringify(route.operators);
  const requested = instant(value.requested_at, "requested activation time");
  if (requested > now || now - requested > MAX_QUALIFICATION_AGE) throw new Error("activation request is stale or future");
  if (value.expires_at !== null && instant(value.expires_at, "authority expiry") <= requested) throw new Error("authority expiry is invalid");
  const q = closedObject(value.qualification, ["schema_version", "kind", "context_sha256", "route_id", "canary_admission_id", "canary_transaction_sha256", "inbox_proof_id", "reply_proof_id", "identity_profile_sha256", "operator_set_sha256", "inbox_observed_at", "provider_accepted_at", "reply_observed_at", "observed_at", "receipt_sha256", "match_count", "body_free", "verification_state"], "golden-thread qualification");
  if (q.schema_version !== 1 || q.kind !== "maildesk_exact_golden_thread_readback" || q.context_sha256 !== digestCanonical(context) ||
      q.route_id !== routeId || q.identity_profile_sha256 !== `sha256:${profileSha}` || q.operator_set_sha256 !== `sha256:${sha(operatorsJson)}` ||
      q.match_count !== 1 || q.body_free !== true || q.verification_state !== "passed") throw new Error("golden-thread qualification binding is invalid");
  const inbox = instant(q.inbox_observed_at, "inbox proof time");
  const accepted = instant(q.provider_accepted_at, "provider acceptance time");
  const reply = instant(q.reply_observed_at, "external reply proof time");
  const observed = instant(q.observed_at, "qualification read time");
  if (!(inbox <= accepted && accepted <= reply && reply <= observed && observed <= requested) || now - inbox > MAX_QUALIFICATION_AGE) throw new Error("qualification chronology or freshness is invalid");
  digest(q.canary_transaction_sha256, "canary transaction");
  const compatibility = closedObject(value.compatibility, ["schema_version", "kind", "runtime_artifacts_sha256", "policy_sha256", "apple_mail_workspace_verified", "signed_recipient_and_message_id", "receipt_sha256", ...(operatorSelected ? ["reply_operator_sha256", "public_identity_sha256"] : [])], "message compatibility");
  if (compatibility.schema_version !== (operatorSelected ? 2 : 1) || compatibility.kind !== "maildesk_actual_message_compatibility" ||
      compatibility.runtime_artifacts_sha256 !== context.runtime_artifacts_sha256 || compatibility.policy_sha256 !== context.policy_sha256 ||
      compatibility.apple_mail_workspace_verified !== true || compatibility.signed_recipient_and_message_id !== true) throw new Error("actual Apple Mail/Workspace signing compatibility is unqualified");
  if (operatorSelected && (compatibility.reply_operator_sha256 !== `sha256:${sha(value.reply_operator as string)}` || compatibility.public_identity_sha256 !== `sha256:${sha(profile.publicAddress)}`)) throw new Error("actual-client compatibility differs from the selected operator identity");
  const owner = admitOwner(value.owner_authorization, context, routeId, "activate_ordinary_route", now, operatorSelected ? profile.publicAddress : undefined);
  const record = {
    schema_version: 1 as const, route_id: routeId, policy_sha256: bare(context.policy_sha256), desired_state_sha256: bare(context.desired_state_sha256),
    public_identity: profile.publicAddress, identity_profile_ref: profile.profileRef, identity_profile_sha256: profileSha,
    operator_set_sha256: sha(operatorsJson), operator_set_json: operatorsJson, sender_adapter: profile.senderAdapter, sender_domain: route.domain,
    runtime_artifacts_sha256: bare(context.runtime_artifacts_sha256), topology_sha256: bare(context.topology_sha256), qualification_kind: "golden_thread" as const,
    canary_admission_id: reference(q.canary_admission_id, "canary admission"), inbox_proof_id: reference(q.inbox_proof_id, "inbox proof"), reply_proof_id: reference(q.reply_proof_id, "reply proof"),
    qualification_receipt_sha256: bare(digest(q.receipt_sha256, "qualification receipt")),
    qualification_valid_until: new Date(inbox + MAX_QUALIFICATION_AGE).toISOString(),
    owner_authorization_sha256: bare(owner.receipt), activated_by_ref: bare(owner.actor), requested_at: new Date(requested).toISOString(),
    expires_at: value.expires_at as string | null,
  };
  const proposalSha = digestCanonical({ context, record, compatibility_receipt_sha256: digest(compatibility.receipt_sha256, "compatibility receipt") });
  return { schema_version: 1, kind: "maildesk_ordinary_route_activation_proposal", performed: false, activation_allowed: false,
    execution_supported: false, integration_status: "cfctl_contract_unqualified", required_provider_effect: "activate_exact_route_authorization",
    proposal_sha256: proposalSha, context, record: { id: `activation:${bare(proposalSha)}`, ...record },
    compatibility_receipt_sha256: compatibility.receipt_sha256 as string, record_insertable: false };
}

function admitOwner(value: unknown, context: OperationContext, routeId: string, effect: string, now: number, publicIdentity?: string): { receipt: string; actor: string } {
  const owner = closedObject(value, ["effect", "route_id", "context_sha256", "authorized_at", "expires_at", "actor_sha256", "receipt_sha256", ...(publicIdentity ? ["public_identity"] : [])], "owner authorization");
  if (owner.effect !== effect || owner.route_id !== routeId || owner.context_sha256 !== digestCanonical(context) ||
      (publicIdentity !== undefined && owner.public_identity !== publicIdentity) ||
      instant(owner.authorized_at, "owner authorization time") > now || instant(owner.expires_at, "owner authorization expiry") <= now) throw new Error("owner authorization does not cover this effect and target");
  return { receipt: digest(owner.receipt_sha256, "owner receipt"), actor: digest(owner.actor_sha256, "owner actor") };
}

export function admitRouteActivationReadback(input: unknown, proposal: RouteActivationProposal, now = Date.now()): { state: "active"; activation_id: string; receipt_sha256: string } {
  const row = closedObject(input, ["schema_version", "kind", "proposal_sha256", "context_sha256", "activation_id", "record_sha256", "activation_receipt_sha256", "activated_at", "observed_at", "status", "match_count", "performed", "body_free", "verification_state"], "route activation readback");
  if (row.schema_version !== 1 || row.kind !== "maildesk_exact_route_activation_readback" || row.proposal_sha256 !== proposal.proposal_sha256 ||
      row.context_sha256 !== digestCanonical(proposal.context) || row.activation_id !== proposal.record.id || row.record_sha256 !== digestCanonical(proposal.record) ||
      row.status !== "active" || row.match_count !== 1 || row.performed !== true || row.body_free !== true || row.verification_state !== "passed") throw new Error("route activation readback binding is invalid");
  const activated = instant(row.activated_at, "activation time"), observed = instant(row.observed_at, "activation observation");
  if (activated < instant(proposal.record.requested_at, "activation request") || activated >= instant(proposal.record.qualification_valid_until, "qualification expiry") ||
      observed < activated || observed > now || now - observed > MAX_QUALIFICATION_AGE ||
      (proposal.record.expires_at !== null && now >= instant(proposal.record.expires_at, "authority expiry"))) throw new Error("route activation readback is stale or out of order");
  return { state: "active", activation_id: proposal.record.id, receipt_sha256: digest(row.activation_receipt_sha256, "activation receipt") };
}

export function compileDispatchRecovery(input: unknown, now = Date.now()) {
  const row = closedObject(input, ["schema_version", "context", "claim", "requested_at"], "dispatch recovery input");
  if (row.schema_version !== 1) throw new Error("unsupported dispatch recovery input");
  const context = admitOperationContext(row.context);
  const claim = closedObject(row.claim, ["id", "route_id", "admission_kind", "activation_id", "policy_sha256", "desired_state_sha256", "status", "admission_status", "provider_boundary_at", "expires_at", "observed_at", "receipt_sha256"], "dispatch claim readback");
  if (typeof claim.id !== "string" || !/^relay-attempt:[a-f0-9]{64}$/.test(claim.id) ||
      !["receiving", "queued", "authorized"].includes(String(claim.status)) || claim.admission_status !== "claimed" || claim.provider_boundary_at !== null ||
      claim.policy_sha256 !== context.policy_sha256 || claim.desired_state_sha256 !== context.desired_state_sha256 ||
      !((claim.admission_kind === "canary" && claim.activation_id === null) || (claim.admission_kind === "ordinary" && typeof claim.activation_id === "string")) ||
      instant(claim.expires_at, "claim expiry") <= now || instant(claim.observed_at, "claim observation") > now || now - instant(claim.observed_at, "claim observation") > 60_000 ||
      instant(row.requested_at, "recovery request") > now) throw new Error("dispatch is not proven current and known-unsent");
  reference(claim.route_id, "claim route"); digest(claim.receipt_sha256, "claim read receipt");
  return { schema_version: 1, kind: "maildesk_known_unsent_dispatch_proposal", performed: false, execution_supported: false,
    integration_status: "cfctl_contract_unqualified", required_provider_effect: "dispatch_exact_durable_claim", context,
    claim_id: claim.id, claim_readback_sha256: digestCanonical(claim), proposal_sha256: digestCanonical(row),
    caller_payload_allowed: false, caller_storage_key_allowed: false, provider_send_performed: false, retry_provider_send_allowed: false };
}

export function compileRouteContainment(input: unknown, now = Date.now()) {
  const row = closedObject(input, ["schema_version", "context", "route_id", "action", "reason", "release_of", "source_quarantine_receipt_sha256", "owner_authorization", "requested_at"], "route containment input");
  if (row.schema_version !== 1 || !["quarantine", "release"].includes(String(row.action)) ||
      !["wrong_identity", "private_identity_exposure", "duplicate_send", "ambiguous_provider_result", "unauthorized_operator", "policy_changed", "controller_recovery"].includes(String(row.reason))) throw new Error("route containment shape is invalid");
  const context = admitOperationContext(row.context), routeId = reference(row.route_id, "containment route");
  if (row.action === "quarantine" && (row.release_of !== null || row.source_quarantine_receipt_sha256 !== null)) throw new Error("quarantine cannot carry release lineage");
  if (row.action === "release") { reference(row.release_of, "exact quarantine ID"); digest(row.source_quarantine_receipt_sha256, "quarantine receipt"); }
  if (instant(row.requested_at, "containment request") > now) throw new Error("containment request is future");
  const owner = admitOwner(row.owner_authorization, context, routeId, `${String(row.action)}_route_replies`, now);
  return { schema_version: 1, kind: "maildesk_route_reply_containment_proposal", performed: false, execution_supported: false,
    integration_status: "cfctl_contract_unqualified", required_provider_effect: "append_exact_route_containment", context, route_id: routeId,
    action: row.action, reason: row.reason, release_of: row.release_of, source_quarantine_receipt_sha256: row.source_quarantine_receipt_sha256,
    owner_authorization_sha256: owner.receipt, proposal_sha256: digestCanonical(row), cannot_unsend: true, replay_allowed: false };
}

// Retained for callers needing an exact, stable representation of this contract.
export const serializeRouteReplyProposal = canonicalJsonV1;
