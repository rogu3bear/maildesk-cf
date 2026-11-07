"""Native normal-exit controls; all processes/leases are disposable fixtures."""
import fcntl
import json
import itertools
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


class GenerationTrackingTests(unittest.TestCase):
    def setUp(self):
        self.root = {"pid": 10, "birth": [1, 0], "ppid": 1, "session": 10, "pgid": 10}
        self.child = {"pid": 11, "birth": [2, 0], "ppid": 10, "session": 10, "pgid": 10}
        self.current = {10: self.root, 11: self.child}
        self.native = types.SimpleNamespace(table=lambda: dict(self.current),
                                            get=mock.Mock(side_effect=lambda pid: self.current.get(pid)), exiting_flag=0x2000)
        self.tracker = settlement.Tracker(self.native, self.root)

    def exiting(self, row):
        return {**row, "state": "exiting", "ppid": None, "pgid": None, "session": None,
                "native_evidence": {"flags": 0x2000, "session_errno": 3}}

    def test_known_and_unrelated_exiting_births_stay_live_until_independent_resolution(self):
        self.tracker.scan()
        self.current[11] = self.exiting(self.child)
        self.current[99] = self.exiting({**self.child, 'pid': 99, 'birth': [4, 0]})
        self.assertEqual({r['pid'] for r in self.tracker.scan()}, {10, 11, 99})
        self.assertEqual(len(self.tracker.pending_exits), 2)
        self.assertEqual(len(self.tracker.exit_history), 2)
        self.current.pop(11); self.current.pop(99)
        self.assertEqual(self.tracker.scan(), [self.root])
        self.assertEqual(self.tracker.pending_exits, [])
        self.assertEqual(len(self.tracker.exit_history), 2)
        self.native.get.assert_any_call(99)

    def test_exit_to_active_regression_and_pending_registration_refuse(self):
        pending = self.exiting(self.child)
        self.current[11] = pending; self.tracker.scan()
        with self.assertRaisesRegex(RuntimeError, 'Pending exit'): self.tracker.register(self.root)
        self.current[11] = self.child
        with self.assertRaisesRegex(RuntimeError, 'regressed'): self.tracker.scan()
        with self.assertRaisesRegex(RuntimeError, 'active identity'): settlement.Tracker(self.native, self.exiting(self.root))

    def test_newer_known_exit_does_not_make_an_older_active_snapshot_a_regression(self):
        self.tracker.scan()
        self.native.get.side_effect = lambda pid: self.exiting(self.child) if pid == 11 else self.current.get(pid)
        rows = self.tracker.scan()
        self.assertEqual(next(r for r in rows if r['pid'] == 11)['state'], 'exiting')

    def test_exiting_snapshot_then_later_active_known_read_is_a_regression(self):
        self.tracker.scan()
        self.current[11] = self.exiting(self.child)
        self.native.get.side_effect = lambda pid: self.child if pid == 11 else self.current.get(pid)
        with self.assertRaisesRegex(RuntimeError, 'regressed'): self.tracker.scan()

    def test_exiting_label_without_kernel_flag_evidence_is_unknown(self):
        self.current[11] = {**self.exiting(self.child), 'native_evidence': {'flags': 0}}
        with self.assertRaisesRegex(RuntimeError, 'Unqualified native exit'): self.tracker.scan()

    def test_recorded_launch_must_be_active_and_complete_even_when_current_is_active(self):
        for expected in (self.exiting(self.root), {**self.root, 'session': None}, {**self.root, 'pgid': None}):
            with self.subTest(expected=expected), self.assertRaisesRegex(RuntimeError, 'Recorded launch'):
                self.tracker.register(expected)

    def test_exit_history_retains_an_immutable_observation(self):
        self.current[11] = self.exiting(self.child)
        self.tracker.scan()
        self.current[11]['native_evidence']['flags'] = 0
        self.assertEqual(self.tracker.exit_history[0]['native_evidence']['flags'], 0x2000)

    def test_reused_child_pid_requires_prior_independent_generation_exit(self):
        self.tracker.scan()
        self.current.pop(11)
        self.tracker.scan()
        self.native.get.assert_any_call(11)
        replacement = {**self.child, "birth": [3, 0]}
        self.current[11] = replacement
        self.assertEqual(self.tracker.scan(), [self.root, replacement])
        self.assertEqual(len(self.tracker.history), 3)
        self.assertEqual(self.tracker.history[(11, (2, 0))], self.child)

    def test_changed_live_generation_still_refuses(self):
        self.tracker.scan()
        self.current[11] = {**self.child, "birth": [3, 0]}
        with self.assertRaisesRegex(RuntimeError, "generation drift.*PID 11"):
            self.tracker.scan()

    def test_population_omission_does_not_establish_generation_exit(self):
        self.tracker.scan()
        self.current.pop(11)
        self.native.get.side_effect = lambda pid: self.child if pid == 11 else self.current.get(pid)
        with self.assertRaisesRegex(RuntimeError, "live generation missing"):
            self.tracker.scan()
        self.current[11] = {**self.child, "birth": [3, 0]}
        with self.assertRaisesRegex(RuntimeError, "generation drift"):
            self.tracker.scan()

    def test_root_identity_never_rebinds_after_exit(self):
        self.tracker.scan()
        self.current.clear()
        self.tracker.scan()
        self.current[10] = {**self.root, "birth": [4, 0]}
        with self.assertRaisesRegex(RuntimeError, "generation drift.*PID 10"):
            self.tracker.scan()

    def test_registration_cannot_rebind_a_live_generation(self):
        self.tracker.scan()
        self.current[11] = {**self.child, "birth": [3, 0]}
        with self.assertRaisesRegex(RuntimeError, "generation drift.*PID 11"):
            self.tracker.register(self.current[11])

    def test_denied_exit_observation_never_qualifies_reuse(self):
        self.tracker.scan()
        self.current.pop(11)
        self.native.get.side_effect = RuntimeError("native identity unknown")
        with self.assertRaisesRegex(RuntimeError, "native identity unknown"):
            self.tracker.scan()
        self.current[11] = {**self.child, "birth": [3, 0]}
        with self.assertRaisesRegex(RuntimeError, "generation drift"):
            self.tracker.scan()

    def test_population_failure_still_observes_each_known_birth(self):
        self.tracker.scan()
        self.native.table = mock.Mock(side_effect=RuntimeError("population unknown"))
        self.current.pop(11)
        with self.assertRaisesRegex(RuntimeError, "population unknown"):
            self.tracker.scan()
        self.assertEqual(self.tracker.population_observation["state"], "unknown")
        self.assertEqual([r["state"] for r in self.tracker.birth_observations], ["alive", "ended"])

    def test_denied_known_identity_does_not_suppress_other_birth_observations(self):
        self.tracker.scan()
        def get(pid):
            if pid == 10:
                raise RuntimeError("known identity denied")
            return self.current.get(pid)
        self.native.get.side_effect = get
        with self.assertRaisesRegex(RuntimeError, "known identity denied"):
            self.tracker.scan()
        self.assertEqual(self.tracker.population_observation["state"], "complete")
        self.assertEqual([r["state"] for r in self.tracker.birth_observations], ["unknown", "alive"])
        self.assertIsNone(self.tracker.birth_observations[0]["observed_at"])
        self.assertEqual(self.tracker.birth_observations[0]["last_successful_observation"]["state"], "alive")

    def test_changed_session_and_process_group_child_remains_in_scope(self):
        self.current[11] = {**self.child, "session": 11, "pgid": 11}
        grandchild = {"pid": 12, "birth": [3, 0], "ppid": 11, "session": 12, "pgid": 12}
        self.current[12] = grandchild
        self.assertEqual({r["pid"] for r in self.tracker.scan()}, {10, 11, 12})
        self.current[11] = {**self.current[11], "ppid": 1}
        self.current[12] = {**grandchild, "ppid": 1}
        self.assertEqual({r["pid"] for r in self.tracker.scan()}, {10, 11, 12})


