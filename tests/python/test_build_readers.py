"""Coverage qualification is read-only; these controls never load the provider."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import build_cache_retirement as cache
import build_readers as readers

HEADER = "p987654\ncfixture\n"
FILE = "f3\ntREG\nD123\ni45\nn/unrelated\n"
MOUNT = "/Volumes/backup"
WARNING = ("lsof: WARNING: can't stat() smbfs file system " + MOUNT + "\n"
           '      Output information may be incomplete.\n'
           '      assuming "dev=7fffff10" from mount table\n')


class ReaderCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maildesk-reader-control-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.mounts = [(MOUNT, "smbfs", 0x7fffff10, 7)]

    def observe(self, stdout=HEADER + FILE, stderr="", code=0, mounts=None):
        result = subprocess.CompletedProcess([], code, stdout, stderr)
        with mock.patch.object(readers.subprocess, "run", return_value=result), mock.patch.object(
                readers, "darwin_mounts", return_value=self.mounts if mounts is None else mounts):
            return cache.open_users(self.root, {})

    def test_four_reported_unknown_coverage_counterexamples_refuse(self):
        for stdout, stderr in [("", ""), (HEADER + "f3\n", ""),
                (HEADER + "fNOFD\nn/opaque (Permission denied)\n", ""),
                (HEADER + FILE, WARNING + "unclassified coverage warning\n")]:
            with self.subTest(stdout=stdout, stderr=stderr), self.assertRaises(readers.CoverageError):
                self.observe(stdout, stderr)

    def test_complete_filesystem_record(self):
        self.assertEqual(self.observe()["status"], "QUALIFIED_NO_CONSUMERS")

    def test_supported_nonfilesystem_types_do_not_require_inode(self):
        names = {"unix": "->0x123", "IPv4": "*:443", "IPv6": "[::1]:443",
                 "PIPE": "", "KQUEUE": "count=0, state=0x8", "NPOLICY": "",
                 "NEXUS": "", "systm": "[ctl example id 2 unit 2]", "CHAN": "channel",
                 "key": "", "netlink": "ROUTE", "a_inode": "[eventpoll]"}
        self.assertEqual(set(names), readers.NON_FILESYSTEM_TYPES)
        for kind, name in names.items():
            with self.subTest(kind=kind):
                self.assertEqual(self.observe(HEADER + "f3\nt" + kind + "\nn" + name + "\n")["files"], 1)

    def test_opaque_nonfilesystem_names_refuse(self):
        for kind in readers.NON_FILESYSTEM_TYPES - {"PIPE", "NPOLICY", "NEXUS", "key"}:
            with self.subTest(kind=kind), self.assertRaises(readers.CoverageError):
                self.observe(HEADER + "f3\nt" + kind + "\nn\n")

    def test_unknown_missing_and_contradictory_fields_refuse(self):
        cases = [FILE.replace("tREG\n", ""), FILE.replace("D123\n", ""),
                 FILE.replace("i45\n", ""), FILE.replace("i45", "i0"),
                 FILE.replace("D123", "D0"), FILE.replace("tREG", "tunknown"),
                 FILE.replace("D123\n", "D123\nD124\n"), FILE + "xopaque\n",
                 FILE.replace("f3", "fNOFD"), FILE.replace("n/unrelated", "nPermission denied"),
                 FILE.replace("tREG", "tKQUEUE"), FILE.replace("n/unrelated", "nrelative")]
        for row in cases:
            with self.subTest(row=row), self.assertRaises(readers.CoverageError):
                self.observe(HEADER + row)

    def test_truncated_duplicate_and_incomplete_processes_refuse(self):
        for text in [HEADER, HEADER + FILE[:-1], HEADER + FILE + FILE,
                     HEADER + FILE + FILE.replace("n/unrelated", "n/other"),
                     HEADER + FILE + HEADER + FILE, "p987654\n" + FILE,
                     HEADER + FILE + "p987655\ncempty\n", HEADER + FILE + "\n"]:
            with self.subTest(text=text), self.assertRaises(readers.CoverageError):
                self.observe(text)

    def test_nonzero_status_refuses_even_with_valid_records(self):
        with self.assertRaises(readers.CoverageError):
            self.observe(code=1)

    def test_exact_distinct_nonoverlapping_smb_warning_qualifies(self):
        result = self.observe(stderr=WARNING)
        self.assertEqual(result["qualified_warnings"][0]["device"], 0x7fffff10)
        self.assertEqual(result["diagnostics"], WARNING)

    def test_unmounted_wrong_device_type_duplicate_and_mixed_warnings_refuse(self):
        cases = [(WARNING, []), (WARNING, [(MOUNT, "apfs", 0x7fffff10, 7)]),
                 (WARNING, [(MOUNT, "smbfs", 12, 7)]), (WARNING * 2, self.mounts),
                 (WARNING + "permission denied\n", self.mounts),
                 (WARNING.replace("assuming", "unknown"), self.mounts)]
        for diagnostic, mounts in cases:
            with self.subTest(diagnostic=diagnostic, mounts=mounts):
                with self.assertRaises(readers.CoverageError) as held:
                    self.observe(stderr=diagnostic, mounts=mounts)
                self.assertEqual(held.exception.details["diagnostics"], diagnostic)

    def test_overlapping_mount_alias_and_same_device_refuse(self):
        for mounts in [self.mounts + [(str(self.root), "smbfs", 0x7fffff10, 7)],
                       self.mounts + [(str(self.root.parent), "smbfs", 0x7fffff10, 7)]]:
            with self.subTest(mounts=mounts), self.assertRaises(readers.CoverageError):
                self.observe(stderr=WARNING, mounts=mounts)
        with self.assertRaises(readers.CoverageError):
            readers.qualify_warnings(WARNING, Path(MOUNT) / "target", {12}, self.mounts, self.mounts)
        with self.assertRaises(readers.CoverageError):
            readers.qualify_warnings(WARNING, self.root, {0x7fffff10}, self.mounts, self.mounts)

    def test_changed_mount_table_refuses(self):
        result = subprocess.CompletedProcess([], 0, HEADER + FILE, WARNING)
        with mock.patch.object(readers.subprocess, "run", return_value=result), mock.patch.object(
                readers, "darwin_mounts", side_effect=[self.mounts, []]), self.assertRaises(readers.CoverageError):
            cache.open_users(self.root, {})

    def test_target_path_hardlink_and_unix_socket_remain_consumers(self):
        for text, files in [(HEADER + FILE.replace("/unrelated", str(self.root / "file")), {}),
                            (HEADER + FILE, {"file": {"device": 0x123, "inode": 45}}),
                            (HEADER + "f3\ntunix\nn" + str(self.root / "socket") + "\n", {})]:
            with self.subTest(text=text), mock.patch.object(readers.subprocess, "run", return_value=
                    subprocess.CompletedProcess([], 0, text, "")), mock.patch.object(readers, "darwin_mounts", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "hardlink consumer"):
                    cache.open_users(self.root, files)

    def test_self_records_still_require_complete_coverage(self):
        with self.assertRaises(readers.CoverageError):
            self.observe("p" + str(os.getpid()) + "\ncself\nf3\n")


if __name__ == "__main__":
    unittest.main()
