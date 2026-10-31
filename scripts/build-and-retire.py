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
import hashlib
import runpy
import time

import build_cache_retirement as retirement
import build_settlement as settlement


def profile_for(repo, command):
    factory = runpy.run_path(str(repo / "scripts/build-workflow.py"))["command_for"]
    for name in ("ci", "build:ui", "build:router-wasm", "build:mail-workers", "check:mail-worker-bundles",
                 "check:ui", "preflight", "test:scripts", "test:workers", "typecheck", "template"):
        base = factory(name, [])
        if command == base:
            return name
        extra = command[len(base):]
        if command[:len(base)] == base and (name == "template" and extra == ["--reuse-worker-bundles"] or
                name == "test:scripts" and len(extra) == 2 and extra[0] == "--test-name-pattern" or
                name == "preflight" and extra in (["--mode", "template"], ["--mode", "production"],
                    ["--mode", "production", "--control-plane", "emergency-api"])):
            return name
    return None


def operation(repo, output, authorization, resource, command, keep, *, policy=None, supervise=settlement.run, pin_dispositions=()):
    """The production CLI fixes repo/policy; disposable fixtures inject their own."""
    if repo.resolve() != repo or output.resolve() != output or not output.is_relative_to(repo / "var/proof"):
        raise RuntimeError("Operation proof must remain in the canonical repository's ignored var/proof")
    if json.loads(resource)["working_directory"] != str(repo):
        raise RuntimeError("Resource request belongs to a different checkout")
    output.mkdir(mode=0o700, exist_ok=False)
    before = retirement.git_state(repo)
    profile = profile_for(repo, command)
    approved_pins = json.loads(json.dumps(list(pin_dispositions)))
    environment = dict(os.environ)
    component = {"scripts/ci.sh": "ci", "scripts/build-ui-edge.sh": "build:ui", "scripts/check-template.sh": "template"}.get(command[1] if len(command) > 1 and command[0] == "bash" else "", "composition")
    environment.update(MAILDESK_BUILD_LIFETIME_PROOF=str(output), MAILDESK_BUILD_COMPONENT=component)
    retirement.save(output / "operation.json", {"source": before, "command": command,
        "resource_request": json.loads(resource), "resource_request_sha256": hashlib.sha256(resource.encode()).hexdigest(),
        "authorization": authorization, "consumer_profile": profile, "approved_pin_dispositions": approved_pins,
        "environment_sha256": hashlib.sha256(json.dumps(environment, sort_keys=True).encode()).hexdigest(),
        "environment_names": sorted(environment),
        "finalizer_sha256": {name: retirement.sha(repo / "scripts" / name) for name in
            ("build-and-retire.py", "build-workflow.py", "build_cache_retirement.py", "build_readers.py", "build_settlement.py")},
        "retained_obligations": ["source and dirty bytes", "sessions", "locks", "products and releases", "failure diagnostics", "proof", "unknowns"]})
    inner = [sys.executable, "-B", str(Path(__file__).resolve()), "--inner", str(output), "--", *command]
    code, settled = supervise(["disk-guard", "run", "--resource-request", resource, "--", *inner],
        cwd=repo, env=environment,
        output=output, read_record=retirement.read_plan)
    retirement.save(output / "operation-exit.json", {"exit": code})
    if code:
        print(json.dumps({"status": "OPERATION_FAILED_CACHE_RETAINED_FOR_DIAGNOSIS", "exit": code, "proof": str(output)}))
        return code
    if settled["status"] != "SETTLED" or profile is None:
        print(json.dumps({"status": "CACHE_RETAINED_SETTLEMENT_UNPROVED" if profile else "CACHE_RETAINED_UNQUALIFIED_CONSUMER_CHAIN", "proof": str(output)}))
        return 78
    if retirement.git_state(repo) != before:
        raise RuntimeError("Outer operation changed source; preserve outputs for reconciliation")
    plan = output / "retirement-plan.json"
    bound = retirement.prepare(repo, policy or Path.home() / ".config/disk-guard/policy.json", plan, authorization, keep,
                               released_pins=approved_pins)
    retired = retirement.apply(plan, bound["sha256"], output / "retirement-journal.jsonl", output / "retirement-receipt.json")
    print(json.dumps({"status": retired["status"], "retired_allocated_bytes": retired["removed_allocated_bytes"], "proof": str(output)}))
    return 0 if retired["status"] == "COMPLETE" else 1


