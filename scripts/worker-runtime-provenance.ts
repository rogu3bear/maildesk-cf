import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEPLOYMENT_MESSAGE = /^source=([a-f0-9]{40}) artifact-sha256=([a-f0-9]{64})$/;

export type WorkerRuntimeStatus = "exact" | "artifact_equivalent" | "drift";

export interface WorkerRuntimeProvenance {
  schema_version: 1;
  status: WorkerRuntimeStatus;
  script_name: string;
  candidate_source_sha: string;
  deployed_source_sha: string;
  expected_artifact_sha256: string;
  deployed_artifact_sha256: string;
  active_version_sha256: string;
  script_etag_sha256: string;
  deployment_message_sha256: string;
  metadata_source: string;
  provider_output_retained: false;
  body_returned: false;
}

interface ProvenanceInput {
  scriptName: string;
  candidateHead: string;
  expectedArtifactSha256: string;
  deployments: unknown;
  versionDetail: unknown;
}

interface ActiveDeployment {
  versionId: string;
  message: string;
  sourceSha: string;
  artifactSha256: string;
}

export function deploymentArtifactSha256(repositoryRoot: string, configPath: string): string {
  const root = realpathSync(repositoryRoot);
  const config = containedRealPath(root, resolve(root, configPath));
  const configMetadata = lstatSync(config);
  if (!configMetadata.isFile() || configMetadata.isSymbolicLink()) {
    throw new Error("Wrangler config must be one regular repository file");
  }
  const parsed = Bun.TOML.parse(readFileSync(config, "utf8"));
  if (!isRecord(parsed)) throw new Error("Wrangler config root must be an object");

  const artifactRoots = new Set<string>();
  const main = requiredString(parsed.main, "Wrangler main");
  const mainPath = containedRealPath(root, resolve(dirname(config), main));
  const mainMetadata = lstatSync(mainPath);
  if (mainMetadata.isSymbolicLink()) throw new Error("artifact paths must not be symbolic links");
  artifactRoots.add(mainMetadata.isDirectory() ? mainPath : dirname(mainPath));

  if (parsed.assets !== undefined) {
    if (!isRecord(parsed.assets)) throw new Error("Wrangler assets must be an object");
    const assetsDirectory = requiredString(parsed.assets.directory, "Wrangler assets.directory");
    const assetsPath = containedRealPath(root, resolve(dirname(config), assetsDirectory));
    if (!lstatSync(assetsPath).isDirectory()) {
      throw new Error("Wrangler assets.directory must be a directory");
    }
    artifactRoots.add(assetsPath);
  }

  const files = new Map<string, string>();
  for (const artifactRoot of [...artifactRoots].sort()) {
    collectArtifactFiles(root, artifactRoot, files);
  }
  if (files.size === 0) throw new Error("Worker deployment artifact set is empty");
  const manifest = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, digest]) => `${digest}  ${path}\n`)
    .join("");
  return sha256(manifest);
}

export function activeWorkerVersionId(value: unknown): string {
  return activeDeployment(value).versionId;
}

export function projectWorkerRuntimeProvenance(input: ProvenanceInput): WorkerRuntimeProvenance {
  if (!validName(input.scriptName)) throw new Error("Worker script name is invalid");
  if (!GIT_SHA.test(input.candidateHead)) throw new Error("candidate source SHA is invalid");
  if (!SHA256.test(input.expectedArtifactSha256)) {
    throw new Error("expected Worker artifact SHA-256 is invalid");
  }
  const deployment = activeDeployment(input.deployments);
  const detail = versionDetail(input.versionDetail);
  if (detail.versionId !== deployment.versionId || detail.message !== deployment.message) {
    throw new Error("Worker version detail does not match the active deployment");
  }
  const artifactMatches = deployment.artifactSha256 === input.expectedArtifactSha256;
  const sourceMatches = deployment.sourceSha === input.candidateHead;
  return {
    schema_version: 1,
    status: artifactMatches ? sourceMatches ? "exact" : "artifact_equivalent" : "drift",
    script_name: input.scriptName,
    candidate_source_sha: input.candidateHead,
    deployed_source_sha: deployment.sourceSha,
    expected_artifact_sha256: input.expectedArtifactSha256,
    deployed_artifact_sha256: deployment.artifactSha256,
    active_version_sha256: sha256(deployment.versionId),
    script_etag_sha256: detail.scriptEtag,
    deployment_message_sha256: sha256(deployment.message),
    metadata_source: detail.metadataSource,
    provider_output_retained: false,
    body_returned: false,
  };
}

