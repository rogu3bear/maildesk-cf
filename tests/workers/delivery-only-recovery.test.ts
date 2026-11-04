import { expect, test } from "bun:test";
import { recoverDeliveryOnlyByFingerprint } from "../../workers/mail-router/src/delivery-only-recovery";
import type { Env } from "../../workers/mail-router/src/inbound-repository";

function fixture(rows: unknown[]) {
  let sends = 0, updates = 0;
  const env = {
    DB: {
      withSession: (constraint: string) => {
        expect(constraint).toBe("first-primary");
        return { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: rows }) }) }) };
      },
      prepare: () => ({ bind: () => ({ run: async () => { updates++; return { success: true, meta: { changes: 1 } }; } }) }),
    },
    EMAIL: { send: async () => { sends++; } },
  } as unknown as Env;
  return { env, sends: () => sends, updates: () => updates };
}
const fingerprint = "a".repeat(64);
const row = { id: `inbound:${fingerprint}`, fingerprint_sha256: fingerprint, policy_sha256: "b".repeat(64),
  raw_r2_key: "spool", recipient_count: 1, delivery_status: "pending", local_part: "dmarc", domain: "example.com", recipient_ref: "c".repeat(64),
  delivery_message_id: "id", delivery_payload_r2_key: "payload", delivery_payload_sha256: "d".repeat(64), status: "sending" };

test("recovery distinguishes absence and incomplete sets without crossing provider boundary", async () => {
  const absent = fixture([]);
  expect(await recoverDeliveryOnlyByFingerprint(absent.env, fingerprint)).toBe("absent");
  const incomplete = fixture([{ ...row, recipient_count: 2 }]);
  expect(await recoverDeliveryOnlyByFingerprint(incomplete.env, fingerprint)).toBe("held");
  expect(incomplete.sends()).toBe(0); expect(incomplete.updates()).toBe(0);
});

test("recovery never resends an attempted recipient", async () => {
  for (const status of ["sending", "provider_accepted", "recovery_required", "failed"]) {
    const f = fixture([{ ...row, status }]);
    expect(await recoverDeliveryOnlyByFingerprint(f.env, fingerprint)).toBe("processed");
    expect(f.sends()).toBe(0); expect(f.updates()).toBe(1);
  }
});
