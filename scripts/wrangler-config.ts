import { isAbsolute } from "node:path";

export function isRepositoryRelativePath(path: string): boolean {
  return !isAbsolute(path) &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !/[\0-\x1f\x7f]/.test(path) &&
    !path.split("/").some((part) => part === "." || part === ".." || part === "");
}

export function wranglerBuildCommandFailure(contents: string): string | null {
  const buildSection = contents.match(
    /^\[build\]\s*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
  )?.[1];
  const declaration = buildSection?.match(/^\s*command\s*=\s*(.*?)\s*$/m)?.[1];
  if (!declaration) return null;

  const command = parseSingleLineTomlString(declaration);
  if (command === null) {
    return "build command must use a supported single-line TOML string";
  }
  return /(^|[^A-Za-z0-9_.-])\.\.(?:[\\/]|(?=\s|$|["']))/.test(command)
    ? "build command runs from the repository invocation directory and must not traverse to a parent directory"
    : null;
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
