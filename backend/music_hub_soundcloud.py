"""Opt-in SoundCloud OAuth2.1 metadata access; local files only for matches."""
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import subprocess
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.request import Request, urlopen

CLIENT_ENV = "MUSIC_HUB_SOUNDCLOUD_CLIENT_ID"
SECRET_ENV = "MUSIC_HUB_SOUNDCLOUD_CLIENT_SECRET"
REDIRECT = "http://127.0.0.1:18769/api/music-hub/soundcloud/callback"
SERVICE = "com.chatonsteroids.music-hub.soundcloud.refresh"
TOKEN_URL = "https://secure.soundcloud.com/oauth/token"
_LOCK = threading.RLock()
_pending = {}
_access = None
_expires = 0
_account = None


class SoundCloudError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def validate_local_request(ip, host, origin=None, fetch_site="", callback_request=False):
    try:
        loopback = ipaddress.ip_address(ip).is_loopback
    except ValueError:
        loopback = False
    if not loopback or host not in (("127.0.0.1:18769",) if callback_request else
                                    ("127.0.0.1:18769", "localhost:18769")):
        raise SoundCloudError("Local SoundCloud access required", 403)
    if origin and origin not in ("http://127.0.0.1:18769", "http://localhost:18769"):
        raise SoundCloudError("Cross-origin SoundCloud request prohibited", 403)
    if (fetch_site or "").lower() not in ("", "same-origin", "none") and not callback_request:
        raise SoundCloudError("Cross-site SoundCloud request prohibited", 403)


def _client_id():
    value = os.getenv(CLIENT_ENV, "").strip()
    return value if re.fullmatch(r"[A-Za-z0-9_-]{8,256}", value) else None


def configured():
    # SoundCloud's documented authorization-code token exchange requires a client secret.
    return bool(_client_id() and os.getenv(SECRET_ENV, "").strip())


def _credentials():
    if not configured():
        raise SoundCloudError("SoundCloud developer client ID and secret are required", 503)
    return {"client_id": _client_id(), "client_secret": os.getenv(SECRET_ENV).strip()}


