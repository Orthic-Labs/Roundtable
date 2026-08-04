#!/usr/bin/env python3
"""Skills provider ranking + candidate emission (Task 4 core; recall gate = Task 1).

Given a task string, a scope, and the deterministic catalog (Task 2), rank the scope's skills by
relevance and emit `ContextCandidate` skill blocks in exactly the shape the delivery carve-out
consumes (`sourceKind:"skill"`, `trustClass`, `name`, bounded `text`=description, `bodyHash`,
`resolver`). The provider emits the INDEX (catalog) only — bodies resolve on selection via the
resolver, per progressive disclosure. bodyHash carries provenance so delivery can verify against the
audited skill (Task 0 hardening); a bare label never delivers.

Ranking is deterministic and lexical over name (x3) + triggers (x2) + description (x1), with an
exact-name boost. This is the baseline the recall gate (Task 1) measures against the router; if it
loses on the labeled set, fold the router trigger terms in or add embedding recall — do not ship a
provider that ranks worse than the current router.
"""
from __future__ import annotations

import re
from typing import Any

_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "and", "for", "with", "to", "of", "in", "on", "my", "this", "that",
         "it", "is", "how", "do", "i", "me", "please", "can", "you"}


def _terms(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(str(text).lower()) if len(t) > 1 and t not in _STOP]


def score_skill(skill: dict, query_terms: list[str]) -> float:
    if not query_terms:
        return 0.0
    name = str(skill.get("name", "")).lower()
    triggers = set(skill.get("triggers", []))
    desc_terms = set(_terms(skill.get("description", "")))
    score = 0.0
    for term in query_terms:
        if term == name:
            score += 6.0            # exact skill-name mention is a strong signal
        elif term in name:
            score += 3.0
        if term in triggers:
            score += 2.0
        if term in desc_terms:
            score += 1.0
    return score


def _normalized_score(raw: float) -> float:
    """Map raw lexical points to a providerScore in [0.45, 0.92] so a strongly-matching skill
    (exact name, or name+trigger hits) competes with repo_code candidates in the global admission
    budget, while a weak single-description hit stays low. A flat score let relevant skills lose to
    code and get budget_exhausted — the whole provider then delivers nothing."""
    return round(min(0.92, 0.45 + raw * 0.08), 4)


def rank_skills(catalog: dict, task: str, scope: str = "skills", limit: int = 5) -> list[tuple[float, dict]]:
    query_terms = _terms(task)
    scored = []
    for skill in catalog.get("skills", []):
        if skill.get("scope") != scope:
            continue
        s = score_skill(skill, query_terms)
        if s > 0:
            scored.append((s, skill))
    # deterministic: score desc, then name asc
    scored.sort(key=lambda pair: (-pair[0], pair[1]["name"]))
    return scored[:limit]


def to_candidates(ranked: list[tuple[float, dict]]) -> list[dict[str, Any]]:
    candidates = []
    for raw, skill in ranked:
        name = skill["name"]
        candidates.append({
            "sourceKind": "skill",
            "trustClass": skill.get("trustClass", "workspace_tracked"),
            "name": name,
            "text": str(skill.get("description", ""))[:200],   # bounded catalog description
            "bodyHash": skill["bodyHash"],                     # provenance for delivery verification
            "resolver": f"crypt skill-read {name}",
            "providerScore": _normalized_score(raw),           # rank-derived, for global admission
        })
    return candidates


def produce(task: str, catalog: dict, *, scope: str = "skills", limit: int = 5) -> dict[str, Any]:
    """Provider entry: task -> {candidates, omissions}. Scope-gated by the caller's grant upstream."""
    ranked = rank_skills(catalog, task, scope=scope, limit=limit)
    return {"candidates": to_candidates(ranked), "omissions": []}
