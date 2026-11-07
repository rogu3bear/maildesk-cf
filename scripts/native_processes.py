"""SDK-compiled, in-process Darwin identity reader; all uncertainty fails closed."""
import ctypes
import errno
import functools
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import stat
import subprocess
import sys
import tempfile

from build_cache_retirement import inherited_fds

LIMIT = 16384


class Record(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_int64), ("microseconds", ctypes.c_int64)]
    _fields_ += [(name, ctypes.c_int32) for name in ("pid", "ppid", "pgid", "session")]
    _fields_ += [(name, ctypes.c_uint32) for name in ("uid", "status", "flags")]
    _fields_ += [("session_error", ctypes.c_int32)]


class Diagnostic(ctypes.Structure):
    _fields_ = [("stage", ctypes.c_uint32)]
    _fields_ += [(name, ctypes.c_int32) for name in ("code", "syscall_result", "native_errno", "pid", "session_result", "signal_result")]
    _fields_ += [("fields", ctypes.c_uint32), ("session_errno", ctypes.c_int32), ("presence_errno", ctypes.c_int32),
                ("reported_bytes", ctypes.c_uint64), ("input_capacity", ctypes.c_uint64),
                ("expected", Record), ("observed", Record)]


def diagnostic_value(detail):
    stages = {1: "input", 2: "pid_read", 3: "empty_pid_presence", 5: "initial_identity", 6: "owner",
              7: "initial_relationship", 8: "after_session_pid_read", 9: "session", 11: "observed_identity",
              12: "identity_or_relationship_drift", 13: "allocation", 14: "population_read", 15: "population_length",
              16: "population_pid", 17: "duplicate_pid"}
    value = {key: getattr(detail, key) for key in ("code", "syscall_result", "native_errno", "pid", "reported_bytes", "input_capacity")}
    value["stage"] = stages.get(detail.stage, "unreported")
    for name, flag in (("expected", 1), ("observed", 2)):
        row = getattr(detail, name)
        value[name] = {key: getattr(row, key) for key, _ in Record._fields_ if key not in ("session", "session_error")} if detail.fields & flag else None
    value["session_result"] = detail.session_result if detail.fields & 4 else None
    value["session_errno"] = detail.session_errno if detail.fields & 4 else None
    value["presence_result"] = detail.signal_result if detail.fields & 8 else None
    value["presence_errno"] = detail.presence_errno if detail.fields & 8 else None
    return value


