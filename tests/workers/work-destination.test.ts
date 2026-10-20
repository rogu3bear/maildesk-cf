import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { handoffSelectedWork, selectDestination, type DurableWorkDestination } from "../../workers/shared/work-destination";
import { routeInbound, type RouterPolicy } from "../../workers/shared/router";

const policy = await Bun.file(new URL("../fixtures/routing-policy-v2.json", import.meta.url)).json() as RouterPolicy;
const result = routeInbound(policy, { envelopeTo: "security@example.net", headerFrom: "sender@example.org" });
if (!result.ok) throw new Error("invalid work destination fixture");
const route = result.value;

test("only an exact supported destination adapter makes a work queue eligible", () => {
  const handoff: DurableWorkDestination["handoff"] = async ({ deliveryId }) => ({ deliveryId, receiptId: "receipt", outcome: "durably_accepted" });
  for (const adapters of [
    new Map<string, DurableWorkDestination>(),
    new Map([["other-queue", { contract: "durable-work-handoff-v1" as const, queueRef: "other-queue", handoff }]]),
    new Map([["support-intake", { contract: "durable-work-handoff-v1" as const, queueRef: "wrong-queue", handoff }]]),
  ]) {
    expect(selectDestination(route, adapters)).toMatchObject({
      destinationRef: "mailbox:support", fallbackUsed: true, target: { kind: "mailbox" },
    });
  }
  const noFallback = { ...route, disposition: { ...route.disposition!, candidates: route.disposition!.candidates.slice(0, 1) } };
  expect(selectDestination(noFallback)).toBeNull();
});

test("a durable fixture handoff deduplicates; an uncertain acceptance never falls back", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE work_items (id TEXT PRIMARY KEY, route_ref TEXT NOT NULL)");
  let loseAcknowledgment = false;
  const adapter: DurableWorkDestination = {
    contract: "durable-work-handoff-v1", queueRef: "support-intake",
    async handoff(input) {
      db.run("INSERT OR IGNORE INTO work_items VALUES (?, ?)", [input.deliveryId, input.routeRef]);
      if (loseAcknowledgment) throw new Error("acceptance acknowledgment lost");
      return { deliveryId: input.deliveryId, receiptId: `accepted:${input.deliveryId}`, outcome: "durably_accepted" };
    },
  };
  try {
    const selected = selectDestination(route, new Map([[adapter.queueRef, adapter]]))!;
    expect(selected.target.kind).toBe("work_queue");
    expect(await handoffSelectedWork(selected, { deliveryId: "one", rawR2Key: "fixture.eml" })).toBe("durably_accepted");
    loseAcknowledgment = true;
    expect(await handoffSelectedWork(selected, { deliveryId: "one", rawR2Key: "fixture.eml" })).toBe("recovery_required");
    expect(db.query("SELECT count(*) AS n FROM work_items").get()).toEqual({ n: 1 });
    expect(selected.target.kind).toBe("work_queue");
  } finally { db.close(); }
});
