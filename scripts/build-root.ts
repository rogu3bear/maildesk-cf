import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** One compiler envelope; generated bindings and final Worker products are separate. */
export function canonicalCargoEnvironment(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, "target");
  if (existsSync(target) && realpathSync(target) !== target) {
    throw new Error("Cargo target must be the repository's real target directory");
  }
  for (const key of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"]) {
    const value = env[key];
    if (value !== undefined && resolve(canonicalRoot, value) !== target) {
      throw new Error(`${key} selects a different compiler root`);
    }
  }
  return { ...env, CARGO_TARGET_DIR: target };
}

if (import.meta.main) {
  try {
    canonicalCargoEnvironment(resolve(import.meta.dir, ".."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