def file_binding(path):
    path = Path(path)
    meta = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_mode & 0o022:
        raise RuntimeError("Native reader input is not a canonical regular file")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    after = path.lstat()
    if any(getattr(after, key) != getattr(meta, key) for key in
           ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_nlink", "st_uid")):
        raise RuntimeError("Native reader input changed during binding")
    return {"path": str(path), "sha256": digest, "identity": [meta.st_dev, meta.st_ino],
            "size": meta.st_size, "mtime_ns": meta.st_mtime_ns, "ctime_ns": meta.st_ctime_ns,
            "mode": stat.S_IMODE(meta.st_mode), "uid": meta.st_uid}


def command(argv, environment):
    result = subprocess.run(argv, env=environment, capture_output=True,
                            pass_fds=tuple(inherited_fds(environment)))
    if result.returncode:
        raise RuntimeError("Native reader preparation failed: " + result.stderr.decode(errors="replace")[-2000:])
    return result.stdout.decode()


@functools.lru_cache(maxsize=None)
def prepare(directory=None):
    if sys.platform != "darwin" or platform.machine() not in ("arm64", "x86_64"):
        raise RuntimeError("Native process reader requires a qualified 64-bit Darwin SDK")
    parent = Path(directory) if directory is not None else None
    if parent is not None and (parent.resolve(strict=True) != parent or not parent.is_dir() or
                               parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o022):
        raise RuntimeError("Native reader proof directory is not canonical and owned")
    temporary = tempfile.TemporaryDirectory(prefix="maildesk-native-reader-") if parent is None else None
    root = Path(temporary.name if temporary is not None else tempfile.mkdtemp(prefix="maildesk-native-reader-", dir=parent)).resolve()
    root.chmod(0o700)
    source = Path(__file__).with_suffix(".c")
    if source.resolve(strict=True) != source:
        raise RuntimeError("Native reader source must be canonical")
    # No CC/CFLAGS/SDKROOT/DEVELOPER_DIR or backend override selects executable code.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("DYLD_") and key not in
                   ("CC", "CFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "DEVELOPER_DIR", "TOOLCHAINS",
                    "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "LIBRARY_PATH",
                    "ARCHFLAGS", "MACOSX_DEPLOYMENT_TARGET", "CCC_OVERRIDE_OPTIONS", "COMPILER_PATH", "GCC_EXEC_PREFIX")}
    environment["TMPDIR"] = str(root)
    clang = Path(command(["/usr/bin/xcrun", "--find", "clang"], environment).strip()).resolve(strict=True)
    sdk = Path(command(["/usr/bin/xcrun", "--show-sdk-path"], environment).strip()).resolve(strict=True)
    if not sdk.is_dir() or not clang.is_file():
        raise RuntimeError("Native reader SDK or compiler unavailable")
    target = root / "reader.dylib"
    base = [str(clang), "-isysroot", str(sdk), "-Wall", "-Wextra", "-Werror"]
    guard = ["disk-guard", "run", "--budget-gb", "0.05", "--volume", str(root), "--volume", "/private/tmp",
             "--build-lane", str(root), "--"]
    def selections(text):
        return sorted({(str(Path(name).absolute()), str(Path(name).resolve(strict=True)))
                       for name in shlex.split(text.replace("\\\n", " "))[1:]})
    dependency_text = command([*guard, *base, "-M", str(source)], environment)
    dependencies = selections(dependency_text)
    if not dependencies or len(dependencies) > 512 or str(source) not in {row[1] for row in dependencies}:
        raise RuntimeError("Native reader dependency inventory unavailable")
    def bindings():
        return {"source": file_binding(source), "compiler": file_binding(clang), "xcrun": file_binding(Path("/usr/bin/xcrun")),
                "SDK": str(sdk), "dependency_resolution": [[name, str(Path(name).resolve(strict=True))] for name, _ in dependencies],
                "dependencies": [file_binding(Path(path)) for _, path in dependencies],
                "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
                "argv": [*base, "-dynamiclib", "-MD", "-MF", str(root / "compiled.d"), str(source), "-o", str(target)]}
    before = bindings()
    command([*guard, *before["argv"]], environment)
    if selections((root / "compiled.d").read_text()) != dependencies or bindings() != before:
        raise RuntimeError("Native reader inputs changed during compilation")
    target.chmod(0o600)
    artifact = file_binding(target)
    binding = {"schema": "maildesk-native-reader/v1", **before, "artifact": artifact}
    library = ctypes.CDLL(str(target), use_errno=True)
    if file_binding(target) != artifact:
        raise RuntimeError("Native reader artifact changed while loading")
    library.md_version.restype = ctypes.c_uint32
    library.md_exit_flag.restype = ctypes.c_uint32
    library.md_record_size.restype = library.md_kernel_record_size.restype = library.md_diagnostic_size.restype = ctypes.c_size_t
    library.md_get.argtypes = [ctypes.c_int, ctypes.POINTER(Record), ctypes.POINTER(Diagnostic)]
    library.md_get.restype = ctypes.c_int
    library.md_table.argtypes = [ctypes.POINTER(Record), ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(Diagnostic)]
    library.md_table.restype = ctypes.c_int
    exit_flag = library.md_exit_flag()
    if (library.md_version() != 4 or exit_flag == 0 or exit_flag & (exit_flag-1) or library.md_record_size() != ctypes.sizeof(Record) or
            library.md_diagnostic_size() != ctypes.sizeof(Diagnostic) or library.md_kernel_record_size() <= 0):
        raise RuntimeError("Native reader ABI is unsupported")
    binding["ABI"] = {"version": 4, "exiting_flag": exit_flag, "record_bytes": library.md_record_size(), "diagnostic_bytes": library.md_diagnostic_size(),
                      "kernel_record_bytes": library.md_kernel_record_size()}
    (root / "binding.json").write_text(json.dumps(binding, indent=2) + "\n")
    (root / "binding.json").chmod(0o600)
    # Production proof persists; only automatically owned temporary fixtures retire at exit.
    return library, binding, temporary


