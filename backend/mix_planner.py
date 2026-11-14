"""Phrase-aware Rekordbox transition planning.

This module is intentionally read-only. It consumes track metadata plus
Rekordbox beat/phrase/cue analysis and returns a planning suggestion; it does
not load a deck, alter a cue, or write to the Rekordbox database.
"""
from __future__ import annotations

import re
from typing import Any

import camelot

_STYLE_STOPWORDS = {
    "dj", "music", "track", "tracks", "audio", "downloads", "download", "spotify",
    "work", "files", "file", "desktop", "users", "mikylecouto", "volumes", "extreme",
    "ssd", "the", "and", "of", "mix", "mixes", "set", "sets", "playlist", "playlists",
}


def _camelot(value: str) -> str:
    key = str(value or "").strip().upper()
    return key if key in camelot.CAMELOT_WHEEL else ""


def _phrases(analysis: dict | None) -> list[dict]:
    rows = (analysis or {}).get("phrases", [])
    return [p for p in rows if isinstance(p, dict) and _finite(p.get("start_sec"))]


def _hot_cues(cues: dict | None) -> list[dict]:
    rows = (cues or {}).get("cues", [])
    return [c for c in rows if isinstance(c, dict) and c.get("hot_cue") and _finite(c.get("in_ms"))]


def _finite(value: Any) -> bool:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def _nearest_hot_cue_seconds(cues: list[dict], at_seconds: float) -> tuple[dict | None, float | None]:
    if not cues:
        return None, None
    best = min(cues, key=lambda c: abs(float(c.get("in_ms", 0)) / 1000.0 - at_seconds))
    distance = abs(float(best.get("in_ms", 0)) / 1000.0 - at_seconds)
    return best, distance


def _bars(phrase: dict) -> int:
    beats = max(1, int(phrase.get("end_beat", 0) or 0) - int(phrase.get("start_beat", 0) or 0))
    return max(1, round(beats / 4))


def _standard_phrase_penalty(beats: int) -> float:
    """Softly prefer common DJ phrase spans while allowing irregular phrases."""
    bars = max(0.25, float(beats) / 4.0)
    common = (2.0, 4.0, 8.0, 16.0, 32.0)
    nearest = min(common, key=lambda x: abs(x - bars))
    return abs(bars - nearest) / nearest


def tempo_relation(from_bpm: float, to_bpm: float) -> dict:
    """Return the closest normal / half-time / double-time BPM relationship."""
    a = float(from_bpm or 0)
    b = float(to_bpm or 0)
    if a <= 0 or b <= 0:
        return {"effective_bpm": b, "multiplier": 1.0, "delta": None, "tempo_percent": None}
    choices = [(1.0, b), (2.0, b * 2.0), (0.5, b * 0.5)]
    multiplier, effective = min(choices, key=lambda item: abs(item[1] - a))
    delta = abs(effective - a)
    tempo_percent = (a / effective - 1.0) * 100.0 if effective > 0 else None
    return {
        "effective_bpm": round(effective, 4),
        "multiplier": multiplier,
        "delta": round(delta, 4),
        "tempo_percent": round(tempo_percent, 4) if tempo_percent is not None else None,
    }


def _style_tokens(track: dict) -> tuple[set[str], set[str]]:
    genre = str(track.get("genre", "") or "")
    path = str(track.get("path", "") or "").replace("\\", "/")

    def tokens(text: str) -> set[str]:
        out = set()
        for raw in re.findall(r"[a-zA-Z]+", text.lower()):
            word = raw.strip()
            if len(word) < 3 or word in _STYLE_STOPWORDS:
                continue
            out.add(word)
        return out

    genre_tokens = tokens(genre)
    parts = [p for p in path.split("/") if p]
    # Directory names are often the user's most meaningful crate taxonomy.
    # Use the three folders closest to the file, excluding the filename.
    folder_tokens = tokens(" ".join(parts[-4:-1])) if len(parts) >= 2 else set()
    return genre_tokens, folder_tokens


def style_similarity(track_a: dict, track_b: dict) -> float:
    """Estimate style continuity from Rekordbox genre + local crate/folder context."""
    ga, fa = _style_tokens(track_a or {})
    gb, fb = _style_tokens(track_b or {})

    def jaccard(a: set[str], b: set[str]) -> float:
        if not a or not b:
            return 0.0
        return len(a & b) / max(1, len(a | b))

    genre_score = jaccard(ga, gb)
    folder_score = jaccard(fa, fb)
    if ga and gb:
        score = genre_score * 0.65 + folder_score * 0.35
    else:
        score = folder_score
    return round(max(0.0, min(1.0, score)), 4)


