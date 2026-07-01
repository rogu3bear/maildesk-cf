import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk verifier", () => {
  test("uses cfctl lifecycle evidence for edge readiness without hiding sender drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const evidencePath = join(dir, "evidence.json");

    writeJson(policyPath, {
      domains: {
        "example.com": {
          role_aliases: {
            founders: {
              operators: ["operator@example.com"],
              reply_identity: "founders@example.com",
              allowed_reply_identities: ["founders@example.com"],
            },
          },
          personal_aliases: {},
        },
      },
    });
    writeJson(desiredPath, {
      domains: [
        {
          name: "example.com",
          role_aliases: ["founders"],
          personal_aliases: [],
          inbound_mx_provider: "cloudflare_email_routing",
        },
      ],
      sender: {
        mode: "cloudflare_first",
        authenticated_domains: ["example.com"],
      },
    });
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      cfctl_maildesk: {
        edge_ready: true,
        mail_ready: false,
        domains: {
          "example.com": {
            email_routing: "ok",
            aliases: {
              "founders@example.com": "ok",
            },
          },
        },
        workers: {
          mail_api: "ok",
          mail_router: "ok",
        },
        storage: {
          d1_database: "ok",
          queue: "ok",
          r2_raw_mail_bucket: "ok",
        },
        sender_domains: {
          "example.com": "missing",
        },
      },
      inbound_proofs: {
        "example.com": {
          status: "ok",
          envelope_to: "founders@example.com",
          route_kind: "role_alias",
          forwarded_to: ["operator@example.com"],
          forward_errors: [],
          default_reply_identity: "founders@example.com",
          raw_r2_key: "raw/example",
        },
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { edge_ready: boolean; mail_ready: boolean };
      gaps: Array<{ readiness: string; field: string; status: string }>;
      rows: Array<{ outbound_sender: string }>;
    };

    expect(receipt.status.edge_ready).toBe(true);
    expect(receipt.status.mail_ready).toBe(false);
    expect(receipt.gaps.filter((gap) => gap.readiness === "edge")).toHaveLength(0);
    expect(receipt.gaps).toContainEqual({
      domain: "example.com",
      field: "outbound_sender",
      status: "missing",
      readiness: "mail",
      detail: "sender provider status is missing",
    });
    expect(receipt.rows[0]?.outbound_sender).toBe("missing");
  });
});

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
