import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvFile } from "./env-file";

interface ReceiptSummary {
  local_truth_ok?: boolean;
  live_evidence_present?: boolean;
  edge_ready?: boolean;
  mail_ready?: boolean;
  domain_count?: number;
  gap_count?: number;
  local_gap_count?: number;
  edge_gap_count?: number;
  mail_gap_count?: number;
  proof_actions?: number;
  targeted_inbound_probes?: number;
  targeted_outbound_reply_probes?: number;
  blocked_proofs?: number;
  sender_domain_blocked_count?: number;
  sender_domain_ack_ready_count?: number;
  sender_domain_ack_missing_count?: number;
}

interface AckDryRunSummary {
  mode?: string;
  ready_count?: number;
  applied_count?: number;
  dry_run_count?: number;
  results?: unknown[];
}

interface RedactedAckDryRunSummary {
  mode: string;
  ready_count: number;
  applied_count: number;
  dry_run_count: number;
  result_count: number;
}

interface AckRefreshSummary {
  ok: boolean;
  status: number;
  plan_path?: string;
  manifest_path?: string;
  preview_count?: number;
  ack_ready_count?: number;
  failed_count?: number;
  failures: string[];
}

interface PreviewCleanupSummary {
  ok: boolean;
  status: number;
  performed?: boolean;
  purged_count?: number;
  duplicate_group_count?: number;
  expired_purged_count?: number;
  failures: string[];
}

interface Blocker {
  kind: string;
  count?: number;
  detail?: string;
}

interface ProtectedActionsSummary {
  sender_domain_apply: ProtectedActionHandoff;
  inbound_probe: ProtectedActionHandoff;
  outbound_reply_probe: ProtectedActionHandoff;
}

interface ProtectedActionHandoff {
  count: number;
  dry_run_ready_count?: number;
  required_flags: string[];
  bulk_confirmation_required: boolean;
  bulk_confirmation_flag: string | null;
}

interface ProtectedCommandHandoffSummary {
  sender_domain_apply: ProtectedCommandHandoff | null;
  inbound_probe: ProtectedCommandHandoff | null;
  outbound_reply_probe: ProtectedCommandHandoff | null;
}

