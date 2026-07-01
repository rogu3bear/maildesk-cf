import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("cfctl provisioning contract check", () => {
  test("reports the template desired state as a cfctl maildesk-cf provisioning lane", () => {
    const result = spawnSync(
      "bun",
      ["run", "scripts/check-cfctl-provisioning.ts", "--", "--json"],
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
    expect(receipt.resources.workers).toEqual(["maildesk-cf", "maildesk-cf-router"]);
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
              config: "wrangler.mail-router.toml",
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
});
