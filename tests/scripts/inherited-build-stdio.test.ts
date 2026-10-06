import { expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { inheritedBuildStdio } from "../../scripts/inherited-build-stdio";

test("build children retain the actual inherited descriptor", () => {
  const opened = openDescriptor();
  const fd = opened.at(-1)!;
  try {
    const child = spawnSync("bun", ["-e", `require('node:fs').fstatSync(${fd}); console.log('descriptor retained')`], {
      encoding: "utf8", stdio: inheritedBuildStdio("pipe", JSON.stringify({ fd })),
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("descriptor retained");
  } finally { for (const descriptor of opened) closeSync(descriptor); }
});

test("invalid or closed reservations fail instead of stripping the token", () => {
  expect(inheritedBuildStdio("pipe", "")).toBe("pipe");
  for (const token of ["bad", '{"fd":0}', '{"fd":999999}', '{}']) {
    expect(() => inheritedBuildStdio("pipe", token)).toThrow("invalid inherited build reservation");
  }
  const opened = openDescriptor();
  const fd = opened.at(-1)!;
  for (const descriptor of opened) closeSync(descriptor);
  expect(() => inheritedBuildStdio("pipe", JSON.stringify({ fd }))).toThrow("descriptor is closed");
});

function openDescriptor(): number[] {
  const opened: number[] = [];
  // Bun's test runner may leave stdin closed; the reservation is always >= 3.
  do { opened.push(openSync(import.meta.filename, "r")); } while (opened.at(-1)! < 3);
  return opened;
}
