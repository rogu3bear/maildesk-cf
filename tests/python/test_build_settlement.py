"""Native normal-exit controls; all processes/leases are disposable fixtures."""
import fcntl
import ctypes
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import types

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import build_cache_retirement as cache
import build_settlement as settlement


class NativeIdentityTests(unittest.TestCase):
    def reader(self, size, error):
        reader = settlement.Processes.__new__(settlement.Processes)
        def query(*args):
            ctypes.set_errno(error)
            return size
        reader.lib = types.SimpleNamespace(proc_pidinfo=query)
        return reader

    def test_empty_errorless_query_requires_independent_kernel_absence(self):
        reader = self.reader(0, 0)
        with mock.patch.object(settlement.os, "kill", side_effect=ProcessLookupError(errno.ESRCH, "ended")) as probe:
            self.assertIsNone(reader.get(12345))
        probe.assert_called_once_with(12345, 0)

    def test_live_or_reused_pid_never_becomes_an_empty_population(self):
        with mock.patch.object(settlement.os, "kill", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "bytes=0, errno=0, PID exists"):
                self.reader(0, 0).get(12345)

    def test_denied_absence_probe_preserves_unknown(self):
        with mock.patch.object(settlement.os, "kill", side_effect=PermissionError(errno.EPERM, "denied")):
            with self.assertRaisesRegex(RuntimeError, "probe errno=1"):
                self.reader(0, 0).get(12345)

    def test_native_denial_is_not_relabelled_as_exit(self):
        with mock.patch.object(settlement.os, "kill") as probe:
            with self.assertRaisesRegex(RuntimeError, "bytes=0, errno=1, not probed"):
                self.reader(0, errno.EPERM).get(12345)
        probe.assert_not_called()

    def test_partial_native_record_remains_unknown(self):
        for error in (0, errno.ESRCH, errno.ENOENT, errno.EPERM):
            with self.subTest(error=error), mock.patch.object(settlement.os, "kill") as probe:
                with self.assertRaisesRegex(RuntimeError, "not probed"):
                    self.reader(ctypes.sizeof(settlement.BSDInfo) - 1, error).get(12345)
                probe.assert_not_called()

    def test_explicit_native_absence_needs_no_fallback(self):
        for error in (errno.ESRCH, errno.ENOENT):
            with self.subTest(error=error), mock.patch.object(settlement.os, "kill") as probe:
                self.assertIsNone(self.reader(0, error).get(12345))
                probe.assert_not_called()

    def population(self, pids, identities):
        reader = settlement.Processes.__new__(settlement.Processes)
        def query(_kind, _uid, buffer, _size):
            target = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_int))
            for index, pid in enumerate(pids):
                target[index] = pid
            return len(pids) * ctypes.sizeof(ctypes.c_int)
        reader.lib = types.SimpleNamespace(proc_listpids=query)
        reader.get = mock.Mock(side_effect=lambda pid: identities.get(pid))
        return reader

    def test_population_requires_the_live_observer(self):
        observer = os.getpid()
        for pids, identities in (([0], {}), ([observer + 1], {observer + 1: {"pid": observer + 1}}),
                                  ([observer], {})):
            with self.subTest(pids=pids, identities=identities):
                with self.assertRaisesRegex(RuntimeError, "population coverage unavailable"):
                    self.population(pids, identities).table()

    def test_population_rejects_duplicate_process_ids(self):
        observer = os.getpid()
        with self.assertRaisesRegex(RuntimeError, "population coverage unavailable"):
            self.population([observer, observer], {observer: {"pid": observer}}).table()

    def test_population_allows_exited_peers_and_zero_padding(self):
        observer = os.getpid()
        identity = {"pid": observer}
        self.assertEqual(self.population([observer, 0, observer + 1], {observer: identity}).table(),
                         {observer: identity})


