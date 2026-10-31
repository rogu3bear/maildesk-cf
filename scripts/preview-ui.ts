import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inheritedBuildStdio } from "./inherited-build-stdio";
import { localUiPreviewConfig, ownedPreviewSocket, previewEnvironment, previewExitExpected, previewOptions, previewPort } from "./local-ui-preview";

async function main() {
  const root = resolve(import.meta.dir, "..");
  const options = previewOptions(process.argv.slice(2));
  const environment = previewEnvironment(process.env);
  const port = previewPort(options.port);
  const inspectorPort = previewPort(0);
  const verify = spawnSync(process.execPath, ["--no-env-file", join(root, "scripts/verify-ui-build.mjs")], {
    cwd: root, env: environment, stdio: inheritedBuildStdio(), encoding: "utf8",
  });
  if (verify.status !== 0) throw new Error("Built UI verification failed; qualify build:ui before previewing");
  const proofRoot = join(root, "var/proof");
  mkdirSync(proofRoot, { recursive: true });
  const proof = mkdtempSync(join(proofRoot, "local-ui-preview-"));
  const source = Bun.TOML.parse(readFileSync(join(root, "wrangler.routing-health.toml"), "utf8")) as Record<string, unknown>;
  const config = localUiPreviewConfig(root, source);
  const configBytes = JSON.stringify(config);
  const configPath = join(proof, "wrangler.json");
  const emptyEnv = join(proof, "empty.env");
  writeFileSync(configPath, configBytes, { mode: 0o600, flag: "wx" });
  writeFileSync(emptyEnv, "", { mode: 0o600, flag: "wx" });
  const address = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--no-env-file", "x", "--no-install", "wrangler", "dev", "--config", configPath,
    "--env-file", emptyEnv, "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(inspectorPort), "--persist-to", join(proof, "state")], {
    cwd: root, detached: true, stdio: inheritedBuildStdio(),
    env: { ...environment, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(proof, "wrangler.log") },
  });
  let log = "";
  child.stdout?.on("data", bytes => { log = (log + bytes).slice(-131072); });
  child.stderr?.on("data", bytes => { log = (log + bytes).slice(-131072); });
  let stopped = false;
  let stopRequested = false;
  let childFailure: Error | undefined;
  const closed = new Promise<void>(done => {
    child.once("error", error => { childFailure = error; stopped = true; done(); });
    child.once("close", () => { stopped = true; done(); });
  });
  const stop = () => {
    if (child.pid && !stopped) {
      stopRequested = true;
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let verified = false;
  let listenerVerified = false;
  const ownedListener = () => {
    if (!child.pid || stopped || child.exitCode !== null || child.signalCode !== null) return false;
    const query = spawnSync("lsof", ["-nP", "-a", "-g", String(child.pid), "-iTCP:" + port, "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8", timeout: 2000, env: environment });
    if (query.error || query.status !== 0) return false;
    return ownedPreviewSocket(query.stdout, query.stderr, port) && !stopped && child.exitCode === null && child.signalCode === null;
  };
  try {
    const deadline = Date.now() + 30000;
    let html: string | undefined;
    while (Date.now() < deadline && !stopped) {
      try {
        if (!ownedListener()) throw new Error("Owned child has not bound the exact loopback port");
        const response = await fetch(`${address}/desk`, { signal: AbortSignal.timeout(1000) });
        if (response.status !== 200) throw new Error("Local desk did not return HTTP200");
        html = await response.text(); break;
      } catch { await new Promise(done => setTimeout(done, 100)); }
    }
    if (!html?.includes("Template preview") || !html.includes("No routes have been projected.")) {
      if (childFailure) throw new Error("Local preview executable unavailable; inspect the retained runtime log");
      throw new Error("Local UI must show the explicit preview and empty-route state");
    }
    const response = await fetch(`${address}/asset-manifest.json`, { signal: AbortSignal.timeout(1000) });
    if (response.status !== 200) throw new Error("Local UI asset manifest unavailable");
    const manifest = await response.json() as Record<string, string>;
    for (const key of ["js", "wasm", "css"]) {
      if (!/^\/pkg\/[A-Za-z0-9_.-]+$/.test(manifest[key] ?? "")) throw new Error("Preview asset escaped its local namespace");
      const asset = await fetch(new URL(manifest[key]!, address), { signal: AbortSignal.timeout(1000) });
      if (asset.status !== 200 || !(await asset.arrayBuffer()).byteLength) throw new Error("Local UI asset unavailable");
    }
    if (!ownedListener()) throw new Error("Preview listener ownership changed; preserve peers");
    listenerVerified = true;
    verified = true;
    console.log(`Local template preview: ${address}/desk\nEmpty isolated D1; outbound disabled. Ctrl+C stops this foreground preview.\nEvidence: ${proof}`);
    if (options.check) stop();
    await closed;
    if (childFailure || !previewExitExpected(child.exitCode, child.signalCode, stopRequested)) throw new Error("Local preview exited unexpectedly");
  } finally {
    stop(); await closed;
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    writeFileSync(join(proof, "runtime.log"), log, { mode: 0o600, flag: "wx" });
    writeFileSync(join(proof, "receipt.json"), JSON.stringify({
      schema_version: 1, kind: "maildesk_local_ui_preview", verified, stopped, listener_verified_in_owned_child_group: listenerVerified,
      child_exit: child.exitCode, child_signal: child.signalCode,
      address: `${address}/desk`, mode: "empty_local_preview", outbound: "disabled",
      provider_boundary_performed: false, live_policy_loaded: false, build_performed: false,
      config_sha256: createHash("sha256").update(configBytes).digest("hex"),
      asset_manifest_sha256: createHash("sha256").update(readFileSync(join(root, "target/site/asset-manifest.json"))).digest("hex"),
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
}

if (import.meta.main) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Local preview failed"); process.exitCode = 1; });
}
