import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { build, version as esbuildVersion, type Metafile, type Plugin } from "esbuild";
import { buildRouterWasm } from "./build-router-wasm";

const root = resolve(import.meta.dir, "..");
const generatedRoot = join(root, "generated");
const finalWasmDirectory = join(generatedRoot, "router-wasm");
const finalWorkersDirectory = join(generatedRoot, "mail-workers");

const roles = [
  { role: "mail-router", entrypoint: "workers/mail-router/src/index.ts" },
  { role: "mail-outbound", entrypoint: "workers/mail-outbound/src/index.ts" },
] as const;

interface ManifestEntry {
  path: string;
  sha256: string;
}

interface ArtifactManifest {
  schema_version: 1;
  role: string;
  entrypoint: string;
  tools: {
    esbuild: string;
    rustc: string;
    wasm_pack: string;
  };
  inputs: ManifestEntry[];
  outputs: ManifestEntry[];
}

const checkOnly = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("usage: build-mail-worker-bundles.ts [--check]");
}

mkdirSync(generatedRoot, { recursive: true });
const staging = mkdtempSync(join(generatedRoot, ".mail-worker-bundles-"));
const stagedWasmDirectory = join(staging, "router-wasm");
const stagedWorkersDirectory = join(staging, "mail-workers");

try {
  await buildRouterWasm(stagedWasmDirectory);
  const tools = {
    esbuild: esbuildVersion,
    rustc: toolVersion("rustc", ["--version"]),
    wasm_pack: toolVersion("wasm-pack", ["--version"]),
  };
  for (const role of roles) {
    await buildRole(role, stagedWasmDirectory, stagedWorkersDirectory, tools);
  }

  if (checkOnly) {
    assertDirectoriesEqual(stagedWasmDirectory, finalWasmDirectory, "router WASM");
    assertDirectoriesEqual(stagedWorkersDirectory, finalWorkersDirectory, "mail Worker bundles");
    console.log("mail Worker bundles match the complete current source closure");
  } else {
    replaceDirectory(stagedWasmDirectory, finalWasmDirectory);
    replaceDirectory(stagedWorkersDirectory, finalWorkersDirectory);
    console.log("mail Worker bundles built from the complete current source closure");
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

async function buildRole(
  role: (typeof roles)[number],
  wasmDirectory: string,
  workersDirectory: string,
  tools: ArtifactManifest["tools"],
): Promise<void> {
  const outputDirectory = join(workersDirectory, role.role);
  mkdirSync(outputDirectory, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [role.entrypoint],
    outfile: join(outputDirectory, "index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["*.wasm"],
    legalComments: "none",
    minify: true,
    metafile: true,
    sourcemap: false,
    treeShaking: true,
    plugins: [routerWasmPlugin(wasmDirectory)],
    logLevel: "silent",
  });
  if (!result.metafile) throw new Error(`${role.role} build did not emit a dependency metafile`);

  copyFileSync(
    join(wasmDirectory, "maildesk_router_bg.wasm"),
    join(outputDirectory, "maildesk_router_bg.wasm"),
  );

  const inputs = closureInputs(result.metafile, wasmDirectory);
  const outputs = ["index.js", "maildesk_router_bg.wasm"].map((path) => ({
    path,
    sha256: sha256File(join(outputDirectory, path)),
  }));
  const manifest: ArtifactManifest = {
    schema_version: 1,
    role: role.role,
    entrypoint: role.entrypoint,
    tools,
    inputs,
    outputs,
  };
  writeFileSync(
    join(outputDirectory, "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function routerWasmPlugin(wasmDirectory: string): Plugin {
  return {
    name: "maildesk-router-wasm",
    setup(context) {
      context.onResolve(
        { filter: /generated\/router-wasm\/maildesk_router\.js$/ },
        () => ({ path: "maildesk_router.js", namespace: "maildesk-router-wasm" }),
      );
      context.onResolve(
        { filter: /^\.\//, namespace: "maildesk-router-wasm" },
        (args) => {
          const path = args.path.slice(2);
          return path.endsWith(".wasm")
            ? { path: `./${path}`, external: true }
            : { path, namespace: "maildesk-router-wasm" };
        },
      );
      context.onLoad(
        { filter: /.*/, namespace: "maildesk-router-wasm" },
        (args) => ({
          contents: readFileSync(join(wasmDirectory, args.path), "utf8"),
          loader: "js",
          resolveDir: wasmDirectory,
        }),
      );
    },
  };
}

function closureInputs(metafile: Metafile, wasmDirectory: string): ManifestEntry[] {
  const paths = new Map<string, string>();
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith("maildesk-router-wasm:")) {
      const name = input.slice("maildesk-router-wasm:".length);
      paths.set(`generated/router-wasm/${name}`, join(wasmDirectory, name));
      continue;
    }
    const absolute = isAbsolute(input) ? input : resolve(root, input);
    const logical = repositoryRelative(absolute);
    paths.set(logical, absolute);
  }
  paths.set(
    "generated/router-wasm/maildesk_router_bg.wasm",
    join(wasmDirectory, "maildesk_router_bg.wasm"),
  );
  for (const path of rustBuildInputs()) paths.set(path, join(root, path));
  return [...paths]
    .map(([path, absolute]) => ({ path, sha256: sha256File(absolute) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function rustBuildInputs(): string[] {
  const fixed = [
    "Cargo.lock",
    "Cargo.toml",
    "crates/maildesk-router/Cargo.toml",
    "scripts/build-mail-worker-bundles.ts",
    "scripts/build-router-wasm.ts",
  ];
  return [...fixed, ...regularFiles(join(root, "crates/maildesk-router/src"))]
    .map((path) => isAbsolute(path) ? repositoryRelative(path) : path)
    .sort();
}

function regularFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`unsupported Rust source entry ${repositoryRelative(path)}`);
  }
  return files;
}

function repositoryRelative(path: string): string {
  const value = relative(root, resolve(path)).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) {
    throw new Error(`bundle dependency escaped the Maildesk repository: ${basename(path)}`);
  }
  return value;
}

function sha256File(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`${repositoryRelative(path)} is not a regular file`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function toolVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} version probe failed`);
  const value = result.stdout.trim();
  if (!value || value.includes("\n")) throw new Error(`${command} version probe was malformed`);
  return value;
}

function replaceDirectory(source: string, destination: string): void {
  const backup = `${destination}.previous`;
  rmSync(backup, { recursive: true, force: true });
  if (exists(destination)) renameSync(destination, backup);
  try {
    renameSync(source, destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!exists(destination) && exists(backup)) renameSync(backup, destination);
    throw error;
  }
}

function assertDirectoriesEqual(expected: string, actual: string, label: string): void {
  if (!exists(actual)) throw new Error(`${label} is missing; run bun run build:mail-workers`);
  const expectedFiles = regularFiles(expected).map((path) => relative(expected, path).split(sep).join("/")).sort();
  const actualFiles = regularFiles(actual).map((path) => relative(actual, path).split(sep).join("/")).sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(`${label} file set drifted; run bun run build:mail-workers`);
  }
  for (const path of expectedFiles) {
    if (sha256File(join(expected, path)) !== sha256File(join(actual, path))) {
      throw new Error(`${label} file ${path} drifted; run bun run build:mail-workers`);
    }
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
