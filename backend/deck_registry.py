"""Persistent, conservative deck-assignment registry for AI-DJ loading.

Assignments are written only after a load was independently confirmed by
Rekordbox feedback. Any observed physical/virtual LOAD action invalidates the
affected deck until the safe loader confirms the new assignment.
"""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / ".cache"
REGISTRY_PATH = CACHE_DIR / "ai_dj_decks.json"
LOCK_PATH = CACHE_DIR / "ai_dj_decks.lock"


def _blank() -> dict:
    return {
        "version": 1,
        "decks": {"1": None, "2": None},
        "last_invalidation": {"1": None, "2": None},
        "updated_at": None,
    }


@contextmanager
def _locked():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _read_unlocked() -> dict:
    try:
        data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _blank()
    except Exception:
        return _blank()
    data.setdefault("version", 1)
    data.setdefault("decks", {})
    data["decks"].setdefault("1", None)
    data["decks"].setdefault("2", None)
    data.setdefault("last_invalidation", {})
    data["last_invalidation"].setdefault("1", None)
    data["last_invalidation"].setdefault("2", None)
    return data


def _write_unlocked(data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = time.time()
    fd, tmp_name = tempfile.mkstemp(prefix="ai_dj_decks.", suffix=".tmp", dir=str(CACHE_DIR))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, REGISTRY_PATH)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def snapshot() -> dict:
    with _locked():
        return json.loads(json.dumps(_read_unlocked()))


def get_assignment(deck: int) -> dict | None:
    deck = int(deck)
    if deck not in (1, 2):
        raise ValueError("deck must be 1 or 2")
    with _locked():
        row = _read_unlocked().get("decks", {}).get(str(deck))
        return dict(row) if isinstance(row, dict) else None


def mark_assignment(deck: int, track: dict, *, confirmation: str, selected_result_index: int | None = None) -> dict:
    deck = int(deck)
    if deck not in (1, 2):
        raise ValueError("deck must be 1 or 2")
    entry = {
        "track_id": str(track.get("id") or ""),
        "title": str(track.get("title") or ""),
        "artist": str(track.get("artist") or ""),
        "album": str(track.get("album") or ""),
        "bpm": float(track.get("bpm") or 0.0),
        "key": str(track.get("key") or ""),
        "length": int(track.get("length") or 0),
        "path": str(track.get("path") or ""),
        "confirmation": str(confirmation),
        "selected_result_index": selected_result_index,
        "verified_at": time.time(),
    }
    with _locked():
        data = _read_unlocked()
        data["decks"][str(deck)] = entry
        data["last_invalidation"][str(deck)] = None
        _write_unlocked(data)
    return entry


def invalidate_assignment(deck: int, *, reason: str) -> None:
    deck = int(deck)
    if deck not in (1, 2):
        return
    with _locked():
        data = _read_unlocked()
        data["decks"][str(deck)] = None
        data["last_invalidation"][str(deck)] = {
            "reason": str(reason),
            "at": time.time(),
        }
        _write_unlocked(data)
