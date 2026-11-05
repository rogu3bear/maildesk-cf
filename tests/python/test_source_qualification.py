"""Proof-binding controls; fixtures never grant publication authority."""
import sys
import tempfile
import unittest
import copy
import contextlib
import io
import json
import os
import subprocess
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import source_qualification as qualification


class EnvironmentBindingTests(unittest.TestCase):
    def test_unclassified_environment_changes_are_not_silently_equivalent(self):
        env = {"PATH": "/one", "CARGO_HOME": "/cargo", "CUSTOM_BUILD_SWITCH": "one"}
        original = qualification.environment_binding(env)
        self.assertNotEqual(original, qualification.environment_binding({**env, "CUSTOM_BUILD_SWITCH": "two"}))
        self.assertNotEqual(original, qualification.environment_binding({**env, "NEW_SWITCH": "one"}))
        self.assertNotEqual(original, qualification.environment_binding({**env, "PATH": "/other"}))

    def test_lifecycle_owned_internal_markers_are_not_consumer_inputs(self):
        env = {"PATH": "/one"}
        original = qualification.environment_binding(env)
        self.assertEqual(original, qualification.environment_binding({**env,
            "MAILDESK_BUILD_LIFETIME_PROOF": "/one/receipt", "MAILDESK_BUILD_COMPONENT": "ci", "MAILDESK_SOURCE_QUALIFICATION": "1", "DISK_GUARD_RESERVATION": "fixture-a"}, ci_child=True))
        self.assertEqual(original, qualification.environment_binding({**env,
            "MAILDESK_BUILD_LIFETIME_PROOF": "/other/receipt", "MAILDESK_BUILD_COMPONENT": "ci", "MAILDESK_SOURCE_QUALIFICATION": "1", "DISK_GUARD_RESERVATION": "fixture-b"}, ci_child=True))

    def test_markers_cannot_grant_publication_or_identify_a_non_ci_child(self):
        markers = {"MAILDESK_BUILD_LIFETIME_PROOF": "/receipt", "MAILDESK_BUILD_COMPONENT": "ci", "MAILDESK_SOURCE_QUALIFICATION": "1", "DISK_GUARD_RESERVATION": "fixture"}
        with self.assertRaises(ValueError):
            qualification.environment_binding(markers)
        with self.assertRaises(ValueError):
            qualification.environment_binding({**markers, "MAILDESK_BUILD_COMPONENT": "other"}, ci_child=True)
        with self.assertRaises(ValueError):
            qualification.environment_binding({"MAILDESK_BUILD_COMPONENT": "ci"}, ci_child=True)

    def test_publication_projection_validates_job_and_controls(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory(prefix="ops-hooks-") as output:
            repo = Path(directory).resolve()
            (repo / ".githooks").mkdir()
            hook = repo / ".githooks/pre-push"
            hook.write_text("fixture hook")
            home = repo / "fixture-home"
            release = home / ".codex/hooks/releases/1.0.3"
            contract = {}
            for name in ("hooks.py", "runner.py", "lefthook.yml", "core.py", "vendor/lefthook"):
                path = release / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture " + name)
                contract[name] = qualification.bytes_sha256(path.read_bytes())
            job = {"kind": "gate", "path": str(hook), "digest": qualification.bytes_sha256(hook.read_bytes()),
                   "args": ["origin", "https://example.invalid/repo"], "result_path": str(Path(output) / "result.json")}
            env = {"PATH": "/bin", "HOME": str(home), "LEFTHOOK_CONFIG": str(release / "lefthook.yml"),
                   "LEFTHOOK_OUTPUT": "failure,execution", "LEFTHOOK_EXCLUDE": "", "OPS_HOOK_WORKER": str(release / "hooks.py"),
                   "OPS_HOOK_PYTHON": "/opt/homebrew/opt/python@3.14/bin/python3.14", "PYTHONDONTWRITEBYTECODE": "1",
                   "OPS_HOOK_JOB": json.dumps(job)}
            def bind(value, **kwargs):
                return qualification.publication_environment_binding(value, repo=repo, remote_name="origin", remote_url="https://example.invalid/repo", **kwargs)
            with mock.patch.object(Path, "home", return_value=home), \
                 mock.patch.object(qualification, "DISPATCHER_FILES", contract):
                expected = bind(env)
                first = bind({**env, "CODEX_TOOL_CALL_ID": "first-private-id"})
                second = bind({**env, "CODEX_TOOL_CALL_ID": "second-private-id"})
                self.assertEqual(first["sha256"], second["sha256"])
                self.assertNotEqual(first["invocation_audit"], second["invocation_audit"])
                self.assertNotIn("first-private-id", json.dumps(first))
                self.assertFalse(expected["invocation_audit"]["present"])
                for bad in ("", "x" * 257, "bad\nvalue"):
                    with self.assertRaisesRegex(ValueError, "invocation audit"):
                        bind({**env, "CODEX_TOOL_CALL_ID": bad})
                for key in ("GIT_CONFIG_COUNT", "CODEX_OTHER", "CUSTOM_BUILD_SWITCH", "PATH"):
                    self.assertNotEqual(first["sha256"], bind({**env, "CODEX_TOOL_CALL_ID": "first-private-id", key: "changed"})["sha256"])
                detailed = bind({**env, "SECRET_TEST": "private-value"}, include_components=True)
                self.assertEqual(detailed["sha256"], bind({**env, "SECRET_TEST": "private-value"})["sha256"])
                self.assertEqual(detailed["value_sha256"]["SECRET_TEST"], qualification.bytes_sha256(b"private-value"))
                self.assertNotIn("private-value", json.dumps(detailed))
                with self.assertRaisesRegex(ValueError, "diagnostic projection exceeds"):
                    bind({**env, "BIG_TEST": "x" * 65537}, include_components=True)
                with tempfile.TemporaryDirectory(prefix="ops-hooks-") as other:
                    self.assertEqual(expected, bind({**env, "OPS_HOOK_JOB": json.dumps({**job, "result_path": str(Path(other) / "result.json")})}))
                # A sibling alias may resolve to the same owner-only directory,
                # but is not the directory allocated by the dispatcher.
                with tempfile.TemporaryDirectory(prefix="ops-hooks-") as alias:
                    alias_path = Path(alias)
                    alias_path.rmdir()
                    alias_path.symlink_to(Path(output), target_is_directory=True)
                    try:
                        linked = {**job, "result_path": str(alias_path / "result.json")}
                        with self.assertRaisesRegex(ValueError, "result path"):
                            bind({**env, "OPS_HOOK_JOB": json.dumps(linked)})
                    finally:
                        alias_path.unlink()
                        alias_path.mkdir(mode=0o700)
                noncanonical = {**job, "result_path": str(Path(output) / ".." / Path(output).name / "result.json")}
                with self.assertRaisesRegex(ValueError, "result path"):
                    bind({**env, "OPS_HOOK_JOB": json.dumps(noncanonical)})
                for name in ("OPS_HOOK_PYTHON", "OPS_HOOK_WORKER", "LEFTHOOK_CONFIG", "LEFTHOOK_OUTPUT", "LEFTHOOK_EXCLUDE"):
                    with self.subTest(name=name), self.assertRaises(ValueError):
                        bind({**env, name: "unexpected"})
                for change in ({"kind": "check"}, {"path": "/wrong"}, {"digest": "0" * 64}, {"args": ["other"]},
                               {"extra": True}, {"result_path": "/tmp/other/result.json"}):
                    with self.subTest(change=change), self.assertRaises(ValueError):
                        bind({**env, "OPS_HOOK_JOB": json.dumps({**job, **change})})
                for invalid in ('{"kind":"gate","kind":"gate"}', "{" + " " * 65536):
                    with self.assertRaises(ValueError):
                        bind({**env, "OPS_HOOK_JOB": invalid})
                installed = release / "runner.py"
                installed.write_text("changed fixture")
                with self.assertRaisesRegex(ValueError, "dispatcher contract"):
                    bind(env)
                installed.unlink()
                with self.assertRaises(ValueError):
                    bind(env)
                installed.write_text("fixture runner.py")
                Path(output).chmod(0o755)
                with self.assertRaisesRegex(ValueError, "owner-only"):
                    bind(env)
                Path(output).chmod(0o700)
                (Path(output) / "result.json").write_text("already used")
                with self.assertRaisesRegex(ValueError, "result path"):
                    bind(env)
                (Path(output) / "result.json").unlink()
                self.assertNotEqual(expected, bind({**env, "GIT_CONFIG_COUNT": "1"}))
                with self.assertRaises(ValueError):
                    bind({**env, "DISK_GUARD_RESERVATION": "forged"})

    def test_publication_projection_refuses_missing_or_mismatched_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            release = home / ".codex/hooks/releases/1.0.3"
            with mock.patch.object(Path, "home", return_value=home):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    qualification.publication_environment_binding({}, repo=home, remote_name="origin", remote_url="url")
                for name in qualification.DISPATCHER_FILES:
                    path = release / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("untrusted content")
                with self.assertRaisesRegex(ValueError, "dispatcher contract changed"):
                    qualification.publication_environment_binding({}, repo=home, remote_name="origin", remote_url="url")

    def test_environment_values_do_not_appear_in_binding(self):
        binding = qualification.environment_binding({"SECRET_TEST_VALUE": "do-not-emit"})
        self.assertNotIn("do-not-emit", str(binding))

    def test_unmodeled_tool_override_holds_before_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for key in ("RUSTC_WRAPPER", "RUSTFLAGS", "CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER", "XDG_CACHE_HOME"):
                with self.subTest(key=key), mock.patch.object(qualification, "_command", side_effect=AssertionError("probe started")):
                    with self.assertRaisesRegex(ValueError, "unmodeled"):
                        qualification.capture_current(root, {key: "custom"})


class ArtifactBindingTests(unittest.TestCase):
    def test_file_binding_rejects_content_changes_and_symlink_substitution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "build").mkdir()
            product = root / "build" / "index.wasm"
            product.write_bytes(b"first product")
            first = qualification.file_bindings(root, ["build/index.wasm"])
            product.write_bytes(b"different product")
            self.assertNotEqual(first, qualification.file_bindings(root, ["build/index.wasm"]))
            product.unlink()
            product.symlink_to(root / "outside")
            with self.assertRaises(ValueError):
                qualification.file_bindings(root, ["build/index.wasm"])

    def test_paths_must_be_unique_relative_and_remain_under_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a").write_bytes(b"a")
            for paths in ([], ["a", "a"], ["../outside"], [str(root / "a")]):
                with self.subTest(paths=paths), self.assertRaises(ValueError):
                    qualification.file_bindings(root, paths)

    def test_tree_binding_covers_file_and_directory_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "empty").mkdir()
            (root / "a").write_bytes(b"a")
            baseline = qualification.tree_binding(root)
            (root / "a").chmod(0o700)
            self.assertNotEqual(baseline, qualification.tree_binding(root))
            (root / "a").chmod(0o600)
            (root / "empty").rmdir()
            self.assertNotEqual(baseline, qualification.tree_binding(root))
            (root / "new").write_bytes(b"b")
            self.assertNotEqual(baseline, qualification.tree_binding(root))
            before_link = qualification.tree_binding(root)
            (root / "link").symlink_to("a")
            linked = qualification.tree_binding(root)
            self.assertNotEqual(before_link, linked)
            (root / "link").unlink()
            (root / "link").symlink_to("new")
            self.assertNotEqual(linked, qualification.tree_binding(root))

    def test_tree_binds_confined_dangling_link_and_its_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "link").symlink_to("missing")
            dangling = qualification.tree_binding(root)
            (root / "missing").write_text("available")
            self.assertNotEqual(dangling, qualification.tree_binding(root))
            (root / "link").unlink()
            (root / "link").symlink_to("../outside-missing")
            with self.assertRaises(ValueError):
                qualification.tree_binding(root)

    def test_tree_rejects_external_directory_link(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            root = Path(directory).resolve()
            (root / "outside").symlink_to(Path(other).resolve(), target_is_directory=True)
            with self.assertRaises(ValueError):
                qualification.tree_binding(root)


class QualificationBindingTests(unittest.TestCase):
    def snapshot(self):
        digest = "a" * 64
        return {"head": "b" * 40, "tree": "c" * 40, "environment": digest,
                "ci_script": digest, "dependency_resolution": {"bun": digest, "cargo": digest},
                "toolchain": {name: digest for name in ("bash", "python", "bun", "cargo", "rustc", "wasm_pack", "wasm_bindgen", "cargo_leptos", "worker_build", "clang", "apple_sdk", "git", "awk", "xcrun", "rustup", "node", "shell_tools", "system")},
                "products": {name: digest for name in ("mail_router", "mail_outbound", "mail_canary", "mail_heartbeat", "mail_mcp", "router_wasm", "ui_worker", "ui_site")}}

    def test_binding_comparison_refuses_missing_changed_or_extra_dimensions(self):
        expected = self.snapshot()
        self.assertTrue(qualification.same_bindings(expected, self.snapshot()))
        for key in expected:
            actual = self.snapshot()
            actual.pop(key)
            self.assertFalse(qualification.same_bindings(expected, actual), key)
        for group in ("dependency_resolution", "toolchain", "products"):
            actual = self.snapshot()
            actual[group].pop(next(iter(actual[group])))
            self.assertFalse(qualification.same_bindings(expected, actual), group)
            self.assertFalse(qualification.same_bindings(actual, actual), group)
        actual = self.snapshot()
        actual["environment"] = "f" * 64
        self.assertFalse(qualification.same_bindings(expected, actual))
        actual = {**self.snapshot(), "unreviewed": True}
        self.assertFalse(qualification.same_bindings(actual, actual))

    def test_invalid_digest_or_candidate_identity_never_qualifies(self):
        for key in ("head", "tree", "environment", "ci_script"):
            invalid = self.snapshot()
            invalid[key] = "x"
            self.assertFalse(qualification.same_bindings(invalid, invalid), key)

    def authorization(self):
        bindings = self.snapshot()
        inputs = {"schema": "maildesk-source-inputs/v1", "bindings": {key: value for key, value in bindings.items() if key != "products"}}
        capture = {"schema": "maildesk-source-capture/v1", "bindings": bindings, "input_sha256": qualification.bytes_sha256(json.dumps(inputs).encode())}
        run = {"schema": "maildesk-source-lifecycle/v1", "status": "SETTLED_CACHE_RETAINED",
               "head": bindings["head"], "tree": bindings["tree"], "capture_sha256": qualification.object_sha256(capture),
               "operation_sha256": "1" * 64, "settlement_sha256": "2" * 64, "exit_sha256": "6" * 64}
        review = {"schema": "maildesk-source-review/v1", "verdict": "ACCEPT", "scope": "source_publication_only", "reviewer": "independent-owner",
                  "head": bindings["head"], "tree": bindings["tree"], "capture_sha256": qualification.object_sha256(capture),
                  "lifecycle_sha256": qualification.object_sha256(run)}
        approval = {"schema": "maildesk-source-publication-approval/v2", "incident_status": "UNKNOWN_CACHE_RETAINED",
                    "incident_sha256": "3" * 64, "head": bindings["head"], "tree": bindings["tree"],
                    "target_ref": "refs/heads/task/inbound-recovery-ui-runtime",
                    "capture_sha256": qualification.object_sha256(capture), "lifecycle_sha256": qualification.object_sha256(run),
                    "review_sha256": qualification.object_sha256(review), "operator_ref": "explicit-approval", "source_writer": "writer-owner",
                    "publication_environment": {"schema": "maildesk-publication-environment/v2", "sha256": "a" * 64}}
        return capture, run, review, approval

    def test_authorization_requires_all_bound_evidence_and_independent_review(self):
        capture, run, review, approval = self.authorization()
        self.assertTrue(qualification.check_evidence(capture, run, review, approval, self.snapshot(),
            "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64))
        for bad in (None, "a" * 64, {}, {"schema": "maildesk-publication-environment/v1", "sha256": "a" * 64},
                    {"schema": "maildesk-publication-environment/v2", "sha256": "bad"},
                    {"schema": "maildesk-publication-environment/v2", "sha256": "a" * 64, "extra": True}):
            self.assertFalse(qualification.check_evidence(capture, run, review, {**approval, "publication_environment": bad},
                self.snapshot(), "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64))
        self.assertFalse(qualification.check_evidence(capture, run, review,
            {**approval, "schema": "maildesk-source-publication-approval/v1"}, self.snapshot(),
            "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64))
        missing = dict(approval); del missing["publication_environment"]
        self.assertFalse(qualification.check_evidence(capture, run, review, missing, self.snapshot(),
            "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64))
        for index, field in ((0, "bindings"), (1, "status"), (2, "verdict"), (3, "incident_status"),
                             (3, "operator_ref"), (3, "review_sha256")):
            values = copy.deepcopy((capture, run, review, approval))
            values[index][field] = "" if field == "operator_ref" else "invalid"
            self.assertFalse(qualification.check_evidence(*values, self.snapshot(),
                "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64), field)
        self.assertFalse(qualification.check_evidence(capture, run, review, approval, self.snapshot(),
            "refs/heads/main", "3" * 64))
        self.assertFalse(qualification.check_evidence(capture, run, review, approval, self.snapshot(),
            "refs/heads/task/inbound-recovery-ui-runtime", "4" * 64))
        self_review = {**approval, "source_writer": review["reviewer"]}
        self.assertFalse(qualification.check_evidence(capture, run, review, self_review, self.snapshot(),
            "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64))

    def test_run_receipts_must_prove_the_exact_clean_ci_and_settlement(self):
        head = "a" * 40
        operation = {"command": ["bash", "scripts/ci.sh"], "consumer_profile": "ci", "retained_qualification": True,
                     "source": {"head": head, "status": ""}}
        settlement = {"status": "SETTLED", "command_exit": 0, "errors": [], "live_generations": [],
                      "stream_eof": ["stdout", "stderr"], "exact_reservation_released": True,
                      "launch_acknowledged": True, "owner_outside_reservation": True}
        self.assertTrue(qualification.check_run_receipts(operation, settlement, {"exit": 0}, head))
        mutations = (("status", "CACHE_RETAINED_SETTLEMENT_UNPROVED"), ("errors", ["unknown"]),
                     ("live_generations", [{"pid": 1}]), ("stream_eof", ["stdout"]),
                     ("exact_reservation_released", False), ("launch_acknowledged", False),
                     ("owner_outside_reservation", False))
        for key, value in mutations:
            changed = {**settlement, key: value}
            self.assertFalse(qualification.check_run_receipts(operation, changed, {"exit": 0}, head), key)
        self.assertFalse(qualification.check_run_receipts(operation, settlement, {"exit": 1}, head))
        self.assertFalse(qualification.check_run_receipts({**operation, "command": ["true"]}, settlement, {"exit": 0}, head))
        self.assertFalse(qualification.check_run_receipts({**operation, "source": {"head": head, "status": "?? x"}}, settlement, {"exit": 0}, head))
        self.assertFalse(qualification.check_run_receipts(operation, settlement, {"exit": 0}, "b" * 40))

    def test_evidence_chain_rejects_forged_or_changed_receipts(self):
        capture, run, review, approval = self.authorization()
        operation = {"command": ["bash", "scripts/ci.sh"], "consumer_profile": "ci", "retained_qualification": True,
                     "source": {"head": capture["bindings"]["head"], "status": ""}}
        settlement = {"status": "SETTLED", "command_exit": 0, "errors": [], "live_generations": [],
                      "stream_eof": ["stdout", "stderr"], "exact_reservation_released": True,
                      "launch_acknowledged": True, "owner_outside_reservation": True}
        operation_bytes = json.dumps(operation, indent=2).encode()
        settlement_bytes = json.dumps(settlement, indent=2).encode()
        inputs_bytes = json.dumps({"schema": "maildesk-source-inputs/v1", "bindings":
            {key: value for key, value in capture["bindings"].items() if key != "products"}}).encode()
        run["operation_sha256"] = qualification.bytes_sha256(operation_bytes)
        run["settlement_sha256"] = qualification.bytes_sha256(settlement_bytes)
        run["exit_sha256"] = qualification.bytes_sha256(b'{"exit":0}')
        review["lifecycle_sha256"] = qualification.object_sha256(run)
        approval["lifecycle_sha256"] = qualification.object_sha256(run)
        approval["review_sha256"] = qualification.object_sha256(review)
        approval_pin = qualification.object_sha256(approval)
        review_pin = qualification.object_sha256(review)
        args = (capture, run, review, approval, operation_bytes, settlement_bytes, inputs_bytes, b'{"exit":0}', self.snapshot(),
                "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64, approval_pin, review_pin)
        self.assertTrue(qualification.check_chain(*args))
        self.assertFalse(qualification.check_chain(*args[:-1], "f" * 64))
        self.assertFalse(qualification.check_chain(*args[:-2], "f" * 64, review_pin))
        changed = {**operation, "consumer_profile": "other"}
        self.assertFalse(qualification.check_chain(capture, run, review, approval, json.dumps(changed).encode(), settlement_bytes, inputs_bytes,
            b'{"exit":0}', self.snapshot(), "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64, approval_pin, review_pin))
        changed_settlement = {**settlement, "status": "CACHE_RETAINED_SETTLEMENT_UNPROVED"}
        self.assertFalse(qualification.check_chain(capture, run, review, approval, operation_bytes, json.dumps(changed_settlement).encode(), inputs_bytes,
            b'{"exit":0}', self.snapshot(), "refs/heads/task/inbound-recovery-ui-runtime", "3" * 64, approval_pin, review_pin))


class PushBindingTests(unittest.TestCase):
    def test_only_one_exact_non_deletion_ref_update_is_eligible(self):
        head, previous = "a" * 40, "b" * 40
        target = "refs/heads/task/inbound-recovery-ui-runtime"
        row = f"refs/heads/task/inbound-recovery-ui-runtime {head} {target} {previous}\n"
        self.assertTrue(qualification.check_push(row, head, target, previous, ancestry_proved=True))
        for data in ("", row + row, row.replace(head, "0" * 40), row.replace(target, "refs/heads/main", 1),
                     row.replace(previous, "c" * 40), row + "garbage\n"):
            self.assertFalse(qualification.check_push(data, head, target, previous, ancestry_proved=True), repr(data))
        self.assertFalse(qualification.check_push(row, head, "refs/heads/main", previous, ancestry_proved=True))
        self.assertFalse(qualification.check_push(row, head, target, "c" * 40, ancestry_proved=True))
        self.assertFalse(qualification.check_push(row, head, target, previous, ancestry_proved=False))

    def test_repository_hook_delegates_ref_input_and_preserves_failure(self):
        source = Path(__file__).resolve().parents[2] / ".githooks/pre-push"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / ".githooks").mkdir()
            (root / "scripts").mkdir()
            (root / "bin").mkdir()
            hook = root / ".githooks/pre-push"
            hook.write_bytes(source.read_bytes())
            python = root / "bin/python3"
            python.write_text('#!/bin/bash\nprintf "ARG:%s\\n" "$@"\ncat\nexit 43\n')
            python.chmod(0o700)
            delegate = root / "home/.config/git/guards/delegate-repo-hook.sh"
            delegate.parent.mkdir(parents=True)
            delegate.write_text('#!/bin/bash\n[ "$*" = "--verify-chain pre-push" ]\n')
            delegate.chmod(0o700)
            env = {**os.environ, "HOME": str(root / "home"), "PATH": str(root / "bin") + ":/usr/bin:/bin"}
            result = subprocess.run(["/bin/bash", str(hook), "origin", "https://example.com/repo.git"],
                                    input="ref-input\n", capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 43)
            self.assertEqual(result.stdout.splitlines(), ["ARG:-B", f"ARG:{root}/scripts/source_qualification.py",
                "ARG:--verify-push", "ARG:origin", "ARG:https://example.com/repo.git", "ref-input"])
            delegate.write_text('#!/bin/bash\nexit 51\n')
            denied = subprocess.run(["/bin/bash", str(hook), "origin", "https://example.com/repo.git"],
                                    input="ref-input\n", capture_output=True, text=True, env=env)
            self.assertEqual(denied.returncode, 51)
            self.assertEqual(denied.stdout, "")


class ApprovalRecordTests(unittest.TestCase):
    def test_approval_requires_owner_only_regular_file_and_strict_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "approval.json"
            path.write_text('{"a": 1}')
            path.chmod(0o600)
            self.assertEqual(qualification.read_approval(path), {"a": 1})
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                qualification.read_approval(path)
            path.chmod(0o600)
            path.write_text('{"a": 1, "a": 2}')
            with self.assertRaises(ValueError):
                qualification.read_approval(path)
            path.unlink()
            (Path(directory) / "other").write_text(json.dumps({"a": 1}))
            path.symlink_to(Path(directory) / "other")
            with self.assertRaises(ValueError):
                qualification.read_approval(path)

    def test_proof_read_rejects_escape_and_symbolic_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "var/proof/run").mkdir(parents=True)
            proof = root / "var/proof/run/receipt.json"
            proof.write_bytes(b"{}")
            self.assertEqual(qualification.read_proof(root, "var/proof/run/receipt.json"), b"{}")
            for name in ("../outside", "var/proof/../receipt", "/tmp/receipt"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    qualification.read_proof(root, name)
            proof.unlink()
            proof.symlink_to(root / "missing")
            with self.assertRaises(ValueError):
                qualification.read_proof(root, "var/proof/run/receipt.json")


class LifecycleCaptureTests(unittest.TestCase):
    def test_capture_requires_acknowledged_inherited_admission(self):
        import build_cache_retirement as retirement
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / "var/proof/run"
            output.mkdir(parents=True)
            env = {"MAILDESK_BUILD_LIFETIME_PROOF": str(output), "MAILDESK_BUILD_COMPONENT": "ci",
                   "MAILDESK_SOURCE_QUALIFICATION": "1"}
            source = {"head": "b" * 40, "status": ""}
            operation = {"retained_qualification": True, "consumer_profile": "ci",
                         "command": ["bash", "scripts/ci.sh"], "resource_request": {"working_directory": str(root)}, "source": source}
            (output / "operation.json").write_text(json.dumps(operation))
            (output / "reservation-binding.json").write_text(json.dumps({"capability": {"fixture": True}}))
            (output / "launch-acknowledgement.json").write_text(json.dumps({"binding_sha256": retirement.sha(output / "reservation-binding.json")}))
            with mock.patch.object(retirement, "inherited_fds", return_value=()):
                with self.assertRaisesRegex(ValueError, "genuine inherited admission"):
                    qualification.capture_in_lifecycle(root, env, phase="inputs")
            self.assertFalse((output / "qualification-capture.json").exists())
            bindings = QualificationBindingTests().snapshot()
            with mock.patch.object(retirement, "inherited_fds", return_value=(7,)), \
                 mock.patch.object(retirement, "capability_identity", return_value={"fixture": True}), \
                 mock.patch.object(retirement, "git_state", return_value=source), \
                 mock.patch.object(qualification, "capture_current", side_effect=lambda *_args, include_products, **_kwargs:
                                   bindings if include_products else {k: v for k, v in bindings.items() if k != "products"}):
                qualification.capture_in_lifecycle(root, env, phase="inputs")
                qualification.capture_in_lifecycle(root, env, phase="results")
            self.assertEqual(json.loads((output / "qualification-capture.json").read_text())["bindings"], bindings)

    def test_input_drift_cannot_create_run_capture(self):
        import build_cache_retirement as retirement
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); output = root / "var/proof/run"; output.mkdir(parents=True)
            env = {"MAILDESK_BUILD_LIFETIME_PROOF": str(output), "MAILDESK_BUILD_COMPONENT": "ci", "MAILDESK_SOURCE_QUALIFICATION": "1"}
            source = {"head": "b" * 40, "status": ""}
            operation = {"retained_qualification": True, "consumer_profile": "ci", "command": ["bash", "scripts/ci.sh"],
                         "resource_request": {"working_directory": str(root)}, "source": source}
            (output / "operation.json").write_text(json.dumps(operation))
            (output / "reservation-binding.json").write_text(json.dumps({"capability": {"fixture": True}}))
            (output / "launch-acknowledgement.json").write_text(json.dumps({"binding_sha256": retirement.sha(output / "reservation-binding.json")}))
            bindings = QualificationBindingTests().snapshot()
            before = {key: value for key, value in bindings.items() if key != "products"}
            changed = {**bindings, "environment": "f" * 64}
            with mock.patch.object(retirement, "inherited_fds", return_value=(7,)), \
                 mock.patch.object(retirement, "capability_identity", return_value={"fixture": True}), \
                 mock.patch.object(retirement, "git_state", return_value=source), \
                 mock.patch.object(qualification, "capture_current", side_effect=[before, changed]):
                qualification.capture_in_lifecycle(root, env, phase="inputs")
                with self.assertRaisesRegex(ValueError, "inputs changed"):
                    qualification.capture_in_lifecycle(root, env, phase="results")
            self.assertTrue((output / "qualification-inputs.json").exists())
            self.assertFalse((output / "qualification-capture.json").exists())

    def test_current_collector_binds_candidate_inputs_and_every_product(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); home = root / "home"; repo = root / "repo"
            for item in (repo, home / ".cargo", home / "Library/Caches/.wasm-pack", root / "sysroot", root / "sdk", root / "dependency"):
                item.mkdir(parents=True)
            (repo / "Cargo.lock").write_text('[[package]]\nname = "wasm-bindgen"\nversion = "0.2.118"\n')
            metadata = {"packages": [{"id": "registry:fixture", "manifest_path": str(root / "dependency/Cargo.toml"), "source": "registry"}],
                        "resolve": {"nodes": [{"id": "registry:fixture"}]}}
            def command(argv, **_kwargs):
                if argv == ["git", "rev-parse", "HEAD"]: return b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
                if argv == ["git", "rev-parse", "HEAD^{tree}"]: return b"cccccccccccccccccccccccccccccccccccccccc\n"
                if argv[:3] == ["git", "status", "--porcelain=v1"]: return b""
                if argv[:2] == ["cargo", "metadata"]: return json.dumps(metadata).encode()
                if argv == ["rustc", "--print", "sysroot"]: return str(root / "sysroot").encode()
                if argv == ["xcrun", "--show-sdk-path"]: return str(root / "sdk").encode()
                if argv == ["sw_vers"] or argv == ["uname", "-a"]: return b"fixture-system"
                raise AssertionError(argv)
            env = {"HOME": str(home), "PATH": "/fixture", "CARGO_TARGET_DIR": str(repo / "target"),
                   "MAILDESK_BUILD_LIFETIME_PROOF": str(repo / "var/proof/run"), "MAILDESK_BUILD_COMPONENT": "ci",
                   "MAILDESK_SOURCE_QUALIFICATION": "1", "DISK_GUARD_RESERVATION": "fixture"}
            with mock.patch.object(qualification, "_command", side_effect=command), \
                 mock.patch.object(qualification, "tree_binding", side_effect=lambda path: qualification.object_sha256(str(path))), \
                 mock.patch.object(qualification, "file_bindings", return_value={"scripts/ci.sh": "d" * 64}), \
                 mock.patch.object(qualification, "_executable_binding", return_value="e" * 64), \
                 mock.patch.object(qualification.shutil, "which", return_value="/fixture/tool"):
                before = qualification.capture_current(repo, env, ci_child=True, include_products=False)
                after = qualification.capture_current(repo, env, ci_child=True)
            self.assertEqual(before, {key: value for key, value in after.items() if key != "products"})
            self.assertTrue(qualification.same_bindings(after, after))


class PublicationGateTests(unittest.TestCase):
    def test_missing_operator_selection_holds_without_observing_or_running_ci(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with mock.patch.object(qualification, "capture_current", side_effect=AssertionError("unexpected observation")), \
                 mock.patch.object(qualification, "publication_environment_binding", return_value={"schema": "maildesk-publication-environment/v2", "sha256": "a" * 64, "invocation_audit": {"present": False}}), \
                 mock.patch.object(qualification, "diagnostic_requested", return_value=False), \
                 mock.patch.object(qualification, "_command", side_effect=AssertionError("unexpected command")):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    qualification.verify_publication(root, {}, "origin", "https://example.com/repo.git", "")

    def test_diagnostic_always_refuses_before_approval_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            value = {"schema": "fixture", "secret": "never-print-this"}
            binding = {"schema": "maildesk-publication-environment/v2", "sha256": "a" * 64, "invocation_audit": {"present": False},
                       "value_sha256": {"SECRET_NAME": qualification.bytes_sha256(b"never-print-this")}}
            output = io.StringIO()
            with mock.patch.object(qualification, "diagnostic_requested", return_value=True), \
                 mock.patch.object(qualification, "publication_environment_binding", return_value=binding) as collect, \
                 mock.patch.object(qualification, "publication_source", return_value=("b" * 40, "c" * 40)), \
                 mock.patch.object(qualification, "read_approval", return_value=value), \
                 mock.patch.object(qualification, "_command", return_value=("d" * 64 + "\n").encode()), \
                 mock.patch.object(qualification, "check_chain", side_effect=AssertionError("approval evaluated")), \
                 contextlib.redirect_stderr(output):
                with self.assertRaisesRegex(ValueError, "diagnostic only; publication always refused"):
                    qualification.verify_publication(root, {"SECRET_NAME": "never-print-this"}, "origin", "https://example.invalid/repo", "row")
            self.assertTrue(collect.call_args.kwargs["include_components"])
            lines = output.getvalue().splitlines()
            report = json.loads(lines[-1])
            self.assertEqual(report["status"], "DIAGNOSTIC_REFUSED")
            self.assertEqual(report["projection"], binding)
            self.assertNotIn("never-print-this", output.getvalue())

    def test_diagnostic_config_requires_one_exact_true_value(self):
        with mock.patch.object(qualification, "_command", return_value=b""):
            self.assertFalse(qualification.diagnostic_requested(Path("/fixture"), {}))
        with mock.patch.object(qualification, "_command", return_value=b"true\n"):
            self.assertTrue(qualification.diagnostic_requested(Path("/fixture"), {}))
        missing = subprocess.CalledProcessError(1, ["git", "config"], output=b"")
        with mock.patch.object(qualification, "_command", side_effect=missing):
            self.assertFalse(qualification.diagnostic_requested(Path("/fixture"), {}))
        for raw in (b"false\n", b"true\ntrue\n", b"TRUE\n"):
            with self.subTest(raw=raw), mock.patch.object(qualification, "_command", return_value=raw):
                with self.assertRaises(ValueError):
                    qualification.diagnostic_requested(Path("/fixture"), {})

    def test_normal_gate_requires_separate_pins_and_exact_run_ref_and_incident(self):
        helper = QualificationBindingTests()
        capture, lifecycle, review, approval = helper.authorization()
        bindings = helper.snapshot()
        operation = {"command": ["bash", "scripts/ci.sh"], "consumer_profile": "ci", "retained_qualification": True,
                     "source": {"head": bindings["head"], "status": ""}}
        settlement = {"status": "SETTLED", "command_exit": 0, "errors": [], "live_generations": [],
                      "stream_eof": ["stdout", "stderr"], "exact_reservation_released": True,
                      "launch_acknowledged": True, "owner_outside_reservation": True}
        inputs = {"schema": "maildesk-source-inputs/v1", "bindings": {key: value for key, value in bindings.items() if key != "products"}}
        operation_bytes, settlement_bytes, inputs_bytes = (json.dumps(value).encode() for value in (operation, settlement, inputs))
        capture["input_sha256"] = qualification.bytes_sha256(inputs_bytes)
        lifecycle.update(capture_sha256=qualification.object_sha256(capture), operation_sha256=qualification.bytes_sha256(operation_bytes),
                         settlement_sha256=qualification.bytes_sha256(settlement_bytes), exit_sha256=qualification.bytes_sha256(b'{"exit":0}'))
        review.update(capture_sha256=qualification.object_sha256(capture), lifecycle_sha256=qualification.object_sha256(lifecycle))
        incident_bytes = json.dumps({"status": "CACHE_RETAINED_SETTLEMENT_UNPROVED"}).encode()
        approval.update(capture_sha256=qualification.object_sha256(capture), lifecycle_sha256=qualification.object_sha256(lifecycle),
                        review_sha256=qualification.object_sha256(review), incident_sha256=qualification.bytes_sha256(incident_bytes))
        target, remote, head = approval["target_ref"], "b" * 40, bindings["head"]
        url = "https://example.com/owner/repo.git"
        selection = {"schema": "maildesk-source-publication-selection/v1", "run_dir": "var/proof/run",
                     "incident": "var/proof/incident/settlement.json", "target_ref": target, "expected_remote": remote,
                     "remote_name": "origin", "remote_url_sha256": qualification.bytes_sha256(url.encode())}
        pins = {"maildesk.sourcePublicationSelectionSha256": qualification.object_sha256(selection),
                "maildesk.sourcePublicationApprovalSha256": qualification.object_sha256(approval),
                "maildesk.sourcePublicationReviewSha256": qualification.object_sha256(review)}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ("var/source-publication", "var/proof/run", "var/proof/incident"):
                (root / name).mkdir(parents=True)
            for name, value in (("selection", selection), ("approval", approval), ("review", review)):
                path = root / "var/source-publication" / (name + ".json")
                path.write_text(json.dumps(value)); path.chmod(0o600)
            for name, value in (("qualification-capture.json", json.dumps(capture).encode()),
                ("qualification-lifecycle.json", json.dumps(lifecycle).encode()), ("operation.json", operation_bytes),
                ("settlement.json", settlement_bytes), ("qualification-inputs.json", inputs_bytes), ("operation-exit.json", b'{"exit":0}')):
                (root / "var/proof/run" / name).write_bytes(value)
            (root / "var/proof/incident/settlement.json").write_bytes(incident_bytes)
            def command(argv, **_kwargs):
                if argv[:4] == ["git", "config", "--local", "--get-all"]:
                    return pins[argv[4]].encode()
                if argv[:3] == ["git", "merge-base", "--is-ancestor"]:
                    return b""
                raise AssertionError(argv)
            row = f"{target} {head} {target} {remote}\n"
            with mock.patch.object(qualification, "_command", side_effect=command), \
                 mock.patch.object(qualification, "diagnostic_requested", return_value=False), \
                 mock.patch.object(qualification, "publication_source", return_value=(head, bindings["tree"])), \
                 mock.patch.object(qualification, "publication_environment_binding", side_effect=lambda env, **kw: {"schema": "maildesk-publication-environment/v2", "sha256": "a" * 64 if not env else "f" * 64, "invocation_audit": {"present": False}}), \
                 mock.patch.object(qualification, "capture_current", side_effect=AssertionError("push must not read build products")):
                qualification.verify_publication(root, {}, "origin", url, row)
                approval_path = root / "var/source-publication/approval.json"
                for bad in ({**approval, "schema": "maildesk-source-publication-approval/v1"},
                            {**approval, "publication_environment": "a" * 64},
                            {**approval, "publication_environment": {"schema": "maildesk-publication-environment/v2", "sha256": "bad"}},
                            {key: value for key, value in approval.items() if key != "publication_environment"}):
                    approval_path.write_text(json.dumps(bad))
                    pins["maildesk.sourcePublicationApprovalSha256"] = qualification.object_sha256(bad)
                    with self.assertRaises(ValueError):
                        qualification.verify_publication(root, {}, "origin", url, row)
                approval_path.write_text(json.dumps(approval))
                pins["maildesk.sourcePublicationApprovalSha256"] = qualification.object_sha256(approval)
                with mock.patch.object(qualification, "publication_source", return_value=("d" * 40, bindings["tree"])):
                    with self.assertRaises(ValueError):
                        qualification.verify_publication(root, {}, "origin", url, row)
                with mock.patch.object(qualification, "publication_source", return_value=(head, "e" * 40)):
                    with self.assertRaises(ValueError):
                        qualification.verify_publication(root, {}, "origin", url, row)
                with self.assertRaisesRegex(ValueError, "publication environment"):
                    qualification.verify_publication(root, {"UNREVIEWED": "value"}, "origin", url, row)
                pins["maildesk.sourcePublicationReviewSha256"] = "f" * 64
                with self.assertRaises(ValueError):
                    qualification.verify_publication(root, {}, "origin", url, row)
                pins["maildesk.sourcePublicationReviewSha256"] = qualification.object_sha256(review)
                pins["maildesk.sourcePublicationReviewSha256"] += "\n" + qualification.object_sha256(review)
                with self.assertRaises(ValueError):
                    qualification.verify_publication(root, {}, "origin", url, row)
                pins["maildesk.sourcePublicationReviewSha256"] = qualification.object_sha256(review)
                with self.assertRaises(ValueError):
                    qualification.verify_publication(root, {}, "origin", url, row + row)
                with self.assertRaises(ValueError):
                    qualification.verify_publication(root, {}, "origin", "https://example.com/other.git", row)


if __name__ == "__main__":
    unittest.main()