def inner():
    output = Path(sys.argv[2]); command = sys.argv[4:]
    repo = Path(__file__).resolve().parents[1]
    if (sys.argv[3] != "--" or not command or output.resolve() != output or
            not output.is_relative_to(repo / "var/proof") or os.environ.get("MAILDESK_BUILD_LIFETIME_PROOF") != str(output)):
        raise RuntimeError("Inner operation does not match its enclosing lifetime")
    operation = retirement.read_plan(output / "operation.json")
    if operation["command"] != command or operation["resource_request"]["working_directory"] != str(repo):
        raise RuntimeError("Inner command changed")
    if retirement.git_state(repo) != operation["source"]:
        raise RuntimeError("Source changed before launch acknowledgement")
    fds = retirement.inherited_fds(os.environ)
    if not fds:
        raise RuntimeError("Inner operation has no genuine inherited admission")
    capability = retirement.capability_identity(fds)
    record = os.pread(fds[0], 16385, 0)
    if len(record) > 16384:
        raise RuntimeError("Reservation record exceeds its qualified bound")
    state = Path(json.loads((Path.home() / ".config/disk-guard/policy.json").read_bytes())["state_dir"])
    binding = {"capability": capability, "inner_generation": settlement.Processes().get(os.getpid()),
               "reservation_path": str(state / ("reservation-" + capability["reservation_id"] + ".json")),
               "reservation_record_sha256": hashlib.sha256(record).hexdigest()}
    settlement.atomic_save(output / "reservation-binding.json", binding)
    deadline = time.monotonic() + 10
    while not (output / "launch-acknowledgement.json").exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Outer owner did not acknowledge the exact live generation and lease")
        time.sleep(0.02)
    if retirement.read_plan(output / "launch-acknowledgement.json")["binding_sha256"] != retirement.sha(output / "reservation-binding.json"):
        raise RuntimeError("Launch acknowledgement belongs to another binding")
    for fd in fds:
        os.set_inheritable(fd, True)
    os.execvpe(command[0], command, os.environ)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resource-request", required=True, help="Existing JSON resource-request file; its estimate is unchanged")
    parser.add_argument("--receipt-dir", required=True, help="Fresh directory under ignored var/proof")
    parser.add_argument("--authorization-ref", required=True)
    parser.add_argument("--protect", action="append", default=[])
    parser.add_argument("--pin-dispositions", help="Owned JSON array of independently authorized exact pin dispositions")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = Path(args.receipt_dir).absolute()
    if any(k in os.environ for k in ("DISK_GUARD_RESERVATION", "DISK_GUARD_CUSTODY")):
        raise RuntimeError("Outer retirement workflow cannot borrow or clear an inherited reservation")
    if output.resolve() != output or not output.is_relative_to(repo / "var/proof"):
        raise RuntimeError("Fresh proof directory must be inside this repository's ignored var/proof")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise RuntimeError("An exact encompassing build/test/package command is required")
    return operation(repo, output, args.authorization_ref, Path(args.resource_request).read_text(), command, args.protect,
                     pin_dispositions=retirement.read_plan(args.pin_dispositions) if args.pin_dispositions else [])


if __name__ == "__main__":
    try:
        raise SystemExit(inner() if sys.argv[1:2] == ["--inner"] else main())
    except Exception as error:
        print(json.dumps({"status": "HOLD", "error": str(error), "provider_details": getattr(error, "details", None)}), file=sys.stderr)
        raise SystemExit(1)
