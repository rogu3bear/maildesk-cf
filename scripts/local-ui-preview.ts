import { resolve } from "node:path";

export function previewExitExpected(code: number | null, signal: NodeJS.Signals | null, stopRequested: boolean): boolean {
  return code === 0 || stopRequested && (signal === "SIGTERM" || signal === null && code === 143);
}

export function previewPort(requested: number): number {
  try {
    const socket = Bun.serve({ hostname: "127.0.0.1", port: requested, fetch: () => new Response() });
    const port = socket.port!; socket.stop(true); return port;
  } catch {
    throw new Error("Requested loopback preview port is unavailable; preserve the existing listener or choose --port 0");
  }
}

export function ownedPreviewSocket(stdout: string, stderr: string, port: number): boolean {
  // This known macOS warning concerns an unavailable backup filesystem, not
  // the selected process group's kernel TCP listener. All other warnings hold.
  const backupWarning = /^lsof: WARNING: can't stat\(\) smbfs file system \/Volumes\/\.timemachine\/[^\n]+\n {6}Output information may be incomplete\.\n {6}assuming "dev=[a-fA-F0-9x]+" from mount table\n?$/;
  return (!stderr || backupWarning.test(stderr)) && stdout.split("\n").includes("n127.0.0.1:" + port);
}

/** Runtime tooling context only; application/provider credentials never enter Wrangler. */
export function previewEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.DISK_GUARD_CUSTODY !== undefined) throw new Error("Preview needs the qualified normal admission lane; preserve the inherited watched custody");
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
    "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DISK_GUARD_RESERVATION"];
  return Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

/** Select only the already-qualified UI artifacts; never copy production vars/bindings. */
export function localUiPreviewConfig(root: string, source: Record<string, unknown>) {
  const assets = source.assets as Record<string, unknown> | undefined;
  if (source.main !== "build/_worker.js" || assets?.directory !== "target/site" ||
      typeof source.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(source.compatibility_date)) {
    throw new Error("Local preview requires the routing-health built Worker, site assets and compatibility date");
  }
  return {
    name: "maildesk-local-preview", main: resolve(root, source.main),
    compatibility_date: source.compatibility_date, workers_dev: false,
    assets: { directory: resolve(root, "target/site"), binding: "ASSETS", run_worker_first: true },
    vars: { MAILDESK_UI_AUTH_MODE: "preview", MAILDESK_UI_ACCESS_SCOPE: "all_routes",
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay", MAILDESK_OUTBOUND_MODE: "disabled" },
    d1_databases: [{ binding: "DB", database_name: "maildesk-local-preview",
      database_id: "00000000-0000-0000-0000-000000000000" }],
  };
}

export function previewOptions(args: string[]) {
  let check = false;
  let port = 57591;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (seen.has(key)) throw new Error("Duplicate preview option");
    seen.add(key);
    if (key === "--check") check = true;
    else if (key === "--port" && /^\d{1,5}$/.test(args[i + 1] ?? "")) {
      port = Number(args[++i]);
      if (port > 65535) throw new Error("Preview port must be 0–65535");
    } else throw new Error("usage: bun --no-env-file scripts/preview-ui.ts [--check] [--port 0–65535]");
  }
  return { check, port };
}
