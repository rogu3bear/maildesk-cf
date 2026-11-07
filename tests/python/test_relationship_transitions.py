"""Complete mutable relationship observations never release an uncertain birth."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import native_processes as native
import build_settlement as settlement


class RelationshipTrackingTests(unittest.TestCase):
    def setUp(self):
        self.root = {"pid": 10, "birth": [1, 0], "ppid": 1, "pgid": 10, "session": 10}
        self.stable = {"pid": 99, "birth": [2, 0], "ppid": 1, "pgid": 99, "session": 99}
        identity = {"pid": 99, "seconds": 2, "microseconds": 0, "uid": os.getuid(),
                    "ppid": 1, "pgid": 1, "status": 2, "flags": 0}
        self.transition = {**self.stable, "ppid": None, "pgid": None, "session": None,
                           "state": "relationship_transition", "native_evidence": {
                               "schema": "maildesk-relationship-bracket/v1",
                               "identities": [dict(identity), {**identity, "pgid": 99}, {**identity, "pgid": 99}],
                               "sessions": [{"result": 1, "errno": 0}, {"result": 99, "errno": 0}]}}
        self.current = {10: self.root, 99: self.transition}
        self.reader = types.SimpleNamespace(table=lambda: deepcopy(self.current),
                                            get=lambda pid: deepcopy(self.current.get(pid)), exiting_flag=8192)
        self.tracker = settlement.Tracker(self.reader, self.root)

    def test_unrelated_transition_stays_pending_after_stable_outside_session_until_independent_end(self):
        self.assertEqual({r["pid"] for r in self.tracker.scan()}, {10, 99})
        self.current[99] = self.stable
        self.tracker.scan()
        self.assertEqual(self.tracker.pending_relationships, [self.stable])
        with self.assertRaisesRegex(RuntimeError, "Pending"):
            self.tracker.register(self.root)
        self.current.pop(99)
        self.assertEqual(self.tracker.scan(), [self.root])
        self.assertEqual(self.tracker.pending_relationships, [])
        self.assertIn((99, (2, 0)), self.tracker.ended)
        self.assertEqual([r.get("state", "active") for r in self.tracker.relationship_history],
                         ["relationship_transition", "active", "ended"])

    def test_newer_stable_read_retains_enrollment_and_immutable_earlier_evidence(self):
        self.reader.get = lambda pid: deepcopy(self.stable if pid == 99 else self.current.get(pid))
        self.tracker.scan()
        self.assertEqual(self.tracker.pending_relationships, [self.stable])
        self.transition["native_evidence"]["identities"][0]["pgid"] = 444
        self.assertEqual(self.tracker.relationship_history[0]["native_evidence"]["identities"][0]["pgid"], 1)

    def test_relationship_then_exit_is_live_for_both_contracts_until_terminal(self):
        self.tracker.scan()
        exiting = {**self.stable, "state": "exiting", "ppid": None, "pgid": None, "session": None,
                   "native_evidence": {"flags": 8192}}
        self.current[99] = exiting
        self.tracker.scan()
        self.assertEqual(self.tracker.pending_exits, [exiting])
        self.assertEqual(self.tracker.pending_relationships, [exiting])
        self.current.pop(99)
        self.tracker.scan()
        self.assertEqual(self.tracker.pending_exits, [])
        self.assertEqual(self.tracker.pending_relationships, [])
        self.assertEqual(self.tracker.relationship_history[-1]["state"], "ended")

    def test_exit_to_relationship_regression_and_terminal_resurrection_hold(self):
        self.tracker.scan()
        self.current[99] = {**self.transition, "state": "exiting", "native_evidence": {"flags": 8192}}
        self.tracker.scan()
        self.current[99] = self.transition
        with self.assertRaisesRegex(RuntimeError, "regressed"):
            self.tracker.scan()
        self.current.pop(99)
        self.tracker.scan()
        self.current[99] = self.stable
        with self.assertRaisesRegex(RuntimeError, "reappeared"):
            self.tracker.scan()

    def test_missing_malformed_denied_identity_or_session_evidence_holds(self):
        for change in (lambda e: e.pop("sessions"), lambda e: e["identities"][1].update(uid=os.getuid()+1),
                       lambda e: e["identities"][2].update(seconds=3), lambda e: e["identities"][0].update(pgid=0),
                       lambda e: e["sessions"][1].update(errno=1), lambda e: e["sessions"][0].update(result=-1)):
            with self.subTest(change=change):
                self.setUp()
                change(self.transition["native_evidence"])
                with self.assertRaisesRegex(RuntimeError, "Unqualified"):
                    self.tracker.scan()
        with self.assertRaisesRegex(RuntimeError, "complete active"):
            settlement.Tracker(self.reader, self.transition)


@unittest.skipUnless(sys.platform == "darwin", "Owned Darwin relationship controls")
class OwnedRelationshipTests(unittest.TestCase):
    def test_owned_group_changes_are_observed_live_then_naturally_terminal(self):
        reader = native.Processes()
        group = os.getpgrp()
        child = os.fork()
        if child == 0:
            try:
                deadline = time.monotonic() + 1.0
                while time.monotonic() < deadline:
                    os.setpgid(0, 0)
                    os.setpgid(0, group)
                os._exit(0)
            except BaseException as error:
                os.write(2, ("Owned PGID fixture error: " + repr(error) + "\n").encode())
                os._exit(2)
        transition = None
        try:
            for _ in range(10000):
                row = reader.get(child)
                if row is None:
                    break
                if row.get("state") == "relationship_transition":
                    transition = row
        finally:
            _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertIsNotNone(transition, "Bounded owned group changes must exercise the native transition projection")
        self.assertIsNone(reader.get(child))
        print("Owned relationship bracket: " + json.dumps(transition, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
