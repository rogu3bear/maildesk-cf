import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const GIT_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface GitCandidate {
  head: string;
  tree: string;
  dirty: boolean;
}

export interface GitCandidateBinding {
  candidate: GitCandidate;
  candidate_sha256: string;
}

export function collectGitCandidate(root: string): GitCandidateBinding {
  const candidate = {
    head: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    dirty: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
  };
  return {
    candidate,
    candidate_sha256: candidateSha256(candidate),
  };
}

export function admitGitCandidateBinding(
  candidate: unknown,
  expectedSha256: unknown,
): GitCandidateBinding {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate binding is missing");
  }
  const value = candidate as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "dirty,head,tree") {
    throw new Error("candidate binding shape is invalid");
  }
  if (!GIT_ID.test(String(value.head)) || !GIT_ID.test(String(value.tree))) {
    throw new Error("candidate HEAD or tree is invalid");
  }
  if (typeof value.dirty !== "boolean") throw new Error("candidate dirty state is invalid");
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    throw new Error("candidate digest is invalid");
  }
  const admitted: GitCandidate = {
    head: value.head as string,
    tree: value.tree as string,
    dirty: value.dirty,
  };
  if (candidateSha256(admitted) !== expectedSha256) throw new Error("candidate digest mismatch");
  return { candidate: admitted, candidate_sha256: expectedSha256 };
}

export function candidateSha256(candidate: GitCandidate): string {
  return createHash("sha256").update(canonicalJson(candidate)).digest("hex");
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git candidate identity is unavailable");
  const value = result.stdout.trim();
  if (args[0] === "rev-parse" && !GIT_ID.test(value)) {
    throw new Error("git candidate identity is invalid");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
