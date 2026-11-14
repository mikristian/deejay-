"""Local Music Hub manual queue, playlists and favorites.

GET /api/music-hub/state -> {queue:[trackId],playlists:[{id,name,trackIds}],favorites:[trackId],ratings:{trackId:1..5}}
POST /api/music-hub/action JSON -> {action, trackId?, playlistId?, name?, index?, from?, to?}
POST /api/music-hub/load JSON -> {deck:1|2,trackId,dryRun?:true}; never starts playback.
GET /api/music-hub/export?playlistId=<id> -> Rekordbox XML Bridge attachment.
Absent/nonexistent music files are omitted with an explanatory XML comment.
Track IDs must exist in the current Rekordbox collection; this module never edits its DB.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET

STATE_PATH = Path(__file__).resolve().parent / ".cache" / "music_hub_state.json"
MAX_PERSONAL_RATINGS = 20000
MAX_LYRICS_TRACKS = 1000
MAX_LYRICS_BYTES = 4 * 1024 * 1024
MAX_TRACK_LYRICS_BYTES = 16 * 1024
_LOCK = threading.RLock()
_ID = re.compile(r"^[0-9]{1,20}$")


class HubError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _empty():
    return {"queue": [], "playlists": [], "folders": [], "favorites": [], "setlists": [], "ratings": {}}


def _read(path):
    if not path.exists():
        return _empty()
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("state must be an object")
        if not isinstance(obj.get("queue"), list) or not isinstance(obj.get("favorites"), list) or not isinstance(obj.get("playlists"), list):
            raise ValueError("invalid state lists")
        setlists = obj.get("setlists", [])
        if not isinstance(setlists, list):
            raise ValueError("setlists must be a list")
        ratings = obj.get("ratings", {})
        folders = obj.get("folders", [])
        if not isinstance(folders, list) or len(folders) > 500:
            raise ValueError("invalid folders")
        _validate_folders(folders)
        if (not isinstance(ratings, dict) or len(ratings) > MAX_PERSONAL_RATINGS or
                any(not isinstance(tid, str) or not _ID.fullmatch(tid) or
                    type(value) is not int or not 1 <= value <= 5
                    for tid, value in ratings.items())):
            raise ValueError("invalid personal ratings")
        return {**{k: copy.deepcopy(obj[k]) for k in ("queue", "playlists", "favorites")},
                "setlists": copy.deepcopy(setlists), "ratings": copy.deepcopy(ratings), "folders": copy.deepcopy(folders)}
    except (OSError, ValueError, KeyError) as exc:
        raise HubError(f"Music Hub state could not be read: {exc}", 503) from exc


def _write(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".music-hub-", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump(state, fp, ensure_ascii=False, separators=(",", ":"))
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def state(path=STATE_PATH):
    with _LOCK:
        result = _read(Path(path))
        result["lyricsAvailable"] = {tid: row["format"] for tid, row in _read_lyrics(_lyrics_path(path)).items()}
        return result


def _lyrics_path(state_path):
    state_path = Path(state_path)
    return state_path.with_name(state_path.stem + ".lyrics.json")


def _read_lyrics(path):
    if not path.exists():
        return {}
    try:
        if path.stat().st_size > MAX_LYRICS_BYTES:
            raise ValueError("lyrics storage exceeds limit")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or len(data) > MAX_LYRICS_TRACKS:
            raise ValueError("invalid lyrics collection")
        for tid, item in data.items():
            if (not isinstance(tid, str) or not _ID.fullmatch(tid) or
                    not isinstance(item, dict) or item.get("format") not in ("plain", "lrc", "elrc") or
                    not isinstance(item.get("text"), str) or
                    not item["text"] or len(item["text"].encode("utf-8")) > MAX_TRACK_LYRICS_BYTES):
                raise ValueError("invalid lyrics entry")
        return data
    except (OSError, ValueError, UnicodeError) as exc:
        raise HubError(f"Music Hub lyrics could not be read: {exc}", 503) from exc


def _local_lyrics_sidecar(tid, collection):
    """Read at most one same-stem local lyric file; never walk or write folders."""
    if not isinstance(collection, list):
        return None
    track = next((row for row in collection if isinstance(row, dict) and str(row.get("id")) == tid), None)
    audio = track.get("path") if track else None
    if not isinstance(audio, str) or not audio.startswith("/") or "\x00" in audio:
        return None
    audio_path = Path(audio)
    if not audio_path.is_absolute() or ".." in audio_path.parts or audio_path.suffix.lower() not in {
            ".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".opus", ".alac"}:
        return None
    if not audio_path.is_file():
        return None
    for extension in (".lrc", ".elrc"):
        candidate = audio_path.with_suffix(extension)
        try:
            # O_NOFOLLOW prevents a sidecar symlink from redirecting reads.
            fd = os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        except OSError:
            continue
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TRACK_LYRICS_BYTES:
                continue
            with os.fdopen(os.dup(fd), "rb") as stream:
                content = stream.read(MAX_TRACK_LYRICS_BYTES + 1)
            if len(content) > MAX_TRACK_LYRICS_BYTES:
                continue
            lyrics = content.decode("utf-8-sig")
            if not lyrics.strip():
                continue
            enhanced = bool(re.search(r"<\d{1,3}:\d{2}(?:\.\d{1,3})?>", lyrics))
            return {"format": "elrc" if enhanced or extension == ".elrc" else "lrc", "text": lyrics}
        except (OSError, UnicodeError):
            continue
        finally:
            os.close(fd)
    return None


def lyrics_for_track(track_id, valid_ids, path=STATE_PATH, *, collection=None):
    tid = _track_id(track_id, valid_ids)
    with _LOCK:
        row = _read_lyrics(_lyrics_path(path)).get(tid)
    source = "user" if row else None
    if row is None:
        row = _local_lyrics_sidecar(tid, collection)
        if row is not None:
            source = "sidecar"
    return {"trackId": tid, "available": row is not None,
            "format": row["format"] if row else None,
            "text": row["text"] if row else "", "source": source}


def _set_lyrics(payload, valid_ids, path):
    tid = _track_id(payload.get("trackId"), valid_ids)
    fmt, content = payload.get("format"), payload.get("text")
    if fmt not in ("plain", "lrc", "elrc") or not isinstance(content, str):
        raise HubError("format must be plain, lrc or elrc; text must be a string")
    if len(content.encode("utf-8")) > MAX_TRACK_LYRICS_BYTES:
        raise HubError("Lyrics exceed 16 KiB per track", 413)
    lyrics_path = _lyrics_path(path)
    with _LOCK:
        data = _read_lyrics(lyrics_path)
        if content:
            if tid not in data and len(data) >= MAX_LYRICS_TRACKS:
                raise HubError("Lyrics track limit reached", 413)
            data[tid] = {"format": fmt, "text": content}
        else:
            data.pop(tid, None)
        if len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_LYRICS_BYTES:
            raise HubError("Lyrics storage limit reached", 413)
        if data != _read_lyrics(lyrics_path):
            _write(lyrics_path, data)
        return state(path)


def export_playlist(playlist_id, collection, path=STATE_PATH):
    """Return (filename, MIME, UTF-8 bytes) of one Rekordbox XML playlist.

    Export is a read-only snapshot. Only tracks with existing, absolute music
    file paths enter COLLECTION/PLAYLISTS; unavailable entries are documented
    in comments, preserving order among the remaining tracks.
    """
    if not isinstance(playlist_id, str) or not re.fullmatch(r"[0-9a-f]{32}", playlist_id):
        raise HubError("A valid playlistId is required")
    with _LOCK:
        saved = _read(Path(path))
        playlist = next((p for p in saved["playlists"] if p.get("id") == playlist_id), None)
        if playlist is None:
            raise HubError("Playlist not found", 404)
        name = playlist["name"]
        ids = list(playlist["trackIds"])

    return _render_rekordbox_xml(name, ids, collection)


def export_setlist(setlist_id, collection, path=STATE_PATH):
    """Export one user-authored set list with its intended running order."""
    if not isinstance(setlist_id, str) or not re.fullmatch(r"[0-9a-f]{32}", setlist_id):
        raise HubError("A valid setlistId is required")
    with _LOCK:
        saved = _read(Path(path))
        found = next((x for x in saved["setlists"] if x.get("id") == setlist_id), None)
        if not found:
            raise HubError("Set list not found", 404)
        name, ids = found["name"], list(found["trackIds"])
    return _render_rekordbox_xml(name, ids, collection, prefix="setlist")


def _render_rekordbox_xml(name, ids, collection, prefix="playlist"):

    if not isinstance(collection, list):
        raise HubError("Rekordbox library unavailable", 503)
    library = {str(row.get("id")): row for row in collection if isinstance(row, dict) and row.get("id")}
    found = []
    missing = []
    for tid in ids:
        row = library.get(str(tid))
        if row is None:
            missing.append((tid, "track missing from current Rekordbox library"))
            continue
        raw_path = row.get("path")
        if not isinstance(raw_path, str) or not raw_path.startswith("/"):
            missing.append((tid, "audio path unavailable"))
            continue
        local_path = Path(raw_path)
        if not local_path.is_file():
            missing.append((tid, "audio file missing at its recorded path"))
            continue
        found.append((str(tid), row, local_path))

    root = ET.Element("DJ_PLAYLISTS", Version="1.0.0")
    collection_xml = ET.SubElement(root, "COLLECTION", Entries=str(len({tid for tid, _, _ in found})))
    seen = set()
    for tid, row, file_path in found:
        if tid in seen:
            continue
        seen.add(tid)
        # Rekordbox XML uses localhost file URIs; as_uri quotes Unicode, '&' and '#'.
        file_uri = file_path.as_uri().replace("file:///", "file://localhost/", 1)
        attributes = {
            "TrackID": tid,
            "Name": str(row.get("title") or ""),
            "Artist": str(row.get("artist") or ""),
            "Location": file_uri,
        }
        bpm = row.get("bpm")
        if isinstance(bpm, (int, float)) and not isinstance(bpm, bool) and bpm > 0:
            attributes["AverageBpm"] = str(bpm)
        if row.get("genre"):
            attributes["Genre"] = str(row["genre"])
        ET.SubElement(collection_xml, "TRACK", attributes)
    playlists_xml = ET.SubElement(root, "PLAYLISTS")
    folder = ET.SubElement(playlists_xml, "NODE", Type="0", Name="ROOT", Count="1")
    node = ET.SubElement(folder, "NODE", Type="1", Name=name, KeyType="0", Entries=str(len(found)))
    for tid, _, _ in found:
        ET.SubElement(node, "TRACK", Key=tid)
    for tid, reason in missing:
        # Comments avoid including any path or unsanitized file metadata.
        node.append(ET.Comment(f"Skipped track {tid}: {reason}"))
    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    # The name is only used as an attachment filename, never as a filesystem path.
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-")[:64] or "playlist"
    return f"music-hub-{stem}.xml", "application/xml; charset=utf-8", xml_bytes


def _name(value):
    if not isinstance(value, str) or not (1 <= len(value.strip()) <= 100) or any(ord(c) < 32 for c in value):
        raise HubError("Name must be 1–100 printable characters")
    return value.strip()


_HEX_ID = re.compile(r"^[0-9a-f]{32}$")
_NATIVE_ID = re.compile(r"^native:[0-9]{1,20}$")


def _folder_id(value, folders, *, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not _HEX_ID.fullmatch(value):
        raise HubError("Invalid folderId")
    if not any(row["id"] == value for row in folders):
        raise HubError("Folder not found", 404)
    return value


def _validate_folders(folders):
    ids = set()
    for row in folders:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not _HEX_ID.fullmatch(row["id"]) or row["id"] in ids:
            raise ValueError("invalid or duplicate folder id")
        ids.add(row["id"])
        if row.get("kind") not in ("folder", "vibe") or row.get("name") != _name(row.get("name")):
            raise ValueError("invalid folder metadata")
        refs = row.get("playlistIds")
        if not isinstance(refs, list) or len(refs) > 500 or len(refs) != len(set(map(str, refs))):
            raise ValueError("invalid folder playlist references")
        if any(not isinstance(ref, str) or not (_HEX_ID.fullmatch(ref) or _NATIVE_ID.fullmatch(ref)) for ref in refs):
            raise ValueError("invalid folder playlist reference")
    parents = {row["id"]: row.get("parentId") for row in folders}
    for folder_id in parents:
        seen = set()
        cursor = folder_id
        while cursor is not None:
            if cursor in seen or cursor not in parents:
                raise ValueError("folder cycle or unknown parent")
            seen.add(cursor)
            cursor = parents[cursor]
            if len(seen) > 20:
                raise ValueError("folder nesting limit reached")


def _track_sequence(value, valid_ids, max_tracks=250):
    if not isinstance(value, list) or len(value) > max_tracks:
        raise HubError(f"Track sequence must have 0–{max_tracks} tracks")
    return [_track_id(item, valid_ids) for item in value]


def _track_id(value, valid_ids):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise HubError("trackId must be a stable Rekordbox ID")
    tid = str(value)
    if not _ID.fullmatch(tid) or tid not in valid_ids:
        raise HubError("trackId is not in the Rekordbox collection", 404)
    return tid


def _index(value, bound, name):
    if type(value) is not int or value < 0 or value >= bound:
        raise HubError(f"{name} must be an index between 0 and {bound - 1}")
    return value


def apply_action(payload, valid_ids, path=STATE_PATH):
    if not isinstance(payload, dict):
        raise HubError("JSON body must be an object")
    action = payload.get("action")
    if action == "lyrics.set":
        return _set_lyrics(payload, valid_ids, path)
    allowed = {"queue.add", "queue.remove", "queue.reorder", "queue.clear",
               "playlist.create", "playlist.add", "playlist.remove", "playlist.reorder", "playlist.delete", "favorite.toggle",
               "setlist.create", "setlist.replace", "setlist.rename", "setlist.delete", "setlist.queue",
               "rating.set", "folder.create", "folder.rename", "folder.move", "folder.assign",
               "folder.unassign", "folder.delete"}
    if action not in allowed:
        raise HubError("Unknown Music Hub action")
    with _LOCK:
        current = _read(Path(path))
        s = copy.deepcopy(current)
        queue, favorites, playlists, setlists = s["queue"], s["favorites"], s["playlists"], s["setlists"]
        folders = s["folders"]
        if action == "folder.create":
            if len(folders) >= 500:
                raise HubError("Folder limit reached")
            parent = _folder_id(payload.get("parentId"), folders, required=False)
            kind = payload.get("kind", "folder")
            if kind not in ("folder", "vibe"):
                raise HubError("Folder kind must be folder or vibe")
            folders.append({"id": uuid.uuid4().hex, "name": _name(payload.get("name")),
                            "parentId": parent, "kind": kind, "playlistIds": []})
            _validate_folders(folders)
        elif action.startswith("folder."):
            fid = _folder_id(payload.get("folderId"), folders)
            folder = next(item for item in folders if item["id"] == fid)
            if action == "folder.rename":
                folder["name"] = _name(payload.get("name"))
            elif action == "folder.move":
                folder["parentId"] = _folder_id(payload.get("parentId"), folders, required=False)
            elif action == "folder.delete":
                folders.remove(folder)
                for child in folders:
                    if child["parentId"] == fid:
                        child["parentId"] = folder["parentId"]
            else:
                ref = payload.get("playlistId")
                if not isinstance(ref, str) or not (_HEX_ID.fullmatch(ref) or _NATIVE_ID.fullmatch(ref)):
                    raise HubError("Invalid playlistId reference")
                if _HEX_ID.fullmatch(ref) and not any(p["id"] == ref for p in playlists):
                    raise HubError("Playlist not found", 404)
                if action == "folder.assign" and ref not in folder["playlistIds"]:
                    if len(folder["playlistIds"]) >= 500:
                        raise HubError("Folder playlist limit reached")
                    folder["playlistIds"].append(ref)
                elif action == "folder.unassign" and ref in folder["playlistIds"]:
                    folder["playlistIds"].remove(ref)
            try:
                _validate_folders(folders)
            except ValueError as exc:
                raise HubError(str(exc)) from exc
        elif action == "rating.set":
            tid = _track_id(payload.get("trackId"), valid_ids)
            rating = payload.get("rating")
            if type(rating) is not int or not 0 <= rating <= 5:
                raise HubError("rating must be an integer from 0 to 5")
            ratings = s["ratings"]
            if rating == 0:
                ratings.pop(tid, None)
            else:
                if tid not in ratings and len(ratings) >= MAX_PERSONAL_RATINGS:
                    raise HubError("Personal ratings limit reached")
                ratings[tid] = rating
        elif action == "setlist.create":
            if len(setlists) >= 100:
                raise HubError("Set list limit reached")
            name = _name(payload.get("name"))
            ids = _track_sequence(payload.get("trackIds", []), valid_ids)
            timestamp = int(time.time())
            setlists.append({"id": uuid.uuid4().hex, "name": name, "trackIds": ids,
                             "createdAt": timestamp, "updatedAt": timestamp})
        elif action.startswith("setlist."):
            setlist_id = payload.get("setlistId")
            entry = next((item for item in setlists if item.get("id") == setlist_id), None)
            if entry is None:
                raise HubError("Set list not found", 404)
            if action == "setlist.delete":
                setlists.remove(entry)
            elif action == "setlist.rename":
                entry["name"] = _name(payload.get("name"))
                entry["updatedAt"] = int(time.time())
            elif action == "setlist.replace":
                entry["trackIds"] = _track_sequence(payload.get("trackIds"), valid_ids)
                entry["updatedAt"] = int(time.time())
            elif action == "setlist.queue":
                if len(queue) + len(entry["trackIds"]) > 2000:
                    raise HubError("Queue limit reached")
                queue.extend(entry["trackIds"])
        elif action == "queue.clear":
            queue.clear()
        elif action == "queue.reorder":
            src = _index(payload.get("from"), len(queue), "from")
            dst = _index(payload.get("to"), len(queue), "to")
            queue.insert(dst, queue.pop(src))
        elif action == "playlist.create":
            name = payload.get("name")
            if not isinstance(name, str) or not (1 <= len(name.strip()) <= 100) or any(ord(c) < 32 for c in name):
                raise HubError("Playlist name must be 1–100 printable characters")
            if len(playlists) >= 200:
                raise HubError("Playlist limit reached")
            # User-initiated Music Hub playlists may reflect full native
            # Rekordbox playlists. Provider copy tools retain their separate
            # consent-based 250-item cap, and setlists remain at 250.
            track_ids = _track_sequence(payload.get("trackIds", []), valid_ids, max_tracks=6000)
            # Preserve the first occurrence of each local Rekordbox ID in source order.
            track_ids = list(dict.fromkeys(track_ids))
            playlists.append({"id": uuid.uuid4().hex, "name": name.strip(), "trackIds": track_ids})
        elif action.startswith("playlist."):
            pid = payload.get("playlistId")
            playlist = next((p for p in playlists if p["id"] == pid), None)
            if playlist is None:
                raise HubError("Playlist not found", 404)
            if action == "playlist.delete":
                playlists.remove(playlist)
                for folder in folders:
                    if pid in folder["playlistIds"]:
                        folder["playlistIds"].remove(pid)
            elif action == "playlist.reorder":
                rows = playlist["trackIds"]
                src = _index(payload.get("from"), len(rows), "from")
                dst = _index(payload.get("to"), len(rows), "to")
                rows.insert(dst, rows.pop(src))
            else:
                tid = _track_id(payload.get("trackId"), valid_ids)
                rows = playlist["trackIds"]
                if action == "playlist.add" and tid not in rows:
                    rows.append(tid)
                if action == "playlist.remove" and tid in rows:
                    rows.remove(tid)
        else:
            tid = _track_id(payload.get("trackId"), valid_ids)
            if action == "favorite.toggle":
                if tid in favorites:
                    favorites.remove(tid)
                else:
                    favorites.append(tid)
            elif action == "queue.add":
                if len(queue) >= 2000:
                    raise HubError("Queue limit reached")
                index = payload.get("index", len(queue))
                if type(index) is not int or not 0 <= index <= len(queue):
                    raise HubError("index is outside queue")
                queue.insert(index, tid)
            elif action == "queue.remove":
                if "index" in payload:
                    i = _index(payload["index"], len(queue), "index")
                    if queue[i] != tid:
                        raise HubError("index and trackId do not match")
                    queue.pop(i)
                elif tid in queue:
                    queue.remove(tid)
        if s != current:
            _write(Path(path), s)
        s["lyricsAvailable"] = {tid: row["format"] for tid, row in _read_lyrics(_lyrics_path(path)).items()}
        return s


def load_deck(payload, valid_ids, load_fn=None):
    if not isinstance(payload, dict):
        raise HubError("JSON body must be an object")
    deck = payload.get("deck")
    if type(deck) is not int or deck not in (1, 2):
        raise HubError("deck must be 1 or 2")
    tid = _track_id(payload.get("trackId"), valid_ids)
    dry = payload.get("dryRun", True)
    if type(dry) is not bool:
        raise HubError("dryRun must be boolean")
    if load_fn is None:
        from ai_dj_loader import load_track
        load_fn = load_track
    try:
        return load_fn(deck=deck, track_id=tid, execute=not dry)
    except Exception as exc:
        from ai_dj_loader import TrackLoadError
        if isinstance(exc, TrackLoadError):
            raise HubError(str(exc), 409) from exc
        raise