def _keychain(action, value=None):
    client = _client_id()
    if not client:
        raise SoundCloudError("SoundCloud is not configured", 503)
    args = ["security"]
    if action == "read":
        args += ["find-generic-password", "-s", SERVICE, "-a", client, "-w"]
    elif action == "write":
        args += ["add-generic-password", "-U", "-s", SERVICE, "-a", client, "-w"]
    elif action == "delete":
        args += ["delete-generic-password", "-s", SERVICE, "-a", client]
    else:
        raise SoundCloudError("Invalid keychain operation")
    try:
        response = subprocess.run(args, input=value + "\n" if action == "write" else None,
                                  capture_output=True, text=True, timeout=8, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SoundCloudError("Mac Keychain is unavailable", 503)
    if response.returncode:
        if action in ("read", "delete"):
            return None
        raise SoundCloudError("Could not store SoundCloud authorization", 503)
    return response.stdout.strip() if action == "read" else True


def _allowed_url(url):
    if not isinstance(url, str) or len(url) > 2048:
        return False
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password or port not in (None, 443) or parsed.fragment:
        return False
    if url == TOKEN_URL:
        return True
    return parsed.hostname == "api.soundcloud.com" and (
        parsed.path in ("/me", "/me/playlists", "/me/likes/tracks", "/playlists")
        or bool(re.fullmatch(r"/playlists/[0-9]{1,20}/tracks", parsed.path))
    )


class _NoRedirect(__import__("urllib.request", fromlist=["HTTPRedirectHandler"]).HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SoundCloudError("Unexpected SoundCloud redirect", 502)


def _request(url, *, data=None, access=None):
    if not _allowed_url(url):
        raise SoundCloudError("Unapproved SoundCloud API endpoint")
    headers = {"Accept": "application/json"}
    if access:
        headers["Authorization"] = "OAuth " + access
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = Request(url, data=urlencode(data).encode() if data is not None else None,
                  headers=headers, method="POST" if data is not None else "GET")
    try:
        from urllib.request import build_opener
        with build_opener(_NoRedirect).open(req, timeout=12) as response:
            payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise SoundCloudError("SoundCloud response exceeded size limit", 502)
        result = json.loads(payload)
        if not isinstance(result, dict) and not (
            isinstance(result, list)
            and re.fullmatch(r"/playlists/[0-9]{1,20}/tracks", urlsplit(url).path)
        ):
            raise SoundCloudError("Unexpected SoundCloud response", 502)
        return result
    except HTTPError as exc:
        if exc.code == 429:
            raise SoundCloudError("SoundCloud rate limit reached; retry later", 429)
        if exc.code == 401:
            raise SoundCloudError("SoundCloud authorization expired; reconnect", 401)
        if exc.code == 403:
            raise SoundCloudError("SoundCloud account permission denied", 403)
        raise SoundCloudError("SoundCloud API request failed", 502)
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        if isinstance(exc, SoundCloudError):
            raise
        raise SoundCloudError("SoundCloud service unavailable", 503)


def connect():
    client = _credentials()["client_id"]
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    with _LOCK:
        _pending.clear()
        _pending[state] = (verifier, time.monotonic() + 600)
    return {"configured": True, "authUrl": "https://secure.soundcloud.com/authorize?" + urlencode({
        "response_type": "code", "client_id": client, "redirect_uri": REDIRECT,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
    })}


def _set_tokens(token, account):
    global _access, _expires, _account
    access = token.get("access_token")
    refresh = token.get("refresh_token")
    if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
        raise SoundCloudError("Incomplete SoundCloud authorization", 502)
    if str(token.get("token_type", "OAuth")).lower() not in ("oauth", "bearer"):
        raise SoundCloudError("Unexpected SoundCloud token type", 502)
    _keychain("write", refresh)
    _access = access
    _expires = time.monotonic() + max(0, min(int(token.get("expires_in", 3600)), 86400) - 60)
    _account = {"id": str(account["id"]), "displayName": account.get("username") or str(account["id"])}


def callback(params):
    states = params.get("state", [])
    with _LOCK:
        entry = _pending.pop(states[0], None) if len(states) == 1 else None
    if entry is None or time.monotonic() > entry[1]:
        raise SoundCloudError("Invalid or expired SoundCloud state", 403)
    codes = params.get("code", [])
    if len(codes) != 1 or not codes[0] or "error" in params:
        raise SoundCloudError("SoundCloud authorization declined", 403)
    payload = {"grant_type": "authorization_code", "code": codes[0],
               "redirect_uri": REDIRECT, "code_verifier": entry[0], **_credentials()}
    token = _request(TOKEN_URL, data=payload)
    if not isinstance(token.get("access_token"), str) or not token.get("refresh_token"):
        raise SoundCloudError("Incomplete SoundCloud authorization", 502)
    account = _request("https://api.soundcloud.com/me", access=token["access_token"])
    if not account.get("id"):
        raise SoundCloudError("SoundCloud account verification failed", 502)
    with _LOCK:
        _set_tokens(token, account)
    return True


def _authorized():
    global _access, _expires, _account
    _credentials()
    with _LOCK:
        if _access and _account and time.monotonic() < _expires:
            return _access, dict(_account)
        refresh = _keychain("read")
        if not refresh:
            raise SoundCloudError("Connect SoundCloud first", 401)
        token = _request(TOKEN_URL, data={"grant_type": "refresh_token", "refresh_token": refresh, **_credentials()})
        if not token.get("refresh_token") or not token.get("access_token"):
            # Never reuse a spent single-use refresh token.
            _access, _expires, _account = None, 0, None
            raise SoundCloudError("SoundCloud token rotation failed; reconnect", 401)
        # Persist the rotated refresh token BEFORE additional network requests.
        _keychain("write", token["refresh_token"])
        _access = token["access_token"]
        _expires = time.monotonic() + max(0, min(int(token.get("expires_in", 3600)), 86400) - 60)
        account = _request("https://api.soundcloud.com/me", access=_access)
        if not account.get("id"):
            raise SoundCloudError("SoundCloud account verification failed", 502)
        _account = {"id": str(account["id"]), "displayName": account.get("username") or str(account["id"])}
        return _access, dict(_account)


def status():
    if not configured():
        return {"configured": False, "connected": False, "account": None}
    try:
        _, account = _authorized()
        return {"configured": True, "connected": True, "account": account}
    except SoundCloudError:
        return {"configured": True, "connected": False, "account": None}


def disconnect():
    """Revoke this Mac's stored authorization locally, even when API is offline."""
    global _access, _expires, _account
    with _LOCK:
        _pending.clear()
        _access, _expires, _account = None, 0, None
        if _client_id():
            _keychain("delete")
    return {"configured": configured(), "connected": False, "account": None}


def _page(endpoint, cursor=None, limit=100):
    if endpoint not in ("/me/playlists", "/me/likes/tracks") and not re.fullmatch(
        r"/playlists/[0-9]{1,20}/tracks", endpoint
    ):
        raise SoundCloudError("Unknown SoundCloud resource")
    if not isinstance(limit, int) or not 1 <= limit <= 100:
        raise SoundCloudError("Invalid SoundCloud page size")
    allowed_paths = {endpoint}
    if endpoint == "/me/playlists":
        # SoundCloud's published pagination examples send follow-up cursors
        # for /me/playlists to /playlists?show_tracks=false&page_size=25&cursor=...
        allowed_paths.add("/playlists")
    if cursor is None:
        params = {"limit": limit, "linked_partitioning": "true"}
        if endpoint == "/me/playlists":
            # SoundCloud recommends omitting nested track metadata here and
            # fetching a chosen playlist's tracks on demand. Otherwise a
            # hundred large playlists can exceed the bounded JSON response.
            params["show_tracks"] = "false"
        url = "https://api.soundcloud.com" + endpoint + "?" + urlencode(params)
    else:
        if not isinstance(cursor, str) or len(cursor) > 2048 or not _allowed_url(cursor):
            raise SoundCloudError("Invalid SoundCloud pagination URL")
        parsed = urlsplit(cursor)
        if parsed.path not in allowed_paths:
            raise SoundCloudError("Cross-resource SoundCloud pagination prohibited")
        query = parse_qs(parsed.query)
        if any(key not in ("cursor", "offset", "limit", "linked_partitioning", "page_size", "show_tracks")
               or len(value) != 1 or not value[0] or len(value[0]) > 1024 for key, value in query.items()):
            raise SoundCloudError("Invalid SoundCloud pagination parameters")
        if any(not query[key][0].isdigit() or int(query[key][0]) > 10000
               for key in ("offset", "limit", "page_size") if key in query):
            raise SoundCloudError("Invalid SoundCloud pagination parameters")
        if "show_tracks" in query and query["show_tracks"][0] not in ("true", "false"):
            raise SoundCloudError("Invalid SoundCloud pagination parameters")
        url = cursor
    token, _ = _authorized()
    result = _request(url, access=token)
    collection = result.get("collection", []) if isinstance(result, dict) else result
    if not isinstance(collection, list):
        raise SoundCloudError("Invalid SoundCloud collection", 502)
    next_href = result.get("next_href") if isinstance(result, dict) else None
    if next_href is not None and (not isinstance(next_href, str) or not _allowed_url(next_href)
                                 or urlsplit(next_href).path not in allowed_paths):
        raise SoundCloudError("Invalid SoundCloud pagination response", 502)
    return collection[:100], next_href


def _track(row):
    if not isinstance(row, dict) or not row.get("id"):
        return None
    artist = (row.get("user") or {}).get("username") or ""
    title = str(row.get("title") or "").strip()
    if not title:
        return None
    # SoundCloud tracks often encode artist in title; only exact supplied metadata is matchable.
    return {"id": str(row["id"]), "title": title, "artist": artist,
            "artists": [artist] if artist else [], "durationMs": row.get("duration"),
            "url": row.get("permalink_url"), "image": row.get("artwork_url"),
            # A creator can opt into original-file downloads. This is a
            # *metadata hint*, not permission for us to fetch/rehost streams.
            # Show the official SoundCloud page where the signed-in listener
            # can use "Download file" if still offered by that creator.
            "creatorDownloadEnabled": row.get("downloadable") is True}


def _attach_matches(items):
    from dashboard_http import get_rekordbox_library_fast
    from music_hub_provider_matching import LocalTrackMatcher
    collection = get_rekordbox_library_fast().get("collection") or []
    def available(row):
        path = row.get("path") or row.get("file_path") or row.get("location")
        return isinstance(path, str) and os.path.isabs(path) and os.path.isfile(path)
    matches = LocalTrackMatcher(collection, file_available=available).match_many(items, maximum=100)
    for item, match in zip(items, matches):
        item["localMatch"] = match
    return items


def likes(cursor=None, limit=100):
    rows, next_href = _page("/me/likes/tracks", cursor, limit)
    items = [_track(row) for row in rows]
    return {"provider": "soundcloud", "items": _attach_matches([item for item in items if item]),
            "nextHref": next_href, "downloadAvailable": False}


def playlists(cursor=None, limit=100):
    rows, next_href = _page("/me/playlists", cursor, limit)
    items = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        tracks = [_track(track) for track in row.get("tracks", [])[:100]] if isinstance(row.get("tracks"), list) else []
        items.append({"id": str(row["id"]), "name": row.get("title") or "Untitled",
                      "url": row.get("permalink_url"), "image": row.get("artwork_url"),
                      "trackCount": row.get("track_count"), "track_count": row.get("track_count"),
                      "tracks": _attach_matches([track for track in tracks if track])})
    return {"provider": "soundcloud", "items": items, "nextHref": next_href, "downloadAvailable": False}


def playlist_items(playlist_id, cursor=None, limit=100):
    """Browse authorized playlist metadata, never remote audio bytes."""
    if not isinstance(playlist_id, str) or not re.fullmatch(r"[0-9]{1,20}", playlist_id):
        raise SoundCloudError("A numeric SoundCloud playlist ID is required")
    rows, next_href = _page("/playlists/" + playlist_id + "/tracks", cursor, limit)
    tracks = [_track(row) for row in rows]
    return {"provider": "soundcloud", "playlistId": playlist_id,
            "items": _attach_matches([item for item in tracks if item]),
            "nextHref": next_href, "downloadAvailable": False}