interface ProtectedCommandHandoff {
  dry_run_one: string[];
  execute_one: string[] | null;
  execute_all: string[] | null;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const jsonOutput = args.includes("--json");
const redactSensitive = args.includes("--redact-sensitive");
const envFileLoad = loadEnvFile(root, argValue("--env-file"));
const summaryPath =
  argValue("--summary") ?? "var/proof/maildesk-receipt-require-ack-ready-summary.local.json";
const ackManifestPath =
  argValue("--ack-manifest") ?? "var/proof/maildesk-sender-domain-ack-manifest.local.json";
const planPath = argValue("--plan") ?? "var/maildesk-proof-plan.json";
const refreshAcks = args.includes("--refresh-acks");
const purgeDuplicatePreviews = args.includes("--purge-duplicate-previews");
const purgeExpiredPreviews = args.includes("--purge-expired-previews");
const skipAckDryRun = args.includes("--skip-ack-dry-run");
const skipProductionPreflight = args.includes("--skip-production-preflight");

const summary = readJson<ReceiptSummary>(summaryPath);
const productionPreflight = skipProductionPreflight
  ? null
  : envFileLoad.failures.length > 0
    ? { ok: false, status: 1, failures: envFileLoad.failures }
    : runProductionPreflight();
const ackRefresh = refreshAcks ? runAckRefresh(planPath, ackManifestPath) : null;
const previewCleanup =
  purgeDuplicatePreviews || purgeExpiredPreviews
    ? runPreviewCleanup(purgeDuplicatePreviews, purgeExpiredPreviews)
    : null;
const ackDryRun =
  skipAckDryRun || !existsSync(resolve(root, ackManifestPath)) ? null : runAckDryRun(ackManifestPath);
const blockers = buildBlockers(summary, productionPreflight, ackRefresh, previewCleanup, ackDryRun);
const protectedActions = buildProtectedActions(summary, ackDryRun);
const protectedCommandHandoff = buildProtectedCommandHandoff(
  protectedActions,
  ackManifestPath,
  planPath,
);
const ready =
  blockers.length === 0 &&
  productionPreflight?.ok !== false &&
  summary.local_truth_ok === true &&
  summary.live_evidence_present === true &&
  summary.edge_ready === true &&
  summary.mail_ready === true;

const closeout = {
  ready,
  sensitive_redacted: redactSensitive,
  summary_path: relativePath(resolve(root, summaryPath)),
  ack_manifest_path:
    skipAckDryRun || !existsSync(resolve(root, ackManifestPath))
      ? null
      : relativePath(resolve(root, ackManifestPath)),
  production_preflight: productionPreflight,
  ack_refresh: ackRefresh,
  preview_cleanup: previewCleanup,
  receipt: {
    local_truth_ok: summary.local_truth_ok === true,
    live_evidence_present: summary.live_evidence_present === true,
    edge_ready: summary.edge_ready === true,
    mail_ready: summary.mail_ready === true,
    domain_count: summary.domain_count ?? 0,
    gap_count: summary.gap_count ?? 0,
    local_gap_count: summary.local_gap_count ?? 0,
    edge_gap_count: summary.edge_gap_count ?? 0,
    mail_gap_count: summary.mail_gap_count ?? 0,
  },
  proof_plan: {
    proof_actions: summary.proof_actions ?? 0,
    targeted_inbound_probes: summary.targeted_inbound_probes ?? 0,
    targeted_outbound_reply_probes: summary.targeted_outbound_reply_probes ?? 0,
    blocked_proofs: summary.blocked_proofs ?? 0,
    sender_domain_blocked_count: summary.sender_domain_blocked_count ?? 0,
    sender_domain_ack_ready_count: summary.sender_domain_ack_ready_count ?? 0,
    sender_domain_ack_missing_count: summary.sender_domain_ack_missing_count ?? 0,
  },
  ack_dry_run: redactSensitive ? redactAckDryRun(ackDryRun) : ackDryRun,
  protected_actions: protectedActions,
  protected_command_handoff: protectedCommandHandoff,
  blockers,
};

if (jsonOutput) {
  console.log(JSON.stringify(closeout, null, 2));
} else {
  console.log(`ready ${closeout.ready}`);
  console.log(`summary ${closeout.summary_path}`);
  console.log(`production_preflight ${productionPreflight?.ok ?? "skipped"}`);
  console.log(`local_truth_ok ${closeout.receipt.local_truth_ok}`);
  console.log(`live_evidence_present ${closeout.receipt.live_evidence_present}`);
  console.log(`edge_ready ${closeout.receipt.edge_ready}`);
  console.log(`mail_ready ${closeout.receipt.mail_ready}`);
  console.log(
    `sender_domain_ack_dry_run ${ackDryRun?.dry_run_count ?? 0}/${ackDryRun?.ready_count ?? 0}`,
  );
  for (const blocker of blockers) {
    console.log(
      `blocker ${blocker.kind}${blocker.count === undefined ? "" : ` count=${blocker.count}`}${
        blocker.detail ? ` detail=${blocker.detail}` : ""
      }`,
    );
  }
}

if (!ready) {
  process.exit(1);
}

function buildBlockers(
  receipt: ReceiptSummary,
  preflight: { ok: boolean; failures: string[] } | null,
  refresh: AckRefreshSummary | null,
  previewCleanup: PreviewCleanupSummary | null,
  ack: AckDryRunSummary | null,
): Blocker[] {
  const blockers: Blocker[] = [];

  if (preflight?.ok === false) {
    for (const failure of preflight.failures) {
      blockers.push({ kind: "production_preflight", detail: failure });
    }
  }
  if (refresh?.ok === false) {
    for (const failure of refresh.failures) {
      blockers.push({ kind: "sender_domain_ack_refresh", detail: failure });
    }
  }
  if (previewCleanup?.ok === false) {
    for (const failure of previewCleanup.failures) {
      blockers.push({ kind: "preview_cleanup", detail: failure });
    }
  }
  if (receipt.local_truth_ok !== true) {
    blockers.push({ kind: "local_truth", count: receipt.local_gap_count ?? receipt.gap_count ?? 0 });
  }
  if (receipt.live_evidence_present !== true) {
    blockers.push({ kind: "live_evidence_missing" });
  }
  if (receipt.edge_ready !== true) {
    blockers.push({ kind: "edge_ready_false", count: receipt.edge_gap_count ?? 0 });
  }
  if (receipt.mail_ready !== true) {
    blockers.push({ kind: "mail_ready_false", count: receipt.mail_gap_count ?? receipt.gap_count ?? 0 });
  }

  const missingAcks = receipt.sender_domain_ack_missing_count ?? 0;
  if (missingAcks > 0) {
    blockers.push({ kind: "sender_domain_ack_missing", count: missingAcks });
  }

  const blockedSenderDomains = receipt.sender_domain_blocked_count ?? 0;
  if (blockedSenderDomains > 0 && missingAcks === 0) {
    blockers.push({ kind: "protected_sender_domain_apply", count: blockedSenderDomains });
  }

  const expectedReadyAcks = receipt.sender_domain_ack_ready_count ?? 0;
  if (ack && expectedReadyAcks > 0 && (ack.ready_count ?? 0) < expectedReadyAcks) {
    blockers.push({ kind: "sender_domain_ack_dry_run_stale", count: expectedReadyAcks - (ack.ready_count ?? 0) });
  }
  if ((ack?.applied_count ?? 0) > 0) {
    blockers.push({ kind: "unexpected_sender_domain_apply", count: ack?.applied_count ?? 0 });
  }

  const inboundProbes = receipt.targeted_inbound_probes ?? 0;
  if (inboundProbes > 0) {
    blockers.push({ kind: "protected_inbound_probe", count: inboundProbes });
  }

  const outboundProbes = receipt.targeted_outbound_reply_probes ?? 0;
  if (outboundProbes > 0) {
    blockers.push({ kind: "protected_outbound_reply_probe", count: outboundProbes });
  }

  return blockers;
}

function buildProtectedActions(
  receipt: ReceiptSummary,
  ack: AckDryRunSummary | null,
): ProtectedActionsSummary {
  const senderDomainCount =
    (receipt.sender_domain_ack_missing_count ?? 0) > 0 ? 0 : receipt.sender_domain_blocked_count ?? 0;
  const inboundProbeCount = receipt.targeted_inbound_probes ?? 0;
  const outboundReplyProbeCount = receipt.targeted_outbound_reply_probes ?? 0;

  return {
    sender_domain_apply: {
      count: senderDomainCount,
      dry_run_ready_count: ack?.ready_count ?? 0,
      required_flags: ["--execute", "--confirm-ack-plan"],
      bulk_confirmation_required: senderDomainCount > 1,
      bulk_confirmation_flag: senderDomainCount > 1 ? "--confirm-bulk-ack-plan" : null,
    },
    inbound_probe: {
      count: inboundProbeCount,
      required_flags: ["--execute", "--confirm-live-send"],
      bulk_confirmation_required: inboundProbeCount > 1,
      bulk_confirmation_flag: inboundProbeCount > 1 ? "--confirm-bulk-live-send" : null,
    },
    outbound_reply_probe: {
      count: outboundReplyProbeCount,
      required_flags: ["--execute", "--confirm-live-send"],
      bulk_confirmation_required: outboundReplyProbeCount > 1,
      bulk_confirmation_flag: outboundReplyProbeCount > 1 ? "--confirm-bulk-live-send" : null,
    },
  };
}

function buildProtectedCommandHandoff(
  actions: ProtectedActionsSummary,
  manifestPath: string,
  proofPlanPath: string,
): ProtectedCommandHandoffSummary {
  return {
    sender_domain_apply: senderDomainApplyCommands(actions.sender_domain_apply, manifestPath),
    inbound_probe: inboundProbeCommands(actions.inbound_probe, proofPlanPath),
    outbound_reply_probe: outboundReplyProbeCommands(actions.outbound_reply_probe, proofPlanPath),
  };
}

function senderDomainApplyCommands(
  action: ProtectedActionHandoff,
  manifestPath: string,
): ProtectedCommandHandoff | null {
  if (action.count <= 0) return null;
  const manifestArg = commandPath(manifestPath);
  const base = [
    "bun",
    "run",
    "apply:maildesk-acks",
    "--",
    "--manifest",
    manifestArg,
  ];
  const dryRunOne = [...base, "--limit", "1", "--json"];
  const canExecute = (action.dry_run_ready_count ?? 0) > 0;
  const executeOne = canExecute
    ? [...base, "--execute", "--confirm-ack-plan", "--limit", "1", "--json"]
    : null;
  const executeAll =
    canExecute && action.count > 1
      ? [
          ...base,
          "--execute",
          "--confirm-ack-plan",
          "--confirm-bulk-ack-plan",
          "--all",
          "--json",
        ]
      : null;

  return {
    dry_run_one: dryRunOne,
    execute_one: executeOne,
    execute_all: executeAll,
  };
}

function inboundProbeCommands(
  action: ProtectedActionHandoff,
  proofPlanPath: string,
): ProtectedCommandHandoff | null {
  if (action.count <= 0) return null;
  const base = [
    "bun",
    "run",
    "send:maildesk-probes",
    "--",
    "--plan",
    commandPath(proofPlanPath),
    "--kind",
    "inbound",
    "--from",
    "<verified-sender>",
  ];
  return {
    dry_run_one: [...base, "--limit", "1", "--json"],
    execute_one: [...base, "--execute", "--confirm-live-send", "--limit", "1", "--json"],
    execute_all:
      action.count > 1
        ? [
            ...base,
            "--execute",
            "--confirm-live-send",
            "--confirm-bulk-live-send",
            "--all",
            "--json",
          ]
        : null,
  };
}

function outboundReplyProbeCommands(
  action: ProtectedActionHandoff,
  proofPlanPath: string,
): ProtectedCommandHandoff | null {
  if (action.count <= 0) return null;
  const base = [
    "bun",
    "run",
    "send:maildesk-probes",
    "--",
    "--plan",
    commandPath(proofPlanPath),
    "--kind",
    "outbound",
    "--api-url",
    "<maildesk-api-url>",
    "--api-token",
    "<reply-api-token>",
    "--to",
    "<proof-recipient>",
  ];
  return {
    dry_run_one: [...base, "--limit", "1", "--json"],
    execute_one: [...base, "--execute", "--confirm-live-send", "--limit", "1", "--json"],
    execute_all:
      action.count > 1
        ? [
            ...base,
            "--execute",
            "--confirm-live-send",
            "--confirm-bulk-live-send",
            "--all",
            "--json",
          ]
        : null,
  };
}

function runAckRefresh(planPath: string, manifestPath: string): AckRefreshSummary {
  const command = argValue("--refresh-ack-command");
  const result = command
    ? spawnSync(command, ["--plan", planPath, "--out", manifestPath, "--json"], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
      })
    : spawnSync(
        "bun",
        [
          "run",
          "scripts/refresh-sender-domain-ack-manifest.ts",
          "--plan",
          planPath,
          "--out",
          manifestPath,
          "--json",
        ],
        { cwd: root, encoding: "utf8", env: process.env },
      );
  const status = result.status ?? 1;
  if (status !== 0) {
    return {
      ok: false,
      status,
      failures: [`sender-domain ack refresh exited ${status}`],
    };
  }

