"""Fail-closed lsof coverage for selective compiler-cache retirement."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class CoverageError(RuntimeError):
    def __init__(self, reason, diagnostics=""):
        self.details = {"reason": reason, "diagnostics": diagnostics}
        super().__init__("Current open-file coverage unavailable: " + reason +
                         ("\n" + diagnostics if diagnostics else ""))


def darwin_mounts():
    """Read the local cached mount table with getfsstat64(MNT_NOWAIT).

    Darwin's public statfs64 ABI is fixed by sys/mount.h. Never stat the
    unavailable SMB mount or initiate network/mount recovery to qualify it.
    """
    if sys.platform != "darwin":
        return []
    class Statfs(ctypes.Structure):
        _fields_ = [("bsize", ctypes.c_uint32), ("iosize", ctypes.c_int32)] + [
            (name, ctypes.c_uint64) for name in ("blocks", "bfree", "bavail", "files", "ffree")
        ] + [("fsid", ctypes.c_int32 * 2)] + [
            (name, ctypes.c_uint32) for name in ("owner", "type", "flags", "subtype")
        ] + [("fstype", ctypes.c_char * 16), ("mount", ctypes.c_char * 1024),
             ("source", ctypes.c_char * 1024), ("flags_ext", ctypes.c_uint32),
             ("reserved", ctypes.c_uint32 * 7)]
    call = ctypes.CDLL(None, use_errno=True).getfsstat64
    call.argtypes = [ctypes.POINTER(Statfs), ctypes.c_int, ctypes.c_int]
    call.restype = ctypes.c_int
    count = call(None, 0, 2)
    if not 0 < count < 4096:
        raise CoverageError("Native mount table unavailable")
    buffer = (Statfs * (count + 16))()
    size = call(buffer, ctypes.sizeof(buffer), 2)
    if not 0 < size < len(buffer):
        raise CoverageError("Native mount table changed or was truncated")
    return sorted((os.fsdecode(row.mount), row.fstype.decode("ascii"),
                   row.fsid[0] & 0xffffffff, row.fsid[1]) for row in buffer[:size])


def qualify_warnings(stderr, root, devices, before, after):
    if not stderr:
        return []
    pattern = re.compile(
        r'lsof: WARNING: can\x27t stat\(\) smbfs file system (/[^\n]+)\n'
        r'      Output information may be incomplete\.\n'
        r'      assuming "dev=([0-9a-fA-F]+)" from mount table\n')
    remaining = stderr
    qualified = []
    seen = set()
    while remaining:
        match = pattern.match(remaining)
        if match is None:
            raise CoverageError("Unqualified lsof diagnostic", stderr)
        mount, raw_device = match.groups()
        device = int(raw_device, 16)
        path = Path(mount)
        rows = [r for r in before if r[0] == mount]
        if (str(path) != mount or not path.is_absolute() or ".." in path.parts or
                len(rows) != 1 or rows[0][1:3] != ("smbfs", device) or
                [r for r in after if r[0] == mount] != rows or
                device in devices or root.is_relative_to(path) or path.is_relative_to(root) or
                mount in seen):
            raise CoverageError("SMB warning scope is not independently qualified", stderr)
        # An alias of the same unavailable device must not overlap the target.
        aliases = [Path(r[0]) for r in before + after if r[2] == device]
        if any(root.is_relative_to(p) or p.is_relative_to(root) for p in aliases):
            raise CoverageError("SMB device has an overlapping mount", stderr)
        seen.add(mount)
        qualified.append({"mount": mount, "device": device, "filesystem": "smbfs"})
        remaining = remaining[match.end():]
    return qualified


FILESYSTEM_TYPES = {"REG", "DIR", "CHR", "BLK", "FIFO", "LINK"}
NON_FILESYSTEM_TYPES = {"unix", "IPv4", "IPv6", "PIPE", "KQUEUE", "NPOLICY",
                        "NEXUS", "systm", "CHAN", "key", "netlink", "a_inode"}


def parse_records(stdout):
    if not stdout or not stdout.endswith("\n"):
        raise CoverageError("Empty or truncated lsof output")
    records, process, record = [], {}, {}
    seen_processes, seen_records, seen_descriptors = set(), set(), set()
    process_files = 0

    def finish_file():
        nonlocal record, process_files
        if not record:
            return
        if set(process) != {"p", "c"} or not {"f", "t", "n"} <= record.keys():
            raise CoverageError("Incomplete process or file record")
        if not re.fullmatch(r"[0-9]+|cwd|rtd|twd|txt|mem|ltx|mmap", record["f"]):
            raise CoverageError("Unknown or denied file descriptor")
        kind = record["t"]
        name = record["n"]
        if re.search(r"permission denied|operation not permitted|no such file|read error|can't stat", name, re.I):
            raise CoverageError("Denial-like file record")
        if kind in FILESYSTEM_TYPES:
            if (set(record) != {"f", "t", "D", "i", "n"} or
                    not re.fullmatch(r"(?:0x)?[0-9a-fA-F]+", record["D"]) or
                    not re.fullmatch(r"[1-9][0-9]*", record["i"]) or int(record["D"], 16) == 0 or
                    not name.startswith("/")):
                raise CoverageError("Incomplete filesystem identity")
        elif kind in NON_FILESYSTEM_TYPES:
            if set(record) != {"f", "t", "n"} or not record["f"].isdecimal():
                raise CoverageError("Contradictory non-filesystem record")
            # Unpaired pipes and these Darwin kernel descriptors have no name.
            if not name and kind not in {"PIPE", "NPOLICY", "NEXUS", "key"}:
                raise CoverageError("Incomplete non-filesystem name")
        else:
            raise CoverageError("Unsupported file type")
        identity = (process["p"], tuple(sorted(record.items())))
        if identity in seen_records:
            raise CoverageError("Duplicate file record")
        descriptor = (process["p"], record["f"])
        if record["f"].isdecimal() and descriptor in seen_descriptors:
            raise CoverageError("Contradictory duplicate descriptor")
        seen_descriptors.add(descriptor)
        seen_records.add(identity)
        records.append({**record, "pid": int(process["p"])})
        process_files += 1
        record = {}

    for line in stdout.splitlines():
        key, value = line[:1], line[1:]
        if key == "p":
            finish_file()
            if process and (set(process) != {"p", "c"} or not process_files):
                raise CoverageError("Incomplete process record")
            if not re.fullmatch(r"[1-9][0-9]*", value) or value in seen_processes:
                raise CoverageError("Invalid or duplicate process")
            seen_processes.add(value)
            process, process_files = {"p": value}, 0
        elif key == "c":
            if set(process) != {"p"} or record or not value:
                raise CoverageError("Invalid process command")
            process["c"] = value
        elif key == "f":
            finish_file()
            if set(process) != {"p", "c"}:
                raise CoverageError("File without process identity")
            record = {"f": value}
        elif key in {"t", "D", "i", "n"} and record and key not in record:
            record[key] = value
        else:
            raise CoverageError("Unknown, misplaced or duplicate lsof field")
    finish_file()
    if not records or not process_files:
        raise CoverageError("Incomplete final process record")
    return records


def open_users(root, files):
    root = Path(root)
    devices = {root.stat().st_dev} | {r["device"] for r in files.values()}
    before = darwin_mounts()
    command = ["lsof", "-nP", "-FpcftDin"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise CoverageError("lsof exited " + str(result.returncode), result.stderr)
    try:
        warnings = qualify_warnings(result.stderr, root, devices, before,
                                    darwin_mounts() if result.stderr else before)
        records = parse_records(result.stdout)
    except CoverageError as error:
        # Keep the complete diagnostic, including mixed/unrecognized warnings.
        raise CoverageError(error.details["reason"], result.stderr) from error
    identities = {(r["device"], r["inode"]) for r in files.values()}
    found = []
    for row in records:
        name = row["n"]
        identity = (int(row["D"], 16), int(row["i"])) if "D" in row else None
        if row["pid"] != os.getpid() and (identity in identities or
                name == str(root) or name.startswith(str(root) + "/")):
            found.append({"pid": row["pid"], "path": name})
    if found:
        raise RuntimeError("Current target or hardlink consumer: " + json.dumps(found[:5]))
    return {"status": "QUALIFIED_NO_CONSUMERS", "command": command,
            "processes": len({r["pid"] for r in records}), "files": len(records),
            "stdout_sha256": hashlib.sha256(result.stdout.encode()).hexdigest(),
            "diagnostics": result.stderr, "qualified_warnings": warnings}
