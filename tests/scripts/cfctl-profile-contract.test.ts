import { describe, expect, test } from "bun:test";
import { cfctlAccountTarget, cfctlExecutable, managedProfileHealthy } from "../../scripts/cfctl-profile-contract";

const envelope = (command: string, result: unknown) => ({ schema_version: 2, command, ok: true, performed: false, result });
const doctor = envelope("doctor", { build_identity_healthy: true, path_build: { healthy: true }, instruction_drift: 0, current_profile: "another-healthy-profile" });
const auth = envelope("auth status", { credential_available: true, profile: { id: "maildesk", kind: "api_token", account_id: "account-a" } });

describe("explicit managed cfctl identity", () => {
  test("uses CLI executable override then environment then PATH", () => {
    expect(cfctlExecutable("/candidate/cfctl", { CFCTL_BIN: "/installed/cfctl" })).toBe("/candidate/cfctl");
    expect(cfctlExecutable(undefined, { CFCTL_BIN: "/installed/cfctl" })).toBe("/installed/cfctl");
    expect(cfctlExecutable(undefined, {})).toBe("cfctl");
  });
  test("accepts explicit available profile without a duplicate API token", () => {
    expect(managedProfileHealthy(doctor, auth, "maildesk", "account-a")).toBe(true);
  });
  test("global current profile cannot rescue unavailable explicit profile", () => {
    expect(managedProfileHealthy(doctor, envelope("auth status", { ...auth.result as object, credential_available: false }), "maildesk", "account-a")).toBe(false);
  });
  test("rejects mismatched account and profile independently", () => {
    expect(managedProfileHealthy(doctor, auth, "other", "account-a")).toBe(false);
    expect(managedProfileHealthy(doctor, auth, "maildesk", "account-b")).toBe(false);
  });
  test("rejects absent, legacy, performing, failed, or wrong-command envelopes", () => {
    for (const invalid of [null, { ok: true, result: auth.result }, { ...auth, performed: true }, { ...auth, ok: false }, { ...auth, command: "auth profiles" }, { ...auth, error: { code: "LOCKED" } }]) {
      expect(managedProfileHealthy(doctor, invalid, "maildesk", "account-a")).toBe(false);
    }
  });
  test("rejects unhealthy runtime regardless of available credential", () => {
    expect(managedProfileHealthy(envelope("doctor", { ...doctor.result as object, instruction_drift: 1 }), auth, "maildesk", "account-a")).toBe(false);
  });
});

test("uses the current OAuth wire spelling and refuses emergency credentials", () => {
  const status = (kind: string) => envelope("auth status", { credential_available: true, profile: { id: "maildesk", account_id: "account-a", kind } });
  expect(managedProfileHealthy(doctor, status("o_auth"), "maildesk", "account-a")).toBe(true);
  expect(managedProfileHealthy(doctor, status("oauth"), "maildesk", "account-a")).toBe(false);
  expect(managedProfileHealthy(doctor, status("global_key"), "maildesk", "account-a")).toBe(false);
  expect(managedProfileHealthy(doctor, status("wrangler_session"), "maildesk", "account-a")).toBe(false);
});

test("preflight and collection resolve literal and named environment account targets identically", () => {
  expect(cfctlAccountTarget({ account_id: "literal" }, { CLOUDFLARE_ACCOUNT_ID: "<placeholder>" })).toBe("literal");
  expect(cfctlAccountTarget({ account_id_env: "ACME_ACCOUNT" }, { ACME_ACCOUNT: "custom" })).toBe("custom");
  expect(cfctlAccountTarget({ account_id: "literal" }, { CLOUDFLARE_ACCOUNT_ID: "explicit" })).toBe("explicit");
  expect(cfctlAccountTarget({}, {})).toBeNull();
});
