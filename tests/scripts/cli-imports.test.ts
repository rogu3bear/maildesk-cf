import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("importing operational scripts cannot execute a CLI, provider helper, or build", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "maildesk-script-imports-"));
  const root = resolve(import.meta.dir, "../..");
  try {
    const source = `
      import { mock } from 'bun:test';
      import { readdirSync } from 'node:fs';
      import * as child from 'node:child_process';
      import { pathToFileURL } from 'node:url';
      const forbidden = () => { throw new Error('CLI effect during import'); };
      mock.module('node:child_process', () => ({ ...child, spawn: forbidden, spawnSync: forbidden,
        exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden }));
      Bun.spawn = forbidden; Bun.spawnSync = forbidden;
      globalThis.fetch = forbidden;
      process.argv = ['bun', 'import-fixture', '--execute', '--confirm-live-send'];
      for (const name of readdirSync(${JSON.stringify(root + "/scripts")})) {
        if (/\\.(ts|mjs)$/.test(name)) await import(pathToFileURL(${JSON.stringify(root + "/scripts/")} + name).href);
      }
      console.log('imports have no execution effects');
    `;
    const result = spawnSync(process.execPath, ["--eval", source], { cwd: directory, encoding: "utf8" });
    expect(result.stderr).not.toContain("CLI effect during import");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("imports have no execution effects");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
