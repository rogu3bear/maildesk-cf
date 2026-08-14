import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type WranglerConfigFormat = "toml" | "json" | "jsonc";
export type WranglerWorkerRole = "mail-router" | "mail-outbound" | "routing-health";

export function isRepositoryRelativePath(path: string): boolean {
  return !isAbsolute(path) &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !/[\0-\x1f\x7f]/.test(path) &&
    !path.split("/").some((part) => part === "." || part === ".." || part === "");
}

export function wranglerBuildCommandFailure(
  contents: string,
  format: WranglerConfigFormat = "toml",
): string | null {
  let root: unknown;
  try {
    root = format === "toml"
      ? Bun.TOML.parse(contents)
      : format === "json"
        ? JSON.parse(contents)
        : Bun.JSONC.parse(contents);
  } catch {
    return `config must be valid ${format.toUpperCase()}`;
  }
  return parsedBuildCommandFailure(root);
}

export function canonicalWorkerConfigFailure(
  path: string,
  role: WranglerWorkerRole,
): string | null {
  const pattern = new RegExp(`^wrangler\\.${role}(?:\\.[a-z0-9-]+)?\\.toml$`);
  return isRepositoryRelativePath(path) && pattern.test(path)
    ? null
    : `must be a repository-relative canonical wrangler.${role}*.toml path`;
}

export function wranglerArtifactContainmentFailure(
  contents: string,
  configPath: string,
  repositoryRoot: string,
  format: WranglerConfigFormat = "toml",
): string | null {
  let root: unknown;
  try {
    root = format === "toml"
      ? Bun.TOML.parse(contents)
      : format === "json"
        ? JSON.parse(contents)
        : Bun.JSONC.parse(contents);
  } catch {
    return `config must be valid ${format.toUpperCase()}`;
  }
  if (!isRecord(root)) return "config root must be an object";

  const configParent = realpathSync(resolve(repositoryRoot, configPath, ".."));
  for (const [label, value] of [
    ["main", root.main],
    ["assets.directory", isRecord(root.assets) ? root.assets.directory : undefined],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) return `${label} must be a non-empty string`;
    const resolvedCandidate = resolveThroughExistingAncestor(resolve(configParent, value));
    const contained = relative(configParent, resolvedCandidate);
    if (!isRepositoryRelativePath(contained)) {
      return `${label} must resolve inside the Wrangler config parent directory`;
    }
  }
  return null;
}

function resolveThroughExistingAncestor(path: string): string {
  let ancestor = path;
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return path;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return suffix.reduce((current, part) => join(current, part), realpathSync(ancestor));
}

function parsedBuildCommandFailure(root: unknown): string | null {
  if (!isRecord(root)) return "config root must be an object";
  const build = root.build;
  if (build === undefined) return null;
  if (!isRecord(build)) return "build config must be an object";
  const command = build.command;
  if (command === undefined) return null;
  if (typeof command !== "string") return "build command must be a string";
  return parentTraversalFailure(command);
}

function parentTraversalFailure(command: string): string | null {
  return command.includes("..")
    ? "build command runs from the Wrangler config parent directory and must not traverse to a parent directory"
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
