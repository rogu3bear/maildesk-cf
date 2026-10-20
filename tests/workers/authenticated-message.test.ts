import { expect, test } from "bun:test";
import { signingFixture } from "../helpers/signed-message";
import { verifyOperatorDkim } from "../../workers/shared/dkim";
import { parseRelayEmail } from "../../workers/shared/inbox-relay";
import { replyAttemptIdentities } from "../../workers/shared/message-identity";

const signer = await signingFixture();
const recipient = `r+${"a".repeat(62)}@reply.example.net`;
const messageId = "<CaseSensitive.1@example.com>";
const headers = ["From: Operator <operator@example.com>", `To: ${recipient}`, `Message-ID: ${messageId}`,
  "Subject: Re: report", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 8bit", "Date: Thu, 15 Oct 2026 12:00:00 +0000"];
const verify = (raw: ArrayBuffer, to = recipient) => verifyOperatorDkim(raw, "operator@example.com", {
  fetcher: signer.fetcher, binding: { recipient: to, messageId },
});

test("ordinary message authentication binds the opaque recipient, exact identity and MIME interpretation", async () => {
  const raw = await signer.sign({ headers, body: "A plain reply.\r\n" });
  const parsed = await parseRelayEmail(raw);
  const auth = await verify(raw);
  expect(auth.status).toBe("verified");
  expect(auth.ordinaryBinding?.schemaVersion).toBe(1);
  expect(parsed.messageId).toBe(messageId);
  expect(parsed.text.trim()).toBe("A plain reply.");
  expect((await verify(raw, `r+${"b".repeat(62)}@reply.example.net`)).ordinaryBinding).toBeUndefined();
  for (const [before, after] of [
    [messageId, "<casesensitive.1@example.com>"], [recipient, `r+${"b".repeat(62)}@reply.example.net`],
    ["text/plain", "text/html"], ["8bit", "base64"], ["Subject: Re: report", "Subject: other"],
  ]) {
    const modified = new TextEncoder().encode(new TextDecoder().decode(raw).replace(before, after)).buffer;
    expect((await verify(modified)).status).not.toBe("verified");
  }
});

test("valid signed From/body alone cannot authorize ordinary replies", async () => {
  for (const unsigned of ["to", "message-id", "content-type", "content-transfer-encoding", "mime-version", "subject"]) {
    const signed = headers.map((line) => line.split(":")[0]!.toLowerCase()).filter((name) => name !== unsigned);
    const auth = await verify(await signer.sign({ headers, body: "Reply\r\n", signed }));
    expect(auth.status).toBe("verified");
    expect(auth.ordinaryBinding).toBeUndefined();
    expect(auth.ordinaryBindingError).toBe("ordinary_consumed_header_unsigned");
  }
});

test("duplicate singleton headers and any partial-body signing fail closed", async () => {
  const raw = new TextDecoder().decode(await signer.sign({ headers, body: "Reply\r\n" }));
  for (const extra of [headers[0]!, headers[1]!, headers[2]!, "Content-Type: text/html", "Subject: conflict"]) {
    expect((await verify(new TextEncoder().encode(`${extra}\r\n${raw}`).buffer)).boundedErrorCode)
      .toBe("ambiguous_singleton_headers");
  }
  const partial = await signer.sign({ headers, body: "Reply\r\n", extraTags: "l=7; " });
  expect((await verify(partial)).boundedErrorCode).toBe("dkim_partial_body_unsupported");
});

test("new attempt identities preserve case; legacy collision lookup remains stable", async () => {
  const first = await replyAttemptIdentities("relay:one", messageId);
  const second = await replyAttemptIdentities("relay:one", messageId.toLowerCase());
  expect(first.current).not.toBe(second.current);
  expect(first.legacy).toBe(second.legacy);
});
