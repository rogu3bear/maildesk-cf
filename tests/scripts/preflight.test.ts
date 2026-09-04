import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { maildeskPrivateReadContracts, maildeskReadContracts } from "../../scripts/cfctl-v2-command-contract";
import { loadEnvFile } from "../../scripts/env-file";

const root = resolve(import.meta.dir, "../..");

setDefaultTimeout(30_000);

describe("production preflight", () => {
  test("new-instance environment matches the split dark activation contract", () => {
    const example = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(example).toContain("MAILDESK_INBOUND_RELAY_MODE=disabled");
    expect(example).toContain("MAILDESK_REPLY_RELAY_MODE=disabled");
    expect(example).not.toContain("MAILDESK_RELAY_PROCESSING_MODE=");
  });
  test("tracked legacy web-desk configs declare an explicit delivery mode", () => {
    for (const configPath of ["wrangler.toml", "deploy/ui/wrangler.toml"]) {
      const config = Bun.TOML.parse(readFileSync(resolve(root, configPath), "utf8")) as {
        vars?: Record<string, unknown>;
      };

      expect({
        configPath,
        mode: config.vars?.MAILDESK_OPERATOR_DELIVERY_MODE,
      }).toEqual({
        configPath,
        mode: "web_desk",
      });
    }
  });

  test("validates desired-state-selected production configs instead of tracked template placeholders", () => {
    const topology = writeProductionTopology();
    try {
      const result = runInboxRelayProductionPreflight(topology.desiredPath);
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("preflight ok: production");
      expect(result.stderr).not.toContain("still contains placeholder Cloudflare resource IDs");
    } finally {
      topology.cleanup();
    }
  });

  test("rejects a placeholder in the selected production config", () => {
    const topology = writeProductionTopology({ routerPlaceholder: true });
    try {
      const result = runInboxRelayProductionPreflight(topology.desiredPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${topology.routerPath} still contains placeholder Cloudflare resource IDs`,
      );
      expect(result.stderr).not.toContain(
        "wrangler.mail-outbound.toml still contains placeholder Cloudflare resource IDs",
      );
    } finally {
      topology.cleanup();
    }
  });

  test("requires the EMAIL binding in the selected inbox-relay outbound config", () => {
    const topology = writeProductionTopology({ outboundWithoutEmail: true });
    try {
      const result = runInboxRelayProductionPreflight(topology.desiredPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `cloudflare_email_service mode requires ${topology.outboundPath} send_email binding named "EMAIL"`,
      );
      expect(result.stderr).not.toContain(
        "cloudflare_email_service mode requires wrangler.toml send_email binding named \"EMAIL\"",
      );
    } finally {
      topology.cleanup();
    }
  });

  test("rejects a missing runtime operator delivery mode", () => {
    const topology = writeProductionTopology();
    try {
      const env = productionEnv(topology.desiredPath, "cloudflare_email_service");
      delete env.MAILDESK_OPERATOR_DELIVERY_MODE;
      const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
        cwd: root,
        encoding: "utf8",
        env,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "MAILDESK_OPERATOR_DELIVERY_MODE (missing) must match desired-state operator_delivery.mode (inbox_relay)",
      );
    } finally {
      topology.cleanup();
    }
  });

  test("rejects non-canonical desired-state Worker config authority", () => {
    const desiredPath = writeDesiredState("disabled", {
      workers: {
        relay_router: { config: "/tmp/wrangler.toml" },
        relay_outbound: { config: "wrangler.mail-outbound.toml" },
        routing_health: { config: "wrangler.routing-health.toml" },
      },
    });
    const env = productionEnv(desiredPath, "disabled");

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "desired-state workers.relay_router.config must be a repository-relative canonical wrangler.mail-router*.toml path",
    );
  });

  test("reports an absent selected production config without throwing", () => {
    const topology = writeProductionTopology();
    try {
      rmSync(resolve(root, topology.routerPath));
      const result = runInboxRelayProductionPreflight(topology.desiredPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`missing required file: ${topology.routerPath}`);
      expect(result.stderr).toContain("relay topology validation failed");
      expect(result.stderr).not.toContain("at readProductionWorkerConfigs");
    } finally {
      topology.cleanup();
    }
  });

  test("rejects a canonical selected config whose symlink resolves outside the repository", () => {
    const topology = writeProductionTopology();
    const outsideDirectory = mkdtempSync(join(tmpdir(), "maildesk-external-wrangler-"));
    const outsideConfig = join(outsideDirectory, "wrangler.toml");
    try {
      const routerConfig = resolve(root, topology.routerPath);
      writeFileSync(outsideConfig, readFileSync(routerConfig));
      rmSync(routerConfig);
      symlinkSync(outsideConfig, routerConfig);

      const result = runInboxRelayProductionPreflight(topology.desiredPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "desired-state workers.relay_router.config must resolve to a regular file inside the repository",
      );
      expect(result.stderr).not.toContain(outsideConfig);
    } finally {
      topology.cleanup();
      rmSync(outsideDirectory, { force: true, recursive: true });
    }
  });

  test("accepts RESEND as a local compatibility alias for RESEND_API_KEY", () => {
    const desiredPath = writeDesiredState("resend");
    const env = {
      ...process.env,
      CFCTL_BIN: "/usr/bin/true",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_DESIRED_STATE_PATH: desiredPath,
      MAILDESK_API_TOKEN: "example-maildesk-token",
      MAILDESK_OUTBOUND_MODE: "resend",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "example.com",
      MAILDESK_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      MAILDESK_ACCESS_AUD: "example-access-audience",
      RESEND: "example-resend-token",
    };
    delete env.RESEND_API_KEY;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("RESEND_API_KEY");
    expect(result.stderr).toContain("cfctl must report a healthy runtime and an available MAILDESK_CFCTL_PROFILE");
  });

  test("fails when runtime sender mode disagrees with desired state", () => {
    const desiredPath = writeDesiredState("resend");
    const env = {
      ...process.env,
      CFCTL_BIN: "/usr/bin/true",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_DESIRED_STATE_PATH: desiredPath,
      MAILDESK_API_TOKEN: "example-maildesk-token",
      MAILDESK_OUTBOUND_MODE: "disabled",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "MAILDESK_OUTBOUND_MODE (disabled) must match desired-state sender.mode (resend)",
    );
  });

  test("requires an EMAIL send_email binding for Cloudflare Email Service mode", () => {
    const desiredPath = writeDesiredState("cloudflare_email_service");
    const wranglerPath = join(mkdtempSync(join(tmpdir(), "maildesk-wrangler-")), "wrangler.toml");
    writeFileSync(wranglerPath, 'name = "maildesk-test"\n');
    const env = {
      ...process.env,
      CFCTL_BIN: "/usr/bin/true",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_DESIRED_STATE_PATH: desiredPath,
      MAILDESK_API_TOKEN: "example-maildesk-token",
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_MAIL_API_WRANGLER_PATH: wranglerPath,
      MAILDESK_VERIFIED_SENDER_DOMAINS: "example.com",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`cloudflare_email_service mode requires ${wranglerPath} send_email binding named "EMAIL"`);
  });

  test("does not treat a generic healthy cfctl lane as account or deploy authority", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_API_TOKEN: "example-maildesk-token",
    };
    scrubCloudflareEnv(env);
    delete env.MAILDESK_PROJECT_NAME;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing Cloudflare account target");
    expect(result.stderr).toContain("cfctl must report a healthy runtime");
    expect(result.stderr).not.toContain("missing project name");
  });

  test("accepts MAILDESK_PROOF_API_TOKEN for proof-only closeout", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_PROOF_API_TOKEN: "example-proof-token",
      MAILDESK_REPLY_API_MODE: "token",
    };
    scrubCloudflareEnv(env);
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROJECT_NAME;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).not.toContain("MAILDESK_API_TOKEN");
    expect(result.stderr).not.toContain("MAILDESK_PROOF_API_TOKEN");
  });

  test("loads production-only secrets from an explicit repo-local env file", () => {
    const cfctl = fakeCfctlDoctor(true);
    const envDir = mkdtempSync(join(ensureVarDir(), "preflight-env-"));
    const envFile = join(envDir, ".dev.vars");
    writeFileSync(
      envFile,
      [
        "MAILDESK_API_TOKEN=example-maildesk-token",
        "MAILDESK_OUTBOUND_MODE=disabled",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
    };
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROOF_API_TOKEN;
    delete env.MAILDESK_OUTBOUND_MODE;
    delete env.MAILDESK_VERIFIED_SENDER_DOMAINS;

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/preflight.ts",
        "--mode",
        "production",
        "--env-file",
        relative(root, envFile),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).not.toContain("set one of MAILDESK_API_TOKEN, MAILDESK_PROOF_API_TOKEN");
    expect(result.stderr).not.toContain("MAILDESK_VERIFIED_SENDER_DOMAINS");
  });

  test("rejects env files outside the repository root", () => {
    const cfctl = fakeCfctlDoctor(true);
    const envDir = mkdtempSync(join(tmpdir(), "maildesk-outside-env-"));
    const envFile = join(envDir, ".dev.vars");
    writeFileSync(envFile, "MAILDESK_API_TOKEN=secret-outside-value\n");
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
    };
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROOF_API_TOKEN;

    const result = spawnSync(
      "bun",
      ["run", "scripts/preflight.ts", "--mode", "production", "--env-file", envFile],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("env file must be under repository root");
    expect(result.stderr).not.toContain("secret-outside-value");
  });

  test("rejects a repo-local env symlink whose target escapes the repository", () => {
    const externalDir = mkdtempSync(join(tmpdir(), "maildesk-external-env-"));
    const externalFile = join(externalDir, ".dev.vars");
    const varDir = resolve(root, "var");
    mkdirSync(varDir, { recursive: true });
    const localDir = mkdtempSync(join(varDir, "env-symlink-"));
    const localLink = join(localDir, ".dev.vars");
    writeFileSync(externalFile, "MAILDESK_API_TOKEN=secret-outside-value\n");
    symlinkSync(externalFile, localLink);
    const env: Record<string, string | undefined> = {};
    const commandMarker = join(localDir, "cfctl-invoked");
    const cfctl = fakeCommandRecorder(commandMarker);

    try {
      const result = loadEnvFile(root, relative(root, localLink), env);

      expect(result).toEqual({
        loaded: [],
        failures: ["env file must be under repository root"],
      });
      expect(env.MAILDESK_API_TOKEN).toBeUndefined();

      const preflight = spawnSync(
        "bun",
        [
          "run",
          "scripts/preflight.ts",
          "--mode",
          "production",
          "--env-file",
          relative(root, localLink),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, CFCTL_BIN: cfctl },
        },
      );
      expect(preflight.status).toBe(1);
      expect(preflight.stderr).toContain("env file must be under repository root");
      expect(preflight.stderr).not.toContain("secret-outside-value");
      expect(existsSync(commandMarker)).toBe(false);
    } finally {
      rmSync(localDir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("accepts a repo-local env symlink whose canonical target stays in the repository", () => {
    const varDir = resolve(root, "var");
    mkdirSync(varDir, { recursive: true });
    const localDir = mkdtempSync(join(varDir, "env-symlink-internal-"));
    const localTarget = join(localDir, "environment.vars");
    const localLink = join(localDir, ".dev.vars");
    writeFileSync(localTarget, "MAILDESK_API_TOKEN=example-local-value\n");
    symlinkSync(localTarget, localLink);
    const env: Record<string, string | undefined> = {};

    try {
      const result = loadEnvFile(root, relative(root, localLink), env);

      expect(result).toEqual({ loaded: ["MAILDESK_API_TOKEN"], failures: [] });
      expect(env.MAILDESK_API_TOKEN).toBe("example-local-value");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  test("fails Cloudflare proof when cfctl doctor has no healthy lane", () => {
    const cfctl = fakeCfctlDoctor(false);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_API_TOKEN: "example-maildesk-token",
    };
    scrubCloudflareEnv(env);

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing Cloudflare account target");
    expect(result.stderr).toContain("cfctl must report a healthy runtime");
  });

  test("accepts the current cfctl v2 doctor health contract", () => {
    const env = {
      ...process.env,
      CFCTL_BIN: fakeCfctlV2Doctor(),
    MAILDESK_CFCTL_PROFILE: "maildesk-production",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_DESIRED_STATE_PATH: writeDesiredState("disabled"),
      MAILDESK_POLICY_PATH: "config/policy.example.json",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_OUTBOUND_MODE: "disabled",
      MAILDESK_REPLY_API_MODE: "disabled",
      MAILDESK_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      MAILDESK_ACCESS_AUD: "example-access-audience",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).not.toContain("cfctl must report a healthy runtime and an available MAILDESK_CFCTL_PROFILE");
  });

  test("accepts an explicit account-bound cfctl profile without global selection", () => {
    const env = {
      ...process.env,
      CFCTL_BIN: fakeCfctlV2ProfileDoctor(),
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_CFCTL_PROFILE: "maildesk-production",
      MAILDESK_DESIRED_STATE_PATH: writeDesiredState("disabled"),
      MAILDESK_POLICY_PATH: "config/policy.example.json",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_OUTBOUND_MODE: "disabled",
      MAILDESK_REPLY_API_MODE: "disabled",
      MAILDESK_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      MAILDESK_ACCESS_AUD: "example-access-audience",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).not.toContain("cfctl must report a healthy runtime and an available MAILDESK_CFCTL_PROFILE");
  });

  test("rejects an explicit cfctl profile bound to another account", () => {
    const env = {
      ...process.env,
      CFCTL_BIN: fakeCfctlV2ProfileDoctor("other-account-id"),
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_CFCTL_PROFILE: "maildesk-production",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cfctl must report a healthy runtime and an available MAILDESK_CFCTL_PROFILE");
  });

  test("asks for either API token only when the legacy reply API is enabled", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_REPLY_API_MODE: "token",
    };
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROOF_API_TOKEN;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("set one of MAILDESK_API_TOKEN, MAILDESK_PROOF_API_TOKEN");
  });

  test("does not require a shared API token when the legacy reply API is disabled", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_REPLY_API_MODE: "disabled",
    };
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROOF_API_TOKEN;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect([0, 1]).toContain(result.status);
    expect(result.stderr).not.toContain("set one of MAILDESK_API_TOKEN, MAILDESK_PROOF_API_TOKEN");
  });

  test("rejects global credentials and wildcard sender domains for production", () => {
    const desiredPath = writeDesiredState("resend");
    const env = {
      ...process.env,
      CFCTL_BIN: "/usr/bin/false",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "",
      CF_GLOBAL_TOKEN: "example-global-token",
      MAILDESK_DESIRED_STATE_PATH: desiredPath,
      MAILDESK_OUTBOUND_MODE: "resend",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "*",
      RESEND_API_KEY: "example-resend-token",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cfctl must report a healthy runtime");
    expect(result.stderr).toContain("explicit DNS domains without wildcards");
  });

  test("rejects embedded and subdomain sender wildcards", () => {
    const desiredPath = writeDesiredState("resend");
    for (const value of ["example.com,*", "*.example.com"]) {
      const env = {
        ...process.env,
        CFCTL_BIN: fakeCfctlDoctor(true),
        CLOUDFLARE_ACCOUNT_ID: "example-account-id",
        CLOUDFLARE_API_TOKEN: "example-token",
        MAILDESK_DESIRED_STATE_PATH: desiredPath,
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_PROJECT_NAME: "maildesk-cf",
        MAILDESK_VERIFIED_SENDER_DOMAINS: value,
        RESEND_API_KEY: "example-resend-token",
      };

      const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("explicit DNS domains without wildcards");
    }
  });

  test("requires cryptographic Cloudflare Access verifier configuration", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_API_TOKEN: "example-maildesk-token",
      MAILDESK_ACCESS_TEAM_DOMAIN: "",
      MAILDESK_ACCESS_AUD: "",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MAILDESK_ACCESS_TEAM_DOMAIN");
    expect(result.stderr).toContain("MAILDESK_ACCESS_AUD");
  });
});

function ensureVarDir(): string {
  const dir = resolve(root, "var");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Neutralize Cloudflare auth env for a spawned preflight. Setting the keys to ""
// (rather than `delete`) is required because Bun auto-loads the repo `.env`
// into a child's environment, which would otherwise re-inject a local operator's
// real credentials and defeat `delete`. An explicit (empty) value takes
// precedence over Bun's `.env` loading, so the child sees no usable auth —
// making these tests hermetic on a machine that has a `.env`, not just in CI.
function scrubCloudflareEnv(env: Record<string, string | undefined>): void {
  for (const key of [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CF_DEV_TOKEN",
    "CF_GLOBAL_TOKEN",
  ]) {
    env[key] = "";
  }
}

function fakeCatalogDispatcher(): string {
  const cases = [...maildeskReadContracts({ emailRouting: true, senderDomains: true, darkAcceptance: true }), ...maildeskPrivateReadContracts("maildesk-cf.d1-evidence-read")].map((contract) => {
    const envelope = { schema_version: 2, command: "catalog show", ok: true, performed: false, result: {
      id: contract.id, adapter_status: contract.privateProjection === "maildesk_v1" ? "delegated_cli" : contract.privateProjection === "r2_digest" ? "native" : "dynamic_api", method: "GET", effect: "read_only", mutating: false,
      response_contract: { body_mode: contract.privateProjection === "r2_digest" ? "r2_private_object_digest" : "cloudflare_json_envelope" },
      workspace_d1_evidence: { projection: "maildesk_v1", database_binding: "DB", query_sha256: `sha256:${"a".repeat(64)}` },
      r2_private_object_digest: { max_object_bytes: 300_000_000 },
      selectors: contract.selectors.map((name) => ({ name, value_type: "string" })),
    } };
    return `"catalog show ${contract.id} --json") printf '%s\\n' '${JSON.stringify(envelope)}'; exit 0 ;;`;
  });
  return `case "$*" in\n${cases.join("\n")}\nesac`;
}

function fakeCfctlDoctor(healthy: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-"));
  const path = join(dir, "cfctl");
  const healthyLanes = healthy ? ["dev"] : [];
  writeFileSync(
    path,
    `#!/bin/sh
${fakeCatalogDispatcher()}
if [ "$1" = "--help" ]; then
  echo "fake cfctl"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  cat <<'JSON'
{"ok":true,"summary":{"healthy_lanes":${JSON.stringify(healthyLanes)}}}
JSON
  exit 0
fi
exit 1
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function fakeCommandRecorder(markerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-command-recorder-"));
  const path = join(dir, "command-recorder");
  writeFileSync(
    path,
    `#!/bin/sh
touch ${JSON.stringify(markerPath)}
exit 0
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function fakeCfctlV2Doctor(): string { return fakeCfctlV2ProfileDoctor(); }

function fakeCfctlV2ProfileDoctor(accountId = "example-account-id"): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-v2-profile-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
${fakeCatalogDispatcher()}
if [ "$1" = "--help" ]; then
  echo "fake cfctl"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  cat <<'JSON'
{"schema_version":2,"command":"doctor","performed":false,"ok":true,"result":{"build_identity_healthy":true,"current_profile":null,"instruction_drift":0,"path_build":{"healthy":true}}}
JSON
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "maildesk-production" ]; then
  cat <<'JSON'
{"schema_version":2,"command":"auth status","performed":false,"ok":true,"result":{"credential_available":true,"profile":{"id":"maildesk-production","kind":"api_token","account_id":"${accountId}"}}}
JSON
  exit 0
fi
exit 1
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeDesiredState(
  mode: "disabled" | "cloudflare_email_service" | "resend",
  additions: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-desired-"));
  const path = join(dir, "desired-state.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        project: {
          name: "maildesk-cf",
          account_id_env: "CLOUDFLARE_ACCOUNT_ID",
        },
        domains: [],
        operator_delivery: {
          mode: "web_desk",
          inbound_processing_mode: "disabled",
          reply_processing_mode: "disabled",
          reply_domain: "reply.maildesk.example.com",
          reply_token_ttl_days: 90,
          spool_retention_days: 7,
          max_encoded_message_bytes: 5_242_880,
          banner_mode: "inline",
        },
        sender: {
          mode,
          candidate_domains: mode === "disabled" ? [] : ["example.com"],
        },
        ...additions,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

let productionTopologySequence = 0;

function writeProductionTopology(options: {
  routerPlaceholder?: boolean;
  outboundWithoutEmail?: boolean;
} = {}) {
  productionTopologySequence += 1;
  const suffix = `preflight-${process.pid}-${productionTopologySequence}`;
  const routerPath = `wrangler.mail-router.${suffix}.toml`;
  const outboundPath = `wrangler.mail-outbound.${suffix}.toml`;
  const healthPath = `wrangler.routing-health.${suffix}.toml`;
  const realId = "11111111-1111-4111-8111-111111111111";
  const placeholder = "00000000-0000-0000-0000-000000000000";
  const selected = [routerPath, outboundPath, healthPath];

  const router = readFileSync(resolve(root, "wrangler.mail-router.toml"), "utf8")
    .replaceAll(placeholder, options.routerPlaceholder ? placeholder : realId);
  let outbound = readFileSync(resolve(root, "wrangler.mail-outbound.toml"), "utf8")
    .replaceAll(placeholder, realId);
  const health = readFileSync(resolve(root, "wrangler.routing-health.toml"), "utf8")
    .replaceAll(placeholder, realId);
  if (options.outboundWithoutEmail) {
    outbound = outbound.replace(/send_email = \[\n\s*\{ name = "EMAIL" \}\n\]\n\n/, "");
  }

  writeFileSync(resolve(root, routerPath), router);
  writeFileSync(resolve(root, outboundPath), outbound);
  writeFileSync(resolve(root, healthPath), health);

  const canonical = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8"));
  const desiredPath = writeDesiredState("cloudflare_email_service", {
    domains: canonical.domains,
    access: canonical.access,
    verification: canonical.verification,
    operator_delivery: {
      mode: "inbox_relay",
      inbound_processing_mode: "disabled",
      reply_processing_mode: "disabled",
      reply_domain: "reply.maildesk.example.com",
      reply_token_ttl_days: 90,
      spool_retention_days: 7,
      max_encoded_message_bytes: 5_242_880,
      banner_mode: "inline",
    },
    workers: {
      relay_router: { script_name: "maildesk-cf-router", config: routerPath },
      relay_outbound: { script_name: "maildesk-cf-relay-outbound", config: outboundPath },
      routing_health: { script_name: "maildesk-cf-routing-health", config: healthPath },
    },
    storage: {
      d1_database: "maildesk-cf-relay-db",
      d1_preview_database: "maildesk-cf-relay-preview-db",
      r2_policy_bucket: "maildesk-cf-policy",
      r2_spool_bucket: "maildesk-cf-relay-spool",
      queue: "maildesk-cf-relay-jobs",
      dead_letter_queue: "maildesk-cf-relay-dlq",
    },
  });

  return {
    desiredPath,
    routerPath,
    outboundPath,
    cleanup: () => {
      for (const path of selected) rmSync(resolve(root, path), { force: true });
    },
  };
}

function productionEnv(
  desiredPath: string,
  mode: "disabled" | "cloudflare_email_service" | "resend",
): Record<string, string | undefined> {
  return {
    ...process.env,
    CFCTL_BIN: fakeCfctlV2Doctor(),
    MAILDESK_CFCTL_PROFILE: "maildesk-production",
    CLOUDFLARE_ACCOUNT_ID: "example-account-id",
    CLOUDFLARE_API_TOKEN: "",
    MAILDESK_DESIRED_STATE_PATH: desiredPath,
    MAILDESK_POLICY_PATH: "config/policy.example.json",
    MAILDESK_PROJECT_NAME: "maildesk-cf",
    MAILDESK_OUTBOUND_MODE: mode,
    MAILDESK_VERIFIED_SENDER_DOMAINS: mode === "disabled" ? "" : "example.com",
    MAILDESK_REPLY_API_MODE: "disabled",
    MAILDESK_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    MAILDESK_ACCESS_AUD: "example-access-audience",
    MAILDESK_UI_ACCESS_SCOPE: "all_routes",
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
    MAILDESK_INBOUND_RELAY_MODE: "disabled",
    MAILDESK_REPLY_RELAY_MODE: "disabled",
    MAILDESK_REPLY_DOMAIN: "reply.maildesk.example.com",
    MAILDESK_REPLY_TOKEN_TTL_DAYS: "90",
    MAILDESK_SPOOL_RETENTION_DAYS: "7",
    MAILDESK_MAX_ENCODED_MESSAGE_BYTES: "5242880",
  };
}

function runInboxRelayProductionPreflight(desiredPath: string) {
  return spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
    cwd: root,
    encoding: "utf8",
    env: productionEnv(desiredPath, "cloudflare_email_service"),
  });
}
