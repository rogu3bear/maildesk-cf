import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeWorkerVersionId,
  deploymentArtifactSha256,
  projectWorkerRuntimeProvenance,
} from "../../scripts/worker-runtime-provenance";

const candidateHead = "a".repeat(40);
const deployedHead = "b".repeat(40);
const artifactSha256 = "c".repeat(64);
const versionId = "11111111-2222-4333-8444-555555555555";
const scriptEtag = "d".repeat(64);

describe("Worker runtime provenance", () => {
  test("projects an exact active version without retaining provider identities", () => {
    const deployments = deploymentResult(candidateHead, artifactSha256);
    const detail = versionDetail(candidateHead, artifactSha256);

    expect(activeWorkerVersionId(deployments)).toBe(versionId);
    expect(projectWorkerRuntimeProvenance({
      scriptName: "maildesk-relay-router",
      candidateHead,
      expectedArtifactSha256: artifactSha256,
      deployments,
      versionDetail: detail,
    })).toEqual({
      schema_version: 1,
      status: "exact",
      script_name: "maildesk-relay-router",
      candidate_source_sha: candidateHead,
      deployed_source_sha: candidateHead,
      expected_artifact_sha256: artifactSha256,
      deployed_artifact_sha256: artifactSha256,
      active_version_sha256: sha256(versionId),
      script_etag_sha256: scriptEtag,
      deployment_message_sha256: sha256(
        `source=${candidateHead} artifact-sha256=${artifactSha256}`,
      ),
      metadata_source: "wrangler",
      provider_output_retained: false,
      body_returned: false,
    });
  });

  test("permits explicit proof inheritance only when runtime artifacts are identical", () => {
    const inherited = projectWorkerRuntimeProvenance({
      scriptName: "maildesk-relay-router",
      candidateHead,
      expectedArtifactSha256: artifactSha256,
      deployments: deploymentResult(deployedHead, artifactSha256),
      versionDetail: versionDetail(deployedHead, artifactSha256),
    });
    expect(inherited.status).toBe("artifact_equivalent");
    expect(inherited.deployed_source_sha).toBe(deployedHead);

    const drifted = projectWorkerRuntimeProvenance({
      scriptName: "maildesk-relay-router",
      candidateHead,
      expectedArtifactSha256: artifactSha256,
      deployments: deploymentResult(deployedHead, "e".repeat(64)),
      versionDetail: versionDetail(deployedHead, "e".repeat(64)),
    });
    expect(drifted.status).toBe("drift");
  });

  test("rejects traffic splits, mismatched detail, and noncanonical annotations", () => {
    const split = deploymentResult(candidateHead, artifactSha256);
    split.result.deployments[0].versions = [
      { version_id: versionId, percentage: 50 },
      { version_id: "99999999-8888-4777-8666-555555555555", percentage: 50 },
    ];
    expect(() => activeWorkerVersionId(split)).toThrow("exactly one 100 percent active version");

    const wrongVersion = versionDetail(candidateHead, artifactSha256);
    wrongVersion.result.id = "99999999-8888-4777-8666-555555555555";
    expect(() => projectWorkerRuntimeProvenance({
      scriptName: "maildesk-relay-router",
      candidateHead,
      expectedArtifactSha256: artifactSha256,
      deployments: deploymentResult(candidateHead, artifactSha256),
      versionDetail: wrongVersion,
    })).toThrow("version detail does not match");

    const extraText = deploymentResult(candidateHead, artifactSha256);
    extraText.result.deployments[0].annotations["workers/message"] += " extra";
    expect(() => projectWorkerRuntimeProvenance({
      scriptName: "maildesk-relay-router",
      candidateHead,
      expectedArtifactSha256: artifactSha256,
      deployments: extraText,
      versionDetail: versionDetail(candidateHead, artifactSha256),
    })).toThrow("deployment annotation is malformed");
  });

  test("hashes the complete main and assets artifact set using repository-relative paths", () => {
    const root = mkdtempSync(join(tmpdir(), "maildesk-artifact-set-"));
    mkdirSync(join(root, "build", "nested"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(join(root, "wrangler.toml"), [
      'main = "build/index.js"',
      "[assets]",
      'directory = "site"',
      "",
    ].join("\n"));
    writeFileSync(join(root, "build", "index.js"), "main\n");
    writeFileSync(join(root, "build", "nested", "module.js"), "nested\n");
    writeFileSync(join(root, "site", "index.html"), "site\n");

    const manifest = [
      `${sha256("main\n")}  build/index.js`,
      `${sha256("nested\n")}  build/nested/module.js`,
      `${sha256("site\n")}  site/index.html`,
      "",
    ].join("\n");
    expect(deploymentArtifactSha256(root, "wrangler.toml")).toBe(sha256(manifest));
  });

  test("rejects symlinked or escaping artifact roots", () => {
    const root = mkdtempSync(join(tmpdir(), "maildesk-artifact-escape-"));
    const outside = mkdtempSync(join(tmpdir(), "maildesk-artifact-outside-"));
    writeFileSync(join(outside, "worker.js"), "outside\n");
    symlinkSync(outside, join(root, "build"));
    writeFileSync(join(root, "wrangler.toml"), 'main = "build/worker.js"\n');
    expect(() => deploymentArtifactSha256(root, "wrangler.toml")).toThrow(
      "artifact path must remain inside the repository",
    );
  });
});

function deploymentResult(source: string, artifact: string) {
  return {
    result: {
      deployments: [{
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: {
          "workers/message": `source=${source} artifact-sha256=${artifact}`,
        },
      }],
    },
  };
}

function versionDetail(source: string, artifact: string) {
  return {
    result: {
      id: versionId,
      annotations: {
        "workers/message": `source=${source} artifact-sha256=${artifact}`,
      },
      metadata: { source: "wrangler" },
      resources: { script: { etag: scriptEtag } },
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
