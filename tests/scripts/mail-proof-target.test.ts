import { expect, test } from "bun:test";
import { roleProofTarget } from "../../scripts/mail-proof-target";

test("proof targets use the actual declared role and its public reply identity", () => {
  const roles = { info: { reply_identity: "support@example.com" } };
  expect(roleProofTarget("example.com", roles)).toEqual({ address: "info@example.com", replyIdentity: "support@example.com" });
  expect(roleProofTarget("example.com", roles, ["founders"])).toBeNull();
});

test("founders preference never selects a sink; no role produces no target", () => {
  const roles = { founders: { reply_identity: "founders@example.com", sink: true }, support: { reply_identity: "support@example.com" } };
  expect(roleProofTarget("example.com", roles)?.address).toBe("support@example.com");
  expect(roleProofTarget("example.com", {})).toBeNull();
});
