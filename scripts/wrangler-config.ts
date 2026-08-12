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
  if (format !== "toml") {
    return jsonBuildCommandFailure(contents, format);
  }
  const buildSection = contents.match(
    /^\[build\]\s*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
  )?.[1];
  const declaration = buildSection?.match(/^\s*command\s*=\s*(.*?)\s*$/m)?.[1];
  if (!declaration) return null;

  const command = parseSingleLineTomlString(declaration);
  if (command === null) {
    return "build command must use a supported single-line TOML string";
  }
  return parentTraversalFailure(command);
}

function jsonBuildCommandFailure(
  contents: string,
  format: "json" | "jsonc",
): string | null {
  let root: unknown;
  try {
    root = format === "json" ? JSON.parse(contents) : Bun.JSONC.parse(contents);
  } catch {
    return `config must be valid ${format.toUpperCase()}`;
  }
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

function parseSingleLineTomlString(value: string): string | null {
  const basic = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
  if (basic) {
    try {
      return JSON.parse(basic[1]!) as string;
    } catch {
      return null;
    }
  }
  return value.match(/^'([^']*)'\s*(?:#.*)?$/)?.[1] ?? null;
}
