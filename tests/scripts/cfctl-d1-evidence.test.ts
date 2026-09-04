import { expect, test } from "bun:test";
import { APPROVED_AUDIT_EVENTS, APPROVED_RELAY_TABLES, decodeD1Evidence, decodePolicyObjectDigest } from "../../scripts/cfctl-d1-evidence";
const sha = "a".repeat(64), other = "b".repeat(64), key = `config/policy/${sha}.json`;
function projection() { return { adapter: "workspace_d1_evidence_v1", success: true, database_id: "db", body_returned: false, provider_output_retained: false, evidence: {
  schema_version: 1, body_returned: false, active_policy_digest: `sha256:${sha}`, immutable_policy_object_key: key, revision_r2_key: key,
  projection_policy_sha256: `sha256:${sha}`, desired_state_digest: `sha256:${sha}`, semantic_projection_digest: `sha256:${sha}`,
  expected_domain_count: 0, projected_domain_count: 0, expected_route_count: 0, projected_route_count: 0,
  approved_schema_present: true, approved_table_presence: Object.fromEntries(APPROVED_RELAY_TABLES.map(name => [name, true])), audit_event_counts: Object.fromEntries(APPROVED_AUDIT_EVENTS.map(name => [name, 0])),
} }; }
test("valid empty counts remain distinguishable from unavailable or malformed evidence", () => {
  expect(decodeD1Evidence(projection(), "db")?.d1.audit_event_counts.inbound_email_accepted).toBe(0);
  for (const value of [null, {}, { ...projection(), success: false }, { ...projection(), body_returned: true }, { ...projection(), evidence: {} }]) expect(decodeD1Evidence(value, "db")).toBeNull();
  expect(decodeD1Evidence(projection(), "other-db")).toBeNull();
});
test("independent policy mismatches stay visible and no mail receipt is inferred", () => {
  const value = projection(); value.evidence.revision_r2_key = `config/policy/${other}.json`; value.evidence.projection_policy_sha256 = `sha256:${other}`;
  const decoded = decodeD1Evidence(value, "db");
  expect(decoded?.active_policy.revision_r2_key).not.toBe(decoded?.active_policy.active_policy_r2_key);
  expect(decoded?.active_policy.projection_policy_sha256).not.toBe(decoded?.active_policy.active_policy_sha256);
  expect(decoded).not.toHaveProperty("inbound_proofs"); expect(decoded).not.toHaveProperty("outbound_proofs");
});
test("R2 digest must bind exact account bucket key and body-free success", () => {
  const value = { success: true, result: { schema_version: 1, account_id: "account", bucket_name: "bucket", object_key: key, sha256: `sha256:${sha}`, byte_count: 12, etag: "etag", body_returned: false } };
  expect(decodePolicyObjectDigest(value, "account", "bucket", key)).toBe(sha);
  expect(decodePolicyObjectDigest(value, "wrong-account", "bucket", key)).toBeNull();
  expect(decodePolicyObjectDigest(value, "account", "wrong-bucket", key)).toBeNull();
  expect(decodePolicyObjectDigest(value, "account", "bucket", `config/policy/${other}.json`)).toBeNull();
  expect(decodePolicyObjectDigest({ ...value, success: false }, "account", "bucket", key)).toBeNull();
});
