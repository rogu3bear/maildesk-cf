"""Selective Cargo payload retirement after an encompassing operation settles.

The installed preservation provider supplies exclusion, never deletion authority.
Plans bind a separately authorized exact snapshot; apply never widens or retries it.
"""
import argparse
import collections
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import struct
import subprocess
import sys
import types

LOADER_SHA256 = "8f7343ec66fb6a5d5b00e3120c5762bc91f5c28d4b3730a893ba40e57e26d77f"
_PROVIDER = None
MAX_ENTRIES = 100_000


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def save(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


def provider():
    global _PROVIDER
    if _PROVIDER is None:
        home = Path.home() / ".local/share/disk-guard"
        record = json.loads((home / "installation.json").read_bytes())
        release = Path(record["release"])
        if (record["phase"] != "active" or home.resolve() != home or
                release.resolve() != release or release.parent != home / "releases"):
            raise RuntimeError("Installed preservation release is not canonical and active")
        manifest = release / "manifest.json"
        if manifest.is_symlink() or sha(manifest) != record["runtime_manifest_sha256"]:
            raise RuntimeError("Installed preservation manifest changed")
        hashes = json.loads(manifest.read_bytes())["source_sha256"]
        path = release / "preservation_loader.py"
        if path.is_symlink() or sha(path) != hashes[path.name] or sha(path) != LOADER_SHA256:
            raise RuntimeError("Reviewed installed preservation loader unavailable")
        loader = types.ModuleType("maildesk_verified_preservation_loader")
        loader.__file__ = str(path)
        exec(compile(path.read_bytes(), str(path), "exec"), loader.__dict__)
        api = loader.load_installed()
        if not callable(getattr(api, "approved_cleanup_exclusion", None)):
            raise RuntimeError("Installed approved cleanup exclusion unavailable")
        _PROVIDER = api, record["runtime_manifest_sha256"], loader
    current = _PROVIDER[2].availability()
    if current.get("status") != "AVAILABLE" or current.get("manifest_sha256") != _PROVIDER[1]:
        raise RuntimeError("Installed provider changed; qualify it in a fresh process")
    return _PROVIDER[:2]


def run(args, cwd=None):
    env = dict(os.environ)
    if args[0] == "git":
        # Foreign fixture/source repositories must not inherit hook-local roots.
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_CONFIG", "GIT_CONFIG_COUNT",
                    "GIT_CONFIG_PARAMETERS", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
                    "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_QUARANTINE_PATH"):
            env.pop(key, None)
        for key in list(env):
            if re.fullmatch(r"GIT_CONFIG_(KEY|VALUE)_\d+", key):
                env.pop(key)
        env["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, check=True)
    return result.stdout


def git_state(repo):
    names = run(["git", "ls-files", "-z"], repo).decode().split("\0")
    state = {"head": run(["git", "rev-parse", "HEAD"], repo).decode().strip(),
             "index_sha256": hashlib.sha256(run(["git", "ls-files", "--stage", "-z"], repo)).hexdigest(),
             "status": run(["git", "status", "--porcelain=v1"], repo).decode(),
             "tracked_sha256": {name: sha(repo / name) for name in names if name and (repo / name).is_file()}}
    if state["status"]:
        raise RuntimeError("Retirement requires the settled committed source candidate")
    return state


def metadata(path):
    value = path.lstat()
    return {"device": value.st_dev, "inode": value.st_ino, "bytes": value.st_size,
            "mtime_ns": value.st_mtime_ns, "mode": stat.S_IMODE(value.st_mode),
            "nlink": value.st_nlink, "allocated": value.st_blocks * 512,
            "type": stat.S_IFMT(value.st_mode)}


def inventory(root):
    files, directories, pending = {}, {}, [root]
    device = root.stat().st_dev
    while pending:
        path = pending.pop()
        directories[str(path.relative_to(root))] = metadata(path)
        for entry in os.scandir(path):
            child = Path(entry.path)
            row = metadata(child)
            if row["device"] != device:
                raise RuntimeError("Inventory crosses an unqualified storage device")
            name = str(child.relative_to(root))
            if row["type"] == stat.S_IFDIR:
                pending.append(child)
            else:
                files[name] = row
        if len(files) + len(directories) > MAX_ENTRIES:
            raise RuntimeError("Retirement inventory exceeds its bounded scope")
    return files, directories


def protected(name, paths):
    return any(name == p or Path(name).is_relative_to(p) for p in paths)


def artifact_kind(path):
    with path.open("rb") as stream:
        raw = stream.read(32)
    if path.suffix in (".rlib", ".a") and raw.startswith(b"!<arch>\n"):
        return "archive"
    if path.suffix == ".rmeta" and raw.startswith(b"rust\x00\x00\x00"):
        return "rust_metadata"
    if path.suffix == ".o" and raw.startswith(b"\x00asm"):
        return "object"
    if raw[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe") and len(raw) >= 16:
        return {1: "object", 6: "shared_library", 8: "shared_library"}.get(struct.unpack("<I", raw[12:16])[0])
    if raw.startswith(b"\x7fELF") and len(raw) >= 18:
        return {1: "object", 3: "shared_library"}.get(struct.unpack("<H" if raw[5] == 1 else ">H", raw[16:18])[0])
    return None


def select_payload(root, files, keep):
    """Only ordinary hashed Cargo dependencies with available regeneration inputs.

    Build-script outputs, executables, WASM deliveries, locks, diagnostics and
    fingerprint/dep-info control metadata are retained. Unknown formats retain.
    """
    selected, controls, reasons, unit_controls = {}, {}, collections.Counter(), {}
    groups = collections.defaultdict(list)
    for name, row in files.items():
        groups[(row["device"], row["inode"])].append(name)
        path = root / name
        parts = Path(name).parts
        if protected(name, keep) or row["type"] != stat.S_IFREG:
            reasons["protected_or_nonregular"] += 1
            continue
        match = re.fullmatch(r"(?:lib)?([A-Za-z0-9_]+)-([a-f0-9]{16})(?:\.[A-Za-z0-9_.]+)?", path.name)
        if len(parts) < 3 or parts[-2] != "deps" or not match or path.suffix not in (".rlib", ".rmeta", ".a", ".o", ".dylib", ".so"):
            reasons["lock_product_metadata_or_unknown"] += 1
            continue
        prefix = parts[:-2]
        layout = prefix[1:] if prefix and prefix[0] == "front" else prefix
        if (not layout or layout[-1] not in ("debug", "release") or len(layout) > 2 or
                len(layout) == 2 and not re.fullmatch(r"[a-z0-9_]+(?:-[a-z0-9_]+){2,}", layout[0])):
            reasons["unqualified_profile_namespace"] += 1
            continue
        kind = artifact_kind(path)
        required = {".rlib": "archive", ".a": "archive", ".rmeta": "rust_metadata", ".o": "object",
                    ".dylib": "shared_library", ".so": "shared_library"}
        if kind != required[path.suffix]:
            reasons["unrecognized_format"] += 1
            continue
        profile = root.joinpath(*prefix)
        unit = match[2]
        fingerprints = list((profile / ".fingerprint").glob("*-" + unit + "/*.json"))
        depinfo = profile / "deps" / (match[1] + "-" + unit + ".d")
        try:
            valid = [p for p in fingerprints if not p.is_symlink() and p.stat().st_size <= 2_000_000 and
                     {"rustc", "features", "target", "profile", "deps"} <= json.loads(p.read_bytes()).keys()]
            if not valid or depinfo.is_symlink() or depinfo.stat().st_size > 2_000_000:
                raise ValueError("Missing Cargo provenance")
            first = depinfo.read_text().splitlines()[0].split(": ", 1)[1]
            inputs = shlex.split(first)
            if not inputs or len(inputs) > 20_000 or any(not (Path(p) if p.startswith("/") else root.parent / p).is_file() for p in inputs):
                raise ValueError("Regeneration source unavailable")
        except (OSError, ValueError, IndexError, UnicodeError):
            reasons["regeneration_unqualified"] += 1
            continue
        for p in [depinfo, *valid]:
            controls[str(p)] = sha(p)
        unit_controls[(str(profile.relative_to(root)), unit)] = [depinfo, *valid]
        selected[name] = {**row, "kind": kind, "sha256": sha(path)}
    # Never sever a retained, external or unknown hardlink peer.
    for names in groups.values():
        eligible = [n for n in names if n in selected]
        if eligible and (len(eligible) != len(names) or files[eligible[0]]["nlink"] != len(names)):
            for name in eligible:
                selected.pop(name)
            reasons["retained_or_external_hardlink"] += len(eligible)
    # Retire dep-info and fingerprint JSON only when all compiler payloads of
    # that unit qualify. Retained products/evidence keep their provenance too.
    for (profile, unit), paths in unit_controls.items():
        payloads = [n for n in files if str(Path(n).parent) == profile + "/deps" and
                    ("-" + unit + ".") in Path(n).name and Path(n).suffix in
                    (".rlib", ".rmeta", ".a", ".o", ".dylib", ".so", ".wasm")]
        if not payloads or any(n not in selected for n in payloads):
            continue
        for path in paths:
            name = str(path.relative_to(root)); row = files[name]
            if row["type"] == stat.S_IFREG and row["nlink"] == 1 and not protected(name, keep):
                selected[name] = {**row, "kind": "cargo_dependency_metadata", "sha256": sha(path)}
    return selected, controls, dict(reasons)


def open_users(root, files):
    result = subprocess.run(["lsof", "-nP", "-FpcfDin"], capture_output=True, text=True, timeout=45)
    if result.returncode or result.stderr and ("smbfs file system /Volumes/.timemachine/" not in result.stderr or
            any(x in result.stderr.lower() for x in ("permission denied", "operation not permitted"))):
        raise RuntimeError("Current open-file coverage unavailable: " + result.stderr[:500])
    identities = {(r["device"], r["inode"]) for r in files.values()}
    pid = device = inode = name = None
    found = []
    def flush():
        if pid != os.getpid() and ((device, inode) in identities or name and
                (name == str(root) or name.startswith(str(root) + "/"))):
            found.append({"pid": pid, "path": name})
    for line in result.stdout.splitlines():
        key, value = line[:1], line[1:]
        if key == "p":
            flush(); pid = int(value); device = inode = name = None
        elif key == "f":
            flush(); device = inode = name = None
        elif key == "D":
            device = int(value, 16)
        elif key == "i":
            inode = int(value)
        elif key == "n":
            name = value
    flush()
    if found:
        raise RuntimeError("Current target or hardlink consumer: " + json.dumps(found[:5]))


@contextlib.contextmanager
def cargo_locks(root, files):
    with contextlib.ExitStack() as stack:
        for name, row in files.items():
            if Path(name).name != ".cargo-lock":
                continue
            if row["type"] != stat.S_IFREG or row["nlink"] != 1:
                raise RuntimeError("Cargo lock identity unqualified")
            fd = os.open(root / name, os.O_RDWR | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if metadata(root / name) != row:
                raise RuntimeError("Cargo lock changed")
        yield


def contents(root, files):
    return {name: sha(root / name) if row["type"] == stat.S_IFREG else
            os.readlink(root / name) if row["type"] == stat.S_IFLNK else None for name, row in files.items()}


def bindings(repo, policy, keep):
    repo, policy = Path(repo), Path(policy)
    root = repo / "target"
    if repo.resolve() != repo or root.resolve() != root or not root.is_dir() or policy.resolve() != policy:
        raise RuntimeError("Require canonical repository, ordinary target and policy")
    if Path(run(["git", "rev-parse", "--show-toplevel"], repo).decode().strip()) != repo:
        raise RuntimeError("Require the repository root")
    if run(["git", "ls-files", "--", "target"], repo).strip():
        raise RuntimeError("Tracked target content is not disposable")
    for name in keep:
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise RuntimeError("Protected target paths must be relative")
    return root


def external_products(repo):
    result = {}
    for directory in (repo / "build", repo / "generated"):
        if directory.exists():
            files, _ = inventory(directory)
            result.update({str(directory / n): h for n, h in contents(directory, files).items()})
    return result


def exclusion(repo, root, policy, released, controls, policy_sha256=None):
    api, _ = provider()
    value = root.stat()
    return api.approved_cleanup_exclusion(str(policy), str(repo),
        [{"path": str(root), "device": value.st_dev, "inode": value.st_ino}],
        policy_sha256=policy_sha256 or sha(policy), released_pins=released, protected_paths=controls)


def prepare(repo, policy, plan_path, authorization, keep=()):
    repo, policy, plan_path = Path(repo), Path(policy), Path(plan_path)
    root = bindings(repo, policy, keep)
    if not authorization.strip() or plan_path.resolve().is_relative_to(root):
        raise RuntimeError("Require separate authorization and a plan outside target")
    pins = json.loads(policy.read_bytes())["retention_pins"]
    released = [p for p in pins if root.is_relative_to(p["path"]) or Path(p["path"]).is_relative_to(root)]
    with exclusion(repo, root, policy, released, [str(plan_path.parent), str(repo / ".git")]) as held:
        files, dirs = inventory(root)
        with cargo_locks(root, files):
            source = git_state(repo)
            keep = sorted(set(keep) | {"site", "doc", "package", "ui-asset-hashes.env"})
            selected, controls, reasons = select_payload(root, files, keep)
            open_users(root, files)
            all_contents = contents(root, files)
            value = root.stat()
            plan = {"schema": "maildesk-build-cache-retirement/v1", "repo": str(repo), "root": str(root),
                    "root_identity": [value.st_dev, value.st_ino], "authorization": authorization,
                    "provider_manifest_sha256": provider()[1], "policy": str(policy), "policy_sha256": sha(policy),
                    "released_pins": released, "source": source, "keep": keep, "files": files,
                    "directories": dirs, "contents": all_contents, "selected": selected,
                    "classifier_controls": controls, "retained_reasons": reasons,
                    "external_products": external_products(repo)}
            held.before_effect()
            if inventory(root) != (files, dirs) or git_state(repo) != source:
                raise RuntimeError("Snapshot changed during qualification")
            save(plan_path, plan)
    return {"plan": str(plan_path), "sha256": sha(plan_path), "files": len(selected),
            "allocated_bytes": sum({(r["device"], r["inode"]): r["allocated"] for r in selected.values()}.values())}


def unlink_at(root_fd, name, directories):
    parts = Path(name).parts
    if Path(name).is_absolute() or not parts or any(p in (".", "..") for p in parts):
        raise RuntimeError("Invalid relative effect")
    with contextlib.ExitStack() as stack:
        fd = os.dup(root_fd); stack.callback(os.close, fd)
        for index, part in enumerate(parts[:-1]):
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            stack.callback(os.close, fd)
            current = os.fstat(fd); expected = directories[str(Path(*parts[:index + 1]))]
            if (current.st_dev, current.st_ino) != (expected["device"], expected["inode"]):
                raise RuntimeError("Effect parent changed")
        os.unlink(parts[-1], dir_fd=fd)
        os.fsync(fd)


def measure(root):
    value = os.statvfs(root)
    return {"target_allocated_bytes": int(run(["du", "-sk", str(root)]).split()[0]) * 1024,
            "filesystem_free_bytes": value.f_bfree * value.f_frsize}


def read_plan(path, expected_sha256=None):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise RuntimeError("Duplicate retirement plan field")
            result[key] = value
        return result
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid() or before.st_size > 32_000_000:
            raise RuntimeError("Plan must be owned, singly linked and bounded")
        raw = os.pread(fd, 32_000_001, 0)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise RuntimeError("Plan changed while reading")
        if expected_sha256 is not None and hashlib.sha256(raw).hexdigest() != expected_sha256:
            raise RuntimeError("Exact reviewed plan changed")
        return json.loads(raw, object_pairs_hook=pairs)
    finally:
        os.close(fd)


def apply(plan_path, plan_sha256, journal_path, receipt_path, *, unlink=unlink_at):
    plan_path, journal_path, receipt_path = map(Path, (plan_path, journal_path, receipt_path))
    plan = read_plan(plan_path, plan_sha256)
    if any(p.exists() or p.is_symlink() for p in (journal_path, receipt_path)):
        raise RuntimeError("Existing transaction requires read-only reconciliation, never replay")
    repo, policy = Path(plan["repo"]), Path(plan["policy"])
    root = bindings(repo, policy, plan["keep"])
    if root != Path(plan["root"]) or any(p.resolve().is_relative_to(root) for p in (journal_path, receipt_path)):
        raise RuntimeError("Transaction controls must survive outside target")
    result = {"status": "HELD_NO_EFFECT", "plan_sha256": plan_sha256, "removed": [], "effect_dispatched": False, "before": measure(root)}
    removed_links = collections.Counter()
    with journal_path.open("x") as journal:
        def event(kind, **values):
            journal.write(json.dumps({"event": kind, **values}, separators=(",", ":")) + "\n")
            journal.flush(); os.fsync(journal.fileno())
        event("STARTED", plan_sha256=plan_sha256, authorization=plan["authorization"])
        try:
            if plan["schema"] != "maildesk-build-cache-retirement/v1" or sha(policy) != plan["policy_sha256"] or provider()[1] != plan["provider_manifest_sha256"]:
                raise RuntimeError("Policy/provider identity changed")
            with exclusion(repo, root, policy, plan["released_pins"], [str(plan_path), str(journal_path), str(receipt_path), str(repo / ".git")], plan["policy_sha256"]) as held:
                if [root.stat().st_dev, root.stat().st_ino] != plan["root_identity"]:
                    raise RuntimeError("Target identity changed")
                files, dirs = inventory(root)
                if files != plan["files"] or dirs != plan["directories"]:
                    raise RuntimeError("Plan inventory changed")
                with cargo_locks(root, files):
                    selected, controls, _ = select_payload(root, files, plan["keep"])
                    if selected != plan["selected"] or controls != plan["classifier_controls"] or contents(root, files) != plan["contents"] or git_state(repo) != plan["source"] or external_products(repo) != plan["external_products"]:
                        raise RuntimeError("Source, classifier or retained evidence changed")
                    open_users(root, files)
                    held.before_effect()
                    for name, expected in selected.items():
                        current = metadata(root / name)
                        identity = (expected["device"], expected["inode"])
                        wanted = {k: v for k, v in expected.items() if k not in ("kind", "sha256")}
                        wanted["nlink"] -= removed_links[identity]
                        if current != wanted or sha(root / name) != expected["sha256"]:
                            raise RuntimeError("Selected file changed before effect")
                        event("UNLINK_INTENT", path=name, sha256=expected["sha256"])
                        result["effect_dispatched"] = True
                        unlink(held.targets[0]["fd"], name, dirs)
                        result["removed"].append(name); removed_links[identity] += 1
                        event("UNLINK_COMPLETE", path=name)
                    after, after_dirs = inventory(root)
                    retained = {n: r for n, r in files.items() if n not in selected}
                    if after != retained or contents(root, after) != {n: h for n, h in plan["contents"].items() if n not in selected}:
                        raise RuntimeError("Retained files changed")
                    if set(after_dirs) != set(dirs) or any((r["device"], r["inode"]) != (dirs[n]["device"], dirs[n]["inode"]) for n, r in after_dirs.items()):
                        raise RuntimeError("Retained directory identity changed")
                    if git_state(repo) != plan["source"] or external_products(repo) != plan["external_products"] or sha(policy) != plan["policy_sha256"]:
                        raise RuntimeError("Source/products/policy changed")
                    held.before_effect()
                    result.update(status="COMPLETE", retained_files_verified=len(after), directory_identities_preserved=True,
                                  locks_products_source_policy_preserved=True)
                    event("VERIFIED", status="COMPLETE")
        except Exception as error:
            result.update(status="PARTIAL_REQUIRES_RECONCILIATION" if result["removed"] else
                          "EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION" if result["effect_dispatched"] else "HELD_NO_EFFECT",
                          error=str(error), provider_details=getattr(error, "details", None))
            causes = []; cause = error.__cause__
            while cause:
                causes.append({"type": type(cause).__name__, "error": str(cause)}); cause = cause.__cause__
            result["cause_chain"] = causes
            event("STOPPED", status=result["status"], error=str(error))
        result["after"] = measure(root)
        result["target_allocation_change_bytes"] = result["after"]["target_allocated_bytes"] - result["before"]["target_allocated_bytes"]
        result["filesystem_free_change_bytes"] = result["after"]["filesystem_free_bytes"] - result["before"]["filesystem_free_bytes"]
        result["removed_allocated_bytes"] = sum({(r["device"], r["inode"]): r["allocated"] for n, r in plan["selected"].items()
            if n in result["removed"] and removed_links[(r["device"], r["inode"])] == r["nlink"]}.values())
        save(receipt_path, result)
    return result


def reconcile(plan_path, journal_path):
    plan = read_plan(plan_path); root = Path(plan["root"])
    if root.resolve() != root or [root.stat().st_dev, root.stat().st_ino] != plan["root_identity"]:
        raise RuntimeError("Reconciliation target identity changed")
    events, incomplete = [], False
    for line in Path(journal_path).read_text().splitlines(keepends=True):
        if not line.endswith("\n"):
            incomplete = True
            break
        events.append(json.loads(line))
    if not events or events[0].get("plan_sha256") != sha(plan_path):
        raise RuntimeError("Journal does not bind the exact plan")
    rows = {}
    for name, expected in plan["selected"].items():
        path = root / name
        if not path.resolve().is_relative_to(root):
            rows[name] = "CHANGED_HOLD"
            continue
        if not path.exists() and not path.is_symlink():
            rows[name] = "ABSENT"
        else:
            row = metadata(path)
            rows[name] = "ORIGINAL_CONTENT" if row["type"] == stat.S_IFREG and (row["device"], row["inode"]) == (expected["device"], expected["inode"]) and sha(path) == expected["sha256"] else "CHANGED_HOLD"
    return {"status": "READ_ONLY_RECONCILIATION", "paths": rows, "replay_allowed": False,
            "incomplete_trailing_journal_record": incomplete,
            "next": "Preserve this transaction; any remaining deletion needs a freshly qualified plan."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    p = commands.add_parser("prepare"); p.add_argument("--plan", required=True); p.add_argument("--authorization-ref", required=True)
    p.add_argument("--protect", action="append", default=[])
    p = commands.add_parser("apply"); p.add_argument("--plan", required=True); p.add_argument("--plan-sha256", required=True); p.add_argument("--journal", required=True); p.add_argument("--receipt", required=True)
    p = commands.add_parser("reconcile"); p.add_argument("--plan", required=True); p.add_argument("--journal", required=True)
    args = parser.parse_args()
    if "DISK_GUARD_RESERVATION" in os.environ and args.mode != "reconcile":
        raise RuntimeError("Retirement must run after the outer admission and its descendants settle; preserve its token")
    if args.mode == "prepare":
        value = prepare(Path(__file__).resolve().parents[1], Path.home() / ".config/disk-guard/policy.json", args.plan, args.authorization_ref, args.protect)
    elif args.mode == "apply":
        bound = read_plan(args.plan, args.plan_sha256)
        if bound["repo"] != str(Path(__file__).resolve().parents[1]) or bound["policy"] != str(Path.home() / ".config/disk-guard/policy.json"):
            raise RuntimeError("Plan belongs to a different repository consumer")
        value = apply(args.plan, args.plan_sha256, args.journal, args.receipt)
    else:
        value = reconcile(args.plan, args.journal)
    print(json.dumps(value))
    return 0 if value.get("status", "COMPLETE") in ("COMPLETE", "READ_ONLY_RECONCILIATION") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "HOLD", "error": str(error), "provider_details": getattr(error, "details", None)}), file=sys.stderr)
        raise SystemExit(1)
