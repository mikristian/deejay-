"""Fail-closed deck metadata for the Music Hub performance header.

Rekordbox doesn't offer a documented current-track API for this DDJ-FLX4.
We show a track as currently loaded ONLY when its durable, load-confirmed
registry entry exists and genuine two-way Rekordbox feedback is live. A
previously verified assignment is exposed as ``lastKnown`` while offline,
never mistaken for a playing or connected deck.

This endpoint never sends MIDI, starts a runtime, loads a song or plays audio.
"""
from __future__ import annotations

import json
import time


def _probe_status():
    """Passive, short-lived status query; no automatic runtime initialization."""
    from websockets.sync.client import connect

    try:
        with connect("ws://127.0.0.1:18765", open_timeout=0.45, close_timeout=0.25) as ws:
            ws.send(json.dumps({"type": "status_request", "_reply_only": True}))
            for _ in range(4):
                event = json.loads(ws.recv(timeout=0.65))
                if event.get("action") == "controller_status":
                    return event.get("status") or {}, None
                if event.get("action") == "error":
                    return {}, str(event.get("message") or "Controller status unavailable")
    except Exception:
        pass
    return {}, "Controller feedback unavailable"


def deck_status(*, probe=None, registry=None, library=None, now=None):
    """Return only verifiable deck states without claiming playback truth."""
    if registry is None:
        from deck_registry import snapshot
        registry = snapshot()
    if probe is None:
        probe = _probe_status
    try:
        controller, error = probe()
    except Exception:
        controller, error = {}, "Controller status unavailable"
    controller = controller if isinstance(controller, dict) else {}
    live = bool(controller.get("rekordbox_two_way_verified") and controller.get("rekordbox_two_way_live"))
    verified_bridge = bool(controller.get("rekordbox_two_way_verified"))
    now = time.time() if now is None else float(now)
    if library is None:
        try:
            from dashboard_http import get_rekordbox_library_fast
            library = get_rekordbox_library_fast().get("collection", [])
        except Exception:
            library = []
    by_id = {str(t.get("id")): t for t in library if isinstance(t, dict) and t.get("id") is not None}
    assignments = registry.get("decks", {}) if isinstance(registry, dict) else {}
    output = {}
    for deck in ("1", "2"):
        record = assignments.get(deck)
        row = None
        if isinstance(record, dict) and record.get("track_id"):
            track_id = str(record["track_id"])
            original = by_id.get(track_id) or {}
            # Last known is historical metadata, not actual deck state.
            row = {
                "trackId": track_id,
                "title": str(record.get("title") or original.get("title") or ""),
                "artist": str(record.get("artist") or original.get("artist") or ""),
                "bpm": float(record.get("bpm") or original.get("bpm") or 0),
                "camelot": str(original.get("camelot") or ""),
                "key": str(record.get("key") or original.get("key") or ""),
                "duration": int(record.get("length") or original.get("length") or 0),
                "artwork": str(original.get("artwork") or ""),
                "verifiedAt": record.get("verified_at"),
                "confirmation": str(record.get("confirmation") or ""),
            }
        # A stale registry entry alone must never look currently loaded.
        loaded = row if live else None
        output[deck] = {
            "loaded": loaded,
            "lastKnown": row,
            "verified": bool(loaded),
            "playback": "unknown",  # MIDI feedback cannot prove track/position/audio.
            "status": "loaded_verified" if loaded else "unverified",
        }
    return {
        "connected": live,
        "verified": verified_bridge,
        "decks": output,
        "checkedAt": now,
        "note": (
            "Two-way MIDI feedback is live; deck titles reflect the most recently verified Music Hub loads. Playback state and actual playhead are not independently verified."
            if live else "No verified live deck state. Any last-known title is historical, not proof the track is loaded or playing."
        ),
        "error": error if not live else None,
    }
