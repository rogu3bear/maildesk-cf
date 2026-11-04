import { expect, test } from "bun:test";
import { buildDeliveryOnlyMessage, type ParsedRelayEmail } from "../../workers/shared/inbox-relay";

test("delivery-only message preserves report content and exposes no reply relay", () => {
  const bytes = new TextEncoder().encode("report payload").buffer;
  const original: ParsedRelayEmail = {
    from: { address: "sender@example.net", name: "Report sender" },
    subject: "Aggregate report",
    text: "report body",
    html: "<p>report body</p>",
    references: [],
    attachments: [{ disposition: "attachment", filename: "report.xml", type: "application/xml", content: bytes }],
  };
  const result = buildDeliveryOnlyMessage(original, {
    recipient: "REPORTS@example.net", receivedAddress: "DMARC@example.com", deliveryMessageId: "delivery:1",
  });
  expect(result.to).toBe("reports@example.net");
  expect(result.from.email).toBe("dmarc@example.com");
  expect(result.text).toBe(original.text);
  expect(result.html).toBe(original.html);
  expect(result.attachments?.[0]?.content).toEqual(bytes);
  expect("replyTo" in result).toBe(false);
  expect(Object.keys(result.headers).some((name) => /reply/i.test(name))).toBe(false);
});

test("delivery-only message rejects invalid mailbox input", () => {
  const original: ParsedRelayEmail = { from: { address: "sender@example.net" }, subject: "x", text: "x", references: [], attachments: [] };
  expect(() => buildDeliveryOnlyMessage(original, { recipient: "bad address", receivedAddress: "dmarc@example.com", deliveryMessageId: "d" })).toThrow();
});
