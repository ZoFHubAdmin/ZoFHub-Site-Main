#!/usr/bin/env python3
"""Turn reviewed AI feedback into versioned, provenance-carrying datasets.

    node tools/run-python.mjs tools/curate-ai-dataset.py --out data/ai-datasets
    node tools/run-python.mjs tools/curate-ai-dataset.py --dry-run

WHAT THIS IS FOR
----------------
lib/ai-feedback.mjs decides what a signal is ALLOWED to influence. This is the
step that turns the allowed rows into something a training or evaluation run can
actually consume — with deduplication, quality filtering, a fixed split, and a
manifest recording exactly where every row came from.

It is an OPERATOR tool. It never runs in the web container, never runs on a
request, and is not a runtime dependency of the site: `datasets` and its Arrow
stack are hundreds of megabytes and have no business in a Node web service.

WHY `datasets` RATHER THAN A JSON FILE
--------------------------------------
Three things it gives that hand-rolled JSON does not, all of which matter here:
  * content-addressed dedup over the whole corpus, not per-file;
  * a fingerprint per transformation, so two people running this get provably
    the same rows or find out why not;
  * one export format that training and evaluation code already understands,
    so nobody writes a bespoke loader that quietly drops a field.

THE FOUR REFUSALS
-----------------
This script will not:
  1. read a row whose review_state is not 'approved' — a human gates every row;
  2. put a row in the SFT split without consent_training AND training_eligible;
  3. let evaluation rows leak into training splits — that would make the eval
     set measure memorisation and every later number meaningless;
  4. emit a dataset without a manifest naming the source rows and the code
     version that produced it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
CODE_VERSION = "2026-09-21.1"

# Lanes, mirrored from lib/ai-feedback.mjs. Kept as literals rather than parsed
# out of the JS so a rename over there fails a test here instead of silently
# producing an empty split.
LANE_SFT = "sft_candidate"
LANE_PREFERENCE = "preference"
LANE_EVAL = "eval"


def _require_datasets():
    try:
        import datasets  # noqa: F401
    except ImportError:
        # NAME THE INTERPRETER. This repo has a .venv and tools/run-python.mjs
        # correctly prefers it, so `pip install datasets` in a shell usually
        # lands in a DIFFERENT Python and the tool keeps reporting it missing.
        # A bare "install it" message sends people round that loop twice.
        sys.stderr.write(
            "This tool needs Hugging Face `datasets`, which is an OPERATOR-ONLY\n"
            "dependency (it is not installed in the web container and must not be).\n\n"
            f"Running under: {sys.executable}\n"
            "Install into THAT interpreter, not whichever `python` your shell finds:\n\n"
            f'    "{sys.executable}" -m pip install "datasets>=3.0,<5"\n\n'
        )
        raise SystemExit(2)
    return __import__("datasets")


# ── Loading ────────────────────────────────────────────────────────────────

def load_rows(path: Path | None) -> list[dict[str, Any]]:
    """Read approved feedback rows.

    Reads a JSON export rather than talking to Supabase directly: the service
    key belongs on the server, not in a developer's shell history, and an
    export is also the artefact you can attach to a dataset card.
    """
    if path is None or not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = raw.get("feedback", raw) if isinstance(raw, dict) else raw
    return [r for r in rows if isinstance(r, dict)]


# ── Quality ────────────────────────────────────────────────────────────────

# Injection shapes that should never become a training target. This is not a
# complete defence and is not presented as one — it is the cheap filter that
# stops the obvious poisoning attempt from reaching a curator's review queue.
_INJECTION = re.compile(
    r"ignore (all )?(previous|prior) instructions"
    r"|disregard (the )?(system|above)"
    r"|you are now"
    r"|system prompt"
    r"|<\|im_start\|>"
    r"|\bDAN\b",
    re.I,
)

_PLACEHOLDER = re.compile(r"\[(email|phone|card|token|address|ip)\]")


@dataclass
class Reject:
    row_id: str
    why: str


def quality_issues(row: dict[str, Any]) -> list[str]:
    """Every reason this row should not be trained on. Empty list means clean."""
    issues: list[str] = []
    inp = (row.get("input") or "").strip()
    out = (row.get("output") or "").strip()
    cor = (row.get("correction") or "").strip()

    if len(inp) < 8:
        issues.append("input too short to be a task")
    if not (out or cor):
        issues.append("no model output and no correction — nothing to learn from")
    if _INJECTION.search(inp) or _INJECTION.search(cor):
        issues.append("looks like a prompt-injection attempt")
    # Heavy redaction means the person pasted personal material. Even redacted,
    # the surrounding text usually still describes their situation, so it is not
    # training material.
    if int(row.get("redactions") or 0) >= 3:
        issues.append("heavily redacted — likely personal context")
    if _PLACEHOLDER.search(cor):
        issues.append("correction contains a redaction placeholder")
    # A "correction" that repeats the answer teaches the model to keep doing it.
    if cor and out and cor.strip().lower() == out.strip().lower():
        issues.append("correction is identical to the output")
    if len(cor) > 4000 or len(inp) > 4000:
        issues.append("over length bound")
    return issues


def content_hash(row: dict[str, Any]) -> str:
    """Identity for dedup: the task and its target, nothing else.

    Deliberately excludes provider, model and timestamp — the same correction
    submitted twice through different models is ONE example, and counting it
    twice would weight it twice.
    """
    basis = "\u0000".join([
        (row.get("input") or "").strip().lower(),
        (row.get("correction") or row.get("output") or "").strip().lower(),
    ])
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


# ── Splitting ──────────────────────────────────────────────────────────────

def split_rows(rows: Iterable[dict[str, Any]]):
    """Route approved rows into splits, enforcing the four refusals."""
    sft, preference, evaluation = [], [], []
    rejects: list[Reject] = []
    seen: dict[str, str] = {}
    eval_hashes: set[str] = set()

    for row in rows:
        rid = str(row.get("id") or "?")

        # Refusal 1 — human review is mandatory.
        if row.get("review_state") != "approved":
            rejects.append(Reject(rid, f"review_state={row.get('review_state')!r}, not approved"))
            continue

        issues = quality_issues(row)
        if issues:
            rejects.append(Reject(rid, "; ".join(issues)))
            continue

        h = content_hash(row)
        if h in seen:
            rejects.append(Reject(rid, f"duplicate of {seen[h]}"))
            continue
        seen[h] = rid

        lanes = row.get("lanes") or []

        if LANE_EVAL in lanes:
            evaluation.append(_eval_example(row))
            eval_hashes.add(h)

        if LANE_PREFERENCE in lanes and row.get("correction"):
            preference.append(_preference_example(row))

        # Refusal 2 — consent AND eligibility, both, every time.
        if LANE_SFT in lanes:
            if not (row.get("consent_training") and row.get("training_eligible")):
                rejects.append(Reject(rid, "in sft lane without consent_training+training_eligible"))
            elif h in eval_hashes:
                # Refusal 3 — never train on something we also measure with.
                rejects.append(Reject(rid, "also an evaluation row; excluded from training"))
            else:
                sft.append(_sft_example(row))

    return sft, preference, evaluation, rejects


def _sft_example(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "user", "content": row.get("input") or ""},
            {"role": "assistant", "content": row.get("correction") or ""},
        ],
        "source_id": str(row.get("id") or ""),
        "provider": row.get("provider"),
        "model": row.get("model"),
        "prompt_version": row.get("prompt_version"),
        "created_at": row.get("created_at"),
    }


def _preference_example(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt": row.get("input") or "",
        "chosen": row.get("correction") or "",
        "rejected": row.get("output") or "",
        "source_id": str(row.get("id") or ""),
        "model": row.get("model"),
    }


def _eval_example(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt": row.get("input") or "",
        "reference": row.get("correction") or "",
        "observed": row.get("output") or "",
        "category": "from-feedback",
        "source_id": str(row.get("id") or ""),
    }


# ── Export ─────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", default=str(ROOT / "data" / "ai-feedback-export.json"),
                    help="JSON export of the ai_feedback table (admin-produced).")
    ap.add_argument("--out", default=str(ROOT / "data" / "ai-datasets"))
    ap.add_argument("--dry-run", action="store_true", help="Report the split without writing.")
    args = ap.parse_args()

    rows = load_rows(Path(args.input))
    if not rows:
        print(f"No rows at {args.input}.")
        print("Export approved feedback from the admin console first; this tool never")
        print("reads the database directly, so the service key stays on the server.")
        return 0

    sft, preference, evaluation, rejects = split_rows(rows)

    print(f"read {len(rows)} row(s)")
    print(f"  sft         {len(sft):5d}")
    print(f"  preference  {len(preference):5d}")
    print(f"  eval        {len(evaluation):5d}")
    print(f"  rejected    {len(rejects):5d}")
    if rejects:
        reasons: dict[str, int] = {}
        for r in rejects:
            key = r.why.split(";")[0]
            reasons[key] = reasons.get(key, 0) + 1
        for why, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
            print(f"      {n:4d}  {why}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    if not (sft or preference or evaluation):
        print("\nNothing passed curation; no dataset written.")
        return 0

    datasets = _require_datasets()
    from datasets import Dataset, DatasetDict

    parts = {}
    if sft:
        parts["sft"] = Dataset.from_list(sft)
    if preference:
        parts["preference"] = Dataset.from_list(preference)
    if evaluation:
        parts["eval"] = Dataset.from_list(evaluation)

    dd = DatasetDict(parts)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dd.save_to_disk(str(out))

    # Refusal 4 — provenance or it did not happen. The fingerprints are what
    # make "which rows produced this model?" answerable months later.
    manifest = {
        "code_version": CODE_VERSION,
        "datasets_version": datasets.__version__,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_export": os.path.basename(args.input),
        "source_rows": len(rows),
        "counts": {k: len(v) for k, v in parts.items()},
        "fingerprints": {k: v._fingerprint for k, v in parts.items()},
        "source_ids": {k: [r.get("source_id") for r in lst][:5000]
                       for k, lst in (("sft", sft), ("preference", preference), ("eval", evaluation)) if lst},
        "rejected": [asdict(r) for r in rejects][:2000],
        "policy": {
            "human_review_required": True,
            "consent_required_for_sft": True,
            "eval_rows_excluded_from_training": True,
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"\nwrote {out}")
    print(f"  fingerprints: {manifest['fingerprints']}")
    print("\nA dataset is NOT a decision. Evaluate before anything is promoted:")
    print("  npm run eval-ai -- --provider huggingface --model <id>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
