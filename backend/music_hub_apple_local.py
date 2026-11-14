"""Read-only bridge to playlists shown in the macOS Music application.

No MusicKit developer account is needed to browse the user's already-running
Mac Music app. This is macOS Automation/Apple Events, NOT cloud MusicKit,
and does not provide downloadable Apple Music audio. No playback, changing
Music playlists, file writes or Rekordbox DB access occur here.
"""
from __future__ import annotations

from functools import lru_cache
import json
import os
import re
import subprocess
import time

from music_hub_provider_matching import LocalTrackMatcher


_PLAYLIST_ID = re.compile(r"^[0-9A-Fa-f]{16}$")
_SCRIPT = r"""
function run(argv) {
  const mode = argv[0] || 'status';
  const app = Application('Music');
  if (!app.running()) {
    return JSON.stringify({running:false, available:true,
      message:'Open the Music app on your Mac to browse its playlists.'});
  }
  if (mode === 'status') {
    return JSON.stringify({running:true, available:true,
      playlistCount:app.playlists.length,
      libraryTrackCount:app.libraryPlaylists.length ? app.libraryPlaylists[0].tracks.length : null,
      message:'Read-only macOS Music application library. Streaming files are not exported.'});
  }
  if (mode === 'playlists') {
    const all = app.playlists();
    const names = app.playlists.name();
    const ids = app.playlists.persistentID();
    const types = app.playlists.class();
    const rows = all.map((p,i) => ({
      id:String(ids[i]), name:String(names[i]),
      kind:String(types[i]), count:p.tracks.length
    }));
    return JSON.stringify({running:true,available:true,playlists:rows,count:rows.length,
      message:'Live playlists in the Mac Music application; no changes made.'});
  }
  if (mode === 'items') {
    const pid=String(argv[1] || '');
    if(!/^[0-9a-fA-F]{16}$/.test(pid)) throw Error('Invalid playlist ID');
    const offset=Math.max(0,parseInt(argv[2] || '0',10));
    const limit=Math.min(100,Math.max(1,parseInt(argv[3] || '50',10)));
    const lists=app.playlists();
    const playlist=lists.find(p => p.persistentID().toUpperCase()===pid.toUpperCase());
    if(!playlist) throw Error('Music playlist no longer exists');
    const count=playlist.tracks.length;
    // AppleScript array property bulk queries are significantly faster than
    // one Apple Event per field/track; only return the requested page.
    const names=playlist.tracks.name();
    const artists=playlist.tracks.artist();
    const albums=playlist.tracks.album();
    const ids=playlist.tracks.persistentID();
    const kinds=playlist.tracks.kind();
    const end=Math.min(count,offset+limit), tracks=[];
    for(let i=offset;i<end;i++){
      tracks.push({id:String(ids[i]),name:String(names[i]),
        artist:String(artists[i]),album:String(albums[i]),
        kind:String(kinds[i]), source:'mac_music_app'});
    }
    return JSON.stringify({running:true,available:true,playlistId:pid,
      playlistName:String(playlist.name()),total:count,offset:offset,limit:limit,
      hasMore:end<count,tracks:tracks,
      message:'Metadata only. Apple Music streams are not downloadable MP3 files.'});
  }
  throw Error('Unsupported local Music action');
}
"""


class AppleLocalError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _call(action: str, *argv: str, runner=subprocess.run) -> dict:
    if action not in {"status", "playlists", "items"}:
        raise AppleLocalError("Unsupported Music app request")
    try:
        result = runner(
            ["/usr/bin/osascript", "-l", "JavaScript", "-e", _SCRIPT, action, *argv],
            timeout=12, capture_output=True, text=True, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AppleLocalError("Music app did not respond. Check macOS Automation permissions.", 503) from exc
    except OSError as exc:
        raise AppleLocalError("Music app automation is unavailable on this Mac.", 503) from exc
    if result.returncode != 0:
        # Do not surface arbitrary Apple Events errors/user paths to web UI.
        raise AppleLocalError("Could not read Music app. Grant macOS Automation permission and try again.", 503)
    if len(result.stdout) > 2_000_000:
        raise AppleLocalError("Music app returned too much metadata", 503)
    try:
        obj = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise AppleLocalError("Music app metadata could not be parsed", 503) from exc
    if not isinstance(obj, dict):
        raise AppleLocalError("Music app did not return a metadata object", 503)
    return obj


_cache: dict[str, tuple[float, dict]] = {}


def _cached(action: str, age: float) -> dict:
    existing = _cache.get(action)
    if existing and time.monotonic() - existing[0] < age:
        return existing[1]
    answer = _call(action)
    _cache[action] = (time.monotonic(), answer)
    return answer


def status() -> dict:
    return _cached("status", 10)


def playlists() -> dict:
    return _cached("playlists", 30)


def playlist_items(playlist_id: str, offset=0, limit=50,
                   collection: list[dict] | None = None) -> dict:
    if not isinstance(playlist_id, str) or not _PLAYLIST_ID.fullmatch(playlist_id):
        raise AppleLocalError("A valid Mac Music playlist ID is required")
    try:
        offset, limit = int(offset), int(limit)
    except (ValueError, TypeError) as exc:
        raise AppleLocalError("Invalid offset or limit") from exc
    if not 0 <= offset <= 20_000 or not 1 <= limit <= 100:
        raise AppleLocalError("Music playlist paging must have offset 0–20000 and limit 1–100")
    data = _call("items", playlist_id.upper(), str(offset), str(limit))
    if collection is not None and isinstance(data.get("tracks"), list):
        matcher = LocalTrackMatcher(collection)
        # Do not label a matching Rekordbox database row as a playable local
        # file when the original file has since moved or a drive is offline.
        # Only stat the at-most-100 matching candidates, never scan the user's
        # entire library or touch protected Apple Music streaming caches.
        local_rows = {str(row.get("id")): row for row in collection if isinstance(row, dict)}
        for song, found in zip(data["tracks"], matcher.match_many(data["tracks"], maximum=100)):
            if found["status"] == "matched":
                row = local_rows.get(found["trackId"], {})
                path = row.get("path") or row.get("file_path") or row.get("location")
                if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
                    found = dict(found, status="local_file_unavailable", trackId=None)
            song["localMatch"] = found
        data["rekordboxCollectionOnly"] = True
    return data