class IndependentObservationTests(unittest.TestCase):
    """Only disposable pipes/files and injected observations; no native PID queries."""
    def observe(self, scans, leases, *, acknowledge=lambda: True, pending=None, relationships=None):
        with tempfile.TemporaryDirectory(prefix="maildesk-observation-fixture-") as directory:
            pipes = []
            for _ in range(2):
                read, write = os.pipe()
                os.close(write)
                pipes.append(os.fdopen(read, "rb"))
            child = types.SimpleNamespace(stdout=pipes[0], stderr=pipes[1],
                                          poll=mock.Mock(side_effect=[None, 0]))
            tracker = types.SimpleNamespace(history={}, pending_exits=[], pending_relationships=[])
            scan_values = iter(scans); pending_values = iter(pending) if pending is not None else None
            relationship_values = iter(relationships) if relationships is not None else None
            def scan():
                value = next(scan_values)
                if pending_values is not None: tracker.pending_exits = next(pending_values)
                if relationship_values is not None: tracker.pending_relationships = next(relationship_values)
                if isinstance(value, Exception): raise value
                return value
            tracker.scan = mock.Mock(side_effect=scan)
            lease = mock.Mock(side_effect=leases)
            try:
                with mock.patch.object(settlement.time, "monotonic", side_effect=itertools.count(1, .1)):
                    _, result = settlement.observe(child, Path(directory), tracker, lease, acknowledge=acknowledge)
            finally:
                for stream in pipes:
                    stream.close()
            return result, lease

    def test_pending_exit_blocks_ack_and_closure_until_resolved(self):
        pending = [{'pid': 11, 'birth': [2, 0], 'state': 'exiting'}]
        acknowledge = mock.Mock(return_value=True)
        result, lease = self.observe([pending, []], [True, True], acknowledge=acknowledge, pending=[pending, []])
        self.assertEqual(lease.call_count, 2)
        acknowledge.assert_called_once()
        self.assertEqual(result['pending_exits'], [])
        self.assertEqual(result['errors'], [])

    def test_relationship_pending_blocks_ack_and_closure_even_with_empty_live_projection(self):
        pending = [{"pid": 99, "birth": [3, 0]}]
        acknowledge = mock.Mock(return_value=True)
        result, lease = self.observe([[], []], [True, True], acknowledge=acknowledge, relationships=[pending, []])
        self.assertEqual(lease.call_count, 2)
        acknowledge.assert_called_once()
        self.assertEqual(result["pending_relationships"], [])
        self.assertEqual(result["errors"], [])

    def test_process_failure_does_not_suppress_exact_lease_release(self):
        stale = [{"pid": 10, "birth": [1, 0]}]
        result, lease = self.observe([stale, RuntimeError("population denied")], [False, True])
        self.assertEqual(lease.call_count, 2)
        self.assertIsNone(result["live_generations"])
        self.assertEqual(result["last_successful_live_generations"], stale)
        self.assertEqual(result["process_scope_observation"]["state"], "unknown")
        self.assertLess(result["process_scope_observation"]["last_successful_elapsed_seconds"],
                        result["process_scope_observation"]["attempted_elapsed_seconds"])
        self.assertIs(result["exact_reservation_released"], True)
        self.assertEqual(result["lease_observation"]["state"], "released")
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")

    def test_lease_failure_does_not_turn_last_held_state_into_current_fact(self):
        result, _ = self.observe([[], []], [False, RuntimeError("lease identity changed")])
        self.assertEqual(result["live_generations"], [])
        self.assertIsNone(result["exact_reservation_released"])
        self.assertEqual(result["lease_observation"]["state"], "unknown")
        self.assertIs(result["lease_observation"]["last_successful_released"], False)
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")

    def test_acknowledgement_failure_still_polls_lease(self):
        def denied():
            raise RuntimeError("registration identity unknown")
        result, lease = self.observe([[], []], [True, True], acknowledge=denied)
        self.assertEqual(lease.call_count, 2)
        self.assertIs(result["exact_reservation_released"], True)
        self.assertFalse(result["launch_acknowledged"])
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")

    def test_unobservable_lease_stays_unknown(self):
        result, _ = self.observe([[], []], [None, RuntimeError("binding unavailable")])
        self.assertIsNone(result["exact_reservation_released"])
        self.assertIsNone(result["lease_observation"]["last_successful_elapsed_seconds"])

    def test_later_complete_observations_do_not_clear_prior_uncertainty(self):
        result, _ = self.observe([RuntimeError("population denied"), []], [False, True])
        self.assertEqual(result["live_generations"], [])
        self.assertEqual(result["process_scope_observation"]["state"], "complete")
        self.assertEqual(result["errors"], ["population denied"])
        self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")

    def binding_case(self, *, initially_held):
        with tempfile.TemporaryDirectory(prefix="maildesk-binding-fixture-") as directory:
            output = Path(directory).resolve()
            reservation = output / "reservation-fixture.json"
            reservation.write_text('{"id":"fixture"}')
            value = reservation.stat()
            root = {"pid": 10, "birth": [1, 0], "ppid": 1, "session": 10, "pgid": 10}
            reader_binding = {"fixture": "controlled native reader"}
            binding = {"native_reader": reader_binding,
                "capability": {"reservation_id": "fixture", "descriptors": [[value.st_dev, value.st_ino]]},
                "inner_generation": root, "reservation_path": str(reservation),
                "reservation_record_sha256": settlement.hashlib.sha256(reservation.read_bytes()).hexdigest()}
            (output / "reservation-binding.json").write_text(json.dumps(binding))
            held = reservation.open("r+b")
            if initially_held:
                fcntl.flock(held, fcntl.LOCK_EX)
            scans = 0
            def denied_population():
                nonlocal scans
                scans += 1
                if scans == 2 and initially_held:
                    fcntl.flock(held, fcntl.LOCK_UN)
                raise RuntimeError("population denied")
            native = types.SimpleNamespace(get=mock.Mock(return_value=root), table=denied_population,
                                           binding=reader_binding)
            pipes = []
            for _ in range(2):
                read, write = os.pipe(); os.close(write)
                pipes.append(os.fdopen(read, "rb"))
            child = types.SimpleNamespace(pid=10, stdout=pipes[0], stderr=pipes[1],
                                          poll=mock.Mock(side_effect=[None, 0]))
            try:
                with mock.patch.object(settlement, "Processes", return_value=native), \
                        mock.patch.object(settlement.subprocess, "Popen", return_value=child), \
                        mock.patch.object(settlement.time, "monotonic", side_effect=itertools.count(1, .1)), \
                        mock.patch.object(settlement.signal, "signal"):
                    _, result = settlement.run(["fixture"], cwd=output, env={}, output=output,
                                              read_record=lambda p: json.loads(p.read_text()))
            finally:
                for stream in pipes:
                    stream.close()
                held.close()
            self.assertFalse(result["launch_acknowledged"])
            self.assertFalse((output / "launch-acknowledgement.json").exists())
            self.assertIs(result["exact_reservation_released"], True)
            self.assertEqual(result["known_birth_observations"][0]["state"], "alive")
            self.assertEqual(result["status"], "CACHE_RETAINED_SETTLEMENT_UNPROVED")
            return result

    def test_initially_unheld_exact_fixture_lease_is_not_an_observed_release_transition(self):
        result = self.binding_case(initially_held=False)
        self.assertEqual(result["lease_observation"]["state"], "released")
        self.assertFalse(result["reservation_observations"].get("held_lock_observed", False))
        self.assertFalse(result["reservation_observations"].get("natural_release_lock_observed", False))

    def test_held_then_released_exact_fixture_is_observed_without_launch_acknowledgement(self):
        result = self.binding_case(initially_held=True)
        self.assertTrue(result["reservation_observations"]["held_lock_observed"])
        self.assertTrue(result["reservation_observations"]["natural_release_lock_observed"])


@unittest.skipUnless(sys.platform == "darwin", "Native settlement requires its qualified Darwin identity reader")
class SettlementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = settlement.Processes()

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
        native = self.native
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
        if result[1]["errors"]:
            print("Owned native fixture diagnostic: " + json.dumps(result[1]), file=sys.stderr)
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
        self.assertTrue(result["exact_reservation_released"], json.dumps(result))
        self.assertFalse(result["errors"], json.dumps(result))
        self.assertFalse(result["live_generations"], json.dumps(result))
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
