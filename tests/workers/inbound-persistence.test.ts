import { expect, test } from "bun:test";
import { relayRuntime } from "../helpers/relay-runtime";

type Fixture = Awaited<ReturnType<typeof relayRuntime>>;
const raw = new TextEncoder().encode([
  "From: sender@example.net", "To: support@example.com",
  "Message-ID: <inbound-persistence@example.net>", "Subject: Persistence recovery",
  "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "An inbound message.", "",
].join("\r\n")).buffer;
const ingress = (f: Fixture) => f.ingress(raw, "support@example.com", "sender@example.net");
const recipients = (f: Fixture) => f.db.query("SELECT status FROM inbound_recipient_deliveries ORDER BY operator_ref").all();

async function finishRecoveredDelivery(f: Fixture) {
  expect(f.sends).toHaveLength(2);
  expect(recipients(f)).toEqual([{ status: "provider_accepted" }, { status: "provider_accepted" }]);
  expect(f.jobs).toHaveLength(1);
  await f.consume(f.jobs[0]);
  expect(f.spools.size).toBe(0);
  expect(await ingress(f)).toBeUndefined();
  expect(f.sends).toHaveLength(2);
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

test("a post-commit audit failure recovers the same inbound spool generation", async () => {
  const f = await relayRuntime();
  try {
    let faulted = false;
    f.d1.before = (sql, values) => {
      if (sql.includes("INSERT INTO audit_events") && values[4] === "inbox_relay_created") {
        faulted = true;
        throw new Error("audit unavailable after committed inbound batch");
      }
    };
    expect(await ingress(f)).toBeUndefined();
    expect(faulted).toBe(true);
    f.d1.before = undefined;
    await finishRecoveredDelivery(f);
  } finally { f.db.close(); }
});

for (const readbackUnavailable of [false, true]) {
  test(`a lost inbound commit acknowledgement preserves recovery with readback ${readbackUnavailable ? "unavailable" : "available"}`, async () => {
    const f = await relayRuntime();
    try {
      const batch = f.d1.batch.bind(f.d1);
      let committed = false;
      f.d1.batch = async (statements) => {
        const result = await batch(statements);
        if (!committed) {
          committed = true;
          throw new Error("inbound commit acknowledgement lost");
        }
        return result;
      };
      f.d1.before = (sql) => {
        if (committed && readbackUnavailable && sql.includes("WHERE d.fingerprint_sha256 = ?1")) {
          throw new Error("inbound readback unavailable");
        }
      };
      const rejected = await ingress(f);
      expect(committed).toBe(true);
      if (readbackUnavailable) {
        expect(rejected).toContain("reconciliation");
        expect(f.sends).toHaveLength(0);
        expect(f.spools.size).toBe(3);
        expect(recipients(f)).toEqual([{ status: "pending" }, { status: "pending" }]);
        f.d1.before = undefined;
        expect(await ingress(f)).toBeUndefined();
      } else expect(rejected).toBeUndefined();
      await finishRecoveredDelivery(f);
    } finally { f.db.close(); }
  });
}

test("a persistence rejection and absent readback retain bounded spools without sending", async () => {
  const f = await relayRuntime();
  try {
    f.d1.before = (sql) => {
      if (sql.startsWith("INSERT INTO inbound_deliveries")) throw new Error("batch rolled back");
    };
    expect(await ingress(f)).toContain("reconciliation");
    expect(f.sends).toHaveLength(0);
    expect(f.spools.size).toBe(3);
    expect(recipients(f)).toEqual([]);
    expect(f.db.query("SELECT count(*) AS n FROM inbound_deliveries WHERE id != 'inbound:one'").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("a competing committed inbound generation retains its delivery and cleans only the losing spools", async () => {
  const f = await relayRuntime();
  try {
    const batch = f.d1.batch.bind(f.d1);
    let competed = false;
    f.d1.batch = async (statements) => {
      if (!competed) {
        competed = true;
        expect(await ingress(f)).toBeUndefined();
      }
      return batch(statements);
    };
    expect(await ingress(f)).toBeUndefined();
    expect(competed).toBe(true);
    expect(f.sends).toHaveLength(2);
    expect(recipients(f)).toEqual([{ status: "provider_accepted" }, { status: "provider_accepted" }]);
    expect(f.spools.size).toBe(0);
    expect(await ingress(f)).toBeUndefined();
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});
