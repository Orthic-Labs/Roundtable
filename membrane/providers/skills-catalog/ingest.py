#!/usr/bin/env python3
"""Deterministic skill-catalog ingest (Task 2 of the skills-as-Membrane-provider plan).

Reads the TRACKED `tools/skills/*/SKILL.md` bundles under the canonical Git root and emits one
byte-stable typed catalog generation. Git is the source of truth and provenance; this catalog is a
regenerable projection, never a second store. The `bodyHash` is computed exactly as
`recall_planner.SkillResolver._audited` computes it (sha256 of the SKILL.md UTF-8 text), so the
provider that reads this catalog and the delivery verifier that re-derives it agree.

Provenance + integrity (the trust root, per the Council/2026 research on skill supply-chain +
MCP tool poisoning): only files git TRACKS under `tools/skills/` are indexed; executable bits come
from the git index mode (100755), not the filesystem, so the catalog is identical on Windows and
macOS; a resource over the size cap or outside its skill dir is rejected.

Usage:
    py -3.11 tools/skills/skills-catalog/ingest.py [--root <workspace>] [--out <catalog.json>] [--print]
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path

# Shared, YAML-free frontmatter parser — MUST be the same implementation the delivery verifier uses,
# or the description bytes diverge across interpreters and the delivery seal rejects real skills.
sys.path.insert(0, "/Volumes/D/claude/tools/lib")
from skill_frontmatter import frontmatter_description, frontmatter_name  # noqa: E402

CATALOG_VERSION = 1
SKILLS_PREFIX = "tools/skills/"
MAX_RESOURCE_BYTES = 2 * 1024 * 1024
_STOP = {"the", "and", "for", "with", "use", "when", "user", "that", "this", "from", "into",
         "via", "not", "are", "you", "your", "any", "per", "its", "than", "then", "each",
         "skill", "skills", "review", "review.", "using", "used", "run", "runs"}


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _tracked_files(root: Path) -> list[tuple[str, str]]:
    """(git-mode, repo-relative-path) for every tracked file under tools/skills/."""
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--stage", "-z", "--", SKILLS_PREFIX],
        capture_output=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit(f"git ls-files failed: {out.stderr.strip()}")
    files = []
    for entry in out.stdout.split("\0"):
        if not entry.strip():
            continue
        # format: "<mode> <objectname> <stage>\t<path>"
        meta, _, path = entry.partition("\t")
        mode = meta.split(" ", 1)[0]
        files.append((mode, path.replace("\\", "/")))
    return files


def _triggers(name: str, description: str) -> list[str]:
    words = []
    for token in (name + " " + description).lower().replace("/", " ").split():
        w = "".join(ch for ch in token if ch.isalnum())
        if len(w) > 3 and w not in _STOP:
            words.append(w)
    seen, ordered = set(), []
    for w in words:
        if w not in seen:
            seen.add(w)
            ordered.append(w)
        if len(ordered) >= 20:
            break
    return sorted(ordered)


def build_catalog(root: Path, scope: str = "skills") -> dict:
    root = root.resolve()
    by_skill: dict[str, dict] = {}
    for mode, path in _tracked_files(root):
        rel = path[len(SKILLS_PREFIX):]
        if "/" not in rel:
            continue  # a loose file directly under tools/skills, not a skill dir
        skill_name = rel.split("/", 1)[0]
        within = rel.split("/", 1)[1]
        abs_path = (root / path).resolve()
        if root not in abs_path.parents:  # traversal / symlink escape guard
            continue
        try:
            data = abs_path.read_bytes()
        except OSError:
            continue
        entry = by_skill.setdefault(skill_name, {"name": skill_name, "resources": []})
        if within == "SKILL.md":
            text = data.decode("utf-8", errors="replace")
            entry["description"] = frontmatter_description(text).strip()
            entry["frontmatterName"] = frontmatter_name(text, skill_name).strip()
            # bodyHash MUST match SkillResolver._audited: sha256 of the UTF-8 text.
            entry["bodyHash"] = _sha256_bytes(text.encode("utf-8"))
        else:
            if len(data) > MAX_RESOURCE_BYTES:
                continue  # oversize resource excluded (loudly absent, not silently trusted)
            entry["resources"].append({
                "path": within,
                "bytes": len(data),
                "sha256": _sha256_bytes(data),
                "executable": mode == "100755",
            })

    skills = []
    for name in sorted(by_skill):
        e = by_skill[name]
        if "bodyHash" not in e:
            continue  # a dir under tools/skills without a tracked SKILL.md is not a skill
        desc = e.get("description", "")
        skills.append({
            "name": name,
            "description": desc,
            "triggers": _triggers(name, desc),
            "scope": scope,
            "trustClass": "workspace_tracked",
            "bodyHash": e["bodyHash"],
            "resources": sorted(e["resources"], key=lambda r: r["path"]),
        })

    payload = {"catalogVersion": CATALOG_VERSION, "scope": scope, "skills": skills}
    payload["generationHash"] = _sha256_bytes(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    return payload


def write_catalog(payload: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    # Byte-stable: sorted keys, trailing newline, LF.
    text = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    tmp = out.with_suffix(out.suffix + f".{__import__('os').getpid()}.tmp")
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    tmp.replace(out)


def main(argv: list[str]) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default="D:/Claude" if sys.platform == "win32" else str(Path.home() / "claude"))
    ap.add_argument("--scope", default="skills")
    ap.add_argument("--out", default=None)
    ap.add_argument("--print", action="store_true")
    args = ap.parse_args(argv)
    payload = build_catalog(Path(args.root), scope=args.scope)
    if args.out:
        write_catalog(payload, Path(args.out))
        print(f"catalog: {len(payload['skills'])} skills, generation {payload['generationHash'][:12]} -> {args.out}")
    if args.print or not args.out:
        print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
