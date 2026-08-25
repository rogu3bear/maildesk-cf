import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  admitGitCandidateBinding,
  candidateSha256,
  collectGitCandidate,
} from "../../scripts/git-candidate";

const root = resolve(import.meta.dir, "../..");

describe("Git candidate binding", () => {
  test("binds the exact checkout HEAD, tree, and dirty state", () => {
    const binding = collectGitCandidate(root);
    expect(binding.candidate_sha256).toBe(candidateSha256(binding.candidate));
    expect(binding.candidate.head).toMatch(/^[a-f0-9]{40}$/);
    expect(binding.candidate.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(typeof binding.candidate.dirty).toBe("boolean");
    expect(admitGitCandidateBinding(binding.candidate, binding.candidate_sha256)).toEqual(binding);
  });

  test("fails closed on malformed, extended, or digest-mismatched bindings", () => {
    const binding = collectGitCandidate(root);
    expect(() => admitGitCandidateBinding({ ...binding.candidate, extra: true }, binding.candidate_sha256))
      .toThrow("shape is invalid");
    expect(() => admitGitCandidateBinding(binding.candidate, "0".repeat(64)))
      .toThrow("digest mismatch");
    expect(() => admitGitCandidateBinding({ ...binding.candidate, dirty: "false" }, binding.candidate_sha256))
      .toThrow("dirty state is invalid");
  });
});
