import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

setDefaultTimeout(30_000);

const roles = [
  {
    role: "mail-router",
    config: "wrangler.mail-router.toml",
    entrypoint: "workers/mail-router/src/index.ts",
    requiredInputs: [
      "workers/mail-router/src/index.ts",
      "workers/shared/contracts.ts",
      "workers/shared/dkim.ts",
      "workers/shared/inbox-relay.ts",
      "workers/shared/policy-store.ts",
      "workers/shared/router.ts",
      "generated/router-wasm/maildesk_router.js",
      "generated/router-wasm/maildesk_router_bg.js",
      "generated/router-wasm/maildesk_router_bg.wasm",
      "Cargo.lock",
      "Cargo.toml",
      "crates/maildesk-router/Cargo.toml",
      "crates/maildesk-router/src/lib.rs",
      "scripts/build-mail-worker-bundles.ts",
      "scripts/build-router-wasm.ts",
    ],
  },
  {
    role: "mail-outbound",
    config: "wrangler.mail-outbound.toml",
    entrypoint: "workers/mail-outbound/src/index.ts",
    requiredInputs: [
      "workers/mail-outbound/src/index.ts",
      "workers/mail-api/src/index.ts",
      "workers/shared/contracts.ts",
      "workers/shared/inbox-relay.ts",
      "workers/shared/policy-store.ts",
      "workers/shared/router.ts",
      "generated/router-wasm/maildesk_router.js",
      "generated/router-wasm/maildesk_router_bg.js",
      "generated/router-wasm/maildesk_router_bg.wasm",
      "Cargo.lock",
      "Cargo.toml",
      "crates/maildesk-router/Cargo.toml",
      "crates/maildesk-router/src/lib.rs",
      "scripts/build-mail-worker-bundles.ts",
      "scripts/build-router-wasm.ts",
    ],
  },
] as const;

describe("closed Maildesk Worker bundles", () => {
  test("Wrangler deploys role-specific artifacts whose manifests bind every imported source", () => {
    for (const role of roles) {
      const config = Bun.TOML.parse(
        readFileSync(resolve(root, role.config), "utf8"),
      ) as Record<string, any>;
      expect(config.main).toBe(`generated/mail-workers/${role.role}/index.js`);
      expect(config.build?.command).toBe("bun run check:mail-worker-bundles");
    }

    const build = spawnSync("bun", ["run", "build:mail-workers"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    for (const role of roles) {
      const outputDirectory = resolve(root, "generated/mail-workers", role.role);
      const manifest = JSON.parse(
        readFileSync(resolve(outputDirectory, "artifact-manifest.json"), "utf8"),
      ) as {
        schema_version: number;
        role: string;
        entrypoint: string;
        inputs: Array<{ path: string; sha256: string }>;
        outputs: Array<{ path: string; sha256: string }>;
      };

      expect(manifest.schema_version).toBe(1);
      expect(manifest.role).toBe(role.role);
      expect(manifest.entrypoint).toBe(role.entrypoint);
      expect(manifest.inputs.map((input) => input.path)).toEqual(
        expect.arrayContaining([...role.requiredInputs]),
      );
      expect(JSON.stringify(manifest)).not.toContain(`${root}/`);

      for (const input of manifest.inputs) {
        const bytes = readFileSync(resolve(root, input.path));
        expect(input.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      for (const output of manifest.outputs) {
        const bytes = readFileSync(resolve(outputDirectory, output.path));
        expect(output.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      expect(manifest.outputs.map((output) => output.path).sort()).toEqual([
        "index.js",
        "maildesk_router_bg.wasm",
      ]);
    }

    const check = spawnSync("bun", ["run", "check:mail-worker-bundles"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
  });

  test("verification fails when an imported shared source drifts from the reviewed artifact", () => {
    const build = spawnSync("bun", ["run", "build:mail-workers"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    const sharedSource = resolve(root, "workers/shared/policy-store.ts");
    const original = readFileSync(sharedSource);
    try {
      writeFileSync(sharedSource, Buffer.concat([original, Buffer.from("\n// closure drift probe\n")]));
      const drifted = spawnSync("bun", ["run", "check:mail-worker-bundles"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(drifted.status).toBe(1);
      expect(drifted.stderr).toContain("mail Worker bundles file");
      expect(drifted.stderr).toContain("drifted");
    } finally {
      writeFileSync(sharedSource, original);
    }

    const restored = spawnSync("bun", ["run", "check:mail-worker-bundles"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(restored.status, restored.stderr).toBe(0);
  });
});
