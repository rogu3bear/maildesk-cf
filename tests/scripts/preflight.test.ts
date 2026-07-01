import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("production preflight", () => {
  test("accepts RESEND as a local compatibility alias for RESEND_API_KEY", () => {
    const env = {
      ...process.env,
      CFCTL_BIN: "/usr/bin/true",
      CLOUDFLARE_ACCOUNT_ID: "example-account-id",
      CLOUDFLARE_API_TOKEN: "example-token",
      MAILDESK_API_TOKEN: "example-maildesk-token",
      MAILDESK_OUTBOUND_MODE: "resend",
      MAILDESK_PROJECT_NAME: "maildesk-cf",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "example.com",
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
    expect(result.stderr).toContain("wrangler.toml still contains placeholder Cloudflare resource IDs");
  });

  test("accepts a healthy cfctl doctor lane for Cloudflare proof", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_API_TOKEN: "example-maildesk-token",
    };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_API_KEY;
    delete env.CLOUDFLARE_EMAIL;
    delete env.CF_DEV_TOKEN;
    delete env.CF_GLOBAL_TOKEN;
    delete env.MAILDESK_PROJECT_NAME;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("missing Cloudflare account target");
    expect(result.stderr).not.toContain("missing Cloudflare auth");
    expect(result.stderr).not.toContain("missing project name");
    expect(result.stderr).toContain("wrangler.toml still contains placeholder Cloudflare resource IDs");
  });

  test("accepts MAILDESK_PROOF_API_TOKEN for proof-only closeout", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_PROOF_API_TOKEN: "example-proof-token",
    };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_API_KEY;
    delete env.CLOUDFLARE_EMAIL;
    delete env.CF_DEV_TOKEN;
    delete env.CF_GLOBAL_TOKEN;
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROJECT_NAME;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("MAILDESK_API_TOKEN");
    expect(result.stderr).not.toContain("MAILDESK_PROOF_API_TOKEN");
    expect(result.stderr).toContain("wrangler.toml still contains placeholder Cloudflare resource IDs");
  });

  test("fails Cloudflare proof when cfctl doctor has no healthy lane", () => {
    const cfctl = fakeCfctlDoctor(false);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
      MAILDESK_API_TOKEN: "example-maildesk-token",
    };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_API_KEY;
    delete env.CLOUDFLARE_EMAIL;
    delete env.CF_DEV_TOKEN;
    delete env.CF_GLOBAL_TOKEN;

    const result = spawnSync("bun", ["run", "scripts/preflight.ts", "--mode", "production"], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing Cloudflare account target");
    expect(result.stderr).toContain("missing Cloudflare auth");
  });

  test("asks for either API token when no reply proof token is present", () => {
    const cfctl = fakeCfctlDoctor(true);
    const env = {
      ...process.env,
      CFCTL_BIN: cfctl,
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
});

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
