import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface EnvFileLoadResult {
  loaded: string[];
  failures: string[];
}

export function loadEnvFile(
  root: string,
  path: string | undefined,
  env: Record<string, string | undefined> = process.env,
): EnvFileLoadResult {
  if (!path) return { loaded: [], failures: [] };

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  if (!isInsideRoot(resolvedRoot, resolvedPath)) {
    return {
      loaded: [],
      failures: ["env file must be under repository root"],
    };
  }

  const displayPath = relativePath(resolvedRoot, resolvedPath);
  if (!existsSync(resolvedPath)) {
    return {
      loaded: [],
      failures: [`missing env file: ${displayPath}`],
    };
  }

  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
    canonicalPath = realpathSync(resolvedPath);
  } catch {
    return {
      loaded: [],
      failures: [`env file could not be resolved: ${displayPath}`],
    };
  }
  if (!isInsideRoot(canonicalRoot, canonicalPath)) {
    return {
      loaded: [],
      failures: ["env file must be under repository root"],
    };
  }

  const loaded: string[] = [];
  const failures: string[] = [];
  const lines = readFileSync(canonicalPath, "utf8").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const assignment = line.replace(/^export\s+/, "");
    const match = assignment.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      failures.push(`invalid env file assignment in ${displayPath}: line ${index + 1}`);
      continue;
    }

    const name = match[1];
    const parsedValue = parseEnvValue(match[2] ?? "", displayPath, index + 1);
    if (parsedValue.failure) {
      failures.push(parsedValue.failure);
      continue;
    }

    if (!env[name]) {
      env[name] = parsedValue.value;
      loaded.push(name);
    }
  }

  return { loaded, failures };
}

function parseEnvValue(
  rawValue: string,
  displayPath: string,
  lineNumber: number,
): { value: string; failure?: undefined } | { value?: undefined; failure: string } {
  const value = rawValue.trim();
  if (!value) return { value: "" };

  const quote = value[0];
  if (quote !== "'" && quote !== '"') return { value };
  if (value[value.length - 1] !== quote) {
    return {
      failure: `unterminated quoted value in ${displayPath}: line ${lineNumber}`,
    };
  }

  return { value: value.slice(1, -1) };
}

function isInsideRoot(root: string, path: string): boolean {
  const rootRelativePath = relative(root, path);
  return rootRelativePath === "" || (!rootRelativePath.startsWith("..") && !isAbsolute(rootRelativePath));
}

function relativePath(root: string, path: string): string {
  return relative(root, path) || ".";
}
