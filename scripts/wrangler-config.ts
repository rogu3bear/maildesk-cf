import { isAbsolute } from "node:path";

export type WranglerConfigFormat = "toml" | "json" | "jsonc";

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
    ? "build command runs from the repository invocation directory and must not traverse to a parent directory"
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
