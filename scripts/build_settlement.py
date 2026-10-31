"""Observed settlement for the repository's bounded native producer chains.

This is an attended, synchronous owner. It never cancels descendants, releases
their leases, runs a detached finalizer or claims universal fork observation.
"""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time


class BSDInfo(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint32) for n in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
        "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
    _fields_ += [(n, ctypes.c_uint32) for n in ("nfiles", "pgid", "jobc", "tdev", "tpgid")]
    _fields_ += [("nice", ctypes.c_int32), ("seconds", ctypes.c_uint64), ("microseconds", ctypes.c_uint64)]


class Processes:
    def __init__(self):
        if sys.platform != "darwin":
            raise RuntimeError("Native process settlement is qualified only on Darwin")
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listpids.restype = ctypes.c_int

    def get(self, pid):
        row = BSDInfo(); ctypes.set_errno(0)
        size = self.lib.proc_pidinfo(pid, 3, 0, ctypes.byref(row), ctypes.sizeof(row))
        if size != ctypes.sizeof(row):
            if ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
                return None
            raise RuntimeError("Unknown native process identity for PID " + str(pid))
        if row.pid != pid or row.uid != os.getuid() or not row.seconds:
            raise RuntimeError("Native process identity/owner drift")
        if row.status == 5:  # Kernel zombie: no executable writer remains.
            return None
        try:
            session = os.getsid(pid)
        except ProcessLookupError:
            return None
        return {"pid": pid, "birth": [row.seconds, row.microseconds], "ppid": row.ppid,
                "session": session, "pgid": row.pgid}

    def table(self):
        pids = (ctypes.c_int * 16384)()
        size = self.lib.proc_listpids(4, os.getuid(), ctypes.byref(pids), ctypes.sizeof(pids))
        if size <= 0 or size >= ctypes.sizeof(pids) or size % ctypes.sizeof(ctypes.c_int):
            raise RuntimeError("Native process population coverage unavailable")
        return {pid: row for pid in pids[:size // ctypes.sizeof(ctypes.c_int)] if pid > 0
                if (row := self.get(pid)) is not None}


def atomic_save(path, value):
    path = Path(path); temporary = path.with_name(path.name + ".pending")
    if path.exists() or path.is_symlink():
        raise RuntimeError("Existing operation record cannot be replayed")
    with temporary.open("x") as stream:
        json.dump(value, stream, indent=2); stream.flush(); os.fsync(stream.fileno())
    os.rename(temporary, path)


class Tracker:
    def __init__(self, processes, root):
        self.processes, self.session = processes, root["session"]
        self.known = {root["pid"]: root}
        self.history = {(root["pid"], tuple(root["birth"])): root}

    def register(self, expected):
        actual = self.processes.get(expected["pid"])
        if actual is None or actual["birth"] != expected["birth"]:
            raise RuntimeError("Registered generation changed before launch acknowledgement")
        self.known[actual["pid"]] = actual
        self.history[(actual["pid"], tuple(actual["birth"]))] = actual

    def scan(self):
        table = self.processes.table()
        live = {pid: row for pid, row in table.items() if
                pid in self.known and row["birth"] == self.known[pid]["birth"] or row["session"] == self.session}
        while True:
            children = {pid: row for pid, row in table.items() if row["ppid"] in live and pid not in live}
            if not children:
                break
            live.update(children)
        for pid, row in live.items():
            key = (pid, tuple(row["birth"]))
            if pid in self.known and row["birth"] != self.known[pid]["birth"]:
                raise RuntimeError("Known process generation drift")
            self.history[key] = row
        if len(self.history) > 16384:
            raise RuntimeError("Known producer population exceeds qualified bound")
        self.known.update(live)
        return list(live.values())


def released(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    # Only this independently opened observation handle owns this lock.
    fcntl.flock(fd, fcntl.LOCK_UN)
    return True


def observe(child, output, tracker, lease, *, timeout=30, acknowledge=lambda: None, lease_evidence=None, control_errors=None):
    """Drain both captured streams and observe independent process/lease gates.

    A missed deadline permanently refuses cleanup. The same attended owner
    continues draining remaining writers until natural EOF; it never kills a
    child or abandons a pipe to force settlement.
    """
    selector = selectors.DefaultSelector()
    streams = {child.stdout: "stdout", child.stderr: "stderr"}
    for stream in streams:
        os.set_blocking(stream.fileno(), False); selector.register(stream, selectors.EVENT_READ)
    started = time.monotonic()
    result = {"status": "CACHE_RETAINED_SETTLEMENT_UNPROVED", "stream_eof": [],
              "stream_eof_elapsed_seconds": {}, "reservation_observations": lease_evidence if lease_evidence is not None else {},
              "errors": control_errors if control_errors is not None else []}
    ended = None; last_scan = 0; live = []; acknowledged = False; locked = True
    with (output / "operation.log").open("xb") as combined, (output / "stdout.log").open("xb") as stdout, (output / "stderr.log").open("xb") as stderr:
        logs = {"stdout": stdout, "stderr": stderr}
        while True:
            for key, _ in selector.select(0.025):
                data = os.read(key.fileobj.fileno(), 65536)
                if data:
                    combined.write(data); logs[streams[key.fileobj]].write(data)
                else:
                    name = streams[key.fileobj]
                    result["stream_eof"].append(name); result["stream_eof_elapsed_seconds"][name] = time.monotonic() - started
                    selector.unregister(key.fileobj); key.fileobj.close()
            now = time.monotonic()
            if now - last_scan >= 0.05:
                try:
                    live = tracker.scan()
                    if not acknowledged and not result["errors"]:
                        acknowledged = acknowledge()
                    locked = not lease()
                except Exception as error:
                    text = str(error)
                    if text not in result["errors"]:
                        result["errors"].append(text)
                last_scan = now
            code = child.poll()
            if code is not None and ended is None:
                ended = now
                result["direct_exit_elapsed_seconds"] = now - started
            if ended is not None and now - ended > timeout and not (not live and not locked and not selector.get_map()):
                if "Settlement deadline exceeded" not in result["errors"]:
                    result["errors"].append("Settlement deadline exceeded")
                    atomic_save(output / "settlement-timeout.json", {**result, "live_generations": live, "exact_reservation_still_locked": locked})
            if code is not None and not selector.get_map() and (not live and not locked or result["errors"]):
                break
        for stream in (combined, stdout, stderr):
            stream.flush(); os.fsync(stream.fileno())
    selector.close()
    result.update(command_exit=code, known_generations=list(tracker.history.values()), live_generations=live,
                  exact_reservation_released=not locked, launch_acknowledged=acknowledged,
                  owner_outside_reservation=not any(k in os.environ for k in ("DISK_GUARD_RESERVATION", "DISK_GUARD_CUSTODY")))
    if acknowledged and code == 0 and not live and not locked and not result["errors"] and result["owner_outside_reservation"]:
        result["status"] = "SETTLED"
    atomic_save(output / "settlement.json", result)
    return code, result


def run(argv, *, cwd, env, output, read_record, timeout=30):
    processes = Processes()
    child = subprocess.Popen(argv, cwd=cwd, env=env, start_new_session=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    root = None
    try:
        root = processes.get(child.pid)
        if root is None:
            raise RuntimeError("Guard generation ended before owner registration; cache retained")
        tracker = Tracker(processes, root)
    except Exception as error:
        problem = str(error)
        class UnqualifiedTracker:
            history = {}
            def scan(self):
                raise RuntimeError(problem)
        tracker = UnqualifiedTracker()
    binding = None; reservation = None; fd = None
    evidence = {}
    control_errors = []
    def forward_user_signal(number, _frame):
        control_errors.append("Owner cancellation requested: " + str(number))
        try:
            actual = processes.get(child.pid)
            if root is not None and actual is not None and actual["birth"] == root["birth"]:
                child.send_signal(number)
        except Exception as error:
            control_errors.append("Cancellation generation unavailable: " + str(error))
    handlers = {number: signal.signal(number, forward_user_signal) for number in (signal.SIGINT, signal.SIGTERM)}
    def acknowledge():
        nonlocal binding, reservation, fd
        path = output / "reservation-binding.json"
        if not path.exists():
            return False
        binding = read_record(path)
        if len(binding["capability"]["descriptors"]) != 1:
            raise RuntimeError("Watched custody requires its separately qualified outer owner")
        tracker.register(binding["inner_generation"])
        reservation = Path(binding["reservation_path"])
        if reservation.resolve() != reservation or reservation.name != "reservation-" + binding["capability"]["reservation_id"] + ".json":
            raise RuntimeError("Reservation namespace is not canonical and exact")
        fd = os.open(reservation, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        value = os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or value.st_nlink != 1 or [value.st_dev, value.st_ino] != binding["capability"]["descriptors"][0]:
            raise RuntimeError("Exact encompassing reservation identity changed")
        raw = os.pread(fd, 16385, 0)
        if len(raw) > 16384 or hashlib.sha256(raw).hexdigest() != binding["reservation_record_sha256"] or json.loads(raw)["id"] != binding["capability"]["reservation_id"]:
            raise RuntimeError("Exact encompassing reservation record changed")
        if released(fd):
            raise RuntimeError("Expected live reservation was not held before launch")
        evidence.update(reservation_id=binding["capability"]["reservation_id"],
                        identity=binding["capability"]["descriptors"][0], path=str(reservation), launch_lock_observed=True)
        atomic_save(output / "launch-acknowledgement.json", {"binding_sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        return True
    def lease():
        if fd is None:
            return False
        value = reservation.stat(follow_symlinks=False)
        if [value.st_dev, value.st_ino] != binding["capability"]["descriptors"][0]:
            raise RuntimeError("Reservation namespace drift; never infer natural release")
        value = released(fd)
        if value:
            evidence["natural_release_lock_observed"] = True
        return value
    try:
        return observe(child, output, tracker, lease, timeout=timeout, acknowledge=acknowledge,
                       lease_evidence=evidence, control_errors=control_errors)
    finally:
        for number, handler in handlers.items():
            signal.signal(number, handler)
        if fd is not None:
            os.close(fd)
