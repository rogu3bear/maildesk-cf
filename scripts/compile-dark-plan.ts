import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface DesiredState {
  project: { name: string };
  workers: Record<string, { script_name: string; config: string }>;
  storage: {
    d1_database: string;
    r2_policy_bucket: string;
    r2_spool_bucket: string;
    queue: string;
    dead_letter_queue: string;
  };
  operator_delivery: {
    inbound_processing_mode?: string;
    reply_processing_mode?: string;
    reply_domain: string;
  };
}

const root = resolve(import.meta.dir, "..");
const desiredPath = arg("--desired-state") ?? "config/desired-state.example.json";
const outputPath = arg("--out");
const desired = json<DesiredState>(desiredPath);
assertDarkActivation(desired.operator_delivery);
const head = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const dirty = git("status", "--porcelain").length > 0;

const sourceFiles = [
  desiredPath,
  ".cfctl/operations/d1-migrations.toml",
  ".cfctl/operations/d1-policy-projections.toml",
  "ops/cfctl/relay-spool-lifecycle.example.json",
  ...Object.values(desired.workers).map((worker) => worker.config),
];

const plan = {
  schema_version: 1,
  kind: "maildesk_dark_plan_blueprint",
  performed: false,
  plan_ready: !dirty,
  operation_ids_created: false,
  repository: {
    head,
    tree,
    dirty,
    source_files: Object.fromEntries(sourceFiles.sort().map((path) => [path, shaFile(path)])),
  },
  activation: {
    inbound_processing_mode: desired.operator_delivery.inbound_processing_mode,
    reply_processing_mode: desired.operator_delivery.reply_processing_mode,
    required_dark_state: "disabled/disabled",
  },
  plan_sets: [
    {
      name: "bootstrap-resources",
      purpose: "Create isolated resources whose returned identifiers are required by later exact Worker configs.",
      children: [
        step("d1", "d1-create-database", desired.storage.d1_database, "delete only the newly created database in a separate plan"),
        step("policy-r2", "r2-create-bucket", desired.storage.r2_policy_bucket, "delete only the empty newly created bucket in a separate plan"),
        step("spool-r2", "r2-create-bucket", desired.storage.r2_spool_bucket, "delete only the empty newly created bucket in a separate plan"),
        step("queue", "queues-create", desired.storage.queue, "delete only the newly created queue in a separate plan"),
        step("dlq", "queues-create", desired.storage.dead_letter_queue, "delete only the newly created dead-letter queue in a separate plan"),
      ],
    },
    {
      name: "dark-deployment",
      purpose: "Compile only after bootstrap identifiers and fresh provider snapshots are verified.",
      children: [
        step("spool-lifecycle", "r2-put-bucket-lifecycle-configuration", desired.storage.r2_spool_bucket, "restore the complete prior lifecycle snapshot; expired objects are unrecoverable"),
        step("d1-migrations", "maildesk-cf.d1-migrations-apply", desired.storage.d1_database, "restore the exact fresh pre-migration bookmark in a separate plan"),
        step("policy-upload", "r2-put-object", `${desired.storage.r2_policy_bucket}/config/policy/<sha256>.json`, "delete only the newly created immutable object in a separate plan"),
        step("policy-projection", "maildesk-cf.d1-policy-project", desired.storage.d1_database, "restore the exact fresh pre-projection bookmark in a separate plan"),
        ...Object.values(desired.workers).map((worker) =>
          step(`deploy-${worker.script_name}`, "wrangler.deploy", worker.config, "redeploy the exact prior Worker version in a separate plan"),
        ),
        step("queue-consumer", "queues-create-consumer", `${desired.storage.queue} -> ${desired.workers.relay_outbound.script_name}`, "delete the exact new consumer in a separate plan"),
        readStep("ui-access-application", "access-applications-get-an-access-application", "existing whole-host Access application"),
        readStep("ui-access-policies", "access-policies-list-access-app-policies", "existing approved operator policies"),
        step("ui-custom-domain", "workers.domains.update", "entire routing-health hostname", "restore the exact prior Worker custom-domain attachment in a separate plan"),
        step("reply-routing", "email-routing-settings-enable-email-routing-dns", desired.operator_delivery.reply_domain, "remove only the reply-subdomain routing and restore its prior DNS snapshot"),
        step("reply-catch-all", "email-routing-routing-rules-update-catch-all-rule", desired.workers.relay_router.script_name, "restore the exact prior subdomain catch-all rule in a separate plan"),
      ],
    },
  ],
  required_fresh_reads: [
    "Workers, versions, bindings, routes, custom domains",
    "D1 databases, bookmarks, migration ledger, schema",
    "R2 buckets, lifecycle, immutable policy object metadata",
    "Queue consumers, backlog, and DLQ",
    "Access application, audience, group, policy, and full-host coverage",
    "Email Routing settings and rules for the canary and reply subdomain",
    "Email Sending entitlement, domains, preview preference, and DNS status",
    "DNS and legacy rollback route for every in-scope zone",
  ],
  explicit_exclusions: [
    "approval or execution of any child operation",
    "credential minting or import",
    "sender-domain onboarding",
    "website alias or MX changes",
    "live inbound or outbound email probes",
    "mlnavigator.com Cloudflare migration",
    "windowdrop.pro migration",
  ],
  stop_conditions: [
    "dirty or drifting source checkout",
    "missing fresh provider snapshot or recovery target",
    "placeholder bootstrap identifier in a downstream Worker config",
    "credential, profile, catalog, policy, source, config, or provider drift",
    "either relay activation switch is enabled",
  ],
};

const encoded = `${JSON.stringify(plan, null, 2)}\n`;
if (outputPath) {
  const absolute = resolve(outputPath);
  writeFileSync(absolute, encoded, { mode: 0o600, flag: "wx" });
  chmodSync(absolute, 0o600);
} else {
  process.stdout.write(encoded);
}

function step(id: string, capability: string, target: string, rollback: string) {
  return { id, capability, target, effect: "mutation", operation_id: null, plan_hash: null, rollback };
}

function readStep(id: string, capability: string, target: string) {
  return { id, capability, target, effect: "read_only", operation_id: null, plan_hash: null, rollback: "not applicable" };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
}

function assertDarkActivation(operatorDelivery: DesiredState["operator_delivery"] | undefined): void {
  if (
    operatorDelivery?.inbound_processing_mode !== "disabled" ||
    operatorDelivery.reply_processing_mode !== "disabled"
  ) {
    throw new Error(
      "dark deployment requires operator_delivery.inbound_processing_mode and operator_delivery.reply_processing_mode to both equal disabled",
    );
  }
}

function shaFile(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}
