"""App-owned persistent Music Hub cue markers; Rekordbox remains read-only."""
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

DEFAULT_PATH = Path(__file__).resolve().parent / ".cache" / "music_hub_markers.json"
MAX_TRACKS = 20000
MAX_PER_TRACK = 64
MAX_BYTES = 8 * 1024 * 1024
_LOCK = threading.RLock()
_TRACK = re.compile(r"[0-9]{1,20}\Z")
_HEX = re.compile(r"#[0-9a-fA-F]{6}\Z")
_UUID = re.compile(r"[0-9a-f]{32}\Z")


class MarkerError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _find(track_id, collection):
    if not isinstance(track_id, str) or not _TRACK.fullmatch(track_id):
        raise MarkerError("Invalid track ID")
    item = next((r for r in collection if isinstance(r, dict) and str(r.get("id")) == track_id), None)
    if item is None:
        raise MarkerError("Track not present in local Rekordbox collection", 404)
    return item


def _duration(row):
    try:
        length = float(row.get("length") or 0)
        return round(length * 1000) if 0 < length < 86400 else None
    except (ValueError, TypeError, OverflowError):
        return None


def _validate(item, tid, duration=None, status=503):
    if (not isinstance(item, dict) or item.get("trackId") != tid or item.get("source") != "user"
            or not isinstance(item.get("id"), str) or not _UUID.fullmatch(item["id"])
            or type(item.get("timeMs")) is not int or not 0 <= item["timeMs"] <= 86400000
            or (duration is not None and item["timeMs"] > duration)
            or not isinstance(item.get("label"), str) or len(item["label"]) > 80
            or len(item["label"].encode("utf-8")) > 240
            or not isinstance(item.get("color"), str) or not _HEX.fullmatch(item["color"])
            or item.get("type") not in ("cue", "hotcue", "loop")):
        raise MarkerError("Invalid marker fields", status)


def _read(path):
    if not path.exists():
        return {}
    try:
        if path.stat().st_size > MAX_BYTES:
            raise ValueError("Storage size limit exceeded")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or len(data) > MAX_TRACKS:
            raise ValueError("Invalid marker data")
        for tid, items in data.items():
            if not isinstance(tid, str) or not _TRACK.fullmatch(tid) or not isinstance(items, list) or len(items) > MAX_PER_TRACK:
                raise ValueError("Invalid marker group")
            seen = set()
            for item in items:
                _validate(item, tid)
                if item["id"] in seen:
                    raise ValueError("Duplicate marker")
                seen.add(item["id"])
        return data
    except (OSError, ValueError, UnicodeError, MarkerError) as exc:
        raise MarkerError(f"Music Hub markers could not be read: {exc}", 503) from exc


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".markers-", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        if os.path.getsize(temporary) > MAX_BYTES:
            raise MarkerError("Marker storage limit exceeded", 413)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _result(tid, user, existing):
    cues = existing.get("cues", []) if isinstance(existing, dict) else []
    markers = []
    for item in cues:
        if not isinstance(item, dict):
            continue
        cue = dict(item)
        cue.update(id="rekordbox:" + str(item.get("id", "")), trackId=tid,
                   source="rekordbox", timeMs=item.get("in_ms", 0),
                   type="loop" if item.get("loop") else ("hotcue" if item.get("hot_cue") else "cue"))
        markers.append(cue)
    markers.extend(dict(m) for m in user)
    markers.sort(key=lambda m: (m["timeMs"], m["source"] != "rekordbox", m["id"]))
    return {"trackId": tid, "markers": markers, "count": len(markers),
            "userCount": len(user), "rekordboxCount": len(markers) - len(user)}


def get_markers(track_id, collection, existing=None, path=DEFAULT_PATH):
    _find(track_id, collection)
    with _LOCK:
        return _result(track_id, _read(Path(path)).get(track_id, []), existing)


def mutate(payload, collection, existing=None, path=DEFAULT_PATH):
    if not isinstance(payload, dict):
        raise MarkerError("JSON object required")
    tid = payload.get("trackId")
    duration = _duration(_find(tid, collection))
    action = payload.get("action")
    if action not in ("add", "update", "remove"):
        raise MarkerError("Unknown marker action")
    with _LOCK:
        data = _read(Path(path))
        items = list(data.get(tid, []))
        if action == "add":
            if len(items) >= MAX_PER_TRACK or (tid not in data and len(data) >= MAX_TRACKS):
                raise MarkerError("Marker limit reached", 413)
            entry = {"id": uuid.uuid4().hex, "trackId": tid, "source": "user",
                     "timeMs": payload.get("timeMs"), "label": payload.get("label", ""),
                     "color": payload.get("color", "#8b5cf6"), "type": payload.get("type", "cue")}
            _validate(entry, tid, duration, 400)
            items.append(entry)
        else:
            mid = payload.get("id")
            if not isinstance(mid, str) or not _UUID.fullmatch(mid):
                raise MarkerError("Invalid user marker ID")
            pos = next((i for i, m in enumerate(items) if m["id"] == mid), None)
            if pos is None:
                raise MarkerError("User marker not found", 404)
            if action == "remove":
                items.pop(pos)
            else:
                entry = dict(items[pos])
                for field in ("timeMs", "label", "color", "type"):
                    if field in payload:
                        entry[field] = payload[field]
                _validate(entry, tid, duration, 400)
                items[pos] = entry
        if items:
            data[tid] = items
        else:
            data.pop(tid, None)
        _write(Path(path), data)
        return _result(tid, items, existing)
