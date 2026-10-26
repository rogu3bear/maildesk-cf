import { expect, test } from "bun:test";
import mailRouter from "../../workers/mail-router/src/index";
import { sha256Hex } from "../../workers/shared/inbox-relay";
import { verifyOperatorDkim } from "../../workers/shared/dkim";
import { activateFixture, relayRuntime } from "../helpers/relay-runtime";
import { signingFixture } from "../helpers/signed-message";

const signer = await signingFixture();
type Runtime = Awaited<ReturnType<typeof relayRuntime>>;
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
function headers(f: Runtime) {
  return ["From: operator@example.com", `To: ${f.relayRecipient}`, "Message-ID: <pipeline@example.com>",
    "Subject: Re: report", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"];
}
async function ingress(f: Runtime, raw: ArrayBuffer, to = f.relayRecipient) {
  let rejected: string | undefined;
  const prior = globalThis.fetch;
  globalThis.fetch = signer.fetcher;
  try {
    await mailRouter.email({ from: "operator@example.com", to, rawSize: raw.byteLength,
      raw: new Response(raw.slice(0)).body!, headers: new Headers(),
      setReject(reason: string) { rejected = reason; },
    } as ForwardableEmailMessage, f.env);
  } finally { globalThis.fetch = prior; }
  return rejected;
}

test("a DKIM deadline cannot consume ordinary authority, stage content or dispatch mail", async () => {
  const f = await relayRuntime();
  const prior = globalThis.fetch;
  try {
    await activateFixture(f);
    const raw = await signer.sign({ headers: headers(f), body: "A plain reply.\r\n", selector: "pipeline-deadline" });
    const before = { jobs: f.jobs.length, sends: f.sends.length, spools: f.spools.size };
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    }) as typeof fetch;
    let rejected: string | undefined;
    await mailRouter.email({ from: "operator@example.com", to: f.relayRecipient, rawSize: raw.byteLength,
      raw: new Response(raw).body!, headers: new Headers(),
      setReject(reason: string) { rejected = reason; },
    } as ForwardableEmailMessage, f.env);
    expect(rejected).toContain("aligned email authentication");
    expect(signal?.aborted).toBe(true);
    expect({ jobs: f.jobs.length, sends: f.sends.length, spools: f.spools.size }).toEqual(before);
    expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT status FROM route_reply_authorizations").get()).toEqual({ status: "active" });
  } finally { globalThis.fetch = prior; f.db.close(); }
}, 10_000);

for (const field of ["message-id", "to", "content-type", "content-transfer-encoding", "mime-version", "subject"]) {
  test(`valid From/body cannot admit an ordinary reply with unsigned ${field}`, async () => {
    const f = await relayRuntime();
    try {
      await activateFixture(f);
      const lines = headers(f);
      const signed = lines.map((line) => line.split(":")[0]!.toLowerCase()).filter((name) => name !== field);
      let raw = await signer.sign({ headers: lines, signed, body: "Authored first paragraph.\r\n\r\nFinal short line.\r\n" });
      const replacement: Record<string, [string, string]> = {
        "message-id": ["<pipeline@example.com>", "<new-logical-reply@example.com>"],
        "to": [f.relayRecipient, `r+${"b".repeat(62)}@reply.example.net`],
        "content-type": ["text/plain", "text/html"],
        "content-transfer-encoding": ["8bit", "base64"],
        "mime-version": ["MIME-Version: 1.0", "MIME-Version: 2.0"],
        "subject": ["Subject: Re: report", "Subject: forged outward content"],
      };
      const [before, after] = replacement[field]!;
      raw = bytes(new TextDecoder().decode(raw).replace(before, after));
      expect((await verifyOperatorDkim(raw, "operator@example.com", { fetcher: signer.fetcher })).status).toBe("verified");
      expect(await ingress(f, raw)).toBeDefined();
      expect(f.jobs).toHaveLength(1);
      expect(f.sends).toHaveLength(1);
      expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 1 });
      expect(f.spools.size).toBe(0);
    } finally { f.db.close(); }
  });
}

test("conflicting singleton headers create no durable authorization or dispatch", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    const original = new TextDecoder().decode(await signer.sign({ headers: headers(f), body: "A plain reply.\r\n" }));
    for (const extra of ["From: second@example.com", `To: ${f.relayRecipient}`, "Message-ID: <other@example.com>", "Content-Type: text/html", "Subject: conflicting"]) {
      expect(await ingress(f, bytes(`${extra}\r\n${original}`))).toBeDefined();
      expect(f.jobs).toHaveLength(1);
      expect(f.sends).toHaveLength(1);
      expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
      expect(f.spools.size).toBe(0);
    }
  } finally { f.db.close(); }
});

test("a fully authenticated accepted message cannot be replayed against another live relay", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    const token = "b".repeat(62);
    f.db.run(`INSERT INTO reply_relays (id,token_sha256,thread_id,route_id,external_recipient,reply_identity,original_message_id,expires_at)
      VALUES ('relay:two',?,'thread:one','route:example.com:support','another@example.net','support@example.com','<original-two@example.net>','2099-01-01T00:00:00Z')`, [await sha256Hex(token)]);
    const raw = await signer.sign({ headers: headers(f), body: "A plain reply.\r\n" });
    expect(await ingress(f, raw)).toBeUndefined();
    await f.consume(f.jobs.at(-1));
    expect(await ingress(f, raw, `r+${token}@reply.example.net`)).toBeDefined();
    expect(f.db.query("SELECT relay_id,status FROM ordinary_reply_admissions").all()).toEqual([{ relay_id: "relay:one", status: "provider_accepted" }]);
    expect(f.sends).toHaveLength(2);
    expect(f.jobs).toHaveLength(2);
    expect(f.spools.size).toBe(0);
  } finally { f.db.close(); }
});

test("authenticated canary and ordinary spool claims require every durable authorization binding", async () => {
  const { CLAIMED_REPLY_SPOOL_SQL } = await import("../../workers/shared/outbound/reply-authorization");
  for (const kind of ["canary", "ordinary"] as const) {
    const f = await relayRuntime();
    try {
      if (kind === "ordinary") await activateFixture(f);
      else await f.admitCanary();
      expect(await f.ingress(await f.signedReply())).toBeUndefined();
      const job = f.jobs.at(-1)!;
      if (job.kind !== "inbox_reply_received") throw new Error("unexpected fixture job");
      const bindings = [job.attemptId, job.relayId, job.operator, job.operatorMessageId, job.rawR2Key,
        job.rawSha256, job.admissionId, job.transactionSha256, job.attemptSha256, job.claimedPayloadSha256,
        job.desiredStateSha256, job.identityProfileSha256, kind, job.activationId ?? null];
      if (bindings.some((value) => value === undefined)) throw new Error("incomplete fixture authorization");
      const bound = bindings as (string | null)[];
      expect(f.db.query(CLAIMED_REPLY_SPOOL_SQL).get(...bound)).toEqual({ id: job.attemptId });
      for (let index = 0; index < bound.length; index++) {
        const wrong = [...bound]; wrong[index] = "substituted-binding";
        expect(f.db.query(CLAIMED_REPLY_SPOOL_SQL).get(...wrong)).toBeNull();
      }
      expect(f.sends).toHaveLength(kind === "ordinary" ? 1 : 0);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { f.db.close(); }
  }
});
