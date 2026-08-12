import { isAbsolute } from "node:path";

export function isRepositoryRelativePath(path: string): boolean {
  return !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === ".." || part === "");
}

export function wranglerBuildCommandFailure(contents: string): string | null {
  const command = contents.match(/^\[build\]\s*$[\s\S]*?^command\s*=\s*"([^"]+)"\s*$/m)?.[1];
  return command && /(^|[\s"'])\.\.\//.test(command)
    ? "build command runs from the repository invocation directory and must not traverse to a parent directory"
    : null;
}
