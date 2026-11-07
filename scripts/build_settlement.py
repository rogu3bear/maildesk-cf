"""Observed settlement for the repository's bounded native producer chains.

This is an attended, synchronous owner. It never cancels descendants, releases
their leases, runs a detached finalizer or claims universal fork observation.
"""
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

from native_processes import Processes


def atomic_save(path, value):
    path = Path(path); temporary = path.with_name(path.name + ".pending")
    if path.exists() or path.is_symlink():
        raise RuntimeError("Existing operation record cannot be replayed")
    with temporary.open("x") as stream:
        json.dump(value, stream, indent=2); stream.flush(); os.fsync(stream.fileno())
    os.rename(temporary, path)


class Tracker:
    @staticmethod
    def active_launch(row):
        if not isinstance(row, dict) or row.get("state", "active") != "active":
            return False
        return (all(type(row.get(key)) is int and row[key] > 0 for key in ("pid", "session", "pgid")) and
                type(row.get("ppid")) is int and row["ppid"] >= 0 and isinstance(row.get("birth"), list) and
                len(row["birth"]) == 2 and all(type(value) is int for value in row["birth"]) and
                row["birth"][0] > 0 and 0 <= row["birth"][1] < 1_000_000)

    def __init__(self, processes, root):
        if not self.active_launch(root):
            raise RuntimeError("Launch registration requires a complete active identity")
        self.processes, self.session = processes, root["session"]
        self.known = {root["pid"]: root}
        self.history = {(root["pid"], tuple(root["birth"])): root}
        self.root_pid = root["pid"]
        self.live = dict(self.known)
        self.ended = set()
        self.exiting = set()
        self.exit_history = []
        self.pending_exits = []
        self.population_observation = {"state": "unknown", "observed_at": None, "last_successful_observed_at": None}
        self.birth_observations = []

    def register(self, expected):
        if not self.active_launch(expected):
            raise RuntimeError("Recorded launch registration requires a complete active identity")
        if self.pending_exits:
            raise RuntimeError("Pending exit identities prevent launch acknowledgement")
        actual = self.processes.get(expected["pid"])
        if actual is None or actual["birth"] != expected["birth"]:
            raise RuntimeError("Registered generation changed before launch acknowledgement")
        if not self.active_launch(actual):
            raise RuntimeError("Launch registration requires a complete active identity")
        self.validate_generation(actual)
        self.known[actual["pid"]] = actual
        self.history[(actual["pid"], tuple(actual["birth"]))] = actual
        self.live[actual["pid"]] = actual

    def validate_generation(self, row, *, observe_state=True):
        pid = row["pid"]
        if pid in self.known and row["birth"] != self.known[pid]["birth"]:
            previous = (pid, tuple(self.known[pid]["birth"]))
            if pid == self.root_pid or previous not in self.ended:
                raise RuntimeError("Known process generation drift for PID " + str(pid) +
                                   " (expected=" + str(previous[1]) + ", observed=" + str(tuple(row["birth"])) + ")")
        if observe_state:
            key = (pid, tuple(row["birth"]))
            state = row.get("state", "active")
            if state == "exiting":
                evidence = row.get("native_evidence")
                flag = getattr(self.processes, "exiting_flag", 0)
                if (not flag or not isinstance(evidence, dict) or type(evidence.get("flags")) is not int or
                        not evidence["flags"] & flag or any(row[key] is not None for key in ("session", "ppid", "pgid"))):
                    raise RuntimeError("Unqualified native exit identity")
            if state not in ("active", "exiting") or key in self.exiting and state != "exiting":
                raise RuntimeError("Native exiting identity regressed or has an unsupported state")
            if state == "exiting" and key not in self.exiting:
                if len(self.exit_history) >= 16384:
                    raise RuntimeError("Native exit history exceeds qualified bound for PID " + str(pid))
                self.exiting.add(key)
                self.exit_history.append({"observed_at": time.time(), **row, "birth": list(row["birth"]),
                                          "native_evidence": dict(row["native_evidence"])})

    def scan(self):
        # Population coverage and known births are independent observations.
        # A denied peer must not prevent reads of already owned generations.
        errors = []
        self.pending_exits = None
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
        if table is not None:
            for row in table.values():
                try:
                    self.validate_generation(row)
                except Exception as error:
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
                if observation["state"] == "alive" and actual.get("state") == "exiting":
                    observation["state"] = "exiting"
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
                row.get("state") == "exiting" or
                pid in self.known and row["birth"] == self.known[pid]["birth"] or row["session"] == self.session}
        # Independent known-birth reads occur after the population snapshot.
        # Keep their newer exit state; an older active snapshot is not regression.
        for pid, actual in current.items():
            if pid in live and actual is not None and actual.get("state") == "exiting":
                live[pid] = actual
        while True:
            children = {pid: row for pid, row in table.items() if row["ppid"] in live and pid not in live}
            if not children:
                break
            live.update(children)
        for pid, row in live.items():
            try:
                self.validate_generation(row, observe_state=False)
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
        self.pending_exits = [row for row in live.values() if row.get("state") == "exiting"]
        return list(live.values())


def released(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    # Only this independently opened observation handle owns this lock.
    fcntl.flock(fd, fcntl.LOCK_UN)
    return True


def observe(child, output, tracker, lease, *, timeout=30, acknowledge=lambda: None, lease_evidence=None, control_errors=None, native_reader=None):
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
    result = {"status": "CACHE_RETAINED_SETTLEMENT_UNPROVED", "native_state_schema": "maildesk-native-state/v1", "stream_eof": [],
              "stream_eof_elapsed_seconds": {}, "reservation_observations": lease_evidence if lease_evidence is not None else {},
              "errors": control_errors if control_errors is not None else []}
    if native_reader is not None:
        result["native_reader"] = native_reader
    ended = None; last_scan = 0; live = None; acknowledged = False; lease_released = None
    last_live = None
    process_observation = {"state": "unknown", "attempted_elapsed_seconds": None, "last_successful_elapsed_seconds": None}
    lease_observation = dict(process_observation)
    def error_record(error):
        text = str(error)
        if text not in result["errors"]:
            result["errors"].append(text)

    def closure_observed():
        return live == [] and getattr(tracker, "pending_exits", []) == [] and lease_released is True and not selector.get_map()
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
                if not acknowledged and not result["errors"] and getattr(tracker, "pending_exits", []) == []:
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
                        "pending_exits": getattr(tracker, "pending_exits", None),
                        "exit_transition_history": getattr(tracker, "exit_history", []),
                        "exact_reservation_released": lease_released, "lease_observation": lease_observation})
            if code is not None and not selector.get_map() and (closure_observed() or result["errors"]):
                break
        for stream in (combined, stdout, stderr):
            stream.flush(); os.fsync(stream.fileno())
    selector.close()
    result.update(command_exit=code, known_generations=list(tracker.history.values()), live_generations=live,
                  pending_exits=getattr(tracker, "pending_exits", None), exit_transition_history=getattr(tracker, "exit_history", []),
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
    processes = Processes(output)
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
        expected_reader = {key: value for key, value in processes.binding.items() if key not in ("artifact", "argv")}
        inner_reader = candidate.get("native_reader")
        if not isinstance(inner_reader, dict) or {key: value for key, value in inner_reader.items() if key not in ("artifact", "argv")} != expected_reader:
            raise RuntimeError("Inner native reader source/compiler/SDK binding changed")
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
                       lease_evidence=evidence, control_errors=control_errors, native_reader=processes.binding)
    finally:
        for number, handler in handlers.items():
            signal.signal(number, handler)
        if fd is not None:
            os.close(fd)
