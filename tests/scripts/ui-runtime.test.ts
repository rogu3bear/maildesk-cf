import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { inheritedBuildStdio } from "../../scripts/inherited-build-stdio";
import { localUiPreviewConfig, previewEnvironment } from "../../scripts/local-ui-preview";

test("the built routing-health UI starts at its configured compatibility date", async () => {
  const root = resolve(import.meta.dir, "../..");
  const config = Bun.TOML.parse(await Bun.file(join(root, "wrangler.routing-health.toml")).text());
  const scratch = mkdtempSync(join(tmpdir(), "maildesk-ui-runtime-"));
  const configPath = join(scratch, "wrangler.json");
  const emptyEnv = join(scratch, "empty.env");
  writeFileSync(emptyEnv, "");
  writeFileSync(configPath, JSON.stringify(localUiPreviewConfig(root, config)));
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = socket.port;
  const inspector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const inspectorPort = inspector.port;
  socket.stop(true);
  inspector.stop(true);
  const child = spawn(process.execPath, ["--no-env-file", "x", "--no-install", "wrangler", "dev", "--config", configPath,
    "--env-file", emptyEnv, "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(inspectorPort), "--persist-to", join(scratch, "state")], {
    cwd: root, detached: true, stdio: inheritedBuildStdio(),
    env: { ...previewEnvironment(process.env), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(scratch, "runtime.log") },
  });
  let output = "";
  child.stdout?.on("data", (bytes) => { output = (output + bytes).slice(-32_768); });
  child.stderr?.on("data", (bytes) => { output = (output + bytes).slice(-32_768); });
  const exited = once(child, "exit");
  try {
    const deadline = Date.now() + 30_000;
    let response: Response | undefined;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/desk`, { signal: AbortSignal.timeout(1_000) });
        break;
      } catch { await new Promise((done) => setTimeout(done, 100)); }
    }
    expect(response, output).toBeDefined();
    expect(response!.status, output).toBe(200);
    const html = await response!.text();
    expect(html).toContain("Template preview");
    expect(html).toContain("No routes have been projected.");
    const manifest = await fetch(`http://127.0.0.1:${port}/asset-manifest.json`);
    expect(manifest.status).toBe(200);
    const assets = await manifest.json() as Record<string, string>;
    for (const kind of ["js", "wasm", "css"]) {
      const asset = await fetch(new URL(assets[kind]!, `http://127.0.0.1:${port}`));
      expect(asset.status, kind).toBe(200);
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    await exited;
  }
}, 60_000);