class Processes:
    def __init__(self, directory=None):
        self.lib, self.binding, self._lifetime = prepare(str(directory) if directory is not None else None)
        self.exiting_flag = self.binding["ABI"]["exiting_flag"]
        if file_binding(Path(__file__).with_suffix(".c")) != self.binding["source"]:
            raise RuntimeError("Native reader source changed after preparation")

    def check_artifact(self):
        expected = self.binding["artifact"]
        meta = Path(expected["path"]).lstat()
        actual = {"identity": [meta.st_dev, meta.st_ino], "size": meta.st_size, "mtime_ns": meta.st_mtime_ns,
                  "ctime_ns": meta.st_ctime_ns, "mode": stat.S_IMODE(meta.st_mode), "uid": meta.st_uid}
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or any(expected[key] != value for key, value in actual.items()):
            raise RuntimeError("Native reader artifact identity changed")

    def row(self, record, expected=None):
        if (record.pid <= 0 or expected is not None and record.pid != expected or record.uid != os.getuid() or
                record.seconds <= 0 or not 0 <= record.microseconds < 1_000_000 or record.status not in (2, 3, 4, 6, 7)):
            raise RuntimeError("Native process identity/owner drift or malformed record")
        if (record.flags & self.exiting_flag and
                (record.session > 0 and record.session_error == 0 or record.session == -1 and record.session_error in (0, errno.ESRCH)) and
                record.ppid >= 0 and record.pgid >= 0):
            attempted = record.session != -1 or record.session_error != 0
            return {"pid": record.pid, "birth": [record.seconds, record.microseconds], "ppid": None, "session": None,
                    "pgid": None, "state": "exiting", "native_evidence": {"flags": record.flags,
                    "session_result": record.session if attempted else None,
                    "session_errno": record.session_error if attempted else None, "ppid": record.ppid, "pgid": record.pgid}}
        if record.ppid < 0 or record.pgid <= 0 or record.session <= 0 or record.session_error != 0:
            raise RuntimeError("Native process identity/owner drift or malformed record")
        return {"pid": record.pid, "birth": [record.seconds, record.microseconds], "ppid": record.ppid,
                "session": record.session, "pgid": record.pgid}

    def get(self, pid):
        if type(pid) is not int or not 0 < pid < 2 ** 31:
            raise RuntimeError("Native process identity target must be a positive pid_t")
        self.check_artifact()
        record = Record(); detail = Diagnostic()
        result = self.lib.md_get(pid, ctypes.byref(record), ctypes.byref(detail))
        if result == 0:
            return None
        if result != 1:
            raise RuntimeError("Unknown native process identity for PID " + str(pid) + ": " + json.dumps(diagnostic_value(detail), sort_keys=True))
        return self.row(record, pid)

    def table(self):
        self.check_artifact()
        records = (Record * LIMIT)(); count = ctypes.c_size_t()
        detail = Diagnostic()
        result = self.lib.md_table(records, LIMIT, ctypes.byref(count), ctypes.byref(detail))
        if result != 0 or not 0 < count.value < LIMIT:
            raise RuntimeError("Native process population coverage unavailable: " + json.dumps({"result": result, "count": count.value,
                               "diagnostic": diagnostic_value(detail)}, sort_keys=True))
        rows = [self.row(record) for record in records[:count.value]]
        table = {row["pid"]: row for row in rows}
        if len(table) != len(rows) or os.getpid() not in table:
            raise RuntimeError("Native process population coverage unavailable: duplicates or observer missing")
        return table
