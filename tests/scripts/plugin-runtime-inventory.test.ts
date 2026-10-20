import { expect, test } from "bun:test";
import { candidateSha256 } from "../../scripts/git-candidate";
import { preparePluginRuntimeInventory, preparePluginSchemaInventory, preparePluginModuleInventory, SCHEMA_OBJECTS_SQL } from "../../scripts/plugin-runtime-inventory";

const candidate = { head: "a".repeat(40), tree: "b".repeat(40), dirty: true };
const inventory = { schema_version: 1, candidate, candidate_sha256: candidateSha256(candidate),
  source_snapshot_sha256: `sha256:${"a".repeat(64)}`, target_manifest_sha256: `sha256:${"b".repeat(64)}`,
  connector_subject: `user:${"c".repeat(32)}`, account_id: "d".repeat(32),
  database_id: "11111111-1111-1111-1111-111111111111",
  workers: { relay_router: "example-router", relay_outbound: "example-outbound", routing_health: "example-health" } };
const versions = { relay_router: "22222222-2222-2222-2222-222222222222",
  relay_outbound: "33333333-3333-3333-3333-333333333333", routing_health: "44444444-4444-4444-4444-444444444444" };
const input = { inventory, versions, deployment_receipt_sha256: `sha256:${"e".repeat(64)}` };

test("dependent selectors bind actual version IDs to exact Workers and receipt", () => {
  const result = preparePluginRuntimeInventory(input, 0);
  expect(result.requests).toHaveLength(6);
  for (const request of result.requests) {
    expect(request.version_id).toBe(versions[request.role]);
    expect(request.path).toContain(`/scripts/${inventory.workers[request.role]}/`);
    expect(request.method).toBe("GET");
    if (request.kind === "worker_version_content") expect(request.query).toEqual({ version: request.version_id });
  }
  expect(result).toMatchObject({ execution_supported: false, qualifies_release: false, qualifies_mail: false,
    private_capture: { print_raw_content: false, print_binding_values: false, on_lossy_or_unsupported_binary: "stop_without_content_identity_claim" } });
  const changed = preparePluginRuntimeInventory({ ...input, versions: { ...versions, relay_router: versions.relay_outbound } }, 0);
  expect(changed.proposal_sha256).not.toBe(result.proposal_sha256);
});

test("closed inputs reject injected selectors, missing receipt and relative versions", () => {
  expect(() => preparePluginRuntimeInventory({ ...input, versions: { ...versions, extra: versions.relay_router } }, 0)).toThrow();
  expect(() => preparePluginRuntimeInventory({ ...input, deployment_receipt_sha256: null }, 0)).toThrow();
  expect(() => preparePluginRuntimeInventory({ ...input, versions: { ...versions, relay_router: "latest" } }, 0)).toThrow();
  expect(() => preparePluginRuntimeInventory({ ...input, inventory: { ...inventory, account_id: "../other" } }, 0)).toThrow();
});

test("schema reconciliation reads bounded sqlite_master DDL including views", () => {
  const result = preparePluginSchemaInventory(inventory, 0);
  expect(result.requests).toEqual([{ kind: "schema_objects", database_id: inventory.database_id,
    sql: SCHEMA_OBJECTS_SQL, params: [], max_rows: 500, max_response_bytes: 524288 }]);
  expect(SCHEMA_OBJECTS_SQL).toContain("'view'");
  expect(result.context.expires_at).toBe("1970-01-01T00:10:00.000Z");
  expect(result.private_capture.print_raw_sql).toBe(false);
  expect(result.qualifies_release).toBe(false);
});

test("JSON module method binds actual runtime qualification and source separately from multipart", () => {
  const packet = { runtime: input, runtime_qualification_sha256: `sha256:${"f".repeat(64)}`,
    projection_source_sha256: `sha256:${"a".repeat(64)}` };
  const result = preparePluginModuleInventory(packet, 0);
  expect(result.requests).toHaveLength(3);
  for (const request of result.requests) {
    expect(request.path).toContain(`/workers/workers/${inventory.workers[request.role]}/versions/${versions[request.role]}`);
    expect(request.query).toEqual({ include: "modules" });
    expect(request.bound_kind).toBe("post_normalization_validation");
  }
  expect(result.qualifies_release).toBe(false);
  expect(() => preparePluginModuleInventory({ ...packet, runtime_qualification_sha256: null }, 0)).toThrow();
});
