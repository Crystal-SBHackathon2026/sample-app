import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

SCRIPT = Path(__file__).with_name("update_image.py")
IMAGE = "ghcr.io/crystal-sbhackathon2026/sample-app"
SHA = "a" * 40


class ImageUpdateTests(unittest.TestCase):
    def run_case(self, enabled=False, manifest=False, legacy_spec="valid"):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        spec = dict(metadata=dict(name="sample-app"), image=dict(repository=IMAGE), target=dict(env="aws"))
        if legacy_spec != "missing":
            (root / "deploy.yaml").write_text(yaml.safe_dump(spec) if legacy_spec == "valid" else "[invalid yaml")
        if manifest:
            (root / "deployment-request.yaml").write_text("kind: DeploymentRequest\n")
        paths = ["base"] + [f"overlays/{env}" for env in ("aws", "gcp", "local")]
        for path in paths:
            dest = root / f"gitops/apps/sample-app/{path}/kustomization.yaml"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(yaml.safe_dump(dict(images=[dict(name=IMAGE, newTag="old")])))
        before = {p: p.read_text() for p in root.rglob("kustomization.yaml")}
        subprocess.run([sys.executable, str(SCRIPT)], cwd=root,
                       env={**os.environ, "GITHUB_SHA": SHA, "MULTI_TARGET_ENABLED": str(enabled).lower(),
                            "GITOPS_CHECKOUT": "gitops"}, check=True, capture_output=True)
        changed = {str(p.relative_to(root)): p.read_text() for p, original in before.items() if p.read_text() != original}
        return changed

    def test_legacy_updates_base(self):
        self.assertEqual(set(self.run_case()), {"gitops/apps/sample-app/base/kustomization.yaml"})

    def test_enabled_single_target_updates_only_aws(self):
        self.assertEqual(set(self.run_case(enabled=True)), {"gitops/apps/sample-app/overlays/aws/kustomization.yaml"})

    def test_multi_target_main_ci_leaves_gitops_to_coordinator(self):
        self.assertEqual(self.run_case(enabled=True, manifest=True), {})
        self.assertEqual(self.run_case(enabled=False, manifest=True), {})

    def test_multi_target_does_not_require_a_valid_legacy_spec(self):
        for legacy_spec in ("missing", "invalid"):
            for enabled in (False, True):
                with self.subTest(legacy_spec=legacy_spec, enabled=enabled):
                    self.assertEqual(self.run_case(enabled=enabled, manifest=True, legacy_spec=legacy_spec), {})


if __name__ == "__main__":
    unittest.main()
