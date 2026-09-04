import { expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { incompatibleMaildeskRead, maildeskReadContracts } from "../../scripts/cfctl-v2-command-contract";

setDefaultTimeout(30_000);

const contracts = maildeskReadContracts({ emailRouting: true, senderDomains: true, darkAcceptance: true });
const first = contracts[0]!;
function envelope(contract = first) {
  return {
    schema_version: 2, command: "catalog show", ok: true, performed: false,
    result: {
      id: contract.id, adapter_status: "dynamic_api", blocked_reason: null,
      method: "GET", effect: "read_only", mutating: false,
      response_contract: { body_mode: "cloudflare_json_envelope" },
      selectors: contract.selectors.map((name) => ({ name, value_type: "string" })),
    },
  };
}

test("installed read contract rejects version, effect, ID, adapter and selector drift", () => {
  expect(incompatibleMaildeskRead(first, envelope())).toBeNull();
  for (const value of [null, {}, { ...envelope(), schema_version: 1 }, { ...envelope(), performed: true }, { ...envelope(), command: "call" }]) {
    expect(incompatibleMaildeskRead(first, value)).not.toBeNull();
  }
  for (const patch of [
    { id: "other-capability" }, { adapter_status: "blocked" }, { adapter_status: "governed_ui" },
    { blocked_reason: "not supported" }, { method: "POST" }, { effect: "reversible_write" },
    { mutating: true }, { response_contract: { body_mode: "raw" } }, { selectors: [] },
    { selectors: first.selectors.map((name) => ({ name, value_type: "number" })) },
    { selectors: [...envelope().result.selectors, { name: "new_required_target", value_type: "string", required: true }] },
  ]) expect(incompatibleMaildeskRead(first, { ...envelope(), result: { ...envelope().result, ...patch } })).not.toBeNull();
});

test("installed check discovers actual required catalog IDs without reads, plans or secrets", () => {
  for (const mode of ["supported", "blocked", "missing", "malformed"]) {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-catalog-contract-"));
    try {
      const binary = join(dir, "cfctl");
      const cases = contracts.map((contract, index) => {
        const value = envelope(contract);
        if (mode === "blocked" && index === 0) value.result.adapter_status = "blocked";
        const reply = mode === "malformed" && index === 0 ? "invalid-json" : JSON.stringify(value);
        return `"catalog show ${contract.id} --json") ${mode === "missing" && index === 0 ? "exit 1" : `printf '%s\\n' '${reply}'` } ;;`;
      }).join("\n");
      writeFileSync(binary, `#!/bin/sh\ncase "$*" in\n${cases}\n*) exit 90 ;;\nesac\n`);
      chmodSync(binary, 0o700);
      const result = spawnSync("bun", ["run", "scripts/check-cfctl-provisioning.ts", "--installed", "--desired-state", "config/desired-state.example.json", "--json"], {
        cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", env: { ...process.env, CFCTL_BIN: binary },
      });
      expect(result.status).toBe(mode === "supported" ? 0 : 1);
      if (mode === "supported") {
        const receipt = JSON.parse(result.stdout);
        expect(receipt.status.installed_read_contract_ready).toBe(true);
        expect(receipt.status.live_mutation_ready).toBe(false);
        expect(receipt.cfctl_handoff.required_read_contracts.map((entry: {id: string}) => entry.id)).toEqual(maildeskReadContracts({ emailRouting: true, senderDomains: false, darkAcceptance: true }).map((contract) => contract.id));
      } else expect(result.stderr).toContain(first.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

import { discoverMaildeskAccess, incompatibleMaildeskAccess, maildeskAccessOperations } from "../../scripts/cfctl-v2-command-contract";

function accessEnvelope(operation: ReturnType<typeof maildeskAccessOperations>[number]) {
  const properties: Record<string, any> = Object.fromEntries(operation.body.map(name => [name, { type: "string" }]));
  if (operation.resource === "access_application") Object.assign(properties, {
    type: { type: "string", enum: ["self_hosted"] },
    domain: { type: "string", format: "hostname" },
    destinations: {
      type: "array", minItems: 1, maxItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["type", "uri"],
        properties: { type: { type: "string", enum: ["public"] }, uri: { type: "string", format: "hostname" } },
      },
    },
    policies: operation.method === "POST" ? { type: "array", maxItems: 0 } : { type: "array", minItems: 1 },
    options_preflight_bypass: { type: "boolean", enum: [false] },
  });
  else Object.assign(properties, {
    decision: { type: "string", enum: ["allow"] },
    exclude: { type: "array", maxItems: 0 }, require: { type: "array", maxItems: 0 },
    include: {
      type: "array", minItems: 1, maxItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["group"],
        properties: { group: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } },
      },
    },
  });
  return { schema_version: 2, command: "catalog show", ok: true, performed: false, result: {
    id: operation.capability_id, method: operation.method, path: operation.path, adapter_status: "dynamic_api", mutating: true, effect: "identity_or_ownership",
    verification: { required: true }, rollback: { supported: true }, response_contract: { body_mode: "cloudflare_json_envelope" },
    selectors: operation.selectors.map(name => ({ name, required: true, location: "path", value_type: "string" })),
    request_schema: { type: "object", additionalProperties: false, required: [...operation.body], properties },
  } };
}

test("closed Access compatibility preserves deny-all creation and separate exact operator policy", () => {
  expect(discoverMaildeskAccess(false).status).toBe("not_checked");
  const operations = maildeskAccessOperations();
  for (const operation of operations) {
    const value = accessEnvelope(operation);
    expect(incompatibleMaildeskAccess(operation, value)).toBeNull();
    for (const mutate of [
      (v: any) => { v.result.id = "access-applications-add-an-application"; },
      (v: any) => { v.result.adapter_status = "blocked"; },
      (v: any) => { v.result.path = "/accounts/{account_id}/access/apps"; v.result.selectors = []; },
      (v: any) => { v.result.request_schema.additionalProperties = true; },
      (v: any) => { v.result.verification.required = false; },
    ]) {
      const altered = structuredClone(value); mutate(altered);
      expect(incompatibleMaildeskAccess(operation, altered)).not.toBeNull();
    }
  }
  const create = operations[0]!;
  const changed = accessEnvelope(create);
  changed.result.request_schema.properties.policies.maxItems = 1;
  expect(incompatibleMaildeskAccess(create, changed)).toContain("deny-all");
  const oldOrigin = accessEnvelope(create);
  oldOrigin.result.request_schema.properties.destinations.items.properties.uri.format = "uri";
  expect(incompatibleMaildeskAccess(create, oldOrigin)).toContain("whole-host");
  const policy = operations[2]!;
  const openRule = accessEnvelope(policy);
  openRule.result.request_schema.properties.include.items.additionalProperties = true;
  expect(incompatibleMaildeskAccess(policy, openRule)).toContain("operator-group");
});

test("explicit Access discovery clears only catalog dependency and never creates mutation authority", () => {
  for (const supported of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-access-catalog-"));
    try {
      const binary = join(dir, "cfctl");
      const cases = maildeskAccessOperations().map((operation, index) => {
        const value = accessEnvelope(operation);
        if (!supported && index === 0) value.result.adapter_status = "blocked";
        return `"catalog show ${operation.capability_id} --json") printf '%s\\n' '${JSON.stringify(value)}' ;;`;
      }).join("\n");
      writeFileSync(binary, `#!/bin/sh\ncase "$*" in\n${cases}\n*) exit 90 ;;\nesac\n`);
      chmodSync(binary, 0o700);
      const env = { ...process.env, CFCTL_BIN: binary };
      const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--installed-access"], { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", env });
      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan.access_capability_contract.catalog_admission.status).toBe(supported ? "compatible" : "incompatible");
      expect(plan.external_dependencies.length).toBe(supported ? 0 : 1);
      expect(plan.operation_ids_created).toBe(false);
      expect(plan.performed).toBe(false);
      if (!supported) expect(plan.plan_ready).toBe(false);
      const provisioning = spawnSync("bun", ["run", "scripts/check-cfctl-provisioning.ts", "--installed-access", "--json"], { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", env });
      expect(provisioning.status).toBe(supported ? 0 : 1);
      if (supported) expect(JSON.parse(provisioning.stdout).status.live_mutation_ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