  const summary = parseJson<Omit<AckRefreshSummary, "ok" | "status" | "failures">>(
    result.stdout,
    "sender-domain ack refresh",
  );
  return {
    ok: true,
    status,
    ...summary,
    failures: [],
  };
}

function runProductionPreflight(): { ok: boolean; failures: string[]; status: number } {
  const command = argValue("--preflight-command");
  const result = command
    ? spawnSync(command, { cwd: root, encoding: "utf8", env: process.env })
    : spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
      });
  const status = result.status ?? 1;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failures = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("fail: "))
    .map((line) => line.slice("fail: ".length));

  return {
    ok: status === 0,
    status,
    failures: status === 0 ? [] : failures.length > 0 ? failures : [`production preflight exited ${status}`],
  };
}

function runPreviewCleanup(purgeDuplicates: boolean, purgeExpired: boolean): PreviewCleanupSummary {
  const duplicateCleanup =
    purgeDuplicates
      ? runPreviewCleanupCommand(
          "duplicate preview cleanup",
          argValue("--preview-cleanup-command"),
          ["previews", "purge-duplicate-active"],
        )
      : null;
  const expiredCleanup =
    purgeExpired
      ? runPreviewCleanupCommand(
          "expired preview cleanup",
          argValue("--expired-preview-cleanup-command"),
          ["previews", "purge-expired"],
        )
      : null;
  const results = [duplicateCleanup, expiredCleanup].filter(
    (result): result is PreviewCleanupSummary => Boolean(result),
  );
  const failures = results.flatMap((result) => result.failures);

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 0 : results.find((result) => result.status !== 0)?.status ?? 1,
    performed: results.some((result) => result.performed === true),
    purged_count: results.reduce((total, result) => total + (result.purged_count ?? 0), 0),
    duplicate_group_count: duplicateCleanup?.duplicate_group_count ?? 0,
    expired_purged_count: expiredCleanup?.purged_count ?? 0,
    failures,
  };
}

