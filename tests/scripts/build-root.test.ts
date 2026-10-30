import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalCargoEnvironment } from "../../scripts/build-root";

const root = resolve(import.meta.dir, "../..");

test("canonical build environment preserves host reservations and separates final products", () => {
  const env = canonicalCargoEnvironment(root, { DISK_GUARD_RESERVATION: "opaque inherited token", OTHER: "retained" });
  expect(env.CARGO_TARGET_DIR).toBe(join(root, "target"));
  expect(env.DISK_GUARD_RESERVATION).toBe("opaque inherited token");
  expect(env.OTHER).toBe("retained");
  expect(canonicalCargoEnvironment(root, { CARGO_TARGET_DIR: "target" }).CARGO_TARGET_DIR).toBe(join(root, "target"));
});

test("conflicting target or intermediate environment roots refuse instead of being overwritten", () => {
  for (const key of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"]) {
    for (const value of ["target/front", "../other-target", ""]) {
      expect(() => canonicalCargoEnvironment(root, { [key]: value })).toThrow("different compiler root");
    }
  }
});

test("a target symlink cannot redirect an entrypoint to another output envelope", () => {
  const fixture = mkdtempSync(join(tmpdir(), "maildesk-root-contract-"));
  try {
    const project = join(fixture, "project");
    const other = join(fixture, "other");
    mkdirSync(project); mkdirSync(other);
    symlinkSync(other, join(project, "target"));
    expect(() => canonicalCargoEnvironment(project, {})).toThrow("real target directory");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("workspace and build dependencies use disposable dev and test compiler profiles", () => {
  const manifest = Bun.TOML.parse(readFileSync(join(root, "Cargo.toml"), "utf8")) as any;
  for (const name of ["dev", "test"]) {
    expect(manifest.profile[name]).toMatchObject({ debug: 0, incremental: false, strip: "none" });
    expect(manifest.profile[name]["build-override"]).toMatchObject({ debug: 0, strip: "none" });
  }
  expect(manifest.package.metadata.leptos["front-target-dir"]).toBe("CARGO_TARGET_DIR");
  expect(manifest.package.metadata.leptos).not.toHaveProperty("separate-front-target-dir");
  const config = Bun.TOML.parse(readFileSync(join(root, ".cargo/config.toml"), "utf8")) as any;
  expect(config.build["target-dir"]).toBe("target");
});
