"""GitOps image update; legacy behavior is preserved until MULTI_TARGET_ENABLED=true."""
import os
from pathlib import Path
import re

import yaml

sha = os.environ["GITHUB_SHA"]
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise ValueError("GITHUB_SHA must be a complete commit SHA")
root = Path(os.environ.get("GITOPS_CHECKOUT", "gitops"))
if Path("deployment-request.yaml").exists():
    print("Multi-target request: the review coordinator owns the GitOps release")
else:
    spec = yaml.safe_load(Path("deploy.yaml").read_text())
    app, image = spec["metadata"]["name"], spec["image"]["repository"]
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", app):
        raise ValueError("invalid app name")
    enabled = os.environ.get("MULTI_TARGET_ENABLED", "false").lower() == "true"
    env = spec["target"]["env"]
    if env not in {"aws", "gcp", "local"}:
        raise ValueError("invalid environment")
    path = root / "apps" / app / (f"overlays/{env}/kustomization.yaml" if enabled else "base/kustomization.yaml")
    text = path.read_text()
    config = yaml.safe_load(text)
    images = config.setdefault("images", [])
    entry = next((v for v in images if v["name"] == image), None)
    if entry is None:
        entry = {"name": image}
        images.append(entry)
    entry.pop("digest", None)
    entry["newTag"] = sha
    path.write_text(yaml.safe_dump(config, sort_keys=False))
