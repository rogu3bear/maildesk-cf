import { fstatSync } from "node:fs";
import type { StdioOptions } from "node:child_process";

// Optional host integration: preserve the actual locked reservation descriptor
// when a build tool starts a child. Never reopen a reservation or clear its token.
export function inheritedBuildStdio(
  base: "pipe" | "inherit" = "pipe",
  reservation = process.env.DISK_GUARD_RESERVATION,
): StdioOptions {
  if (!reservation) return base;
  let fd: unknown;
  try { fd = JSON.parse(reservation).fd; } catch { throw new Error("invalid inherited build reservation"); }
  if (!Number.isSafeInteger(fd) || (fd as number) < 3 || (fd as number) > 65535) {
    throw new Error("invalid inherited build reservation descriptor");
  }
  try { fstatSync(fd as number); } catch { throw new Error("inherited build reservation descriptor is closed"); }
  const stdio: StdioOptions = [base, base, base];
  for (let index = 3; index <= (fd as number); index++) {
    stdio[index] = index === fd ? fd as number : "ignore";
  }
  return stdio;
}
