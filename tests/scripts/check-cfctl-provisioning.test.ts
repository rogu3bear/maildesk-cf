import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  wranglerArtifactContainmentFailure,
  wranglerBuildCommandFailure,
} from "../../scripts/wrangler-config";
import { isRepositoryRelativePath } from "../../scripts/wrangler-config";

const root = resolve(import.meta.dir, "../..");

describe("cfctl provisioning contract check", () => {
  test("reports the template desired state as a non-performing cfctl v2 handoff", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        "config/desired-state.example.json",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      schema_path: string;
      desired_state_path: string;
      status: { provisioning_contract_ready: boolean };
      cfctl_handoff: {
        schema_version: number;
        discovery_commands: Array<{ purpose: string; performed: boolean; argv: string[] }>;
        read_contract: Record<string, string>;
        mutation_contract: Record<string, string>;
        access_capability_contract: Record<string, unknown>;
      };
      resources: {
        workers: string[];
        worker_configs: string[];
        storage: string[];
        email_routing_aliases: string[];
        access: Record<string, unknown>;
      };
      outside_checkout_blockers: string[];
    };

    expect(receipt.schema_path).toBe("ops/cfctl/maildesk-cf.desired-state.schema.json");
    expect(receipt.desired_state_path).toBe("config/desired-state.example.json");
    expect(receipt.status.provisioning_contract_ready).toBe(true);
    expect(receipt.cfctl_handoff.schema_version).toBe(2);
    expect(receipt.cfctl_handoff.discovery_commands).toContainEqual({
      purpose: "doctor",
      performed: false,
      argv: ["cfctl", "doctor", "--json"],
    });
    expect(receipt.cfctl_handoff.discovery_commands).toContainEqual({
      purpose: "resolve_readback",
      performed: false,
      argv: [
        "cfctl",
        "resolve",
        "read Maildesk current state for config/desired-state.example.json without mutation",
        "--json",
      ],
    });
    expect(JSON.stringify(receipt.cfctl_handoff)).not.toMatch(/cfctl maildesk-cf|--ack-plan|cfctl apply/);
    expect(receipt.resources.workers).toEqual([
      "maildesk-cf-relay-outbound",
      "maildesk-cf-router",
      "maildesk-cf-routing-health",
    ]);
    expect(receipt.resources.worker_configs).toEqual([
      "wrangler.mail-outbound.toml",
      "wrangler.mail-router.toml",
      "wrangler.routing-health.toml",
    ]);
    expect(receipt.resources.storage).toEqual([
      "d1:maildesk-cf-relay-db",
      "d1-preview:maildesk-cf-preview-db",
      "r2-policy:maildesk-cf-policy",
      "r2-spool:maildesk-cf-relay-spool",
      "queue:maildesk-cf-relay-jobs",
      "queue-dlq:maildesk-cf-relay-dlq",
    ]);
    expect(receipt.resources.email_routing_aliases).toContain("founders@example.com");
    expect(receipt.resources.access).toEqual({
      worker_role: "routing_health",
      hostname: "configured",
      application_identity: "configured",
      application_type: "self_hosted",
      path_scope: "all_routes",
      managed_policy_identity: "configured",
      policy_decision: "allow",
      operator_group_reference: "environment",
      runtime_jwt_validation: "required",
    });
    expect(receipt.cfctl_handoff.access_capability_contract).toMatchObject({
      status: "external_dependency",
      desired_state_path: "access.routing_health",
      required_read_capabilities: [
        "access-applications-list-access-applications",
        "access-applications-get-an-access-application",
        "access-policies-list-access-app-policies",
        "access-policies-get-an-access-policy",
      ],
      prohibited_bypasses: ["raw_http", "dashboard", "wrangler"],
    });
    const accessContract = receipt.cfctl_handoff.access_capability_contract as Record<string, any>;
    expect(accessContract.ownership).toEqual({
      application_selector: ["application_name", "hostname"],
      managed_policy_selector: ["policy_name", "operator_group_id"],
      resolved_provider_ids: ["app_id", "policy_id"],
      authority: "one_owned_application_and_one_owned_policy_only",
    });
    expect(accessContract.admission.application.fail_closed).toEqual([
      "zero_exact_with_ambiguous_existing_candidates",
      "duplicate_exact_matches",
      "overlapping_name_or_hostname_selectors",
      "missing_resolved_app_id_for_update",
    ]);
    expect(accessContract.admission.managed_policy.fail_closed).toEqual([
      "zero_exact_with_ambiguous_existing_candidates",
      "duplicate_exact_matches",
      "overlapping_name_or_operator_group_selectors",
      "multiple_policies_satisfy_managed_identity",
      "missing_resolved_policy_id_for_update",
    ]);
    expect(accessContract.preservation).toEqual({
      unrelated_applications: "outside_reconciliation_authority",
      unrelated_policies: "preserve_exact_bytes_semantics_and_order",
      collection_replacement: "forbidden",
      collection_deletion: "forbidden",
      required_prior_state: [
        "owned_application_full_snapshot",
        "owned_policy_full_snapshot",
        "unrelated_policy_content_hashes_in_order",
      ],
    });
    expect(accessContract.required_plan_v2_operations).toEqual([
      expect.objectContaining({
        resource: "access_application",
        action: "create_owned_self_hosted_whole_host",
        selectors: ["account_id", "application_name", "hostname"],
        rollback: "delete_only_returned_app_id_in_separate_reviewed_plan",
      }),
      expect.objectContaining({
        resource: "access_application",
        action: "update_owned_self_hosted_whole_host",
        selectors: ["account_id", "app_id"],
        rollback: "restore_exact_prior_owned_application_snapshot_in_separate_reviewed_plan",
      }),
      expect.objectContaining({
        resource: "access_policy",
        action: "create_owned_operator_allow_policy",
        selectors: ["account_id", "app_id", "policy_name", "operator_group_id"],
        rollback: "delete_only_returned_policy_id_in_separate_reviewed_plan",
      }),
      expect.objectContaining({
        resource: "access_policy",
        action: "update_owned_operator_allow_policy",
        selectors: ["account_id", "app_id", "policy_id"],
        rollback: "restore_exact_prior_owned_policy_snapshot_in_separate_reviewed_plan",
      }),
    ]);
    expect(accessContract.mutation_proof).toEqual({
      retain: ["operation_id", "content_hash", "app_id", "policy_id", "prior_state_digest"],
      exact_id_readback: [
        "access-applications-get-an-access-application:app_id",
        "access-policies-get-an-access-policy:app_id+policy_id",
      ],
      readiness_requires: [
        "desired_app_state_at_resolved_app_id",
        "desired_policy_state_at_resolved_app_id_and_policy_id",
        "unrelated_policy_content_hashes_and_order_unchanged",
      ],
      mismatch: "fail_closed",
    });
    expect(accessContract.identity_continuity).toEqual({
      equality: "byte_exact_provider_id",
      application_create: {
        source: "application_create.provider_result.app_id",
        must_equal: [
          "application_create.status.app_id",
          "application_create.rollback_target.app_id",
          "managed_policy.parent.app_id",
          "application_verification.selector.app_id",
          "application_verification.result.app_id",
        ],
      },
      application_update: {
        source: "application_admission.resolved_app_id",
        must_equal: [
          "application_update.prior_state.app_id",
          "application_update.plan.app_id",
          "application_update.review.app_id",
          "application_update.approval.app_id",
          "application_update.apply.app_id",
          "application_update.status.app_id",
          "application_update.rollback_target.app_id",
          "managed_policy.parent.app_id",
          "application_verification.selector.app_id",
          "application_verification.result.app_id",
        ],
      },
      policy_create: {
        parent_source: "retained_application.app_id",
        parent_must_equal: [
          "policy_create.plan.app_id",
          "policy_create.review.app_id",
          "policy_create.approval.app_id",
          "policy_create.apply.app_id",
          "policy_create.status.app_id",
          "policy_create.rollback_target.app_id",
          "policy_verification.selector.app_id",
          "policy_verification.result.app_id",
        ],
        source: "policy_create.provider_result.policy_id",
        must_equal: [
          "policy_create.status.policy_id",
          "policy_create.rollback_target.policy_id",
          "policy_verification.selector.policy_id",
          "policy_verification.result.policy_id",
        ],
      },
      policy_update: {
        source: "policy_admission.resolved_app_id+resolved_policy_id",
        must_equal: [
          "policy_update.prior_state.app_id+policy_id",
          "policy_update.plan.app_id+policy_id",
          "policy_update.review.app_id+policy_id",
          "policy_update.approval.app_id+policy_id",
          "policy_update.apply.app_id+policy_id",
          "policy_update.status.app_id+policy_id",
          "policy_update.rollback_target.app_id+policy_id",
          "policy_verification.selector.app_id+policy_id",
          "policy_verification.result.app_id+policy_id",
        ],
      },
      failure: {
        absent_or_unequal: "fail_closed",
        selector_equivalent_wrong_id: "reject",
        blocks: ["plan_ready", "live_mutation_ready", "post_apply_success", "edge_ready"],
      },
    });
    expect(JSON.stringify(receipt.resources.access)).not.toContain("routing-health.example.com");
    expect(receipt.outside_checkout_blockers).toEqual([
      "install or update cfctl with the required v2 catalog capabilities",
      "resolve and implement cfctl PlanV2 capabilities for Access application and policy reconciliation",
      "copy config/desired-state.example.json to config/desired-state.local.json and replace reserved examples with a real Cloudflare account and domain",
      "run cfctl version, doctor, and agents doctor before governed discovery",
      "bind every live call to an explicit profile, selected account, capability, and exact selectors",
      "review the immutable PlanV2 operation before approval and execution",
      "run capability-specific post-change readback and targeted mail proof after mutation",
    ]);
  });

  test("fails closed on missing, partial, desk-only, contradictory, or unmodeled Access authority", () => {
    const original = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as Record<string, any>;
    const cases: Array<[string, (desired: Record<string, any>) => void, string]> = [
      ["missing", (desired) => delete desired.access, "access is required"],
      ["partial", (desired) => delete desired.access.routing_health.policy, "access.routing_health.policy is required"],
      ["missing-app-identity", (desired) => delete desired.access.routing_health.application_name, "access.routing_health.application_name is required"],
      ["missing-policy-identity", (desired) => delete desired.access.routing_health.policy.policy_name, "access.routing_health.policy.policy_name is required"],
      ["malformed-app-identity", (desired) => (desired.access.routing_health.application_name = "Maildesk Access"), "access.routing_health.application_name must be a stable lowercase owned name"],
      ["malformed-policy-identity", (desired) => (desired.access.routing_health.policy.policy_name = "Maildesk Policy"), "access.routing_health.policy.policy_name must be a stable lowercase owned name"],
      ["desk-only", (desired) => (desired.access.routing_health.path_scope = "desk_only"), "access.routing_health.path_scope must be one of all_routes"],
      ["contradictory", (desired) => (desired.access.routing_health.worker_role = "relay_router"), "access.routing_health.worker_role must be one of routing_health"],
      ["unmodeled", (desired) => (desired.access.routing_health.path_patterns = ["/desk/*"]), "access.routing_health contains unmodeled fields: path_patterns"],
    ];

    for (const [name, mutate, expected] of cases) {
      const directory = mkdtempSync(join(tmpdir(), `maildesk-access-${name}-`));
      const desiredPath = join(directory, "desired-state.json");
      const desired = structuredClone(original);
      mutate(desired);
      writeFileSync(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);
      const result = spawnSync(
        "bun",
        ["run", "scripts/check-cfctl-provisioning.ts", "--", "--desired-state", desiredPath, "--json"],
        { cwd: root, encoding: "utf8" },
      );
      rmSync(directory, { force: true, recursive: true });
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toContain(expected);
    }
  });

  test("rejects noncanonical Worker config basenames before cfctl planning", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-config-"));
    const desiredPath = join(dir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { relay_router: { config: string } } };
    desired.workers.relay_router.config = "wrangler.toml";
    writeFileSync(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        desiredPath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    rmSync(dir, { force: true, recursive: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "workers.relay_router.config must be a repository-relative canonical wrangler.mail-router*.toml path",
    );
  });

  test("rejects nested Wrangler build commands that assume the config directory is cwd", () => {
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "bun run --cwd ../.. build:router-wasm"\n'),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "bun run --cwd=../.. build:router-wasm"\n'),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "cd .. && bun run build:router-wasm"\n'),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure("[build]\ncommand = 'cd .. && bun run build:router-wasm'\n"),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure(
        '[build]\ncommand = "cd $IFS../.. && bun run build:router-wasm"\n',
      ),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure(
        '[build]\ncommand = "cd \\u002e\\u002e && bun run build:router-wasm"\n',
      ),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "bun run build:router-wasm"\n'),
    ).toBeNull();
    expect(
      wranglerBuildCommandFailure("[build]\ncommand = 'bun run build:router-wasm' # literal\n"),
    ).toBeNull();
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = """bun run build:router-wasm"""\n'),
    ).toBeNull();
    expect(
      wranglerBuildCommandFailure('build.command = "bun run --cwd ../.. build:router-wasm"\n'),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure('build = { command = "bun run --cwd ../.. build:router-wasm" }\n'),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure('"build"."command" = "bun run --cwd ../.. build:router-wasm"\n'),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure("[build\ncommand = 'bun run build:router-wasm'\n"),
    ).toContain("config must be valid TOML");
    expect(
      wranglerBuildCommandFailure('[vars]\ncommand = "cd .."\n'),
    ).toBeNull();
    expect(
      wranglerBuildCommandFailure('{"build":{"command":"cd .."}}', "json"),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure(
        '// comment\n{"build":{"command":"bun run --cwd ../.. build:router-wasm",},}',
        "jsonc",
      ),
    ).toContain("build command runs from the Wrangler config parent directory");
    expect(
      wranglerBuildCommandFailure('{"vars":{"command":"cd .."}}', "json"),
    ).toBeNull();
    expect(
      wranglerBuildCommandFailure('{"build":{"command":false}}', "json"),
    ).toContain("build command must be a string");
    expect(
      wranglerBuildCommandFailure('{"build":', "json"),
    ).toContain("config must be valid JSON");
  });

  test("rejects Worker config paths that escape the repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-config-path-"));
    const desiredPath = join(dir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { relay_router: { config: string } } };
    desired.workers.relay_router.config = "../outside/wrangler.toml";
    writeFileSync(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        desiredPath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    rmSync(dir, { force: true, recursive: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a normalized repository-relative path");
    expect(isRepositoryRelativePath("./deploy/router/wrangler.toml")).toBe(false);
    expect(isRepositoryRelativePath("C:/deploy/router/wrangler.toml")).toBe(false);
    expect(isRepositoryRelativePath("deploy//router/wrangler.toml")).toBe(false);
    expect(isRepositoryRelativePath("deploy/router/wrangler.toml")).toBe(true);
  });

  test("rejects JSONC configs outside the canonical role-specific TOML family", () => {
    const configPath = join(root, "tests/fixtures/wrangler-jsonc/wrangler.jsonc");
    const desiredDir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-jsonc-"));
    const desiredPath = join(desiredDir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { relay_router: { config: string } } };
    desired.workers.relay_router.config = relative(root, configPath);
    writeFileSync(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        desiredPath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    rmSync(desiredDir, { force: true, recursive: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical wrangler.mail-router*.toml path");
  });

  test("rejects nested TOML configs outside the canonical root family", () => {
    const configPath = join(root, "tests/fixtures/wrangler-toml-dotted/wrangler.toml");
    const desiredDir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-toml-"));
    const desiredPath = join(desiredDir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { relay_router: { config: string } } };
    desired.workers.relay_router.config = relative(root, configPath);
    writeFileSync(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        desiredPath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    rmSync(desiredDir, { force: true, recursive: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical wrangler.mail-router*.toml path");
  });

  test("confines main and assets to the Wrangler config parent", () => {
    expect(wranglerArtifactContainmentFailure(
      'main = "workers/mail-router/src/index.ts"\n',
      "wrangler.mail-router.toml",
      root,
    )).toBeNull();
    expect(wranglerArtifactContainmentFailure(
      'main = "../outside.ts"\n',
      "wrangler.mail-router.toml",
      root,
    )).toContain("main must resolve inside the Wrangler config parent directory");
    expect(wranglerArtifactContainmentFailure(
      '[assets]\ndirectory = "../outside"\n',
      "wrangler.routing-health.toml",
      root,
    )).toContain("assets.directory must resolve inside the Wrangler config parent directory");

    const repository = mkdtempSync(join(tmpdir(), "maildesk-artifact-boundary-"));
    const outside = join(tmpdir(), `maildesk-outside-${process.pid}.ts`);
    try {
      writeFileSync(outside, "export default {};\n");
      symlinkSync(outside, join(repository, "linked.ts"));
      expect(wranglerArtifactContainmentFailure(
        'main = "linked.ts"\n',
        "wrangler.mail-router.toml",
        repository,
      )).toContain("main must resolve inside the Wrangler config parent directory");
      const outsideDirectory = mkdtempSync(join(tmpdir(), "maildesk-outside-assets-"));
      symlinkSync(outsideDirectory, join(repository, "target"));
      expect(wranglerArtifactContainmentFailure(
        '[assets]\ndirectory = "target/site"\n',
        "wrangler.routing-health.toml",
        repository,
      )).toContain("assets.directory must resolve inside the Wrangler config parent directory");
      rmSync(outsideDirectory, { force: true, recursive: true });

      symlinkSync(join(tmpdir(), `maildesk-missing-${process.pid}.ts`), join(repository, "dangling.ts"));
      expect(wranglerArtifactContainmentFailure(
        'main = "dangling.ts"\n',
        "wrangler.mail-router.toml",
        repository,
      )).toContain("main must not traverse a dangling or unresolvable symbolic link");

      symlinkSync(
        join(tmpdir(), `maildesk-missing-assets-${process.pid}`),
        join(repository, "dangling-assets"),
      );
      expect(wranglerArtifactContainmentFailure(
        '[assets]\ndirectory = "dangling-assets/site"\n',
        "wrangler.routing-health.toml",
        repository,
      )).toContain("assets.directory must not traverse a dangling or unresolvable symbolic link");

      expect(wranglerArtifactContainmentFailure(
        'main = "ordinary/missing.ts"\n',
        "wrangler.mail-router.toml",
        repository,
      )).toBeNull();
    } finally {
      rmSync(repository, { force: true, recursive: true });
      rmSync(outside, { force: true });
    }
  });

  test("rejects desired state missing storage resources needed for provisioning", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-provision-"));
    const desiredPath = join(dir, "desired-state.json");
    writeFileSync(
      desiredPath,
      `${JSON.stringify(
        {
          project: {
            name: "maildesk-cf",
            account_id_env: "CLOUDFLARE_ACCOUNT_ID",
          },
          domains: [
            {
              name: "example.com",
              inbound_mx_provider: "cloudflare_email_routing",
              role_aliases: ["founders"],
              personal_aliases: [],
            },
          ],
          workers: {
            relay_router: {
              script_name: "maildesk-cf-router",
              config: "wrangler.mail-router.toml",
            },
            relay_outbound: {
              script_name: "maildesk-cf-relay-outbound",
              config: "wrangler.mail-outbound.toml",
            },
            routing_health: {
              script_name: "maildesk-cf-routing-health",
              config: "wrangler.routing-health.toml",
            },
          },
          storage: {
            d1_database: "maildesk-cf-db",
            d1_preview_database: "maildesk-cf-preview-db",
            r2_policy_bucket: "maildesk-cf-policy",
            r2_spool_bucket: "maildesk-cf-relay-spool",
          },
          sender: {
            mode: "disabled",
            candidate_domains: [],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        desiredPath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("storage.queue is required");
    expect(result.stderr).not.toContain("maildesk-cf-db");
  });

  test("rejects malformed domain authorities before cfctl planning", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-domain-"));
    const desiredPath = join(dir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as {
      domains: Array<{ name: string }>;
      operator_delivery: { reply_domain: string };
      sender: { candidate_domains: string[] };
    };
    desired.domains[0]!.name = "-invalid.example.com";
    desired.operator_delivery.reply_domain = "reply..maildesk.example.com";
    desired.sender.candidate_domains = ["-invalid.example.com"];
    writeFileSync(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-cfctl-provisioning.ts",
        "--",
        "--desired-state",
        desiredPath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("domains[].name is not a valid domain");
    expect(result.stderr).toContain("operator_delivery.reply_domain must be a valid domain");
    expect(result.stderr).toContain("sender.candidate_domains entries must be valid domains");
  });
});
