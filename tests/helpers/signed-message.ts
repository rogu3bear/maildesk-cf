export async function signingFixture() {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicKey = base64(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    fetcher: (async () => Response.json({ Status: 0, Answer: [{
      type: 16, TTL: 0, data: `"v=DKIM1; k=rsa; p=${publicKey}"`,
    }] })) as typeof fetch,
    async sign(input: {
      headers: string[]; body: string; signed?: string[]; selector?: string; extraTags?: string;
    }): Promise<ArrayBuffer> {
      const signed = input.signed ?? input.headers.map((line) => line.slice(0, line.indexOf(":" )).toLowerCase());
      const body = input.body.replace(/\r?\n/g, "\r\n").split("\r\n")
        .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, "")).join("\r\n").replace(/(?:\r\n)*$/, "\r\n");
      const bodyHash = base64(await crypto.subtle.digest("SHA-256", bytes(body)));
      const value = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=${input.selector ?? "fixture"}; h=${signed.join(":")}; ${input.extraTags ?? ""}bh=${bodyHash}; b=`;
      const used = new Map<string, number>();
      const canonical = signed.map((name) => {
        const matching = input.headers.filter((line) => line.slice(0, line.indexOf(":" )).toLowerCase() === name);
        const offset = used.get(name) ?? 0;
        used.set(name, offset + 1);
        const line = matching.at(-1 - offset);
        return line ? canonicalHeader(line) + "\r\n" : "";
      }).join("") + `dkim-signature:${value}`;
      const signature = base64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, bytes(canonical)));
      return bytes([`DKIM-Signature: ${value}${signature}`, ...input.headers, "", input.body].join("\r\n"));
    },
  };
}

function canonicalHeader(line: string): string {
  const at = line.indexOf(":");
  return line.slice(0, at).toLowerCase() + ":" + line.slice(at + 1).replace(/\r\n[ \t]+/g, " ").replace(/[ \t]+/g, " ").trim();
}
function bytes(text: string): ArrayBuffer { return new TextEncoder().encode(text).buffer; }
function base64(bytes: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
