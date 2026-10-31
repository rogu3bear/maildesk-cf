import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { localUiPreviewConfig, ownedPreviewSocket, previewEnvironment, previewExitExpected, previewOptions, previewPort } from "../../scripts/local-ui-preview";

test("only an owned requested stop accepts the Bun wrapper's SIGTERM exit code", () => {
  expect(previewExitExpected(0, null, false)).toBe(true);
  expect(previewExitExpected(null, "SIGTERM", true)).toBe(true);
  expect(previewExitExpected(143, null, true)).toBe(true);
  expect(previewExitExpected(143, null, false)).toBe(false);
  expect(previewExitExpected(null, "SIGTERM", false)).toBe(false);
  expect(previewExitExpected(1, null, true)).toBe(false);
  expect(previewExitExpected(null, "SIGKILL", true)).toBe(false);
});

test("readiness needs the exact owned loopback socket; unqualified query coverage holds", () => {
  expect(ownedPreviewSocket("p123\nn127.0.0.1:57591\n", "", 57591)).toBe(true);
  expect(ownedPreviewSocket("p123\nn127.0.0.1:57592\n", "", 57591)).toBe(false);
  expect(ownedPreviewSocket("p123\nn*:57591\n", "", 57591)).toBe(false);
  expect(ownedPreviewSocket("p123\nn127.0.0.1:57591\n", "permission denied", 57591)).toBe(false);
  expect(ownedPreviewSocket("p123\nn127.0.0.1:57591\n", 'lsof: WARNING: can\'t stat() smbfs file system /Volumes/.timemachine/example\n      Output information may be incomplete.\n      assuming "dev=3600009c" from mount table\n', 57591)).toBe(true);
});

test("a pre-existing requested-port listener is preserved and cannot satisfy preview readiness", async () => {
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owned peer remains") });
  try {
    expect(() => previewPort(peer.port!)).toThrow("preserve the existing listener");
    expect(await (await fetch(`http://127.0.0.1:${peer.port}`)).text()).toBe("owned peer remains");
  } finally { peer.stop(true); }
});

test("preview excludes provider/application secrets and preserves the actual normal reservation", () => {
  expect(previewEnvironment({ PATH: "/tooling", HOME: "/fixture", DISK_GUARD_RESERVATION: "actual capability",
    CF_DEV_TOKEN: "must not enter", CLOUDFLARE_API_TOKEN: "must not enter", NODE_OPTIONS: "must not enter",
    MAILDESK_PRIVATE_POLICY: "must not enter" })).toEqual({ PATH: "/tooling", HOME: "/fixture", DISK_GUARD_RESERVATION: "actual capability" });
  expect(() => previewEnvironment({ DISK_GUARD_CUSTODY: "opaque watched capability" })).toThrow("preserve the inherited");
});

test("preview selects built artifacts but never copies production authority or private vars", () => {
  const root = resolve(import.meta.dir, "../..");
  const config = localUiPreviewConfig(root, {
    main: "build/_worker.js", compatibility_date: "2026-08-12", assets: { directory: "target/site" },
    vars: { PRIVATE_VALUE: "must not be copied", MAILDESK_OUTBOUND_MODE: "enabled" },
    d1_databases: [{ database_id: "production-identity" }], queues: { producer: "production" },
    build: { command: "must not run" }, routes: ["production.example.com"],
  });
  expect(config.main).toBe(resolve(root, "build/_worker.js"));
  expect(config.compatibility_date).toBe("2026-08-12");
  expect(config.vars).toEqual({ MAILDESK_UI_AUTH_MODE: "preview", MAILDESK_UI_ACCESS_SCOPE: "all_routes",
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay", MAILDESK_OUTBOUND_MODE: "disabled" });
  expect(config.assets.run_worker_first).toBe(true);
  expect(config.d1_databases[0]!.database_id).toBe("00000000-0000-0000-0000-000000000000");
  expect(config).not.toHaveProperty("build"); expect(config).not.toHaveProperty("queues"); expect(config).not.toHaveProperty("routes");
});

test("preview refuses an unexpected artifact source instead of following a production config", () => {
  expect(() => localUiPreviewConfig("/fixture", { main: "workers/mail-router/src/index.ts" })).toThrow("built Worker");
});

test("preview CLI binds loopback options and rejects remote/host/config escape options", () => {
  expect(previewOptions([])).toEqual({ check: false, port: 57591 });
  expect(previewOptions(["--check", "--port", "0"])).toEqual({ check: true, port: 0 });
  for (const args of [["--remote"], ["--host", "0.0.0.0"], ["--config", "production.toml"],
    ["--port", "65536"], ["--check", "--check"], ["--port", "-1"]]) {
    expect(() => previewOptions(args)).toThrow();
  }
});
