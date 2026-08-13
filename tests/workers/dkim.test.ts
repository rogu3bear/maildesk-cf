import { beforeAll, expect, test } from "bun:test";

import { verifyOperatorDkim } from "../../workers/shared/dkim";

let privateKey: CryptoKey;
let publicKeyBase64: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicKeyBase64 = base64(await crypto.subtle.exportKey("spki", pair.publicKey));
});

test("aligned rsa-sha256 signature cryptographically authorizes the operator", async () => {
  const raw = await signedMessage();
  const result = await verifyOperatorDkim(raw, "operator@example.com", { fetcher: dnsFetcher() });

  expect(result.status).toBe("verified");
  expect(result.signingDomain).toBe("example.com");
  expect(result.selectorHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.alignedOperatorId).toMatch(/^[a-f0-9]{64}$/);
});

test("body, signing-domain, and signed From tampering fail closed", async () => {
  const valid = decode(await signedMessage());
  const cases = [
    valid.replace("hello\r\n", "tampered\r\n"),
    valid.replace("d=example.com", "d=example.net"),
    valid.replace("From: operator@example.com", "From: attacker@example.com"),
  ];
  for (const raw of cases) {
    const result = await verifyOperatorDkim(encode(raw), "operator@example.com", { fetcher: dnsFetcher() });
    expect(result.status).not.toBe("verified");
  }
});

test("sender-controlled Authentication-Results never substitutes for DKIM", async () => {
  const raw = encode([
    "From: operator@example.com",
    "To: relay@example.net",
    "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com",
    "Subject: unsigned",
    "",
    "hello",
    "",
  ].join("\r\n"));
  const result = await verifyOperatorDkim(raw, "operator@example.com", { fetcher: dnsFetcher() });
  expect(result.status).toBe("rejected");
  expect(result.boundedErrorCode).toBe("dkim_missing");
});

test("DNS failure is indeterminate and therefore fail closed", async () => {
  const result = await verifyOperatorDkim(await signedMessage("unavailable"), "operator@example.com", {
    fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  });
  expect(result.status).toBe("indeterminate");
  expect(result.boundedErrorCode).toBe("dkim_key_unavailable");
});

test("a cryptographically valid 1024-bit RSA signature is rejected as weak", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const weakPublicKey = base64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const raw = await signedMessage("weak", pair.privateKey);
  const result = await verifyOperatorDkim(raw, "operator@example.com", {
    fetcher: dnsFetcher(weakPublicKey),
  });

  expect(result.status).toBe("rejected");
  expect(result.boundedErrorCode).toBe("dkim_key_weak");
});

async function signedMessage(selector = "test", signingKey = privateKey): Promise<ArrayBuffer> {
  const headers = [
    "From: operator@example.com",
    "To: relay@example.net",
    "Subject: reply",
    "Date: Wed, 12 Aug 2026 12:00:00 +0000",
  ];
  const body = "hello\r\n";
  const bodyHash = base64(await crypto.subtle.digest("SHA-256", encode(body)));
  const value = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=${selector}; h=from:to:subject:date; bh=${bodyHash}; b=`;
  const canonical = [
    "from:operator@example.com\r\n",
    "to:relay@example.net\r\n",
    "subject:reply\r\n",
    "date:Wed, 12 Aug 2026 12:00:00 +0000\r\n",
    `dkim-signature:${value}`,
  ].join("");
  const signature = base64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encode(canonical)));
  return encode([`DKIM-Signature: ${value}${signature}`, ...headers, "", body].join("\r\n"));
}

function dnsFetcher(key = publicKeyBase64): typeof fetch {
  return (async () => Response.json({
    Status: 0,
    Answer: [{ type: 16, TTL: 60, data: `"v=DKIM1; k=rsa; p=${key}"` }],
  })) as typeof fetch;
}

function encode(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

function decode(value: ArrayBuffer): string {
  return new TextDecoder().decode(value);
}

function base64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
