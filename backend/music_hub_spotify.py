"""Opt-in, local-only Spotify metadata bridge using Authorization Code PKCE."""
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CLIENT_ENV = "MUSIC_HUB_SPOTIFY_CLIENT_ID"
REDIRECT = "http://127.0.0.1:18769/api/music-hub/spotify/callback"
SCOPES = "playlist-read-private playlist-read-collaborative user-library-read user-read-private"
SERVICE = "com.chatonsteroids.music-hub.spotify.refresh"
_LOCK = threading.RLock()
_pending = {}
_access = None
_expires = 0
_account = None


class SpotifyError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _client_id():
    value = os.environ.get(CLIENT_ENV, "").strip()
    return value if re.fullmatch(r"[0-9a-fA-F]{32}", value) else None


def configured():
    return bool(_client_id())


def _keychain(action, value=None):
    client = _client_id()
    if not client:
        raise SpotifyError("Spotify developer client ID is not configured", 503)
    common = ["security"]
    if action == "read":
        args = common + ["find-generic-password", "-s", SERVICE, "-a", client, "-w"]
    elif action == "write":
        # Supplying -w without an argument reads the password from stdin on macOS.
        args = common + ["add-generic-password", "-U", "-s", SERVICE, "-a", client, "-w"]
    else:
        args = common + ["delete-generic-password", "-s", SERVICE, "-a", client]
    try:
        result = subprocess.run(args, input=(value + "\n") if action == "write" else None,
                                capture_output=True, text=True, timeout=8, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SpotifyError("macOS Keychain is unavailable", 503)
    if result.returncode:
        if action in ("read", "delete"):
            return None
        raise SpotifyError("Could not save Spotify authorization in macOS Keychain", 503)
    return result.stdout.strip() if action == "read" else True


def _json_request(url, *, data=None, bearer=None):
    if not (url.startswith("https://api.spotify.com/v1/") or url == "https://accounts.spotify.com/api/token"):
        raise SpotifyError("Unapproved Spotify endpoint")
    headers = {"Accept": "application/json"}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = Request(url, data=urlencode(data).encode() if data is not None else None,
                      headers=headers, method="POST" if data is not None else "GET")
    try:
        with urlopen(request, timeout=12) as response:
            content = response.read(1024 * 1024 + 1)
        if len(content) > 1024 * 1024:
            raise SpotifyError("Spotify response too large", 502)
        return json.loads(content)
    except HTTPError as exc:
        if exc.code == 429:
            raise SpotifyError("Spotify rate limit reached; retry later", 429)
        if exc.code == 401:
            raise SpotifyError("Spotify authorization expired; reconnect", 401)
        if exc.code == 403:
            raise SpotifyError("Spotify access denied for this account or playlist", 403)
        raise SpotifyError("Spotify request failed", 502)
    except (URLError, TimeoutError, ValueError):
        raise SpotifyError("Spotify service unavailable", 503)


def connect():
    client = _client_id()
    if not client:
        raise SpotifyError("Set MUSIC_HUB_SPOTIFY_CLIENT_ID to a valid Spotify client ID", 503)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    with _LOCK:
        now = time.monotonic()
        _pending.clear()
        _pending[state] = (verifier, now + 600)
    url = "https://accounts.spotify.com/authorize?" + urlencode({
        "response_type": "code", "client_id": client, "scope": SCOPES,
        "redirect_uri": REDIRECT, "state": state,
        "code_challenge_method": "S256", "code_challenge": challenge,
    })
    return {"configured": True, "authUrl": url}


def callback(params):
    global _access, _expires, _account
    state = params.get("state", [])
    with _LOCK:
        item = _pending.pop(state[0], None) if len(state) == 1 else None
    if not item or time.monotonic() > item[1]:
        raise SpotifyError("Invalid or expired Spotify authorization state", 403)
    code = params.get("code", [])
    if len(code) != 1 or not code[0] or "error" in params:
        raise SpotifyError("Spotify authorization was declined")
    token = _json_request("https://accounts.spotify.com/api/token", data={
        "grant_type": "authorization_code", "code": code[0],
        "redirect_uri": REDIRECT, "client_id": _client_id(), "code_verifier": item[0],
    })
    access = token.get("access_token")
    refresh = token.get("refresh_token")
    if not access or not refresh or token.get("token_type", "").lower() != "bearer":
        raise SpotifyError("Spotify did not return a usable authorization", 502)
    account = _json_request("https://api.spotify.com/v1/me", bearer=access)
    if not isinstance(account, dict) or not account.get("id"):
        raise SpotifyError("Spotify account verification failed", 502)
    _keychain("write", refresh)
    with _LOCK:
        _access = access
        _expires = time.monotonic() + max(0, min(int(token.get("expires_in", 3600)), 86400) - 60)
        _account = {"id": account["id"], "displayName": account.get("display_name") or account["id"]}
    return True


def _authorized():
    global _access, _expires, _account
    if not configured():
        raise SpotifyError("Spotify is not configured", 503)
    with _LOCK:
        if _access and time.monotonic() < _expires and _account:
            return _access, dict(_account)
        refresh = _keychain("read")
        if not refresh:
            raise SpotifyError("Connect Spotify first", 401)
        token = _json_request("https://accounts.spotify.com/api/token", data={
            "grant_type": "refresh_token", "refresh_token": refresh, "client_id": _client_id(),
        })
        access = token.get("access_token")
        if not access:
            raise SpotifyError("Spotify authorization expired; reconnect", 401)
        profile = _json_request("https://api.spotify.com/v1/me", bearer=access)
        if not isinstance(profile, dict) or not profile.get("id"):
            raise SpotifyError("Spotify account verification failed", 502)
        if token.get("refresh_token"):
            _keychain("write", token["refresh_token"])
        _access = access
        _expires = time.monotonic() + max(0, min(int(token.get("expires_in", 3600)), 86400) - 60)
        _account = {"id": profile["id"], "displayName": profile.get("display_name") or profile["id"]}
        return _access, dict(_account)


def status():
    if not configured():
        return {"configured": False, "connected": False, "account": None}
    try:
        _, account = _authorized()
        return {"configured": True, "connected": True, "account": account}
    except SpotifyError:
        return {"configured": True, "connected": False, "account": None}


def _page(path, token, limit=50, offset=0):
    if not re.fullmatch(r"/v1/(?:me/playlists|me/tracks|playlists/[A-Za-z0-9]{22}/items)", path):
        raise SpotifyError("Invalid Spotify resource")
    return _json_request("https://api.spotify.com" + path + "?" + urlencode({"limit": limit, "offset": offset}), bearer=token)


def _playlist(row, account_id):
    if not isinstance(row, dict):
        return None
    owner = (row.get("owner") or {}).get("id")
    if owner != account_id and not row.get("collaborative"):
        return None
    return {"id": row.get("id"), "name": row.get("name") or "Untitled",
            "owner": owner, "collaborative": bool(row.get("collaborative")),
            "url": (row.get("external_urls") or {}).get("spotify"),
            "image": ((row.get("images") or [{}])[0] or {}).get("url")}


def playlists(offset=0):
    token, account = _authorized()
    if not isinstance(offset, int) or offset < 0 or offset > 10000:
        raise SpotifyError("Invalid page offset")
    result = _page("/v1/me/playlists", token, 50, offset)
    items = [_playlist(row, account["id"]) for row in result.get("items", [])]
    return {"items": [row for row in items if row and row["id"]], "offset": offset,
            "nextOffset": offset + len(result.get("items", [])) if result.get("next") else None,
            "total": result.get("total")}


def _track(row):
    if not isinstance(row, dict) or row.get("is_local") or row.get("type") not in (None, "track"):
        return None
    track_id = row.get("id")
    if not isinstance(track_id, str) or not re.fullmatch(r"[A-Za-z0-9]{22}", track_id):
        return None
    return {"id": track_id, "title": row.get("name") or "Untitled",
            "artists": [a.get("name") for a in row.get("artists", []) if isinstance(a, dict) and a.get("name")],
            "album": (row.get("album") or {}).get("name"),
            "durationMs": row.get("duration_ms"),
            "url": "https://open.spotify.com/track/" + track_id,
            "image": (((row.get("album") or {}).get("images") or [{}])[0] or {}).get("url")}


def _attach_local_matches(items):
    """Match metadata to existing local tracks, without changing queues or media."""
    from dashboard_http import get_rekordbox_library_fast
    from music_hub_provider_matching import LocalTrackMatcher
    collection = get_rekordbox_library_fast().get("collection") or []
    # The local library can include disconnected media; check paths before offering playback.
    def exists(row):
        path = row.get("path") or row.get("file_path") or row.get("location")
        return isinstance(path, str) and os.path.isabs(path) and os.path.isfile(path)
    matches = LocalTrackMatcher(collection, file_available=exists).match_many(items)
    for item, match in zip(items, matches):
        item["localMatch"] = match
    return items


def saved():
    token, _ = _authorized()
    data = _page("/v1/me/tracks", token, 50)
    items = [_track(row.get("track")) for row in data.get("items", []) if isinstance(row, dict)]
    return {"items": _attach_local_matches([item for item in items if item]), "total": data.get("total"),
            "nextOffset": 50 if data.get("next") else None}


def search(query, limit=20):
    """Search official Spotify metadata using the connected user's token."""
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 150:
        raise SpotifyError("Search must contain 1–150 characters")
    if not isinstance(limit, int) or not 1 <= limit <= 50:
        raise SpotifyError("Search limit must be 1–50")
    token, _ = _authorized()
    url = "https://api.spotify.com/v1/search?" + urlencode({
        "q": query.strip(), "type": "track", "limit": limit,
    })
    data = _json_request(url, bearer=token)
    tracks = data.get("tracks", {}) if isinstance(data, dict) else {}
    if not isinstance(tracks, dict):
        raise SpotifyError("Invalid Spotify search response", 502)
    items = [_track(row) for row in tracks.get("items", []) if isinstance(row, dict)]
    return {"provider": "spotify", "source": "official_api", "items":
            _attach_local_matches([row for row in items if row]),
            "total": tracks.get("total"), "downloadAvailable": False}


def playlist_items(playlist_id):
    if not isinstance(playlist_id, str) or not re.fullmatch(r"[A-Za-z0-9]{22}", playlist_id):
        raise SpotifyError("Invalid Spotify playlist ID")
    token, account = _authorized()
    # Authorization check uses only Spotify's own account playlist endpoint.
    offset = 0
    found = False
    while offset <= 10000:
        page = _page("/v1/me/playlists", token, 50, offset)
        for candidate in page.get("items", []):
            row = _playlist(candidate, account["id"])
            if row and row["id"] == playlist_id:
                found = True
                break
        if found or not page.get("next") or not page.get("items"):
            break
        offset += len(page["items"])
    if not found:
        raise SpotifyError("Playlist is not owned or collaborative for this account", 403)
    tracks = []
    for offset in (0, 50, 100, 150, 200):
        size = 50
        page = _page("/v1/playlists/" + playlist_id + "/items", token, size, offset)
        for item in page.get("items", []):
            track = _track(item.get("item") or item.get("track")) if isinstance(item, dict) else None
            if track:
                tracks.append(track)
        if not page.get("next") or not page.get("items"):
            break
    return {"playlistId": playlist_id, "items": _attach_local_matches(tracks[:250]), "maxItems": 250}


def disconnect():
    global _access, _account, _expires
    with _LOCK:
        _pending.clear()
        _access, _account, _expires = None, None, 0
        if configured():
            _keychain("delete")
    return {"configured": configured(), "connected": False, "account": None}
