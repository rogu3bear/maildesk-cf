#!/usr/bin/env python3
"""Run one admitted outer operation, then qualify and retire its compiler payload.

Invoke outside any existing reservation. Guarded descendants must settle before
the installed exclusion can be acquired. Failure evidence is retained on failure.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

import build_cache_retirement as retirement


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resource-request", required=True, help="Existing JSON resource-request file; its estimate is unchanged")
    parser.add_argument("--receipt-dir", required=True, help="Fresh directory under ignored var/proof")
    parser.add_argument("--authorization-ref", required=True)
    parser.add_argument("--protect", action="append", default=[])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = Path(args.receipt_dir).absolute()
    if "DISK_GUARD_RESERVATION" in os.environ:
        raise RuntimeError("Outer retirement workflow cannot borrow or clear an inherited reservation")
    if output.resolve() != output or not output.is_relative_to(repo / "var/proof"):
        raise RuntimeError("Fresh proof directory must be inside this repository's ignored var/proof")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise RuntimeError("An exact encompassing build/test/package command is required")
    resource = Path(args.resource_request).read_text()
    if json.loads(resource)["working_directory"] != str(repo):
        raise RuntimeError("Resource request belongs to a different checkout")
    output.mkdir(exist_ok=False)
    before = retirement.git_state(repo)
    retirement.save(output / "operation.json", {"source": before, "command": command,
        "resource_request": json.loads(resource), "authorization": args.authorization_ref})
    with (output / "operation.log").open("x") as log:
        result = subprocess.run(["disk-guard", "run", "--resource-request", resource, "--", *command],
                                cwd=repo, stdout=log, stderr=subprocess.STDOUT)
    retirement.save(output / "operation-exit.json", {"exit": result.returncode})
    if result.returncode:
        print(json.dumps({"status": "OPERATION_FAILED_CACHE_RETAINED_FOR_DIAGNOSIS", "exit": result.returncode, "proof": str(output)}))
        return result.returncode
    if retirement.git_state(repo) != before:
        raise RuntimeError("Outer operation changed source; preserve outputs for reconciliation")
    plan = output / "retirement-plan.json"
    bound = retirement.prepare(repo, Path.home() / ".config/disk-guard/policy.json", plan,
                               args.authorization_ref, args.protect)
    retired = retirement.apply(plan, bound["sha256"], output / "retirement-journal.jsonl", output / "retirement-receipt.json")
    print(json.dumps({"status": retired["status"], "retired_allocated_bytes": retired["removed_allocated_bytes"], "proof": str(output)}))
    return 0 if retired["status"] == "COMPLETE" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "HOLD", "error": str(error), "provider_details": getattr(error, "details", None)}), file=sys.stderr)
        raise SystemExit(1)
