import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hashUiAssets } from "../../scripts/hash-ui-assets.mjs";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex").slice(0, 16);

test("WASM-only changes invalidate the final JavaScript URL and every digest names actual bytes", () => {
  const js = Buffer.from('const wasm = new URL("maildesk-ui.wasm",import.meta.url);');
  const css = Buffer.from("body{}");
  const before = hashUiAssets("maildesk-ui", js, Buffer.from("wasm-before"), css);
  const after = hashUiAssets("maildesk-ui", js, Buffer.from("wasm-after"), css);
  expect(before.names.js).not.toBe(after.names.js);
  expect(after.rewrittenJs).toContain(after.names.wasm);
  expect(after.hashes.js).toBe(hash(after.rewrittenJs));
  expect(after.hashes.wasm).toBe(hash("wasm-after"));
  expect(after.hashes.css).toBe(hash(css));
  for (const text of ['new URL("other.wasm",import.meta.url)', 'no reference', `${js};${js}`]) {
    expect(() => hashUiAssets("maildesk-ui", Buffer.from(text), Buffer.from("wasm"), css)).toThrow("exactly one known");
  }
});
