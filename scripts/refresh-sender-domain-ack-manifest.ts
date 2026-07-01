import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface ProofPlan {
  actions?: ProofAction[];
}

interface ProofAction {
  kind?: string;
  blocked_by?: string;
  preview_command?: string;
}

interface PreviewCommand {
  lane?: string;
  zone: string;
  name: string;
}

interface PreviewReceipt {
  ok?: boolean;
  performed?: boolean;
  operation_id?: string;
  preview_expires_at?: string;
  summary?: {
    plan_mode?: boolean;
  };
  trust?: {
    preview_expires_at?: string;
  };
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const planPath = argValue("--plan") ?? "var/maildesk-proof-plan.json";
const outPath = argValue("--out") ?? "var/proof/maildesk-sender-domain-ack-manifest.local.json";
const previewDir = argValue("--preview-dir") ?? "var/proof/sender-domain-ack-previews";
const cfctlBin = argValue("--cfctl") ?? "cfctl";

const proofPlan = readJson<ProofPlan>(resolve(root, planPath));
const previewActions = (proofPlan.actions ?? []).filter(
  (action) =>
    action.kind === "blocked" &&
    action.blocked_by === "sender_domain_not_verified" &&
    typeof action.preview_command === "string" &&
    action.preview_command.length > 0,
);

mkdirSync(resolve(root, previewDir), { recursive: true });

const items = previewActions.map((action, index) => {
  const command = parsePreviewCommand(action.preview_command ?? "");
  if (!command) {
    console.error(`unsupported sender-domain preview command at index ${index + 1}`);
    process.exit(1);
  }

  const result = spawnSync(
    cfctlBin,
    ["apply", "sender_domain", "enable", "--zone", command.zone, "--name", command.name, "--plan"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(command.lane ? { CF_TOKEN_LANE: command.lane } : {}),
      },
    },
  );
  const previewPath = resolve(root, previewDir, `preview-${String(index + 1).padStart(2, "0")}.json`);
  if (result.stdout) {
    writeFileSync(previewPath, result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`sender-domain preview failed at index ${index + 1}`);
    process.exit(result.status ?? 1);
  }
  if (!result.stdout) {
    console.error(`sender-domain preview produced no output at index ${index + 1}`);
    process.exit(1);
  }

  const preview = parseJson<PreviewReceipt>(result.stdout, `sender-domain preview ${index + 1}`);
  const operationId = preview.operation_id;
  if (typeof operationId !== "string" || operationId.length === 0) {
    console.error(`sender-domain preview missing operation id at index ${index + 1}`);
    process.exit(1);
  }
  const previewExpiresAt = preview.trust?.preview_expires_at ?? preview.preview_expires_at;
  const ackCommand = ackCommandFor(command, operationId);

  return {
    index: index + 1,
    exit_code: result.status ?? 0,
    ok: preview.ok !== false,
    performed: preview.performed === true,
    operation_id: operationId,
    operation_id_present: true,
    lane: command.lane ?? null,
    zone: command.zone,
    target: command.name,
    zone_present: command.zone.length > 0,
    target_present: command.name.length > 0,
    ...(previewExpiresAt ? { preview_expires_at: previewExpiresAt } : {}),
    ack_command: ackCommand,
    plan_mode: preview.summary?.plan_mode === true,
    error_code: null,
  };
});

writeJson(outPath, { items });

const ackReadyCount = items.filter(
  (item) =>
    item.ok === true &&
    item.performed === false &&
    typeof item.operation_id === "string" &&
    item.operation_id.length > 0 &&
    typeof item.ack_command === "string" &&
    item.ack_command.length > 0,
).length;

const summary = {
  plan_path: relativePath(resolve(root, planPath)),
  manifest_path: relativePath(resolve(root, outPath)),
  preview_dir: relativePath(resolve(root, previewDir)),
  preview_count: items.length,
  ack_ready_count: ackReadyCount,
  failed_count: items.length - ackReadyCount,
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`plan ${summary.plan_path}`);
  console.log(`manifest ${summary.manifest_path}`);
  console.log(`preview_dir ${summary.preview_dir}`);
  console.log(`sender_domain_previews ${summary.preview_count}`);
  console.log(`sender_domain_ack_ready ${summary.ack_ready_count}/${summary.preview_count}`);
}

if (summary.failed_count > 0) {
  process.exit(1);
}

function parsePreviewCommand(command: string): PreviewCommand | null {
  const match = command.match(
    /^(?:CF_TOKEN_LANE=([^\s]+)\s+)?cfctl\s+apply\s+sender_domain\s+enable\s+--zone\s+([^\s]+)\s+--name\s+([^\s]+)\s+--plan$/,
  );
  if (!match) return null;
  return {
    lane: match[1],
    zone: match[2],
    name: match[3],
  };
}

function ackCommandFor(command: PreviewCommand, operationId: string): string {
  const prefix = command.lane ? `CF_TOKEN_LANE=${command.lane} ` : "";
  return `${prefix}cfctl apply sender_domain enable --zone ${command.zone} --name ${command.name} --ack-plan ${operationId}`;
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error(`${label} did not produce valid JSON`);
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
