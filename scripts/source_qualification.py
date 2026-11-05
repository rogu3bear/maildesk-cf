"""Bindings for the prospective Maildesk-only source qualification.

No function in this module grants publication authority. Unclassified
environment values are included in the digest, never presumed immaterial.
"""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path, PurePosixPath

REQUIRED_TOOLS = frozenset(("bash", "python", "bun", "cargo", "rustc", "wasm_pack", "wasm_bindgen",
                            "cargo_leptos", "worker_build", "clang", "apple_sdk", "git", "awk", "xcrun", "rustup", "node", "shell_tools", "system"))
REQUIRED_PRODUCTS = frozenset(("mail_router", "mail_outbound", "mail_canary", "mail_heartbeat", "mail_mcp",
                               "router_wasm", "ui_worker", "ui_site"))


DISPATCHER_FILES = {
    "hooks.py": "995c3fd35af52fbd25d38646f1ab8c91965d1c9b5ee75d435f5ea54a4f6035b9",
    "runner.py": "b003189b8fa74eea51eb3531f9ef116296b6e03f9e0012e3fad542538ae062c0",
    "lefthook.yml": "53af7cd5b8ba54bbfda33272fb6ed380129ee6bff8c400591d84a1f2369a3661",
    "core.py": "921539bd780e43d1f8053de3da58fd30618ceb3007a828ec58edb03763599d53",
    "vendor/lefthook": "22881605cdf99b3d7da67005d6a08d4bb90fed4730dde6e2d39e316750be1afe",
}


def same_bindings(expected, observed):
    """Compare complete binding shapes; this does not authenticate a receipt.

    Callers must separately prove capture provenance, coverage, settlement,
    independent acceptance, and the authority of the expected values.
    """
    keys = {"head", "tree", "environment", "ci_script", "dependency_resolution", "toolchain", "products"}
    def valid(value):
        if not isinstance(value, dict) or set(value) != keys:
            return False
        if any(not isinstance(value[k], str) or not re.fullmatch(r"[0-9a-f]{40}", value[k]) for k in ("head", "tree")):
            return False
        if any(not isinstance(value[k], str) or not re.fullmatch(r"[0-9a-f]{64}", value[k]) for k in ("environment", "ci_script")):
            return False
        for key, required in (("dependency_resolution", {"bun", "cargo"}),
                              ("toolchain", REQUIRED_TOOLS), ("products", REQUIRED_PRODUCTS)):
            group = value[key]
            if not isinstance(group, dict) or set(group) != required or any(
                    not isinstance(item, str) or not re.fullmatch(r"[0-9a-f]{64}", item) for item in group.values()):
                return False
        return True
    return valid(expected) and valid(observed) and expected == observed


def object_sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def bytes_sha256(value):
    return hashlib.sha256(value).hexdigest()


