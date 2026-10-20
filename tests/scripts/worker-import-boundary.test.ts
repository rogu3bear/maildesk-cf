import { expect, test } from "bun:test";
import { assertWorkerImportBoundary } from "../../scripts/worker-import-boundary";

test("role closures reject host tools, deployable entrypoints, and legacy HTTP handlers", () => {
  const entry = "workers/mail-outbound/src/index.ts";
  expect(() => assertWorkerImportBoundary([entry, "workers/shared/outbound/queue.ts", "node_modules/postal-mime/src/postal-mime.js"], entry)).not.toThrow();
  for (const forbidden of ["scripts/sync-route-policy.ts", "node:fs", "tests/helpers/relay-runtime.ts",
    "workers/mail-api/src/index.ts", "workers/shared/legacy-reply-http.ts"]) {
    expect(() => assertWorkerImportBoundary([entry, forbidden], entry)).toThrow("forbidden runtime import");
  }
});
