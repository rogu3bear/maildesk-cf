import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

setDefaultTimeout(30_000);

describe("production preflight", () => {
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
    expect(result.stderr).toContain("cfctl doctor must report at least one healthy lane");
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
    const env = {
      ...process.env,
      CFCTL_BIN: "/usr/bin/true",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_DESIRED_STATE_PATH: desiredPath,
      MAILDESK_API_TOKEN: "example-maildesk-token",
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "example.com",
    };

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cloudflare_email_service mode requires wrangler.toml send_email binding named "EMAIL"');
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
    expect(result.stderr).toContain("missing Cloudflare deploy auth");
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
    expect(result.stderr).toContain("missing Cloudflare deploy auth");
  });

  test("accepts the current cfctl v2 doctor health contract", () => {
    const env = {
      ...process.env,
      CFCTL_BIN: fakeCfctlV2Doctor(),
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
    expect(result.stderr).not.toContain("cfctl doctor must report at least one healthy lane");
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
    expect(result.stderr).not.toContain("cfctl doctor must report at least one healthy lane");
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
    expect(result.stderr).toContain("cfctl doctor must report at least one healthy lane");
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
    expect(result.stderr).toContain("purpose-scoped CLOUDFLARE_API_TOKEN");
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

function fakeCfctlDoctor(healthy: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-"));
  const path = join(dir, "cfctl");
  const healthyLanes = healthy ? ["dev"] : [];
  writeFileSync(
    path,
    `#!/bin/sh
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

function fakeCfctlV2Doctor(): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-v2-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "fake cfctl"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  cat <<'JSON'
{"ok":true,"result":{"build_identity_healthy":true,"current_profile":"maildesk-production","instruction_drift":0,"path_build":{"healthy":true}}}
JSON
  exit 0
fi
exit 1
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function fakeCfctlV2ProfileDoctor(accountId = "example-account-id"): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-v2-profile-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "fake cfctl"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  cat <<'JSON'
{"ok":true,"result":{"build_identity_healthy":true,"current_profile":null,"instruction_drift":0,"path_build":{"healthy":true}}}
JSON
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "maildesk-production" ]; then
  cat <<'JSON'
{"ok":true,"result":{"credential_available":true,"profile":{"id":"maildesk-production","account_id":"${accountId}"}}}
JSON
  exit 0
fi
exit 1
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeDesiredState(mode: "disabled" | "cloudflare_email_service" | "resend"): string {
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
        sender: {
          mode,
          authenticated_domains: mode === "disabled" ? [] : ["example.com"],
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}
