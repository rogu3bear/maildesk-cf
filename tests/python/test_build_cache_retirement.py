"""Disposable fixtures use the verified installed API, never mutable provider source."""
import fcntl
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import build_cache_retirement as cache
workflow = runpy.run_path(str(ROOT / "scripts/build-workflow.py"))
operation = runpy.run_path(str(ROOT / "scripts/build-and-retire.py"))["operation"]


class RetirementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (Path.home() / ".local/share/disk-guard/installation.json").exists():
            raise unittest.SkipTest("Optional installed preservation API absent; retirement integration is unqualified")
        cache.provider()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maildesk-retirement-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo = self.base / "repo"; self.repo.mkdir()
        self.target = self.repo / "target"; self.target.mkdir()
        # CI's real root must not redirect a disposable foreign workspace.
        # This changes only fixture Cargo configuration, never host capabilities.
        cargo_env = mock.patch.dict(os.environ, {"CARGO_TARGET_DIR": str(self.target)})
        cargo_env.start(); self.addCleanup(cargo_env.stop)
        self.proof = self.repo / "var/proof/run"; self.proof.mkdir(parents=True)
        (self.repo / "src").mkdir()
        (self.repo / "src/lib.rs").write_text("pub fn fixture() {}\n")
        (self.repo / "Cargo.toml").write_text('[package]\nname="retirement-fixture"\nversion="0.1.0"\n')
        (self.repo / ".gitignore").write_text("/target/\n/var/\n/build/\n/generated/\n")
        cache.run(["git", "init"], self.repo)
        cache.run(["git", "config", "user.name", "Retirement Fixture"], self.repo)
        cache.run(["git", "config", "user.email", "operator@example.com"], self.repo)
        cache.run(["git", "add", "Cargo.toml", "src/lib.rs", ".gitignore"], self.repo)
        cache.run(["git", "commit", "-m", "fixture source"], self.repo)
        self.api, _ = cache.provider()
        self.state = self.base / "state"; self.state.mkdir()
        (self.state / "admission.lock").touch(mode=0o600)
        self.pin = {"path": str(self.repo), "owner": "fixture-operator", "reason": "retained scope"}
        self.policy = self.base / "policy.json"
        self.policy.write_text(json.dumps({"version": 1, "cleanup_mode": "report-only", "state_dir": str(self.state),
            "reserve_gb": 5, "hard_reserve_gb": 5, "warning_gb": 150, "critical_gb": 4, "hysteresis_gb": 10,
            "retention_pins": [self.pin], "preservation_coordination": dict(self.api.COORDINATION)}))
        self.lock = self.target / "debug/.cargo-lock"; self.lock.parent.mkdir(); self.lock.touch()
        self.first = self.unit("first", "1")
        self.plan = self.proof / "plan.json"
        self.journal = self.proof / "journal.jsonl"
        self.receipt = self.proof / "receipt.json"

    def unit(self, name, character):
        unit = character * 16
        deps = self.target / "debug/deps"; deps.mkdir(exist_ok=True)
        artifact = deps / ("lib" + name + "-" + unit + ".rmeta")
        artifact.write_bytes(b"rust\x00\x00\x00fixture metadata")
        (deps / (name + "-" + unit + ".d")).write_text(str(artifact) + ": " + str(self.repo / "src/lib.rs") + "\n")
        fingerprint = self.target / ("debug/.fingerprint/" + name + "-" + unit)
        fingerprint.mkdir(parents=True)
        (fingerprint / ("lib-" + name + ".json")).write_text(json.dumps(dict(rustc=1, features=[], target=1, profile=1, deps=[])))
        return artifact

    def prepare(self, keep=()):
        return cache.prepare(self.repo, self.policy, self.plan, "Explicit fixture-only authorized retirement", keep)

    def apply(self, bound, **kwargs):
        return cache.apply(self.plan, bound["sha256"], self.journal, self.receipt, **kwargs)

    def test_selective_retirement_preserves_locks_products_release_evidence_and_history(self):
        evidence = self.unit("release_evidence", "2")
        retained = [self.lock, evidence, self.repo / "var/history.json", self.target / "site/delivery.wasm",
                    self.repo / "build/worker.mjs", self.repo / "generated/router.wasm"]
        for path in retained[2:]:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"exact retained content")
        before = {str(p): (cache.metadata(p), cache.sha(p)) for p in retained}
        bound = self.prepare([str(evidence.relative_to(self.target))])
        self.assertEqual(bound["files"], 3)
        result = self.apply(bound)
        self.assertEqual(result["status"], "COMPLETE")
        self.assertFalse(self.first.exists())
        self.assertTrue(result["locks_products_source_policy_preserved"])
        self.assertEqual(before, {str(p): (cache.metadata(p), cache.sha(p)) for p in retained})
        self.assertEqual(json.loads(self.policy.read_text())["retention_pins"], [self.pin])

    def test_missing_exact_pin_disposition_refuses_before_effect(self):
        self.prepare(); plan = json.loads(self.plan.read_text()); plan["released_pins"] = []
        self.plan.write_text(json.dumps(plan))
        result = self.apply({"sha256": cache.sha(self.plan)})
        self.assertEqual(result["status"], "HELD_NO_EFFECT")
        self.assertEqual(result["provider_details"]["reason"], "PRESERVATION_PINNED")
        self.assertTrue(self.first.exists())

    def test_held_admission_and_cargo_lock_refuse(self):
        bound = self.prepare()
        for path in (self.state / "admission.lock", self.lock):
            with path.open("rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = self.apply(bound)
            self.assertEqual(result["status"], "HELD_NO_EFFECT")
            self.assertTrue(self.first.exists())
            self.journal.unlink(); self.receipt.unlink()

    def test_live_writer_lease_refuses_before_effect(self):
        bound = self.prepare()
        identity = "a" * 32
        path = self.state / ("reservation-" + identity + ".json")
        path.write_text(json.dumps({"id": identity, "workspace": str(self.repo), "bytes": 1,
                                   "volumes": [str(self.repo)], "build_lanes": [str(self.target)]}))
        with path.open("rb") as live:
            fcntl.flock(live, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.apply(bound)
        self.assertEqual(result["status"], "HELD_NO_EFFECT")
        self.assertEqual(result["provider_details"]["reason"], "PRESERVATION_LEASED")

    def test_current_unleased_reader_is_observed(self):
        bound = self.prepare()
        child = subprocess.Popen([sys.executable, "-c", "import sys; f=open(sys.argv[1],'rb'); print('ready',flush=True); input()", str(self.first)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            result = self.apply(bound)
            self.assertEqual(result["status"], "HELD_NO_EFFECT")
            self.assertTrue(self.first.exists())
        finally:
            child.communicate("release\n", timeout=10)

    def test_external_or_retained_hardlinks_and_symlinks_are_never_selected(self):
        os.link(self.first, self.base / "external.rmeta")
        (self.first.parent / "libalias-2222222222222222.rmeta").symlink_to(self.first)
        self.assertEqual(self.prepare()["files"], 0)

    def workspace_library(self):
        crate = "retirement_fixture"
        deps = self.target / "debug/deps"
        source = self.repo / "src/lib.rs"
        fingerprint = self.target / "debug/.fingerprint/retirement-fixture-3333333333333333"
        fingerprint.mkdir(parents=True)
        (fingerprint / ("lib-" + crate + ".json")).write_text(json.dumps(dict(rustc=1, features=[], target=1, profile=1, deps=[])))
        library = deps / ("lib" + crate + ".rlib")
        library.write_bytes(b"!<arch>\nfixture workspace archive")
        peer = self.target / ("debug/lib" + crate + ".rlib")
        os.link(library, peer)
        obj = deps / (crate + "." + crate + ".4444444444444444-cgu.01.rcgu.o")
        obj.write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 8 + b"\x01\0\0\0" + b"\0" * 16)
        (deps / (crate + ".d")).write_text(str(library) + ": " + str(source) + "\n")
        return library, peer, obj

    def test_native_workspace_metadata_qualifies_unhashed_library_links_and_codegen_objects(self):
        products = self.workspace_library()
        bound = self.prepare()
        selected = json.loads(self.plan.read_text())["selected"]
        self.assertTrue(all(str(p.relative_to(self.target)) in selected for p in products))
        self.assertEqual(self.apply(bound)["status"], "COMPLETE")
        self.assertTrue(all(not p.exists() for p in products))

    def test_workspace_unknown_namespace_format_and_missing_source_remain(self):
        library, peer, obj = self.workspace_library()
        unknown = obj.with_name("retirement_fixture.unowned.o")
        unknown.write_bytes(obj.read_bytes())
        misplaced = self.target / "evidence/libretirement_fixture.rlib"
        misplaced.parent.mkdir(); misplaced.write_bytes(library.read_bytes())
        library.write_bytes(b"unrecognized workspace format")
        (obj.parent / "retirement_fixture.d").write_text(str(obj) + ": " + str(self.repo / "Cargo.toml") + "\n")
        bound = self.prepare()
        self.assertEqual(self.apply(bound)["status"], "COMPLETE")
        self.assertTrue(all(p.exists() for p in (library, peer, obj, unknown, misplaced)))

    def test_workspace_protected_hardlink_keeps_entire_library_set(self):
        library, peer, _ = self.workspace_library()
        bound = self.prepare([str(peer.relative_to(self.target))])
        self.assertEqual(self.apply(bound)["status"], "COMPLETE")
        self.assertTrue(library.exists() and peer.exists())

    def test_build_script_compiler_binaries_retire_but_generated_outputs_and_diagnostics_remain(self):
        unit = "5" * 16
        directory = self.target / ("debug/build/fixture-" + unit)
        directory.mkdir(parents=True)
        binary = directory / ("build_script_build-" + unit)
        binary.write_bytes(b"\x7fELF\x02\x01" + b"\0" * 10 + b"\x02\0" + b"\0" * 14)
        peer = directory / "build-script-build"; os.link(binary, peer)
        (directory / (binary.name + ".d")).write_text(str(binary) + ": " + str(self.repo / "src/lib.rs") + "\n")
        fingerprint = self.target / ("debug/.fingerprint/fixture-" + unit)
        fingerprint.mkdir(parents=True)
        (fingerprint / "build-script-build-script-build.json").write_text(json.dumps(dict(rustc=1, features=[], target=1, profile=1, deps=[])))
        output = directory / "out/generated.rs"; output.parent.mkdir(); output.write_text("retained generated input")
        diagnostic = directory / "output"; diagnostic.write_text("retained build-script diagnostics")
        bound = self.prepare()
        self.assertEqual(self.apply(bound)["status"], "COMPLETE")
        self.assertFalse(binary.exists() or peer.exists())
        self.assertEqual(output.read_text(), "retained generated input")
        self.assertEqual(diagnostic.read_text(), "retained build-script diagnostics")

    def test_signed_or_unqualified_signature_is_retained(self):
        _, _, obj = self.workspace_library()
        binary = obj.parent / "libretirement_fixture-1111111111111111.dylib"
        binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 8 + b"\x06\0\0\0" + b"\0" * 16)
        # Real signing identities are deliberately not needed by this fixture.
        with mock.patch.object(cache, "signature_retained", return_value=True):
            bound = self.prepare()
            result = self.apply(bound)
        self.assertEqual(result["status"], "COMPLETE")
        self.assertTrue(binary.exists())

    def test_retained_allocation_changes_are_measurements_and_not_integrity_failures(self):
        product = self.target / "site/delivery.wasm"
        product.parent.mkdir(); product.write_bytes(b"retained exact UI delivery")
        identity, digest = cache.metadata(product), cache.sha(product)
        bound = self.prepare()
        native_metadata = cache.metadata
        phase = 0
        def allocation_only(path):
            row = native_metadata(path)
            if Path(path) == product:
                row["allocated"] += (phase + 1) * 4096
            return row
        def unlink(fd, name, dirs):
            nonlocal phase
            cache.unlink_at(fd, name, dirs); phase += 1
        with mock.patch.object(cache, "metadata", side_effect=allocation_only):
            result = self.apply(bound, unlink=unlink)
        self.assertEqual(result["status"], "COMPLETE")
        self.assertEqual((cache.metadata(product), cache.sha(product)), (identity, digest))

    def lifecycle_settings(self):
        request = self.repo / "var/request.json"
        request.write_text(json.dumps({"working_directory": str(self.repo), "estimated_growth_gb": 12,
                                       "write_paths": [str(self.repo)]}))
        (self.repo / "var/build-cache-retirement.json").write_text(json.dumps({
            "schema": "maildesk-local-cache-lifecycle/v1", "authorization_ref": "Explicit disposable fixture only",
            "resource_request": "var/request.json"}))

    def test_default_workflow_waits_for_build_and_real_consumer_before_retirement(self):
        self.lifecycle_settings()
        consumed = self.repo / "var/consumed.json"
        command = [sys.executable, "-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.exists(); pathlib.Path(sys.argv[2]).write_text(p.read_text())",
                   str(self.first), str(consumed)]
        # Simulate only admission for the isolated provider fixture. Native
        # default-command qualification separately exercises real admission.
        def admit(argv, **kwargs):
            self.assertTrue(self.first.exists())
            return subprocess.run(command, **kwargs)
        def outer(repo, output, authorization, resource, actual, keep):
            self.assertEqual(actual, ["bash", "-c", 'bun scripts/build-mail-worker-bundles.ts && bun test ./tests/workers "$@"', "maildesk-worker-tests"])
            return operation(repo, output, authorization, resource, actual, keep, policy=self.policy, execute=admit)
        native_fds = cache.inherited_fds
        with mock.patch.object(cache, "inherited_fds", side_effect=lambda env: () if env is os.environ else native_fds(env)), mock.patch.dict(os.environ, {"MAILDESK_BUILD_LIFETIME_PROOF": ""}):
            result = workflow["workflow"](self.repo, "test:workers", [], outer=outer)
        self.assertEqual(result, 0)
        self.assertTrue(consumed.exists())
        self.assertFalse(self.first.exists())

    def test_default_workflow_failure_preserves_cache_and_exact_failure_log(self):
        self.lifecycle_settings()
        def fail(argv, **kwargs):
            return subprocess.run([sys.executable, "-c", "import sys; print('owned fixture failure'); sys.exit(7)"], **kwargs)
        def outer(repo, output, authorization, resource, command, keep):
            return operation(repo, output, authorization, resource, command, keep, policy=self.policy, execute=fail)
        native_fds = cache.inherited_fds
        with mock.patch.object(cache, "inherited_fds", side_effect=lambda env: () if env is os.environ else native_fds(env)), mock.patch.dict(os.environ, {"MAILDESK_BUILD_LIFETIME_PROOF": ""}):
            result = workflow["workflow"](self.repo, "ci", [], outer=outer)
        self.assertEqual(result, 7)
        self.assertTrue(self.first.exists())
        proofs = list((self.repo / "var/proof").glob("build-lifecycle-*"))
        self.assertEqual(len(proofs), 1)
        self.assertEqual((proofs[0] / "operation.log").read_text(), "owned fixture failure\n")
        self.assertFalse((proofs[0] / "retirement-plan.json").exists())

    def test_nested_and_external_active_lifetimes_never_retire_between_consumers(self):
        self.lifecycle_settings()
        cache.save(self.proof / "operation.json", {"resource_request": {"working_directory": str(self.repo)}})
        def consumer(command, **kwargs):
            self.assertTrue(self.first.exists())
            self.assertEqual(kwargs["pass_fds"], (123,))
            return subprocess.CompletedProcess(command, 0)
        with mock.patch.object(cache, "inherited_fds", return_value=(123,)), mock.patch.object(cache, "capability_identity", return_value={"fixture_identity": True}):
            cache.save(self.proof / "reservation-binding.json", {"fixture_identity": True})
            with mock.patch.dict(os.environ, {"MAILDESK_BUILD_LIFETIME_PROOF": str(self.proof)}):
                self.assertEqual(workflow["workflow"](self.repo, "build:ui", [], execute=consumer), 0)
            with mock.patch.dict(os.environ, {"MAILDESK_BUILD_LIFETIME_PROOF": ""}):
                self.assertEqual(workflow["workflow"](self.repo, "build:ui", [], execute=consumer), 78)
        self.assertTrue(self.first.exists())
        self.assertFalse(self.plan.exists() or self.journal.exists())

    def test_nested_lifetime_marker_cannot_borrow_an_unrelated_admission(self):
        self.lifecycle_settings()
        cache.save(self.proof / "operation.json", {"resource_request": {"working_directory": str(self.repo)}})
        cache.save(self.proof / "reservation-binding.json", {"fixture_identity": "different"})
        with mock.patch.object(cache, "inherited_fds", return_value=(123,)), mock.patch.object(cache, "capability_identity", return_value={"fixture_identity": "current"}), mock.patch.dict(os.environ, {"MAILDESK_BUILD_LIFETIME_PROOF": str(self.proof)}):
            with self.assertRaisesRegex(RuntimeError, "different admission"):
                workflow["workflow"](self.repo, "build:ui", [], execute=lambda *a, **k: self.fail("Unrelated consumer launched"))
        self.assertTrue(self.first.exists())

    def test_partial_effect_requires_reconciliation_and_never_replays(self):
        self.unit("second", "2"); bound = self.prepare()
        calls = 0
        def interrupted(fd, name, dirs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("Owned fixture interrupt before second unlink")
            cache.unlink_at(fd, name, dirs)
        result = self.apply(bound, unlink=interrupted)
        self.assertEqual(result["status"], "PARTIAL_REQUIRES_RECONCILIATION")
        self.assertEqual(len(result["removed"]), 1)
        reconciled = cache.reconcile(self.plan, self.journal)
        self.assertEqual(list(reconciled["paths"].values()).count("ABSENT"), 1)
        self.assertEqual(list(reconciled["paths"].values()).count("ORIGINAL_CONTENT"), bound["files"] - 1)
        self.assertFalse(reconciled["replay_allowed"])
        with self.assertRaisesRegex(RuntimeError, "reconciliation"):
            self.apply(bound)

    def test_plan_source_or_selected_content_drift_never_deletes(self):
        bound = self.prepare(); self.first.write_bytes(b"changed cache generation")
        self.assertEqual(self.apply(bound)["status"], "HELD_NO_EFFECT")
        self.assertTrue(self.first.exists())

    def test_unlink_then_failure_is_uncertain_not_a_no_effect_claim(self):
        bound = self.prepare()
        def lost_ack(fd, name, dirs):
            cache.unlink_at(fd, name, dirs)
            raise RuntimeError("Owned fixture loses acknowledgment after unlink")
        result = self.apply(bound, unlink=lost_ack)
        self.assertEqual(result["status"], "EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION")
        self.assertEqual(len(result["removed"]), 0)
        self.assertFalse(self.first.exists())
        observed = cache.reconcile(self.plan, self.journal)
        self.assertEqual(list(observed["paths"].values()).count("ABSENT"), 1)

    def test_source_change_after_plan_holds_before_any_unlink(self):
        bound = self.prepare()
        (self.repo / "src/lib.rs").write_text("pub fn changed_source() {}\n")
        result = self.apply(bound)
        self.assertEqual(result["status"], "HELD_NO_EFFECT")
        self.assertTrue(self.first.exists())
        self.assertTrue(any("settled committed source" in row["error"] for row in result["cause_chain"]))

    def test_reconciliation_retains_and_reports_a_torn_last_journal_record(self):
        bound = self.prepare(); self.apply(bound)
        with self.journal.open("a") as journal:
            journal.write('{"event":')
        before = self.journal.read_bytes()
        result = cache.reconcile(self.plan, self.journal)
        self.assertTrue(result["incomplete_trailing_journal_record"])
        self.assertFalse(result["replay_allowed"])
        self.assertEqual(self.journal.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