function runPreviewCleanupCommand(
  label: string,
  command: string | undefined,
  cfctlArgs: string[],
): PreviewCleanupSummary {
  const result = command
    ? spawnSync(command, { cwd: root, encoding: "utf8", env: process.env })
    : spawnSync("cfctl", cfctlArgs, {
        cwd: root,
        encoding: "utf8",
        env: process.env,
      });
  const status = result.status ?? 1;
  if (status !== 0) {
    return {
      ok: false,
      status,
      failures: [`${label} exited ${status}`],
    };
  }

  const output = parseJson<{
    ok?: boolean;
    performed?: boolean;
    summary?: {
      purged_count?: number;
      duplicate_group_count?: number;
    };
  }>(result.stdout, label);

  return {
    ok: output.ok === true,
    status,
    performed: output.performed === true,
    purged_count: output.summary?.purged_count ?? 0,
    duplicate_group_count: output.summary?.duplicate_group_count ?? 0,
    failures: output.ok === true ? [] : [`${label} did not report ok`],
  };
}

function runAckDryRun(manifestPath: string): AckDryRunSummary {
  const result = spawnSync(
    "bun",
    ["run", "scripts/apply-sender-domain-ack-manifest.ts", "--manifest", manifestPath, "--json"],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    return {
      mode: "dry_run",
      ready_count: 0,
      dry_run_count: 0,
      applied_count: 0,
      results: [],
    };
  }
  return parseJson<AckDryRunSummary>(result.stdout, "sender-domain ack dry-run");
}

function redactAckDryRun(ack: AckDryRunSummary | null): RedactedAckDryRunSummary | null {
  if (!ack) return null;
  return {
    mode: ack.mode ?? "dry_run",
    ready_count: ack.ready_count ?? 0,
    applied_count: ack.applied_count ?? 0,
    dry_run_count: ack.dry_run_count ?? 0,
    result_count: ack.results?.length ?? 0,
  };
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readJson<T>(path: string): T {
  return parseJson<T>(readFileSync(resolve(root, path), "utf8"), path);
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

function commandPath(path: string): string {
  const absolutePath = resolve(root, path);
  return relative(root, absolutePath) || ".";
}
