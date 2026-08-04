"""Task 2 validation — deterministic skill catalog + provider/verifier hash agreement."""
from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # workspace root (…/tools/skills/skills-catalog → root)

_spec = importlib.util.spec_from_file_location("skills_ingest", HERE / "ingest.py")
ingest = importlib.util.module_from_spec(_spec)
sys.modules["skills_ingest"] = ingest
_spec.loader.exec_module(ingest)

_rp_spec = importlib.util.spec_from_file_location("recall_planner", ROOT / "tools" / "hooks" / "recall_planner.py")
recall_planner = importlib.util.module_from_spec(_rp_spec)
sys.modules["recall_planner"] = recall_planner
_rp_spec.loader.exec_module(recall_planner)


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)  # exact bytes, LF, no platform translation


def _tmp_repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@t.t")
    _git(tmp_path, "config", "user.name", "t")
    _write(tmp_path / ".gitattributes", b"* text=auto eol=lf\n")
    skill = tmp_path / "tools" / "skills" / "demo"
    _write(skill / "SKILL.md", b"---\nname: demo\ndescription: A demo skill for testing catalog ingest here.\n---\n# Demo\nbody\n")
    _write(skill / "scripts" / "run.sh", b"echo hi\n")
    _git(tmp_path, "add", "-A")
    return tmp_path


def test_catalog_is_deterministic(tmp_path):
    root = _tmp_repo(tmp_path)
    a = ingest.build_catalog(root)
    b = ingest.build_catalog(root)
    assert a["generationHash"] == b["generationHash"], "same input must yield the same generation hash"
    assert a == b


def test_bodyhash_matches_resolver_audit():
    # The catalog's bodyHash MUST equal what the delivery verifier re-derives, or a real skill
    # would be rejected at delivery. Checked against the live repo's `brief` skill.
    catalog = ingest.build_catalog(ROOT)
    brief = next(s for s in catalog["skills"] if s["name"] == "brief")
    resolver = recall_planner.SkillResolver(skills_root=ROOT / "tools" / "skills", emit=lambda e: None)
    audited_hash, _desc = resolver._audited("brief")
    assert brief["bodyHash"] == audited_hash


def test_resource_manifest_shape_and_exec_bit(tmp_path):
    root = _tmp_repo(tmp_path)
    _git(root, "update-index", "--chmod=+x", "tools/skills/demo/scripts/run.sh")
    demo = next(s for s in ingest.build_catalog(root)["skills"] if s["name"] == "demo")
    res = {r["path"]: r for r in demo["resources"]}
    assert "scripts/run.sh" in res
    r = res["scripts/run.sh"]
    assert r["bytes"] == len(b"echo hi\n")
    assert r["sha256"] == hashlib.sha256(b"echo hi\n").hexdigest()
    assert r["executable"] is True, "exec bit must come from the git index mode (100755)"


def test_only_tracked_files_indexed(tmp_path):
    root = _tmp_repo(tmp_path)
    _write(root / "tools" / "skills" / "demo" / "scripts" / "secret.sh", b"evil\n")  # untracked
    demo = next(s for s in ingest.build_catalog(root)["skills"] if s["name"] == "demo")
    assert all(r["path"] != "scripts/secret.sh" for r in demo["resources"]), "untracked file leaked into catalog"


def test_skill_without_tracked_skillmd_is_not_a_skill(tmp_path):
    root = _tmp_repo(tmp_path)
    _write(root / "tools" / "skills" / "notaskill" / "readme.txt", b"hi\n")
    _git(root, "add", "-A")
    names = [s["name"] for s in ingest.build_catalog(root)["skills"]]
    assert "notaskill" not in names