def strict_object(data):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result
    value = json.loads(data, object_pairs_hook=unique_pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid JSON constant")))
    if not isinstance(value, dict):
        raise ValueError("JSON record must be an object")
    return value


def check_evidence(capture, lifecycle, review, approval, observed, target_ref, incident_sha256):
    """Compare already-authenticated records; this function supplies no trust anchor.

    The caller must establish ownership of the operator approval, pin the
    independent review and incident receipt, and independently verify that the
    lifecycle and capture records were produced by the named run. Untrusted
    matching JSON is not a qualification or an approval.
    """
    expected_keys = (
        {"schema", "bindings", "input_sha256"},
        {"schema", "status", "head", "tree", "capture_sha256", "operation_sha256", "settlement_sha256", "exit_sha256"},
        {"schema", "verdict", "scope", "reviewer", "head", "tree", "capture_sha256", "lifecycle_sha256"},
        {"schema", "incident_status", "incident_sha256", "head", "tree", "target_ref", "capture_sha256",
         "lifecycle_sha256", "review_sha256", "operator_ref", "source_writer", "publication_environment"},
    )
    records = (capture, lifecycle, review, approval)
    if any(not isinstance(record, dict) or set(record) != keys for record, keys in zip(records, expected_keys)):
        return False
    if (capture["schema"] != "maildesk-source-capture/v1" or
        lifecycle["schema"] != "maildesk-source-lifecycle/v1" or lifecycle["status"] != "SETTLED_CACHE_RETAINED" or
        review["schema"] != "maildesk-source-review/v1" or review["verdict"] != "ACCEPT" or review["scope"] != "source_publication_only" or
        approval["schema"] != "maildesk-source-publication-approval/v1" or
        approval["incident_status"] != "UNKNOWN_CACHE_RETAINED"):
        return False
    if not same_bindings(capture["bindings"], observed):
        return False
    if not isinstance(capture["input_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", capture["input_sha256"]):
        return False
    if any(record["head"] != observed["head"] or record["tree"] != observed["tree"] for record in (lifecycle, review, approval)):
        return False
    if any(not isinstance(record[key], str) or not re.fullmatch(r"[0-9a-f]{64}", record[key])
           for record, key in ((lifecycle, "operation_sha256"), (lifecycle, "settlement_sha256"), (lifecycle, "exit_sha256"))):
        return False
    if not all(isinstance(record[key], str) and record[key].strip() for record, key in
               ((review, "reviewer"), (approval, "operator_ref"), (approval, "source_writer"))):
        return False
    if review["reviewer"] == approval["source_writer"]:
        return False
    capture_hash, lifecycle_hash = object_sha256(capture), object_sha256(lifecycle)
    return (all(record["capture_sha256"] == capture_hash for record in (lifecycle, review, approval)) and
            review["lifecycle_sha256"] == approval["lifecycle_sha256"] == lifecycle_hash and
            approval["review_sha256"] == object_sha256(review) and
            isinstance(incident_sha256, str) and bool(re.fullmatch(r"[0-9a-f]{64}", incident_sha256)) and approval["incident_sha256"] == incident_sha256 and
            isinstance(target_ref, str) and target_ref.startswith("refs/heads/") and approval["target_ref"] == target_ref)


def check_run_receipts(operation, settlement, exit_record, head):
    """Check required facts in authenticated run receipts, not their origin."""
    if not all(isinstance(value, dict) for value in (operation, settlement, exit_record)):
        return False
    source = operation.get("source")
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head) or not isinstance(source, dict):
        return False
    streams = settlement.get("stream_eof")
    if not isinstance(streams, list) or len(streams) != 2 or not all(isinstance(item, str) for item in streams) or set(streams) != {"stdout", "stderr"}:
        return False
    return (operation.get("command") == ["bash", "scripts/ci.sh"] and operation.get("consumer_profile") == "ci" and
            operation.get("retained_qualification") is True and
            source.get("head") == head and source.get("status") == "" and
            set(exit_record) == {"exit"} and type(exit_record["exit"]) is int and exit_record["exit"] == 0 and
            settlement.get("status") == "SETTLED" and type(settlement.get("command_exit")) is int and
            settlement["command_exit"] == 0 and settlement.get("errors") == [] and
            settlement.get("live_generations") == [] and
            settlement.get("exact_reservation_released") is True and
            settlement.get("launch_acknowledged") is True and settlement.get("owner_outside_reservation") is True)


def check_chain(capture, lifecycle, review, approval, operation_bytes, settlement_bytes, inputs_bytes, exit_bytes,
                observed, target_ref, incident_sha256, approved_pin, review_pin):
    """Check a caller-pinned approval and its complete qualification chain.

    The pin must come from a separately controlled operator authorization;
    passing a digest supplied by the same untrusted JSON is not authorization.
    The caller must collect ``observed`` from actual current inputs and must
    authenticate the historical incident receipt separately.
    """
    if any(not isinstance(pin, str) or not re.fullmatch(r"[0-9a-f]{64}", pin) for pin in (approved_pin, review_pin)):
        return False
    try:
        operation = strict_object(operation_bytes)
        settlement = strict_object(settlement_bytes)
        inputs = strict_object(inputs_bytes)
        exit_record = strict_object(exit_bytes)
        return (object_sha256(approval) == approved_pin and object_sha256(review) == review_pin and
                check_evidence(capture, lifecycle, review, approval, observed, target_ref, incident_sha256) and
                lifecycle["operation_sha256"] == bytes_sha256(operation_bytes) and
                lifecycle["settlement_sha256"] == bytes_sha256(settlement_bytes) and
                lifecycle["exit_sha256"] == bytes_sha256(exit_bytes) and
                capture["input_sha256"] == bytes_sha256(inputs_bytes) and
                set(inputs) == {"schema", "bindings"} and inputs["schema"] == "maildesk-source-inputs/v1" and
                inputs["bindings"] == {key: value for key, value in capture["bindings"].items() if key != "products"} and
                check_run_receipts(operation, settlement, exit_record, observed["head"]))
    except (TypeError, ValueError, KeyError):
        return False


def check_push(stdin_text, head, target_ref, expected_remote, *, ancestry_proved):
    """Admit one exact branch update; force and deletion are not inferred safe."""
    if ancestry_proved is not True or not all(isinstance(value, str) for value in (stdin_text, head, target_ref, expected_remote)):
        return False
    if (not re.fullmatch(r"[0-9a-f]{40}", head) or head == "0" * 40 or
            not re.fullmatch(r"[0-9a-f]{40}", expected_remote) or expected_remote == "0" * 40):
        return False
    if not re.fullmatch(r"refs/heads/[A-Za-z0-9._/-]+", target_ref):
        return False
    lines = stdin_text.splitlines()
    if len(lines) != 1:
        return False
    fields = lines[0].split()
    return fields == [target_ref, head, target_ref, expected_remote]


def read_approval(path):
    """Read one operator-owned approval; caller must still verify its trust pin."""
    path = Path(path)
    if not path.is_absolute() or path.parent.resolve(strict=True) != path.parent:
        raise ValueError("approval path must be canonical")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536):
                raise ValueError("approval must be an owner-only regular file")
            data = os.read(fd, 65537)
            after = os.fstat(fd)
            if len(data) != info.st_size or (info.st_ino, info.st_dev, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
                    after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("approval changed while read")
        finally:
            os.close(fd)
    except OSError as error:
        raise ValueError("approval is unavailable or is a symbolic link") from error
    try:
        value = strict_object(data)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("approval is not strict JSON") from error
    return value


def read_proof(repo, relative):
    """Read one bounded repository proof without following path links."""
    path = PurePosixPath(relative)
    if (path.is_absolute() or not path.parts or str(path) != relative or any(part in (".", "..") for part in path.parts)
            or path.parts[:2] != ("var", "proof")):
        raise ValueError("proof path is outside the repository proof root")
    descriptors = []
    try:
        directory = os.open(repo, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for component in path.parts[:-1]:
            directory = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(directory)
        fd = os.open(path.parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        descriptors.append(fd)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size > 2_000_000:
            raise ValueError("proof must be a bounded owned regular file")
        chunks, remaining = [], before.st_size
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                raise ValueError("proof is truncated")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("proof changed while read")
        return b"".join(chunks)
    except OSError as error:
        raise ValueError("proof is unavailable or has a symbolic-link component") from error
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def environment_binding(environment, *, ci_child=False):
    """Hash the complete environment except lifecycle-owned CI markers.

    The enclosing lifecycle sets these markers itself for its CI child. Their
    values must not be accepted as evidence of a live lifecycle or admission.
    Every other name and value remains bound, so an unreviewed difference holds.
    """
    markers = ("MAILDESK_BUILD_LIFETIME_PROOF", "MAILDESK_BUILD_COMPONENT", "MAILDESK_SOURCE_QUALIFICATION",
               "DISK_GUARD_RESERVATION", "DISK_GUARD_CUSTODY")
    if ci_child:
        if (not environment.get(markers[0]) or environment.get(markers[1]) != "ci" or environment.get(markers[2]) != "1" or
                not any(environment.get(key) for key in markers[3:])):
            raise ValueError("CI child markers are invalid")
    elif any(key in environment for key in markers):
        raise ValueError("lifecycle markers cannot authorize publication")
    projection = {key: value for key, value in environment.items() if key not in markers}
    encoded = json.dumps(projection, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return {"schema": "maildesk-source-environment/v1", "sha256": hashlib.sha256(encoded).hexdigest()}


def publication_environment_binding(environment, *, repo, remote_name, remote_url, include_components=False):
    """Bind the admitted job and all controls, omitting only its output path.

    This validates a fixed installed dispatcher contract; it does not prove
    dispatch. The independent global hook-chain check supplies that boundary.
    """
    repo = Path(repo)
    release = Path.home() / ".codex/hooks/releases/1.0.3"
    if file_bindings(release, list(DISPATCHER_FILES)) != DISPATCHER_FILES:
        raise ValueError("installed dispatcher contract changed")
    controls = {"LEFTHOOK_CONFIG": str(release / "lefthook.yml"), "LEFTHOOK_OUTPUT": "failure,execution",
                "LEFTHOOK_EXCLUDE": "", "OPS_HOOK_WORKER": str(release / "hooks.py"),
                "OPS_HOOK_PYTHON": "/opt/homebrew/opt/python@3.14/bin/python3.14", "PYTHONDONTWRITEBYTECODE": "1"}
    if any(environment.get(name) != expected for name, expected in controls.items()):
        raise ValueError("installed dispatcher controls do not match the reviewed contract")
    job_text = environment.get("OPS_HOOK_JOB")
    if not isinstance(job_text, str) or len(job_text.encode()) > 65536:
        raise ValueError("dispatcher job is unavailable or too large")
    job = strict_object(job_text)
    if set(job) != {"kind", "path", "digest", "args", "result_path"}:
        raise ValueError("dispatcher job schema changed")
    hook = repo / ".githooks/pre-push"
    hook_digest = file_bindings(repo, [".githooks/pre-push"])[".githooks/pre-push"]
    if (job["kind"] != "gate" or job["path"] != str(hook) or job["digest"] != hook_digest or
            job["args"] != [remote_name, remote_url]):
        raise ValueError("dispatcher job does not match the selected hook and push")
    result = job["result_path"]
    if not isinstance(result, str):
        raise ValueError("dispatcher result path is invalid")
    path = Path(result)
    if (not path.is_absolute() or path.name != "result.json" or not re.fullmatch(r"ops-hooks-[a-z0-9_]{8}", path.parent.name) or
            path.parent.parent != Path(tempfile.gettempdir()) or path.parent.is_symlink() or
            path.parent.resolve(strict=True).parent != Path(tempfile.gettempdir()).resolve(strict=True) or
            path.exists() or path.is_symlink()):
        raise ValueError("dispatcher result path is outside the temporary result scope")
    info = path.parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("dispatcher result directory is not owner-only")
    projected = {key: value for key, value in environment.items()
                 if key not in {"SHLVL", "_", "OLDPWD", "NO_COLOR", "OPS_HOOK_JOB"}}
    projected["OPS_HOOK_JOB"] = json.dumps({key: value for key, value in job.items() if key != "result_path"},
                                           sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    binding = {"schema": "maildesk-publication-environment/v1", "sha256": environment_binding(projected)["sha256"]}
    if include_components:
        if (len(projected) > 256 or any(not isinstance(key, str) or not isinstance(value, str) or
                len(key.encode()) > 256 or len(value.encode()) > 65536 or
                any(ord(ch) < 32 or ord(ch) == 127 for ch in key) for key, value in projected.items()) or
                len(json.dumps(projected, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()) > 1_048_576):
            raise ValueError("diagnostic projection exceeds its bounds")
        binding["value_sha256"] = {key: bytes_sha256(value.encode()) for key, value in sorted(projected.items())}
    return binding


def diagnostic_requested(repo, environment):
    """Read a local opt-in; any ambiguous setting holds rather than publishing."""
    try:
        raw = _command(["git", "config", "--local", "--get-all", "maildesk.sourcePublicationDiagnostic"],
                       cwd=repo, environment=environment)
    except subprocess.CalledProcessError as error:
        if error.returncode == 1 and not error.stdout:
            return False
        raise ValueError("diagnostic setting unavailable") from error
    values = raw.decode().splitlines()
    if not values:
        return False
    if values != ["true"]:
        raise ValueError("diagnostic setting must be exactly one true value")
    return True


def file_bindings(root, paths):
    """Hash an explicit, nonempty set of regular files without following links."""
    root = Path(root).resolve(strict=True)
    if not paths or len(set(paths)) != len(paths):
        raise ValueError("artifact paths must be nonempty and unique")
    result = {}
    for name in sorted(paths):
        path = PurePosixPath(name)
        if path.is_absolute() or not path.parts or str(path) != name or any(part in (".", "..") for part in path.parts):
            raise ValueError("artifact path must be relative to the qualification root")
        descriptors = []
        try:
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.append(directory)
            for component in path.parts[:-1]:
                directory = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                descriptors.append(directory)
            fd = os.open(path.parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise ValueError("artifact must be a regular file")
            digest = hashlib.sha256()
            while chunk := os.read(fd, 1024 * 1024):
                digest.update(chunk)
            after = os.fstat(fd)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("artifact changed while it was read")
            result[name] = digest.hexdigest()
        except OSError as error:
            raise ValueError("artifact is unavailable or has a symbolic-link component") from error
        finally:
            for fd in reversed(descriptors):
                os.close(fd)
    return result


def tree_binding(root):
    """Bind a stable inventory, including links confined within the tree.

    This is not an archive or a writer exclusion. Callers must independently
    establish output custody for the entire observation.
    """
    root = Path(root)
    if not root.is_absolute() or root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("tree root must be a canonical directory")
    def inventory():
        files, directories, links = {}, {}, {}
        def error(problem):
            raise problem
        for current, dirnames, filenames in os.walk(root, followlinks=False, onerror=error):
            directory = Path(current)
            meta = directory.lstat()
            if not stat.S_ISDIR(meta.st_mode):
                raise ValueError("tree directory is unavailable")
            relative = directory.relative_to(root).as_posix()
            directories[relative] = (meta.st_dev, meta.st_ino, meta.st_mtime_ns, meta.st_ctime_ns, stat.S_IMODE(meta.st_mode))
            for name in list(dirnames) + filenames:
                entry = directory / name
                entry_meta = entry.lstat()
                mode = entry_meta.st_mode
                if stat.S_ISLNK(mode):
                    target = entry.resolve(strict=False)
                    if not target.is_relative_to(root):
                        raise ValueError("tree link escapes the bound root")
                    links[entry.relative_to(root).as_posix()] = (os.readlink(entry), target.relative_to(root).as_posix(), target.exists(),
                        entry_meta.st_dev, entry_meta.st_ino, entry_meta.st_mtime_ns, entry_meta.st_ctime_ns)
                    if name in dirnames:
                        dirnames.remove(name)
                elif stat.S_ISREG(mode):
                    files[entry.relative_to(root).as_posix()] = (entry_meta.st_dev, entry_meta.st_ino,
                        entry_meta.st_size, entry_meta.st_mtime_ns, entry_meta.st_ctime_ns, stat.S_IMODE(mode))
                elif not stat.S_ISDIR(mode):
                    raise ValueError("tree contains a non-regular entry")
        return files, directories, links
    try:
        entries, directories, links = inventory()
        files = file_bindings(root, list(entries)) if entries else {}
        after_entries, after_directories, after_links = inventory()
    except OSError as error:
        raise ValueError("tree inventory is unavailable") from error
    if entries != after_entries or directories != after_directories or links != after_links:
        raise ValueError("tree inventory changed while read")
    return object_sha256({"directories": {name: value[-1] for name, value in sorted(directories.items())},
                          "files": {name: {"sha256": digest, "mode": entries[name][-1]} for name, digest in files.items()},
                          "links": {name: value[:3] for name, value in sorted(links.items())}})


def _command(argv, *, cwd, environment):
    result = subprocess.run(argv, cwd=cwd, env=environment, capture_output=True, check=True, timeout=120)
    return result.stdout


def _executable_binding(path):
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise ValueError("required tool is unavailable")
    digest = file_bindings(Path("/"), [resolved.as_posix().lstrip("/")])[resolved.as_posix().lstrip("/")]
    return object_sha256({"path": str(resolved), "sha256": digest})


def capture_current(repo, environment, *, ci_child=False, include_products=True):
    """Collect exact candidate and current inputs; caller owns stable custody.

    No network access or build is performed. Cargo resolution is offline and
    locked. Full tree observations can be expensive and are not a substitute
    for output exclusion, a run-bound capture, or independent review.
    """
    repo = Path(repo)
    if not repo.is_absolute() or repo.resolve(strict=True) != repo:
        raise ValueError("repository path must be canonical")
    unsupported = {"RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
                   "CC", "CXX", "AR", "LD", "NODE_OPTIONS", "PYTHONPATH", "XDG_CACHE_HOME"}
    if any(key in environment for key in unsupported) or any(
            key.startswith(("CARGO_BUILD_", "CARGO_PROFILE_", "CARGO_TARGET_")) and key != "CARGO_TARGET_DIR" for key in environment):
        raise ValueError("unmodeled build or tool override requires a reviewed collector")
    git_env = {key: value for key, value in environment.items() if not key.startswith("GIT_")}
    def run(argv, env=environment):
        return _command(argv, cwd=repo, environment=env)
    head = run(["git", "rev-parse", "HEAD"], git_env).decode().strip()
    tree = run(["git", "rev-parse", "HEAD^{tree}"], git_env).decode().strip()
    if run(["git", "status", "--porcelain=v1", "--untracked-files=all"], git_env):
        raise ValueError("source candidate must be clean")
    projected_environment = dict(environment)
    target = str(repo / "target")
    if ci_child and projected_environment.get("CARGO_TARGET_DIR") != target:
        raise ValueError("CI compiler target is not the canonical root")
    if "CARGO_TARGET_DIR" in projected_environment and projected_environment["CARGO_TARGET_DIR"] != target:
        raise ValueError("compiler target differs from the canonical root")
    # CI itself unconditionally selects this exact root; no other target or
    # compiler environment override is treated as equivalent.
    projected_environment.pop("CARGO_TARGET_DIR", None)
    env_binding = environment_binding(projected_environment, ci_child=ci_child)["sha256"]
    ci_hash = file_bindings(repo, ["scripts/ci.sh"])["scripts/ci.sh"]
    node_resolution = tree_binding(repo / "node_modules")
    metadata = strict_object(run(["cargo", "metadata", "--locked", "--offline", "--format-version=1"]))
    packages = metadata.get("packages")
    if not isinstance(packages, list) or not packages or not isinstance(metadata.get("resolve"), dict):
        raise ValueError("locked Cargo resolution is incomplete")
    external = {}
    for package in packages:
        if not isinstance(package, dict) or not isinstance(package.get("id"), str) or not isinstance(package.get("manifest_path"), str):
            raise ValueError("Cargo package identity is invalid")
        source_root = Path(package["manifest_path"]).parent.resolve(strict=True)
        if package.get("source") is None:
            if not source_root.is_relative_to(repo):
                raise ValueError("unbound external path dependency")
        else:
            external[package["id"]] = {"path": str(source_root), "tree": tree_binding(source_root)}
    cargo_home = Path(environment.get("CARGO_HOME", str(Path(environment.get("HOME", "")) / ".cargo")))
    if not cargo_home.is_absolute() or cargo_home.resolve(strict=True) != cargo_home:
        raise ValueError("Cargo home is unavailable or noncanonical")
    config_paths = [cargo_home / "config", cargo_home / "config.toml"]
    config_paths.extend(parent / ".cargo" / name for parent in (repo, *repo.parents) for name in ("config", "config.toml"))
    configs = {}
    for path in sorted(set(config_paths)):
        if path.is_symlink():
            raise ValueError("Cargo configuration is a symbolic link")
        if path.exists():
            resolved = path.resolve(strict=True)
            if resolved != path:
                raise ValueError("Cargo configuration path is noncanonical")
            configs[str(path)] = file_bindings(Path("/"), [path.as_posix().lstrip("/")])[path.as_posix().lstrip("/")]
        else:
            configs[str(path)] = None
    cargo_resolution = object_sha256({"metadata": metadata, "external_sources": external, "configs": configs})
    def executable(name):
        path = shutil.which(name, path=environment.get("PATH"))
        if not path:
            raise ValueError("required tool is unavailable: " + name)
        return _executable_binding(path)
    sysroot = Path(run(["rustc", "--print", "sysroot"]).decode().strip()).resolve(strict=True)
    sdk = Path(run(["xcrun", "--show-sdk-path"]).decode().strip()).resolve(strict=True)
    with (repo / "Cargo.lock").open("rb") as lock_file:
        lock = tomllib.load(lock_file)
    bindgen_versions = {entry["version"] for entry in lock.get("package", []) if entry.get("name") == "wasm-bindgen"}
    if len(bindgen_versions) != 1:
        raise ValueError("locked wasm-bindgen selection is ambiguous")
    bindgen = repo / "var/cargo-tools" / ("wasm-bindgen-" + next(iter(bindgen_versions))) / "bin/wasm-bindgen"
    leptos = repo / "var/cargo-tools/cargo-leptos-0.3.11/bin/cargo-leptos"
    wasm_cache = Path(environment.get("HOME", "")) / "Library/Caches/.wasm-pack"
    if not wasm_cache.is_absolute() or not wasm_cache.exists():
        raise ValueError("wasm-pack tool cache is unavailable")
    tools = {"bash": executable("bash"), "python": _executable_binding(sys.executable), "bun": executable("bun"),
             "cargo": executable("cargo"), "rustc": object_sha256({"launcher": executable("rustc"), "sysroot": tree_binding(sysroot)}),
             "wasm_pack": object_sha256({"launcher": executable("wasm-pack"), "cache": tree_binding(wasm_cache.resolve(strict=True))}),
             "wasm_bindgen": _executable_binding(bindgen),
             "cargo_leptos": _executable_binding(leptos) if leptos.exists() else executable("cargo-leptos"),
             "worker_build": executable("worker-build"), "clang": executable("clang"), "apple_sdk": tree_binding(sdk),
             "git": executable("git"), "awk": executable("awk"), "xcrun": executable("xcrun"), "rustup": executable("rustup"),
             "node": executable("node"), "shell_tools": object_sha256({name: executable(name) for name in
                 ("cat", "chmod", "cp", "dirname", "find", "grep", "ln", "mkdir", "mv", "rm", "sed", "sh", "sort", "tar", "sw_vers", "uname")} ),
             "system": object_sha256({"sw_vers": run(["sw_vers"]).decode(), "uname": run(["uname", "-a"]).decode()})}
    products = {"mail_router": repo / "generated/mail-workers/mail-router", "mail_outbound": repo / "generated/mail-workers/mail-outbound",
                "mail_canary": repo / "generated/mail-workers/mail-canary", "mail_heartbeat": repo / "generated/mail-workers/mail-heartbeat",
                "mail_mcp": repo / "generated/mail-workers/mail-mcp", "router_wasm": repo / "generated/router-wasm",
                "ui_worker": repo / "build", "ui_site": repo / "target/site"}
    result = {"head": head, "tree": tree, "environment": env_binding, "ci_script": ci_hash,
              "dependency_resolution": {"bun": node_resolution, "cargo": cargo_resolution}, "toolchain": tools}
    if include_products:
        result["products"] = {key: tree_binding(path) for key, path in products.items()}
    return result


def capture_in_lifecycle(repo, environment, *, phase):
    """Create a capture only inside the exact admitted retained-CI lifetime."""
    import build_cache_retirement as retirement
    repo = Path(repo)
    output = Path(environment.get("MAILDESK_BUILD_LIFETIME_PROOF", ""))
    if (not output.is_absolute() or output.resolve(strict=True) != output or
            not output.is_relative_to(repo / "var/proof") or environment.get("MAILDESK_BUILD_COMPONENT") != "ci" or
            environment.get("MAILDESK_SOURCE_QUALIFICATION") != "1"):
        raise ValueError("retained CI lifetime is unavailable")
    operation = retirement.read_plan(output / "operation.json")
    if (operation.get("retained_qualification") is not True or operation.get("consumer_profile") != "ci" or
            operation.get("command") != ["bash", "scripts/ci.sh"] or
            operation.get("resource_request", {}).get("working_directory") != str(repo)):
        raise ValueError("capture does not belong to retained full CI")
    fds = retirement.inherited_fds(environment)
    if not fds:
        raise ValueError("capture requires genuine inherited admission")
    binding = retirement.read_plan(output / "reservation-binding.json")
    acknowledgement = retirement.read_plan(output / "launch-acknowledgement.json")
    if (retirement.capability_identity(fds) != binding.get("capability") or
            acknowledgement.get("binding_sha256") != retirement.sha(output / "reservation-binding.json")):
        raise ValueError("capture admission does not match the acknowledged lifetime")
    if retirement.git_state(repo) != operation.get("source"):
        raise ValueError("capture source changed during CI")
    if phase not in ("inputs", "results"):
        raise ValueError("invalid qualification capture phase")
    snapshot = capture_current(repo, environment, ci_child=True, include_products=phase == "results")
    if snapshot.get("head") != operation["source"]["head"]:
        raise ValueError("capture bindings are incomplete")
    if retirement.git_state(repo) != operation["source"]:
        raise ValueError("capture source changed during observation")
    inputs_path = output / "qualification-inputs.json"
    if phase == "inputs":
        retirement.save(inputs_path, {"schema": "maildesk-source-inputs/v1", "bindings": snapshot})
    else:
        inputs = retirement.read_plan(inputs_path)
        if (inputs.get("schema") != "maildesk-source-inputs/v1" or
                inputs.get("bindings") != {key: value for key, value in snapshot.items() if key != "products"} or
                not same_bindings(snapshot, snapshot)):
            raise ValueError("qualification inputs changed or are incomplete")
        retirement.save(output / "qualification-capture.json", {"schema": "maildesk-source-capture/v1", "bindings": snapshot,
                        "input_sha256": retirement.sha(inputs_path)})


def publication_source(repo, environment):
    """Read the Git source identity consumed by a source-only push.

    Run-bound dependency and product inventories are reviewed evidence; they
    are not live push inputs. Git overrides cannot redirect these observations.
    """
    git_env = {key: value for key, value in environment.items() if not key.startswith("GIT_")}
    def run(*args):
        return _command(["git", *args], cwd=repo, environment=git_env).decode().strip()
    head, tree = run("rev-parse", "HEAD"), run("rev-parse", "HEAD^{tree}")
    if run("status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("source candidate must be clean")
    return head, tree


def verify_publication(repo, environment, remote_name, remote_url, stdin_text):
    """Verify a single push against separately pinned local owner records.

    The operator installs the selection and approval pins; the independent
    reviewer supplies a separate review pin. This function never creates or
    updates those trust anchors, runs CI, or changes the historical receipt.
    """
    repo = Path(repo)
    if not repo.is_absolute() or repo.resolve(strict=True) != repo:
        raise ValueError("repository path must be canonical")
    config_env = {key: value for key, value in environment.items() if not key.startswith("GIT_")}
    diagnostic = diagnostic_requested(repo, config_env)
    binding = publication_environment_binding(environment, repo=repo, remote_name=remote_name,
                                              remote_url=remote_url, include_components=diagnostic)
    publication_environment = binding["sha256"]
    print("source publication environment sha256: " + publication_environment, file=sys.stderr)
    def pin(name):
        values = _command(["git", "config", "--local", "--get-all", name], cwd=repo, environment=config_env).decode().splitlines()
        if len(values) != 1 or not re.fullmatch(r"[0-9a-f]{64}", values[0]):
            raise ValueError("required independent pin is unavailable")
        return values[0]
    if diagnostic:
        head, tree = publication_source(repo, environment)
        controls = {name: object_sha256(read_approval(repo / "var/source-publication" / (name + ".json")))
                    for name in ("selection", "approval", "review")}
        pins = {name: pin("maildesk.sourcePublication" + name.capitalize() + "Sha256")
                for name in ("selection", "approval", "review")}
        report = {"schema": "maildesk-publication-environment-diagnostic/v1", "status": "DIAGNOSTIC_REFUSED",
                  "head": head, "tree": tree, "remote_name_sha256": bytes_sha256(remote_name.encode()),
                  "remote_url_sha256": bytes_sha256(remote_url.encode()), "stdin_sha256": bytes_sha256(stdin_text.encode()),
                  "controls_canonical_sha256": controls, "configured_pins": pins,
                  "projection": binding}
        print(json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=True), file=sys.stderr)
        raise ValueError("diagnostic only; publication always refused")
    selection = read_approval(repo / "var/source-publication/selection.json")
    approval = read_approval(repo / "var/source-publication/approval.json")
    review = read_approval(repo / "var/source-publication/review.json")
    selection_keys = {"schema", "run_dir", "incident", "target_ref", "expected_remote", "remote_name", "remote_url_sha256"}
    if (set(selection) != selection_keys or selection.get("schema") != "maildesk-source-publication-selection/v1" or
            object_sha256(selection) != pin("maildesk.sourcePublicationSelectionSha256") or
            selection.get("remote_name") != remote_name or
            selection.get("remote_url_sha256") != bytes_sha256(remote_url.encode())):
        raise ValueError("publication selection is unavailable or changed")
    run_dir = selection.get("run_dir")
    incident_path = selection.get("incident")
    if not isinstance(run_dir, str) or not re.fullmatch(r"var/proof/[A-Za-z0-9._-]+", run_dir):
        raise ValueError("qualification lifetime path is invalid")
    if (not isinstance(incident_path, str) or not re.fullmatch(r"var/proof/[A-Za-z0-9._-]+/settlement\.json", incident_path) or
            incident_path.startswith(run_dir + "/")):
        raise ValueError("historical incident path is invalid")
    def proof(name):
        return read_proof(repo, run_dir + "/" + name)
    capture = strict_object(proof("qualification-capture.json"))
    lifecycle = strict_object(proof("qualification-lifecycle.json"))
    operation_bytes, settlement_bytes = proof("operation.json"), proof("settlement.json")
    inputs_bytes = proof("qualification-inputs.json")
    exit_bytes = proof("operation-exit.json")
    incident_bytes = read_proof(repo, incident_path)
    incident = strict_object(incident_bytes)
    if incident.get("status") != "CACHE_RETAINED_SETTLEMENT_UNPROVED":
        raise ValueError("historical incident status changed")
    # The separately approved push projection is not equated to the CI child.
    # Only the validated result-output location is projected out of the job.
    if approval.get("publication_environment") != publication_environment:
        raise ValueError("publication environment is unavailable or changed")
    head, tree = publication_source(repo, environment)
    if not isinstance(capture.get("bindings"), dict):
        raise ValueError("capture bindings are unavailable")
    observed = {**capture["bindings"], "head": head, "tree": tree}
    expected_remote = selection.get("expected_remote")
    try:
        _command(["git", "merge-base", "--is-ancestor", expected_remote, observed["head"]], cwd=repo, environment=config_env)
        ancestry = True
    except (subprocess.SubprocessError, TypeError):
        ancestry = False
    target = selection.get("target_ref")
    if not check_push(stdin_text, observed["head"], target, expected_remote, ancestry_proved=ancestry):
        raise ValueError("push ref or ancestry does not match the approved candidate")
    if not check_chain(capture, lifecycle, review, approval, operation_bytes, settlement_bytes, inputs_bytes,
                       exit_bytes, observed, target, bytes_sha256(incident_bytes),
                       pin("maildesk.sourcePublicationApprovalSha256"), pin("maildesk.sourcePublicationReviewSha256")):
        raise ValueError("source qualification or independent review is unavailable or changed")


def main(argv):
    repo = Path(__file__).resolve().parents[1]
    if argv == ["--capture-inputs"] or argv == ["--capture-results"]:
        capture_in_lifecycle(repo, os.environ, phase="inputs" if argv[0] == "--capture-inputs" else "results")
    elif len(argv) == 3 and argv[0] == "--print-publication-environment":
        print(json.dumps(publication_environment_binding(os.environ, repo=repo, remote_name=argv[1], remote_url=argv[2]), sort_keys=True))
    elif len(argv) == 3 and argv[0] == "--verify-push":
        data = sys.stdin.read(65537)
        if len(data) > 65536:
            raise ValueError("push ref input is too large")
        verify_publication(repo, os.environ, argv[1], argv[2], data)
    else:
        raise ValueError("unsupported source-qualification operation")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        print("source qualification held: " + str(error), file=sys.stderr)
        raise SystemExit(1)
