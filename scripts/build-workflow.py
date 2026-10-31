#!/usr/bin/env python3
"""Ordinary package workflows share one admitted compiler-cache lifetime."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import uuid

import build_cache_retirement as retirement


def command_for(name, extra):
    commands = {
        "ci": ["bash", "scripts/ci.sh"],
        "build:ui": ["bash", "scripts/build-ui-edge.sh"],
        "build:router-wasm": ["bun", "scripts/build-router-wasm.ts"],
        "build:mail-workers": ["bun", "scripts/build-mail-worker-bundles.ts"],
        "check:mail-worker-bundles": ["bun", "scripts/build-mail-worker-bundles.ts", "--check"],
        "check:ui": ["cargo", "check", "--package", "maildesk-ui", "--all-features"],
        "preflight": ["bun", "scripts/preflight.ts"],
        "test:scripts": ["bun", "test", "./tests/scripts"],
        "template": ["bash", "scripts/check-template.sh"],
        "test:workers": ["bash", "-c", "bun scripts/build-mail-worker-bundles.ts && bun test ./tests/workers \"$@\"", "maildesk-worker-tests"],
        "typecheck": ["bash", "-c", "bun scripts/build-mail-worker-bundles.ts && bun node_modules/typescript/bin/tsc -p tsconfig.workers.json --noEmit && bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json --noEmit"],
    }
    if name not in commands:
        raise RuntimeError("Unknown compiler workflow")
    if extra and name not in ("build:router-wasm", "test:workers", "test:scripts", "template", "preflight"):
        raise RuntimeError("Unexpected compiler workflow arguments")
    return commands[name] + extra


def settings(repo):
    path = repo / "var/build-cache-retirement.json"
    if not path.exists():
        return None
    value = retirement.read_plan(path)
    if value.get("schema") != "maildesk-local-cache-lifecycle/v1" or not value.get("authorization_ref", "").strip():
        raise RuntimeError("Local cache lifecycle needs its real operator instruction reference")
    resource = repo / value["resource_request"]
    if resource.resolve() != resource or not resource.is_relative_to(repo / "var"):
        raise RuntimeError("Local resource request must remain in the repository's ignored var")
    request = retirement.read_plan(resource)
    if request.get("working_directory") != str(repo):
        raise RuntimeError("Local cache lifecycle resource request belongs to another checkout")
    return value, resource, request


def enclosing_operation(repo, proof, inherited):
    path = Path(proof)
    if path.resolve() != path or not path.is_relative_to(repo / "var/proof"):
        raise RuntimeError("Enclosing operation proof belongs to another checkout")
    operation = retirement.read_plan(path / "operation.json")
    if operation["resource_request"]["working_directory"] != str(repo) or (path / "operation-exit.json").exists():
        raise RuntimeError("Enclosing operation is not a live matching lifetime")
    if retirement.read_plan(path / "reservation-binding.json") != retirement.capability_identity(inherited):
        raise RuntimeError("Enclosing operation belongs to a different admission")
    return path


def workflow(repo, name, extra, *, execute=subprocess.run, outer=None):
    command = command_for(name, extra)
    inherited = retirement.inherited_fds(os.environ)
    configured = settings(repo)
    if configured is None:
        # Preserve standalone template builds on hosts without this optional API.
        result = execute(command, cwd=repo, pass_fds=inherited, env={**os.environ, "MAILDESK_BUILD_COMPONENT": name})
        print(json.dumps({"status": "CACHE_LIFECYCLE_NOT_CONFIGURED", "operation_exit": result.returncode, "deletion_attempted": False}))
        return result.returncode
    if inherited:
        proof = os.environ.get("MAILDESK_BUILD_LIFETIME_PROOF")
        if proof:
            enclosing_operation(repo, proof, inherited)
        result = execute(command, cwd=repo, pass_fds=inherited, env={**os.environ, "MAILDESK_BUILD_COMPONENT": name})
        status = "NESTED_CONSUMER_SETTLED_OUTER_RETAINS_CACHE" if proof else "EXTERNAL_GUARD_FINALIZER_REQUIRED_CACHE_RETAINED"
        print(json.dumps({"status": status, "workflow": name, "operation_exit": result.returncode, "deletion_attempted": False}))
        return result.returncode if result.returncode or proof else 78
    if os.environ.get("MAILDESK_BUILD_LIFETIME_PROOF"):
        raise RuntimeError("Enclosing lifetime marker has no genuine inherited host capability")
    value, resource, request = configured
    if name == "build:router-wasm" and extra:
        if len(extra) != 2 or extra[0] != "--out-dir" or not Path(extra[1]).is_absolute():
            raise RuntimeError("Router output requires one explicit absolute --out-dir")
        destination = Path(extra[1]).resolve()
        if not any(destination.is_relative_to(Path(p).resolve()) for p in request["write_paths"]):
            raise RuntimeError("Router output is outside the admitted write paths")
    output = repo / "var/proof" / ("build-lifecycle-" + uuid.uuid4().hex)
    if outer is None:
        outer = runpy.run_path(str(repo / "scripts/build-and-retire.py"))["operation"]
    return outer(repo, output, value["authorization_ref"], resource.read_text(), command, ())


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("A supported compiler workflow is required")
    return workflow(Path(__file__).resolve().parents[1], sys.argv[1], sys.argv[2:])


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "CACHE_LIFECYCLE_HELD", "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