function activeDeployment(value: unknown): ActiveDeployment {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.deployments)) {
    throw new Error("Worker deployments result is malformed");
  }
  const latest = value.result.deployments[0];
  if (!isRecord(latest) || !Array.isArray(latest.versions)) {
    throw new Error("Worker active deployment is missing");
  }
  const active = latest.versions.filter((entry) =>
    isRecord(entry) && entry.percentage === 100 && typeof entry.version_id === "string"
  );
  if (latest.versions.length !== 1 || active.length !== 1 || !UUID.test(String(active[0].version_id))) {
    throw new Error("Worker deployment must have exactly one 100 percent active version");
  }
  const annotations = latest.annotations;
  if (!isRecord(annotations) || typeof annotations["workers/message"] !== "string") {
    throw new Error("Worker deployment annotation is missing");
  }
  const message = annotations["workers/message"];
  const match = DEPLOYMENT_MESSAGE.exec(message);
  if (!match) throw new Error("Worker deployment annotation is malformed");
  return {
    versionId: active[0].version_id as string,
    message,
    sourceSha: match[1],
    artifactSha256: match[2],
  };
}

function versionDetail(value: unknown): {
  versionId: string;
  message: string;
  scriptEtag: string;
  metadataSource: string;
} {
  if (!isRecord(value) || !isRecord(value.result)) {
    throw new Error("Worker version detail is malformed");
  }
  const result = value.result;
  if (typeof result.id !== "string" || !UUID.test(result.id)) {
    throw new Error("Worker version detail ID is invalid");
  }
  if (!isRecord(result.annotations) || typeof result.annotations["workers/message"] !== "string") {
    throw new Error("Worker version detail annotation is missing");
  }
  if (!DEPLOYMENT_MESSAGE.test(result.annotations["workers/message"])) {
    throw new Error("Worker version detail annotation is malformed");
  }
  const script = isRecord(result.resources) && isRecord(result.resources.script)
    ? result.resources.script
    : null;
  if (!script || typeof script.etag !== "string" || !SHA256.test(script.etag)) {
    throw new Error("Worker version script etag is invalid");
  }
  const metadataSource = isRecord(result.metadata) && typeof result.metadata.source === "string"
    ? result.metadata.source
    : null;
  if (!metadataSource || !validName(metadataSource)) {
    throw new Error("Worker version metadata source is invalid");
  }
  return {
    versionId: result.id,
    message: result.annotations["workers/message"],
    scriptEtag: script.etag,
    metadataSource,
  };
}

function collectArtifactFiles(root: string, directory: string, files: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("artifact paths must not be symbolic links");
    if (entry.name === ".git") throw new Error("artifact path must not contain Git metadata");
    if (entry.isDirectory()) {
      collectArtifactFiles(root, containedRealPath(root, path), files);
      continue;
    }
    if (!entry.isFile()) throw new Error("Worker deployment artifact contains a non-file entry");
    const real = containedRealPath(root, path);
    const logical = relative(root, real).split(sep).join("/");
    files.set(logical, sha256(readFileSync(real)));
  }
}

function containedRealPath(root: string, path: string): string {
  const real = realpathSync(path);
  const logical = relative(root, real);
  if (!logical || logical === ".." || logical.startsWith(`..${sep}`) || isAbsolute(logical)) {
    throw new Error("artifact path must remain inside the repository");
  }
  return real;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validName(value: string): boolean {
  return value.length > 0 && value === value.trim() && !/[\0-\x1f\x7f]/.test(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
