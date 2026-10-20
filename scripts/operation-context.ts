import { createHash } from "node:crypto";
import { admitGitCandidateBinding, type GitCandidateBinding } from "./git-candidate";

/** Shared operation identity. This is a binding, never a grant of authority. */
export interface OperationContext extends GitCandidateBinding {
  schema_version: 1;
  policy_sha256: string;
  desired_state_sha256: string;
  scope_manifest_sha256: string;
  runtime_artifacts_sha256: string;
  topology_sha256: string;
  control_plane: {
    profile_id: string; account_id: string; database_id: string;
    cfctl_build_sha256: string; capability_contract_sha256: string;
  };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function closedObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const row = object(value, label);
  if (Object.keys(row).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} has an unsupported shape`);
  return row;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function reference(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9:._%/-]{1,240}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function instant(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return Date.parse(value);
}

export function canonicalJsonV1(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonV1(row[key])}`).join(",")}}`;
}

export const digestCanonical = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalJsonV1(value)).digest("hex")}`;

export function admitOperationContext(value: unknown): OperationContext {
  const row = closedObject(value, ["schema_version", "candidate", "candidate_sha256", "policy_sha256", "desired_state_sha256", "scope_manifest_sha256", "runtime_artifacts_sha256", "topology_sha256", "control_plane"], "operation context");
  if (row.schema_version !== 1) throw new Error("operation context version is unsupported");
  const candidate = admitGitCandidateBinding(row.candidate, row.candidate_sha256);
  if (candidate.candidate.dirty) throw new Error("protected operation requires a clean candidate");
  const control = closedObject(row.control_plane, ["profile_id", "account_id", "database_id", "cfctl_build_sha256", "capability_contract_sha256"], "operation control plane");
  return { schema_version: 1, ...candidate,
    policy_sha256: digest(row.policy_sha256, "policy digest"), desired_state_sha256: digest(row.desired_state_sha256, "desired-state digest"),
    scope_manifest_sha256: digest(row.scope_manifest_sha256, "scope digest"), runtime_artifacts_sha256: digest(row.runtime_artifacts_sha256, "runtime artifact digest"),
    topology_sha256: digest(row.topology_sha256, "topology digest"), control_plane: {
      profile_id: reference(control.profile_id, "profile"), account_id: reference(control.account_id, "account"), database_id: reference(control.database_id, "database"),
      cfctl_build_sha256: digest(control.cfctl_build_sha256, "cfctl build"), capability_contract_sha256: digest(control.capability_contract_sha256, "capability contract"),
    } };
}

/** Shared envelope identity only. Callers must still validate their specific
 * selectors, content hashes, chronology, verification and lifecycle receipts.
 */
export function admitPlanEnvelopeIdentity(input: unknown, expected: { command: string; performed: boolean; capabilityId: string; operationId: string }): Record<string, unknown> {
  const envelope = object(input, "PlanV2 envelope");
  if (envelope.schema_version !== 2 || envelope.ok !== true || envelope.error !== null ||
      envelope.command !== expected.command || envelope.performed !== expected.performed ||
      envelope.capability_id !== expected.capabilityId || envelope.operation_id !== expected.operationId) {
    throw new Error("PlanV2 envelope identity drift");
  }
  return envelope;
}