def plan_transition(
    from_track: dict,
    to_track: dict,
    from_analysis: dict | None,
    to_analysis: dict | None,
    from_cues: dict | None = None,
    to_cues: dict | None = None,
) -> dict:
    """Return one transparent phrase-aware transition suggestion.

    The ranking favors a late phrase boundary in the outgoing track, an early
    phrase boundary in the incoming track, similar phrase lengths, and saved
    hot cues close to those boundaries. Confidence is reported separately from
    the candidate score and is based on key/BPM compatibility plus availability
    of real Rekordbox phrase analysis.
    """
    a = dict(from_track or {})
    b = dict(to_track or {})
    pa = _phrases(from_analysis)
    pb = _phrases(to_analysis)
    ca = _hot_cues(from_cues)
    cb = _hot_cues(to_cues)

    duration_a = max(1.0, float(a.get("length", 0) or 0))
    duration_b = max(1.0, float(b.get("length", 0) or 0))
    bpm_a = float(a.get("bpm", 0) or 0)
    bpm_b = float(b.get("bpm", 0) or 0)
    key_a = _camelot(a.get("camelot") or a.get("key"))
    key_b = _camelot(b.get("camelot") or b.get("key"))
    harmonic = bool(key_a and key_b and key_b in camelot.compatible_keys(key_a))
    tempo = tempo_relation(bpm_a, bpm_b)
    bpm_delta = tempo.get("delta")
    style_score = style_similarity(a, b)

    outgoing = [p for p in pa if 0.50 <= float(p["start_sec"]) / duration_a <= 0.93][-8:]
    incoming = [p for p in pb if float(p["start_sec"]) / duration_b <= 0.42][:8]

    best = None
    for po in outgoing:
        out_pos = float(po["start_sec"]) / duration_a
        out_beats = max(1, int(po.get("end_beat", 0) or 0) - int(po.get("start_beat", 0) or 0))
        out_cue, out_cue_distance = _nearest_hot_cue_seconds(ca, float(po["start_sec"]))
        for pi in incoming:
            in_pos = float(pi["start_sec"]) / duration_b
            in_beats = max(1, int(pi.get("end_beat", 0) or 0) - int(pi.get("start_beat", 0) or 0))
            in_cue, in_cue_distance = _nearest_hot_cue_seconds(cb, float(pi["start_sec"]))
            phrase_penalty = abs(out_beats - in_beats) / max(out_beats, in_beats)
            structure_penalty = _standard_phrase_penalty(out_beats) + _standard_phrase_penalty(in_beats)
            score = (
                abs(out_pos - 0.74) * 2.2
                + abs(in_pos - 0.16) * 2.0
                + phrase_penalty * 1.6
                + structure_penalty * 0.7
            )
            # Prefer existing cue markers close to a phrase boundary, but only
            # as a modest tie-breaker so cue presence never overwhelms phrasing.
            if out_cue_distance is not None and out_cue_distance <= 2.0:
                score -= 0.12
            if in_cue_distance is not None and in_cue_distance <= 2.0:
                score -= 0.12
            candidate = {
                "score": round(score, 5),
                "out_phrase": po,
                "in_phrase": pi,
                "out_bars": max(1, round(out_beats / 4)),
                "in_bars": max(1, round(in_beats / 4)),
                "out_hot_cue": out_cue if out_cue_distance is not None and out_cue_distance <= 2.0 else None,
                "in_hot_cue": in_cue if in_cue_distance is not None and in_cue_distance <= 2.0 else None,
            }
            if best is None or candidate["score"] < best["score"]:
                best = candidate

    if harmonic and bpm_delta is not None and bpm_delta <= 4:
        confidence = "high"
    elif harmonic or (bpm_delta is not None and bpm_delta <= 6):
        confidence = "medium"
    else:
        confidence = "low"

    tempo_percent = tempo.get("tempo_percent")

    result = {
        "from": {"id": str(a.get("id", "")), "title": a.get("title", ""), "bpm": bpm_a, "key": key_a or a.get("key", "")},
        "to": {"id": str(b.get("id", "")), "title": b.get("title", ""), "bpm": bpm_b, "key": key_b or b.get("key", "")},
        "harmonic": harmonic,
        "bpm_delta": round(bpm_delta, 3) if bpm_delta is not None else None,
        "incoming_tempo_percent_to_match": round(tempo_percent, 3) if tempo_percent is not None else None,
        "incoming_effective_bpm": tempo.get("effective_bpm"),
        "tempo_multiplier": tempo.get("multiplier"),
        "style_similarity": style_score,
        "confidence": confidence,
        "phrase_analysis": {"from_count": len(pa), "to_count": len(pb)},
        "suggestion": None,
    }
    if best is not None:
        result["suggestion"] = {
            "from_start_sec": round(float(best["out_phrase"]["start_sec"]), 4),
            "to_start_sec": round(float(best["in_phrase"]["start_sec"]), 4),
            "from_phrase_index": int(best["out_phrase"].get("index", 0) or 0),
            "to_phrase_index": int(best["in_phrase"].get("index", 0) or 0),
            "from_bars": best["out_bars"],
            "to_bars": best["in_bars"],
            "from_phrase_kind": int(best["out_phrase"].get("kind", 0) or 0),
            "to_phrase_kind": int(best["in_phrase"].get("kind", 0) or 0),
            "from_hot_cue": best["out_hot_cue"],
            "to_hot_cue": best["in_hot_cue"],
            "selection_score": best["score"],
        }
    return result
