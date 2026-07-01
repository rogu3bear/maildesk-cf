import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface AckManifest {
  items?: AckManifestItem[];
}

interface AckManifestItem {
  ok?: boolean;
  performed?: boolean;
  lane?: string | null;
  zone?: string;
  target?: string;
  operation_id?: string;
  ack_command?: string;
  preview_expires_at?: string;
}

interface ReadyAck {
  index: number;
  domain: string;
  lane: string | null;
  zone: string;
  name: string;
  operation_id: string;
  ack_command: string;
}

interface SenderDomainAckCommand {
  lane?: string;
  zone: string;
  name: string;
  operation_id: string;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmAckPlan = args.includes("--confirm-ack-plan");
const jsonOutput = args.includes("--json");
const manifestPath = argValue("--manifest") ?? "var/proof/maildesk-sender-domain-ack-manifest.local.json";
const outPath = argValue("--out");
const cfctlBin = argValue("--cfctl") ?? "cfctl";
const domainFilter = argValue("--domain");
const limit = args.includes("--all")
  ? Number.POSITIVE_INFINITY
  : Number(argValue("--limit") ?? (execute ? "1" : "Infinity"));

if (execute && !confirmAckPlan) {
  console.error("missing --confirm-ack-plan for --execute");
  process.exit(1);
}

if (!Number.isFinite(limit) && !args.includes("--all") && !(!execute && argValue("--limit") === undefined)) {
  console.error("invalid --limit");
  process.exit(1);
}

const manifest = readJson<AckManifest | AckManifestItem[]>(resolve(root, manifestPath));
const items = Array.isArray(manifest) ? manifest : manifest.items ?? [];
const ready = items
  .map((item, index) => normalizedAck(item, index + 1))
  .filter((item): item is ReadyAck => Boolean(item))
  .filter((item) => !domainFilter || item.domain === domainFilter)
  .slice(0, limit);

const results = ready.map((item) => (execute ? applyAck(item) : dryRunAck(item)));
const summary = {
  mode: execute ? "execute" : "dry_run",
  manifest_path: relativePath(resolve(root, manifestPath)),
  requested_domain: domainFilter ?? null,
  ready_count: ready.length,
  applied_count: results.filter((result) => result.status === "applied").length,
  dry_run_count: results.filter((result) => result.status === "dry_run").length,
  results,
};

if (outPath) {
  writeJson(outPath, summary);
}

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.status} ${result.domain} ${result.operation_id}`);
  }
  console.log(`mode ${summary.mode}`);
  console.log(`ready_count ${summary.ready_count}`);
  console.log(`applied_count ${summary.applied_count}`);
  console.log(`dry_run_count ${summary.dry_run_count}`);
}

function normalizedAck(item: AckManifestItem, index: number): ReadyAck | null {
  if (item.performed === true) return null;
  if (item.ok === false) return null;
  if (typeof item.operation_id !== "string" || item.operation_id.length === 0) return null;
  if (typeof item.ack_command !== "string" || item.ack_command.length === 0) return null;
  if (isExpired(item.preview_expires_at)) return null;

  const command = parseSenderDomainAckCommand(item.ack_command);
  if (!command) return null;
  if (item.operation_id !== command.operation_id) return null;

  const target = typeof item.target === "string" && item.target.length > 0 ? item.target : command.name;
  if (target !== command.name) return null;

  return {
    index,
    domain: target,
    lane: command.lane ?? item.lane ?? null,
    zone: command.zone,
    name: command.name,
    operation_id: item.operation_id,
    ack_command: item.ack_command,
  };
}

function dryRunAck(item: ReadyAck) {
  return {
    status: "dry_run" as const,
    index: item.index,
    domain: item.domain,
    lane: item.lane,
    zone: item.zone,
    name: item.name,
    operation_id: item.operation_id,
    ack_command: item.ack_command,
  };
}

function applyAck(item: ReadyAck) {
  const result = spawnSync(
    cfctlBin,
    [
      "apply",
      "sender_domain",
      "enable",
      "--zone",
      item.zone,
      "--name",
      item.name,
      "--ack-plan",
      item.operation_id,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(item.lane ? { CF_TOKEN_LANE: item.lane } : {}),
      },
    },
  );

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return {
    status: "applied" as const,
    index: item.index,
    domain: item.domain,
    lane: item.lane,
    zone: item.zone,
    name: item.name,
    operation_id: item.operation_id,
  };
}

function parseSenderDomainAckCommand(command: string): SenderDomainAckCommand | null {
  const match = command.match(
    /^(?:CF_TOKEN_LANE=([^\s]+)\s+)?cfctl\s+apply\s+sender_domain\s+enable\s+--zone\s+([^\s]+)\s+--name\s+([^\s]+)\s+--ack-plan\s+([^\s]+)$/,
  );
  if (!match) return null;
  return { lane: match[1], zone: match[2], name: match[3], operation_id: match[4] };
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
