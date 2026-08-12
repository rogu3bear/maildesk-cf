import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { wranglerBuildCommandFailure } from "../../scripts/wrangler-config";
import { isRepositoryRelativePath } from "../../scripts/wrangler-config";

const root = resolve(import.meta.dir, "../..");

describe("cfctl provisioning contract check", () => {
  test("reports the template desired state as a cfctl maildesk-cf provisioning lane", () => {
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
      cfctl_commands: string[];
      resources: {
        workers: string[];
        worker_configs: string[];
        storage: string[];
        email_routing_aliases: string[];
      };
      outside_checkout_blockers: string[];
    };

    expect(receipt.schema_path).toBe("ops/cfctl/maildesk-cf.desired-state.schema.json");
    expect(receipt.desired_state_path).toBe("config/desired-state.example.json");
    expect(receipt.status.provisioning_contract_ready).toBe(true);
    expect(receipt.cfctl_commands).toContain(
      "cfctl maildesk-cf provision --file config/desired-state.example.json --plan",
    );
    expect(receipt.cfctl_commands).toContain(
      "cfctl maildesk-cf provision --file config/desired-state.example.json --ack-plan <operation-id>",
    );
    expect(receipt.cfctl_commands).toContain(
      "cfctl maildesk-cf verify --file config/desired-state.example.json",
    );
    expect(receipt.resources.workers).toEqual(["maildesk-cf", "maildesk-cf-router", "maildesk-cf-ui"]);
    expect(receipt.resources.worker_configs).toEqual([
      "deploy/mail-router/wrangler.toml",
      "deploy/ui/wrangler.toml",
      "wrangler.toml",
    ]);
    expect(receipt.resources.storage).toEqual([
      "d1:maildesk-cf-db",
      "d1-preview:maildesk-cf-preview-db",
      "r2:maildesk-cf-raw-mail",
      "r2-preview:maildesk-cf-raw-mail-preview",
      "queue:maildesk-cf-jobs",
    ]);
    expect(receipt.resources.email_routing_aliases).toContain("founders@example.com");
    expect(receipt.outside_checkout_blockers).toEqual([
      "install or update cfctl with the maildesk-cf lifecycle surface",
      "copy config/desired-state.example.json to config/desired-state.local.json and replace reserved examples with a real Cloudflare account and domain",
      "run cfctl doctor with a healthy credential lane before planning",
      "review the cfctl provision preview and provide its operation id before --ack-plan",
      "run targeted cfctl maildesk-cf verify and mail proof readbacks after mutation",
    ]);
  });

  test("rejects noncanonical Worker config basenames before cfctl planning", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-config-"));
    const desiredPath = join(dir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { mail_router: { config: string } } };
    desired.workers.mail_router.config = "wrangler.mail-router.toml";
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
    expect(result.stderr).toContain("workers.mail_router.config must use the canonical wrangler.toml");
  });

  test("rejects nested Wrangler build commands that assume the config directory is cwd", () => {
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "bun run --cwd ../.. build:router-wasm"\n'),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "bun run --cwd=../.. build:router-wasm"\n'),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure('[build]\ncommand = "cd .. && bun run build:router-wasm"\n'),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure("[build]\ncommand = 'cd .. && bun run build:router-wasm'\n"),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure(
        '[build]\ncommand = "cd $IFS../.. && bun run build:router-wasm"\n',
      ),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure(
        '[build]\ncommand = "cd \\u002e\\u002e && bun run build:router-wasm"\n',
      ),
    ).toContain("build command runs from the repository invocation directory");
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
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure('build = { command = "bun run --cwd ../.. build:router-wasm" }\n'),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure('"build"."command" = "bun run --cwd ../.. build:router-wasm"\n'),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure("[build\ncommand = 'bun run build:router-wasm'\n"),
    ).toContain("config must be valid TOML");
    expect(
      wranglerBuildCommandFailure('[vars]\ncommand = "cd .."\n'),
    ).toBeNull();
    expect(
      wranglerBuildCommandFailure('{"build":{"command":"cd .."}}', "json"),
    ).toContain("build command runs from the repository invocation directory");
    expect(
      wranglerBuildCommandFailure(
        '// comment\n{"build":{"command":"bun run --cwd ../.. build:router-wasm",},}',
        "jsonc",
      ),
    ).toContain("build command runs from the repository invocation directory");
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
    ) as { workers: { mail_router: { config: string } } };
    desired.workers.mail_router.config = "../outside/wrangler.toml";
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

  test("inspects JSONC build commands through the desired-state config path", () => {
    const configPath = join(root, "tests/fixtures/wrangler-jsonc/wrangler.jsonc");
    const desiredDir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-jsonc-"));
    const desiredPath = join(desiredDir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { mail_router: { config: string } } };
    desired.workers.mail_router.config = relative(root, configPath);
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
    expect(result.stderr).toContain("must not traverse to a parent directory");
  });

  test("inspects dotted TOML build commands through the desired-state config path", () => {
    const configPath = join(root, "tests/fixtures/wrangler-toml-dotted/wrangler.toml");
    const desiredDir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-toml-"));
    const desiredPath = join(desiredDir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(join(root, "config/desired-state.example.json"), "utf8"),
    ) as { workers: { mail_router: { config: string } } };
    desired.workers.mail_router.config = relative(root, configPath);
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
    expect(result.stderr).toContain("must not traverse to a parent directory");
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
            mail_api: { script_name: "maildesk-cf", config: "wrangler.toml" },
            mail_router: {
              script_name: "maildesk-cf-router",
              config: "deploy/mail-router/wrangler.toml",
            },
            ui: {
              script_name: "maildesk-cf-ui",
              config: "deploy/ui/wrangler.toml",
            },
          },
          storage: {
            d1_database: "maildesk-cf-db",
            d1_preview_database: "maildesk-cf-preview-db",
            r2_raw_mail_bucket: "maildesk-cf-raw-mail",
            r2_raw_mail_preview_bucket: "maildesk-cf-raw-mail-preview",
          },
          sender: {
            mode: "disabled",
            authenticated_domains: [],
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
      sender: { authenticated_domains: string[] };
    };
    desired.domains[0]!.name = "-invalid.example.com";
    desired.operator_delivery.reply_domain = "reply..maildesk.example.com";
    desired.sender.authenticated_domains = ["-invalid.example.com"];
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
    expect(result.stderr).toContain("sender.authenticated_domains entries must be valid domains");
  });
});
