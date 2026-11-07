"""The native projection never turns malformed or denied data into absence."""
import ctypes
import errno
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import native_processes as native


class NativeIdentityTests(unittest.TestCase):
    def row(self, **changes):
        row = native.Record(100, 500, os.getpid(), 1, 42, 42, os.getuid(), 2)
        for key, value in changes.items(): setattr(row, key, value)
        return row

    def reader(self, result=1, row=None):
        reader = native.Processes.__new__(native.Processes)
        reader.exiting_flag = 0x2000  # Controlled fixture mask, production obtains it from the SDK backend.
        def query(pid, output, detail):
            value = row if row is not None else self.row(pid=pid)
            ctypes.memmove(output, ctypes.byref(value), ctypes.sizeof(value))
            return result
        reader.lib = types.SimpleNamespace(md_get=mock.Mock(side_effect=query))
        reader.check_artifact = mock.Mock()
        return reader

    def test_complete_identity_retains_birth_parent_and_session(self):
        self.assertEqual(self.reader().get(12345),
                         {"pid": 12345, "birth": [100, 500], "ppid": 1, "pgid": 42, "session": 42})

    def test_only_successful_native_absence_is_absent(self):
        self.assertIsNone(self.reader(0).get(12345))
        for result in (-errno.EPERM, -errno.ESRCH, -errno.EIO, -errno.EPROTO, -errno.ESTALE, 2):
            with self.subTest(result=result), self.assertRaisesRegex(RuntimeError, "Unknown native process identity"):
                self.reader(result).get(12345)

    def test_no_signal_or_alternate_reader_after_denial(self):
        with mock.patch.object(native.os, "kill") as probe:
            with self.assertRaises(RuntimeError): self.reader(-errno.EPERM).get(12345)
            probe.assert_not_called()

    def test_same_call_diagnostic_preserves_read_fields_without_followup(self):
        reader = self.reader(-errno.ESTALE)
        def query(pid, output, detail):
            value = ctypes.cast(detail, ctypes.POINTER(native.Diagnostic))[0]
            value.stage = 12; value.code = -errno.ESTALE; value.pid = pid; value.fields = 7
            value.expected = self.row(pid=pid); value.observed = self.row(pid=pid, seconds=101)
            value.session_result = 42; value.reported_bytes = 648; value.input_capacity = 648
            return -errno.ESTALE
        reader.lib.md_get.side_effect = query
        with self.assertRaisesRegex(RuntimeError, 'identity_or_relationship_drift') as error:
            reader.get(12345)
        import json
        detail = json.loads(str(error.exception).split(': ', 1)[1])
        self.assertEqual((detail['expected']['seconds'], detail['observed']['seconds']), (100, 101))
        self.assertEqual((detail['session_result'], detail['reported_bytes']), (42, 648))
        self.assertEqual(reader.lib.md_get.call_count, 1)

    def test_malformed_or_wrong_owner_record_remains_unknown(self):
        for key, value in (("pid", 12346), ("uid", os.getuid()+1), ("seconds", 0),
                           ("microseconds", 1000000), ("ppid", -1), ("pgid", 0), ("session", 0), ("status", 0), ("status", 1), ("status", 5), ("status", 8)):
            with self.subTest(key=key, value=value), self.assertRaisesRegex(RuntimeError, "malformed record"):
                self.reader(row=self.row(**({"pid": 12345} | {key: value}))).get(12345)

    def test_invalid_pid_does_not_reach_native_code(self):
        for pid in (0, -1, True, 1.5, 2**31):
            reader = self.reader()
            with self.subTest(pid=pid), self.assertRaisesRegex(RuntimeError, "positive pid_t"):
                reader.get(pid)
            reader.lib.md_get.assert_not_called()

    def test_identified_exit_has_no_fabricated_relationships_and_keeps_evidence(self):
        row = self.row(pid=12345, flags=0x2000, session=-1, session_error=errno.ESRCH, pgid=0, ppid=0)
        value = self.reader(row=row).get(12345)
        self.assertEqual(value['state'], 'exiting')
        self.assertEqual((value['session'], value['pgid'], value['ppid']), (None, None, None))
        self.assertEqual(value['native_evidence']['session_errno'], errno.ESRCH)
        row.flags = 0
        with self.assertRaises(RuntimeError): self.reader(row=row).get(12345)
        row.flags = 0x2000; row.session_error = errno.EPERM
        with self.assertRaises(RuntimeError): self.reader(row=row).get(12345)

    def population(self, rows, result=0, count=None):
        reader = native.Processes.__new__(native.Processes)
        reader.exiting_flag = 0x2000
        def query(output, capacity, size, detail):
            self.assertEqual(capacity, native.LIMIT)
            for index, row in enumerate(rows): output[index] = row
            ctypes.cast(size, ctypes.POINTER(ctypes.c_size_t))[0] = len(rows) if count is None else count
            return result
        reader.lib = types.SimpleNamespace(md_table=query)
        reader.check_artifact = mock.Mock()
        return reader

    def test_complete_population_requires_observer_and_unique_valid_identities(self):
        observer = self.row()
        self.assertEqual(self.population([observer]).table()[os.getpid()]["birth"], [100, 500])
        for rows in ([], [self.row(pid=os.getpid()+1)], [observer, observer], [observer, self.row(pid=-1)]):
            with self.subTest(rows=len(rows)), self.assertRaises(RuntimeError): self.population(rows).table()

    def test_any_native_coverage_failure_refuses_whole_population(self):
        for result in (-errno.EPERM, -errno.ENOMEM, -errno.EPROTO, -errno.ESTALE, 1):
            with self.subTest(result=result), self.assertRaisesRegex(RuntimeError, "coverage unavailable"):
                self.population([self.row()], result).table()
        for count in (0, native.LIMIT, native.LIMIT+1):
            with self.subTest(count=count), self.assertRaisesRegex(RuntimeError, "coverage unavailable"):
                self.population([], count=count).table()

    def test_unsupported_platform_cannot_prepare_a_reader(self):
        with mock.patch.object(native.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "qualified 64-bit Darwin"):
                native.prepare.__wrapped__()

    def test_symlink_or_nonregular_input_binding_is_rejected(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/"file").write_text("fixture"); (root/"link").symlink_to(root/"file")
            for path in (root, root/"link"):
                with self.subTest(path=path), self.assertRaises(RuntimeError): native.file_binding(path)

    def test_changed_backend_artifact_is_rejected_before_native_call(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            artifact = Path(folder)/"reader"; artifact.write_bytes(b"owned fixture")
            reader = native.Processes.__new__(native.Processes)
            reader.binding = {"artifact": native.file_binding(artifact)}
            reader.lib = types.SimpleNamespace(md_get=mock.Mock())
            artifact.write_bytes(b"changed fixture")
            with self.assertRaisesRegex(RuntimeError, "artifact identity changed"): reader.get(12345)
            reader.lib.md_get.assert_not_called()


@unittest.skipUnless(sys.platform == "darwin", "SDK-compiled Darwin controls")
class NativeKernelContractTests(unittest.TestCase):
    def test_owned_zombie_keeps_identity_without_live_relationship_requirements(self):
        reader = native.Processes()
        child = os.fork()
        if child == 0:
            os._exit(0)
        try:
            status = os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
            self.assertEqual(status.si_pid, child)
            row = native.Record(); detail = native.Diagnostic()
            self.assertEqual(reader.lib.md_get(child, ctypes.byref(row), ctypes.byref(detail)), 0,
                             native.diagnostic_value(detail))
            self.assertEqual(detail.expected.status, 5)
            self.assertGreater(detail.expected.seconds, 0)
            self.assertEqual(detail.expected.uid, os.getuid())
        finally:
            os.waitpid(child, 0)
        self.assertIsNone(reader.get(child))

    def test_compiled_native_error_and_drift_controls(self):
        import tempfile
        with tempfile.TemporaryDirectory(prefix="maildesk-kernel-contract-") as folder:
            binary = Path(folder)/"contract"
            environment = dict(os.environ)
            environment["TMPDIR"] = folder
            guard = ["disk-guard", "run", "--budget-gb", "0.05", "--volume", folder, "--volume", "/private/tmp",
                     "--build-lane", folder, "--"]
            native.command([*guard, "/usr/bin/xcrun", "clang", "-Wall", "-Wextra", "-Werror",
                            str(Path(__file__).with_name("native_processes_contract.c")), "-o", str(binary)], environment)
            output = native.command([*guard, str(binary)], environment)
            self.assertIn("contract controls passed", output)


if __name__ == "__main__": unittest.main()
