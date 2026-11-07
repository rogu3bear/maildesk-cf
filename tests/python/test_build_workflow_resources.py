"""Ordinary and manually declared operations keep exact output ownership."""
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
planner = runpy.run_path(str(ROOT / "scripts/build-workflow.py"))["operation_resource"]


class OperationResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maildesk-resource-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name).resolve()
        self.output = self.repo / "var/proof/one-exact-operation"
        self.request = {"schema": "disk-guard.resource-request.v1", "working_directory": str(self.repo),
                        "estimated_growth_gb": 12, "write_paths": [str(self.repo)],
                        "output_roots": [str(self.repo / "target")], "purpose": "operation",
                        "label": "fixture", "estimate_basis": "Original 12GB envelope"}

    def test_derivative_preserves_envelope_and_binds_original_before_admission(self):
        original = json.dumps(self.request, indent=1) + "\n"
        result = json.loads(planner(self.repo, self.output, original))
        for name in ("estimated_growth_gb", "write_paths", "purpose", "label"):
            self.assertEqual(result[name], self.request[name])
        self.assertEqual(result["output_roots"], [*self.request["output_roots"], str(self.repo / "build"), str(self.output)])
        self.assertIn(hashlib.sha256(original.encode()).hexdigest(), result["estimate_basis"])
        self.assertFalse(self.output.exists(), "Planning must not create or admit an operation")

    def test_fully_declared_manual_request_retains_exact_bytes(self):
        self.request["output_roots"] += [str(self.repo / "build"), str(self.output)]
        original = json.dumps(self.request, indent=3) + "\n\n"
        self.assertEqual(planner(self.repo, self.output, original), original)

    def test_missing_write_authority_refuses_instead_of_widening(self):
        self.request["write_paths"] = [str(self.repo / "target")]
        with self.assertRaisesRegex(RuntimeError, "authorized write paths"):
            planner(self.repo, self.output, json.dumps(self.request))

    def test_proof_escape_and_build_symlink_refuse(self):
        with self.assertRaisesRegex(RuntimeError, "canonical proof"):
            planner(self.repo, self.repo / "elsewhere", json.dumps(self.request))
        (self.repo / "build").symlink_to(self.repo / "target")
        with self.assertRaisesRegex(RuntimeError, "authorized write paths"):
            planner(self.repo, self.output, json.dumps(self.request))


if __name__ == "__main__":
    unittest.main()
