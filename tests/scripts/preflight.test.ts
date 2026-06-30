import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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
});
