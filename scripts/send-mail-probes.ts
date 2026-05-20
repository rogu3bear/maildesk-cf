import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface ProofPlan {
  actions: ProofAction[];
}

type ProofAction =
  | {
      kind: "targeted_inbound_probe";
      domain: string;
      target: string;
      description: string;
    }
  | {
      kind: "targeted_outbound_reply_probe" | "blocked";
      domain: string;
      description: string;
    };

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const jsonOutput = args.includes("--json");
const planPath = resolve(root, argValue("--plan") ?? "var/maildesk-proof-plan.json");
const from = argValue("--from") ?? (execute ? undefined : "maildesk-proof@example.com");
const domainFilter = argValue("--domain");
const limit = args.includes("--all") ? Number.POSITIVE_INFINITY : Number(argValue("--limit") ?? "1");

if (!from) {
  console.error("missing --from <verified-sender> for --execute");
  process.exit(1);
}
if (!Number.isFinite(limit) && !args.includes("--all")) {
  console.error("invalid --limit");
  process.exit(1);
}

const plan = readJson<ProofPlan>(planPath);
const probes = plan.actions
  .filter((action): action is Extract<ProofAction, { kind: "targeted_inbound_probe" }> =>
    action.kind === "targeted_inbound_probe",
  )
  .filter((action) => !domainFilter || action.domain === domainFilter)
  .slice(0, limit);

const generatedAt = new Date().toISOString();
const results = probes.map((probe) => sendProbe(probe, generatedAt));
const summary = {
  mode: execute ? "execute" : "dry_run",
  plan_path: relativePath(planPath),
  from,
  requested_domain: domainFilter ?? null,
  probe_count: results.length,
  results,
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.status} ${result.domain} ${result.target} ${result.id ?? ""}`.trim());
  }
  console.log(`mode ${summary.mode}`);
  console.log(`probe_count ${summary.probe_count}`);
}

function sendProbe(
  probe: Extract<ProofAction, { kind: "targeted_inbound_probe" }>,
  generatedAt: string,
): { domain: string; target: string; status: "sent" | "dry_run"; id?: string } {
  const idempotencyKey = `maildesk-proof:${probe.domain}:${generatedAt.slice(0, 10)}`;
  const commandArgs = [
    "emails",
    "send",
    "--from",
    from as string,
    "--to",
    probe.target,
    "--subject",
    `Maildesk proof ${probe.domain} ${generatedAt}`,
    "--text",
    `Maildesk targeted inbound proof for ${probe.domain}\nGenerated at: ${generatedAt}\nTarget: ${probe.target}\n`,
    "--headers",
    `X-Maildesk-Proof-Domain=${probe.domain}`,
    `X-Maildesk-Proof-Generated-At=${generatedAt}`,
    "--tags",
    "category=maildesk-proof",
    `domain=${probe.domain}`,
    "--idempotency-key",
    idempotencyKey,
    "--json",
    ...(execute ? [] : ["--dry-run"]),
  ];
  const result = spawnSync("resend", commandArgs, { cwd: root, encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const parsed = parseJson<{ id?: string }>(result.stdout, "resend emails send");
  return {
    domain: probe.domain,
    target: probe.target,
    status: execute ? "sent" : "dry_run",
    ...(parsed.id ? { id: parsed.id } : {}),
  };
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

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