@unittest.skipUnless(sys.platform == "darwin", "Native settlement requires its qualified Darwin identity reader")
class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maildesk-settlement-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name).resolve()

    def run_case(self, mode, *, timeout=2, query_error=False, drift=False):
        lease = self.output / "fixture-reservation"
        held = lease.open("w+b"); fcntl.flock(held, fcntl.LOCK_EX)
        probe = os.open(lease, os.O_RDONLY)
        self.addCleanup(os.close, probe)
        code = '''import json,os,signal,subprocess,sys,time
fd=int(sys.argv[1]); mode=sys.argv[2]; done=sys.argv[3]
host=json.loads(os.environ.get("FIXTURE_HOST_FDS","[]"))
print("owned stdout",flush=True);print("owned stderr",file=sys.stderr,flush=True)
if mode not in ("direct","signal"):
 child="import os,sys,time; "
 if mode == "closed": child+="os.close(1);os.close(2); "
 child+="time.sleep(.45); open(sys.argv[1],'w').write('natural child exit')"
 kwargs={"pass_fds":tuple(host+([fd] if mode=="lease" else []))}
 if mode in ("lease","closed"):kwargs.update(stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if mode=="closed":kwargs["start_new_session"]=True
 subprocess.Popen([sys.executable,"-c",child,done],**kwargs)
time.sleep(.18)
if mode=="signal":os.kill(os.getpid(),signal.SIGTERM)
'''
        host = cache.inherited_fds(os.environ)
        child = subprocess.Popen([sys.executable, "-c", code, str(held.fileno()), mode, str(self.output / "child-done")],
            pass_fds=(held.fileno(), *host), stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            env={**os.environ, "FIXTURE_HOST_FDS": json.dumps(host)})
        held.close()  # Only the fixture descendants now retain the fixture lease.
        native = settlement.Processes()
        root = native.get(child.pid); self.assertIsNotNone(root)
        tracker = settlement.Tracker(native, root)
        if drift:
            tracker.known[child.pid] = {**root, "birth": [0, 0]}
        if query_error:
            class Unknown:
                history = tracker.history
                def scan(self):
                    raise RuntimeError("Owned fixture native-query failure")
            tracker = Unknown()
        started = time.monotonic()
        result = settlement.observe(child, self.output, tracker, lambda: settlement.released(probe),
            timeout=timeout, acknowledge=lambda: True)
        elapsed = time.monotonic() - started
        self.assertEqual(child.wait(timeout=2), -15 if mode == "signal" else 0)
        if mode not in ("direct", "signal"):
            deadline = time.monotonic() + 3
            while not (self.output / "child-done").exists():
                self.assertLess(time.monotonic(), deadline, "Fixture child must settle naturally; never cancel it")
                time.sleep(.02)
        return result[1], elapsed

    def test_normal_exit_closes_both_captured_streams_and_releases_exact_fixture_lease(self):
        result, _ = self.run_case("direct")
        self.assertEqual(sorted(result["stream_eof"]), ["stderr", "stdout"])
        self.assertTrue(result["exact_reservation_released"])
        self.assertFalse(result["live_generations"])
        self.assertFalse(result["errors"])
        self.assertEqual((self.output / "stdout.log").read_text(), "owned stdout\n")
        self.assertEqual((self.output / "stderr.log").read_text(), "owned stderr\n")
        expected = "SETTLED" if result["owner_outside_reservation"] else "CACHE_RETAINED_SETTLEMENT_UNPROVED"
        self.assertEqual(result["status"], expected)

    def test_direct_child_return_does_not_release_a_descendant_held_reservation(self):
        result, elapsed = self.run_case("lease")
        self.assertGreater(elapsed, .4)
        self.assertLess(max(result["stream_eof_elapsed_seconds"].values()), .4)
        self.assertTrue(result["exact_reservation_released"])
        self.assertGreaterEqual(len(result["known_generations"]), 2)

    def test_signalled_exit_retains_its_failure_diagnostics_and_never_qualifies_success(self):
        result, _ = self.run_case("signal")
        self.assertEqual(result["command_exit"], -15)
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")
        self.assertTrue(result["exact_reservation_released"])
        self.assertEqual((self.output / "stderr.log").read_text(), "owned stderr\n")

    def test_direct_child_return_does_not_mean_captured_writer_eof(self):
        result, elapsed = self.run_case("streams")
        self.assertGreater(elapsed, .4)
        self.assertGreater(min(result["stream_eof_elapsed_seconds"].values()), .4)
        self.assertLess(result["direct_exit_elapsed_seconds"], .4)

    def test_descendant_closing_streams_and_lease_is_still_an_active_generation(self):
        result, elapsed = self.run_case("closed")
        self.assertGreater(elapsed, .4)
        self.assertLess(max(result["stream_eof_elapsed_seconds"].values()), .4)
        self.assertGreaterEqual(len(result["known_generations"]), 2)
        self.assertFalse(result["live_generations"])

    def test_settlement_timeout_permanently_retains_cache_and_drains_natural_exit(self):
        result, _ = self.run_case("streams", timeout=.05)
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")
        self.assertIn("Settlement deadline exceeded", result["errors"])
        self.assertTrue((self.output / "settlement-timeout.json").exists())
        self.assertTrue((self.output / "child-done").exists())

    def test_native_query_unknown_retains_cache(self):
        result, _ = self.run_case("direct", query_error=True)
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")
        self.assertTrue(any("native-query failure" in x for x in result["errors"]))

    def test_process_generation_drift_retains_cache(self):
        result, _ = self.run_case("direct", drift=True)
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")
        self.assertTrue(any("generation drift" in x for x in result["errors"]))


if __name__ == "__main__":
    unittest.main()
