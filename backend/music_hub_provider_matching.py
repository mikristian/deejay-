"""Read-only local-file matching for authorized streaming playlist metadata.

This module never fetches/plays streaming audio or mutates Rekordbox.  It only
returns an existing Rekordbox collection ID when artist + recording title are
unambiguous. Remix, live, acoustic, remaster and edit versions must NOT be
collapsed into each other.
"""
from __future__ import annotations

from collections import defaultdict
import os
import re
import unicodedata

_NONRECORDING_TAG = re.compile(
    r"\s*[\[(]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|lyric\s+video|visuali[sz]er)\s*[\])]\s*$",
    flags=re.I,
)
_LABEL_ARTIST_SPLIT = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s+", flags=re.I)


def normalized(value: str, *, title: bool = False) -> str:
    """Accent-insensitive literal word normalization, not fuzzy similarity.

    Trailing video labels may be removed (same recording), but edit/remix/live
    descriptors are preserved. Unknown or non-string metadata does not match.
    """
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if title:
        value = _NONRECORDING_TAG.sub("", value)
    value = unicodedata.normalize("NFKD", value.casefold())
    value = "".join(c for c in value if not unicodedata.combining(c))
    value = value.replace("’", "'").replace("‘", "'")
    # Apostrophes separate a contraction only typographically; keep letters.
    value = value.replace("'", "")
    return " ".join("".join(c if c.isalnum() else " " for c in value).split())


def primary_artist(row: dict) -> str:
    """Recognize Spotify's artists list and Rekordbox's artist text."""
    artists = row.get("artists")
    if isinstance(artists, list) and artists:
        primary = artists[0]
        return primary.get("name", "") if isinstance(primary, dict) else str(primary)
    name = row.get("artist", "")
    if not isinstance(name, str):
        return ""
    # A local artist field such as 'Artist feat. Guest' has a clear primary.
    return _LABEL_ARTIST_SPLIT.split(name, maxsplit=1)[0]


def recording_title(row: dict) -> str:
    """Track objects may have Spotify `name` or Rekordbox `title`."""
    title = row.get("name") if "name" in row else row.get("title")
    return title if isinstance(title, str) else ""


class LocalTrackMatcher:
    """O(N) one-time index with O(1) average lookup per playlist item."""

    def __init__(self, collection: list[dict], *, file_available=None):
        self._exact = defaultdict(list)
        self._normalized = defaultdict(list)
        self._source_paths: dict[str, str] = {}
        self.indexed = 0
        for row in collection:
            if not isinstance(row, dict) or row.get("is_sampler"):
                continue
            track_id = str(row.get("id", ""))
            title = recording_title(row).strip()
            artist = primary_artist(row).strip()
            if not track_id.isdigit() or not title or not artist:
                continue
            if file_available is not None and not file_available(row):
                continue
            path = row.get("path") or row.get("file_path") or row.get("location")
            if isinstance(path, str) and os.path.isabs(path):
                self._source_paths[track_id] = path
            self._exact[(title.casefold(), artist.casefold())].append(track_id)
            key = (normalized(title, title=True), normalized(artist))
            if key[0] and key[1]:
                self._normalized[key].append(track_id)
            self.indexed += 1

    @staticmethod
    def _result(status: str, match_ids=(), method: str | None = None) -> dict:
        # Only expose an actionable local ID when exactly one local file
        # matches. Ambiguous files require user selection in the Hub UI.
        values = sorted(set(match_ids))
        return {
            "status": status,
            "trackId": values[0] if status == "matched" and len(values) == 1 else None,
            "method": method,
            "candidateCount": len(values),
        }

    def _resolve(self, ids, method: str) -> dict:
        values = sorted(set(ids))
        if len(values) == 1:
            return self._result("matched", values, method)
        if len(values) > 1:
            # Multiple Rekordbox rows may reference one physical audio file,
            # or stale paths from disconnected volumes. Only *available*
            # local paths count as playback candidates. A single existing
            # file is safe, even if other rows point to missing files.
            # Distinct available versions remain ambiguous.
            live_paths: dict[str, list[str]] = defaultdict(list)
            for track_id in values:
                path = self._source_paths.get(track_id)
                if path and os.path.isfile(path):
                    live_paths[os.path.realpath(path)].append(track_id)
            if len(live_paths) == 1:
                chosen_ids = next(iter(live_paths.values()))
                return {
                    "status": "matched", "trackId": sorted(chosen_ids)[0],
                    "method": method + "_same_local_file", "candidateCount": len(values),
                }
            return self._result("ambiguous", values, method)
        return self._result("not_in_local_library")

    def match(self, item: dict) -> dict:
        if not isinstance(item, dict):
            return self._result("invalid")
        title = recording_title(item).strip()
        artist = primary_artist(item).strip()
        if not title or not artist:
            return self._result("insufficient_metadata")
        exact = self._exact.get((title.casefold(), artist.casefold()), ())
        if exact:
            return self._resolve(exact, "exact")
        key = (normalized(title, title=True), normalized(artist))
        matched = self._normalized.get(key, ())
        if matched:
            return self._resolve(matched, "normalized")
        return self._result("not_in_local_library")

    def match_many(self, items: list[dict], *, maximum: int = 250) -> list[dict]:
        if not isinstance(items, list):
            return []
        return [self.match(item) for item in items[:max(0, min(maximum, 250))]]
