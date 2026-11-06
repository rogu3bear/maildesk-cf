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
            error = ctypes.get_errno()
            if size == 0 and error in (errno.ESRCH, errno.ENOENT):
                return None
            # An enumerated process can exit before libproc supplies a record.
            # An empty/errorless read alone proves nothing. Only independent
            # kernel absence qualifies this case; denial, partial data, a live
            # or reused PID, and any other probe failure remain unknown.
            absence = "not probed"
            if size == 0 and error == 0:
                try:
                    os.kill(pid, 0)
                    absence = "PID exists"
                except OSError as probe:
                    if probe.errno == errno.ESRCH:
                        return None
                    absence = "probe errno=" + str(probe.errno)
            raise RuntimeError("Unknown native process identity for PID " + str(pid) +
                               " (bytes=" + str(size) + ", errno=" + str(error) + ", " + absence + ")")
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
        population = [pid for pid in pids[:size // ctypes.sizeof(ctypes.c_int)] if pid > 0]
        if len(population) != len(set(population)):
            raise RuntimeError("Native process population coverage unavailable: duplicate PIDs")
        table = {pid: row for pid in population if (row := self.get(pid)) is not None}
        # This observer is necessarily live under the queried UID. Its absence
        # makes an empty or partial native snapshot unknown, never settled.
        if os.getpid() not in table:
            raise RuntimeError("Native process population coverage unavailable: observer missing")
        return table


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
        self.root_pid = root["pid"]
        self.live = dict(self.known)
        self.ended = set()
        self.population_observation = {"state": "unknown", "observed_at": None, "last_successful_observed_at": None}
        self.birth_observations = []

    def register(self, expected):
        actual = self.processes.get(expected["pid"])
        if actual is None or actual["birth"] != expected["birth"]:
            raise RuntimeError("Registered generation changed before launch acknowledgement")
        self.validate_generation(actual)
        self.known[actual["pid"]] = actual
        self.history[(actual["pid"], tuple(actual["birth"]))] = actual
        self.live[actual["pid"]] = actual

    def validate_generation(self, row):
        pid = row["pid"]
        if pid in self.known and row["birth"] != self.known[pid]["birth"]:
            previous = (pid, tuple(self.known[pid]["birth"]))
            if pid == self.root_pid or previous not in self.ended:
                raise RuntimeError("Known process generation drift for PID " + str(pid) +
                                   " (expected=" + str(previous[1]) + ", observed=" + str(tuple(row["birth"])) + ")")

    def scan(self):
        # Population coverage and known births are independent observations.
        # A denied peer must not prevent reads of already owned generations.
        errors = []
        table = None
        self.population_observation["attempted_at"] = time.time()
        try:
            table = self.processes.table()
            observed = time.time()
            self.population_observation.update(state="complete", observed_at=observed, last_successful_observed_at=observed)
            self.population_observation.pop("error", None)
        except Exception as error:
            self.population_observation.update(state="unknown", observed_at=None, error=str(error))
            errors.append(str(error))
        current = {}
        previous = {(r["pid"], tuple(r["birth"])): r for r in self.birth_observations}
        self.birth_observations = []
        for pid, expected in list(self.known.items()):
            key = (pid, tuple(expected["birth"]))
            observation = {"pid": pid, "birth": expected["birth"], "attempted_at": time.time(),
                           "observed_at": None, "state": "unknown",
                           "last_successful_observation": previous.get(key, {}).get("last_successful_observation")}
            try:
                actual = self.processes.get(pid)
                if actual is not None:
                    self.validate_generation(actual)
                current[pid] = actual
                observation["state"] = "alive" if actual is not None and actual["birth"] == expected["birth"] else "ended"
                observation["observed_at"] = time.time()
                observation["last_successful_observation"] = {"state": observation["state"],
                    "observed_at": observation["observed_at"], "observed_birth": actual["birth"] if actual is not None else None}
                if observation["state"] == "ended":
                    self.ended.add((pid, tuple(expected["birth"])))
            except Exception as error:
                observation["error"] = str(error)
                errors.append(str(error))
            self.birth_observations.append(observation)
        if table is None:
            raise RuntimeError("; ".join(dict.fromkeys(errors)))
        live = {pid: row for pid, row in table.items() if
                pid in self.known and row["birth"] == self.known[pid]["birth"] or row["session"] == self.session}
        while True:
            children = {pid: row for pid, row in table.items() if row["ppid"] in live and pid not in live}
            if not children:
                break
            live.update(children)
        for pid, row in live.items():
            try:
                self.validate_generation(row)
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("; ".join(dict.fromkeys(errors)))
        for pid, row in live.items():
            self.history[(pid, tuple(row["birth"]))] = row
        if len(self.history) > 16384:
            raise RuntimeError("Known producer population exceeds qualified bound")
        ended = set(self.ended)
        for pid, row in self.live.items():
            if pid not in live:
                actual = current[pid]
                if actual is not None and actual["birth"] == row["birth"]:
                    raise RuntimeError("Known live generation missing from native population for PID " + str(pid))
                # Only an independent identity read establishes this generation
                # ended. A later owned child may reuse its PID; preserve both
                # immutable births in history. The operation root never rebinds.
                ended.add((pid, tuple(row["birth"])))
        self.ended, self.live = ended, live
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
    ended = None; last_scan = 0; live = None; acknowledged = False; lease_released = None
    last_live = None
    process_observation = {"state": "unknown", "attempted_elapsed_seconds": None, "last_successful_elapsed_seconds": None}
    lease_observation = dict(process_observation)
    def error_record(error):
        text = str(error)
        if text not in result["errors"]:
            result["errors"].append(text)

    def closure_observed():
        return live == [] and lease_released is True and not selector.get_map()
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
                elapsed = now - started
                process_observation["attempted_elapsed_seconds"] = elapsed
                try:
                    live = tracker.scan()
                    last_live = live
                    process_observation.update(state="complete", last_successful_elapsed_seconds=time.monotonic() - started)
                    process_observation.pop("error", None)
                except Exception as error:
                    live = None
                    process_observation.update(state="unknown", error=str(error))
                    error_record(error)
                if not acknowledged and not result["errors"]:
                    try:
                        acknowledged = acknowledge()
                    except Exception as error:
                        error_record(error)
                # Always service the exact lease, even if process coverage or
                # acknowledgement failed. None means not yet observable.
                lease_observation["attempted_elapsed_seconds"] = time.monotonic() - started
                try:
                    lease_released = lease()
                    if lease_released is not None and type(lease_released) is not bool:
                        raise RuntimeError("Exact lease observation is not boolean or unknown")
                    lease_observation["state"] = "unknown" if lease_released is None else "released" if lease_released else "held"
                    if lease_released is not None:
                        lease_observation.update(last_successful_elapsed_seconds=time.monotonic() - started,
                                                 last_successful_released=lease_released)
                    lease_observation.pop("error", None)
                except Exception as error:
                    lease_released = None
                    lease_observation.update(state="unknown", error=str(error))
                    error_record(error)
                last_scan = now
            now = time.monotonic()
            code = child.poll()
            if code is not None and ended is None:
                ended = now
                result["direct_exit_elapsed_seconds"] = now - started
            if ended is not None and now - ended > timeout and not closure_observed():
                if "Settlement deadline exceeded" not in result["errors"]:
                    result["errors"].append("Settlement deadline exceeded")
                    atomic_save(output / "settlement-timeout.json", {**result, "live_generations": live,
                        "last_successful_live_generations": last_live, "process_scope_observation": process_observation,
                        "native_population_observation": getattr(tracker, "population_observation", {"state": "unknown"}),
                        "known_birth_observations": getattr(tracker, "birth_observations", []),
                        "exact_reservation_released": lease_released, "lease_observation": lease_observation})
            if code is not None and not selector.get_map() and (closure_observed() or result["errors"]):
                break
        for stream in (combined, stdout, stderr):
            stream.flush(); os.fsync(stream.fileno())
    selector.close()
    result.update(command_exit=code, known_generations=list(tracker.history.values()), live_generations=live,
                  last_successful_live_generations=last_live, process_scope_observation=process_observation,
                  native_population_observation=getattr(tracker, "population_observation", {"state": "unknown", "observed_at": None}),
                  known_birth_observations=getattr(tracker, "birth_observations", []), lease_observation=lease_observation,
                  exact_reservation_released=lease_released, launch_acknowledged=acknowledged,
                  owner_outside_reservation=not any(k in os.environ for k in ("DISK_GUARD_RESERVATION", "DISK_GUARD_CUSTODY")))
    if acknowledged and code == 0 and live == [] and lease_released is True and not result["errors"] and result["owner_outside_reservation"]:
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
    def prepare_binding():
        nonlocal binding, reservation, fd
        if fd is not None:
            return True
        path = output / "reservation-binding.json"
        if not path.exists():
            return False
        candidate = read_record(path)
        if len(candidate["capability"]["descriptors"]) != 1:
            raise RuntimeError("Watched custody requires its separately qualified outer owner")
        path_reservation = Path(candidate["reservation_path"])
        if path_reservation.resolve() != path_reservation or path_reservation.name != "reservation-" + candidate["capability"]["reservation_id"] + ".json":
            raise RuntimeError("Reservation namespace is not canonical and exact")
        probe = os.open(path_reservation, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            value = os.fstat(probe)
            if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or value.st_nlink != 1 or [value.st_dev, value.st_ino] != candidate["capability"]["descriptors"][0]:
                raise RuntimeError("Exact encompassing reservation identity changed")
            raw = os.pread(probe, 16385, 0)
            if len(raw) > 16384 or hashlib.sha256(raw).hexdigest() != candidate["reservation_record_sha256"] or json.loads(raw)["id"] != candidate["capability"]["reservation_id"]:
                raise RuntimeError("Exact encompassing reservation record changed")
        except Exception:
            os.close(probe)
            raise
        binding, reservation, fd = candidate, path_reservation, probe
        evidence.update(reservation_id=binding["capability"]["reservation_id"],
                        identity=binding["capability"]["descriptors"][0], path=str(reservation))
        return True
    def acknowledge():
        if not prepare_binding():
            return False
        tracker.register(binding["inner_generation"])
        if lease():
            raise RuntimeError("Expected live reservation was not held before launch")
        evidence["launch_lock_observed"] = True
        path = output / "reservation-binding.json"
        atomic_save(output / "launch-acknowledgement.json", {"binding_sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        return True
    def lease():
        if not prepare_binding():
            return None
        value = reservation.stat(follow_symlinks=False)
        if [value.st_dev, value.st_ino] != binding["capability"]["descriptors"][0]:
            raise RuntimeError("Reservation namespace drift; never infer natural release")
        value = released(fd)
        if not value:
            evidence["held_lock_observed"] = True
        elif evidence.get("held_lock_observed"):
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
