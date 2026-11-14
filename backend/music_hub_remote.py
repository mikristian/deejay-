"""Explicitly enabled, authenticated remote-intent API for a mobile Music Hub.

Runs in its own process. It never sends MIDI, modifies Rekordbox, or serves audio.
Use MUSIC_HUB_REMOTE_ENABLED=1 and a random 32+ character
MUSIC_HUB_REMOTE_TOKEN to start. Binding is localhost unless the operator sets
MUSIC_HUB_REMOTE_HOST to an explicit LAN interface address.
"""

from __future__ import annotations

import hmac
import http.client
import ipaddress
import json
import math
import mimetypes
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from music_hub_pairing import PhonePairing, COOKIE_CLEAR

MAX_BODY = 2048
MAX_QUEUE = 250
MAX_LIBRARY_PAGE = 1000
MAX_LIBRARY_BROWSE = 20000
MOBILE_WAVEFORM_POINTS = 96
HUB_PORT = 18769
COMMAND_TTL = 15
HEARTBEAT_TTL = 10
ASSETS = {"/": "mobile.html", "/music-hub/": "mobile.html",
          "/music-hub/mobile.html": "mobile.html",
          "/music-hub/mobile.css": "mobile.css",
          "/music-hub/mobile.js": "mobile.js"}
FIELDS = ("id", "title", "artist", "album", "albumArtist", "genre", "bpm", "camelot", "key", "length", "duration")


class RemoteError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class RemoteQueue:
    def __init__(self, valid_track_ids=None):
        self._valid_track_ids = valid_track_ids or self._library_ids
        self._lock = threading.RLock()
        self._entries = []
        self._revision = 0

    @staticmethod
    def _library_ids():
        from dashboard_http import get_rekordbox_library_fast
        return {str(x["id"]) for x in get_rekordbox_library_fast().get("collection", []) if x.get("id")}

    def snapshot(self):
        with self._lock:
            return {"revision": self._revision, "items": [dict(x) for x in self._entries]}

    def mutate(self, body):
        if not isinstance(body, dict):
            raise RemoteError("JSON object required")
        action = body.get("action")
        with self._lock:
            if type(body.get("revision")) is not int or body["revision"] != self._revision:
                raise RemoteError("Queue revision changed; reload and retry", 409)
            if action == "enqueue":
                tid = body.get("trackId")
                deck = body.get("deck")
                if not isinstance(tid, str) or not tid.isascii() or not tid.isdecimal() or len(tid) > 20:
                    raise RemoteError("Invalid local track ID")
                if deck not in ("1", "2", "auto"):
                    raise RemoteError("Deck must be 1, 2 or auto")
                if len(self._entries) >= MAX_QUEUE:
                    raise RemoteError("Queue is full", 409)
                try:
                    valid = self._valid_track_ids()
                except Exception as exc:
                    raise RemoteError("Local library unavailable", 503) from exc
                if tid not in valid:
                    raise RemoteError("Track must exist in the local Rekordbox library", 404)
                self._entries.append({"id": secrets.token_hex(12), "trackId": tid,
                                      "deck": deck, "addedAt": int(time.time())})
            elif action == "remove":
                key = body.get("id")
                if not isinstance(key, str) or not any(x["id"] == key for x in self._entries):
                    raise RemoteError("Queue item not found", 404)
                self._entries = [x for x in self._entries if x["id"] != key]
            elif action == "move":
                key, index = body.get("id"), body.get("index")
                if type(index) is not int or not 0 <= index < len(self._entries):
                    raise RemoteError("Invalid queue position")
                old_index = next((i for i, x in enumerate(self._entries) if x["id"] == key), None)
                if old_index is None:
                    raise RemoteError("Queue item not found", 404)
                self._entries.insert(index, self._entries.pop(old_index))
            elif action == "target":
                key, deck = body.get("id"), body.get("deck")
                if deck not in ("1", "2", "auto"):
                    raise RemoteError("Deck must be 1, 2 or auto")
                item = next((x for x in self._entries if x["id"] == key), None)
                if item is None:
                    raise RemoteError("Queue item not found", 404)
                item["deck"] = deck
            else:
                raise RemoteError("Unsupported queue action")
            self._revision += 1
            return self.snapshot()


class PreviewCommands:
    """Expiring, one-delivery local-preview requests; no direct hardware control."""

    def __init__(self, clock=None, valid_track_ids=None):
        self.clock = clock or time.monotonic
        self.valid_track_ids = valid_track_ids or RemoteQueue._library_ids
        self.lock = threading.RLock()
        self.heartbeat_at = -float("inf")
        self.items = []
        self.preview = None

    def active(self):
        with self.lock:
            return self.clock() - self.heartbeat_at <= HEARTBEAT_TTL

    @staticmethod
    def validate_preview(payload):
        keys = {"deckA", "deckB", "playingA", "playingB", "positionA", "positionB",
                "durationA", "durationB", "crossfade", "autoFading"}
        if not isinstance(payload, dict) or set(payload) != keys:
            raise RemoteError("Preview requires exactly the documented fields")
        result = {}
        for field in ("deckA", "deckB"):
            value = payload[field]
            if value is not None and (not isinstance(value, str) or not value.isascii() or
                                      not value.isdecimal() or not 1 <= len(value) <= 20):
                raise RemoteError(f"{field} must be a local numeric track ID or null")
            result[field] = value
        for field in ("playingA", "playingB", "autoFading"):
            if type(payload[field]) is not bool:
                raise RemoteError(f"{field} must be a boolean")
            result[field] = payload[field]
        for field in ("positionA", "positionB", "durationA", "durationB", "crossfade"):
            value = payload[field]
            upper = 1 if field == "crossfade" else 86400
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= upper:
                raise RemoteError(f"{field} must be finite and between 0 and {upper}")
            result[field] = value
        return result

    def heartbeat(self, body=None):
        if body is None:
            body = {}
        if not isinstance(body, dict) or set(body) - {"preview"}:
            raise RemoteError("Heartbeat accepts only an optional preview")
        new_preview = self.validate_preview(body["preview"]) if "preview" in body else None
        with self.lock:
            self.heartbeat_at = self.clock()
            self.preview = new_preview
            return {"active": True, "expiresInSeconds": HEARTBEAT_TTL}

    def preview_snapshot(self):
        with self.lock:
            if self.clock() - self.heartbeat_at > HEARTBEAT_TTL or self.preview is None:
                return None
            return dict(self.preview)

    def submit(self, body):
        if not isinstance(body, dict):
            raise RemoteError("JSON object required")
        action = body.get("action")
        schema = {"local.stage": {"action", "deck", "trackId"},
                  "local.play": {"action", "deck"}, "local.seek": {"action", "deck", "positionSec"},
                  "local.fade": {"action", "target", "durationMs"},
                  "local.autoMixStart": {"action"}, "local.autoMixStop": {"action"}}
        if action not in schema or set(body) != schema[action]:
            raise RemoteError("Unsupported or malformed local preview command")
        if action in ("local.stage", "local.play", "local.seek") and body.get("deck") not in ("1", "2"):
            raise RemoteError("Deck must be 1 or 2")
        if action == "local.stage":
            tid = body["trackId"]
            if not isinstance(tid, str) or not tid.isascii() or not tid.isdecimal() or not 1 <= len(tid) <= 20:
                raise RemoteError("trackId must be a numeric ASCII local track ID")
        if action == "local.seek":
            sec = body["positionSec"]
            if type(sec) not in (int, float) or not 0 <= sec <= 86400 or sec != sec:
                raise RemoteError("Invalid seek position")
        if action == "local.fade":
            target, duration = body["target"], body["durationMs"]
            if type(target) not in (int, float) or not 0 <= target <= 1 or target != target:
                raise RemoteError("Invalid fade parameters")
            if type(duration) is not int or not 100 <= duration <= 30000:
                raise RemoteError("Invalid fade duration")
        with self.lock:
            now = self.clock()
            if now - self.heartbeat_at > HEARTBEAT_TTL:
                raise RemoteError("Desktop local-preview controller is offline", 409)
            if action == "local.stage":
                try:
                    valid_ids = self.valid_track_ids()
                except Exception as exc:
                    raise RemoteError("Local library unavailable", 503) from exc
                if tid not in valid_ids:
                    raise RemoteError("Track must exist in the local Rekordbox library", 404)
            self.items = [x for x in self.items if x["expires"] > now]
            if len(self.items) >= 64:
                raise RemoteError("Remote command queue is full", 409)
            item = {"id": secrets.token_hex(16), "action": action,
                    "args": {k: v for k, v in body.items() if k != "action"},
                    "expires": now + COMMAND_TTL, "delivered": False}
            self.items.append(item)
            return {"accepted": True, "id": item["id"], "expiresInSeconds": COMMAND_TTL}

    def poll(self):
        with self.lock:
            now = self.clock()
            self.items = [x for x in self.items if x["expires"] > now]
            result = [{"id": x["id"], "action": x["action"], "args": dict(x["args"])}
                      for x in self.items if not x["delivered"]]
            for x in self.items:
                x["delivered"] = True
            return {"commands": result, "expiresInSeconds": COMMAND_TTL}

    def ack(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("id"), str):
            raise RemoteError("Command ID required")
        with self.lock:
            count = len(self.items)
            self.items = [x for x in self.items if x["id"] != body["id"]]
            return {"acknowledged": len(self.items) < count}


def capabilities(commands=None):
    return {"version": 1, "queue": True, "savedHubQueue": True, "mobileWeb": True,
            "smartReorder": True,
            "deckTargets": ["1", "2", "auto"],
            "queueIsIntentOnly": True, "controllerCommands": False,
            "localPreviewRemote": bool(commands and commands.active()),
            "deckLoad": False, "play": False, "seek": False,
            "faders": False, "automix": False, "playheadVerified": False,
            "note": "This remote queues verified local tracks. Desktop must explicitly consume queued intentions. No hardware playback or transitions are controlled by this bridge."}


def safe_library(limit=MAX_LIBRARY_BROWSE, offset=0, *, provider=None):
    """Whitelist metadata only; no file paths, storage locations or streaming URLs."""
    if provider is None:
        from dashboard_http import get_rekordbox_library_fast
        provider = get_rekordbox_library_fast
    result = provider()
    rows = result.get("collection", [])
    if not isinstance(rows, list):
        raise RemoteError("Local library unavailable", 503)
    output = []
    for row in rows[offset: offset + limit]:
        if not isinstance(row, dict) or row.get("id") is None:
            continue
        track = {field: row[field] for field in FIELDS if field in row and
                 isinstance(row[field], (str, int, float)) and not isinstance(row[field], bool)}
        track["id"] = str(track.get("id", ""))
        if not track["id"].isascii() or not track["id"].isdecimal():
            continue
        for field, value in list(track.items()):
            if isinstance(value, str):
                track[field] = value[:256]
        output.append(track)
    native = []
    native_source = result.get("playlists")
    for playlist in (native_source[:1000] if isinstance(native_source, list) else []):
        if not isinstance(playlist, dict):
            continue
        ident = str(playlist.get("id", ""))
        if not ident.isascii() or not ident.isdecimal() or not 1 <= len(ident) <= 20:
            continue
        kind = playlist.get("kind")
        if kind not in ("playlist", "folder"):
            continue
        raw_count = playlist.get("count")
        count = raw_count if type(raw_count) is int and 0 <= raw_count <= 100000 else 0
        native.append({"id": ident, "name": str(playlist.get("name") or "Playlist")[:160],
                       "kind": kind, "count": count})
    return {"collection": output, "total": len(rows), "offset": offset,
            "limit": limit, "hasMore": offset + limit < len(rows),
            "nativePlaylists": native}


def safe_native_playlist(playlist_id, *, library_provider=None, playlist_provider=None):
    """Read-only native Rekordbox playlist order, returning IDs not file metadata."""
    if (not isinstance(playlist_id, str) or not playlist_id.isascii() or
            not playlist_id.isdecimal() or not 1 <= len(playlist_id) <= 20):
        raise RemoteError("Invalid native playlist ID")
    if library_provider is None:
        from dashboard_http import get_rekordbox_library_fast
        library_provider = get_rekordbox_library_fast
    try:
        listing = library_provider()
        playlist = next((x for x in listing.get("playlists", []) if
                         isinstance(x, dict) and str(x.get("id")) == playlist_id and
                         x.get("kind") == "playlist"), None)
    except Exception as exc:
        raise RemoteError("Rekordbox playlist index unavailable", 503) from exc
    if playlist is None:
        raise RemoteError("Native playlist not found", 404)
    if playlist_provider is None:
        from dashboard_http import load_rekordbox_playlist
        playlist_provider = load_rekordbox_playlist
    try:
        data = playlist_provider(playlist_id, 10000)
    except Exception as exc:
        raise RemoteError("Rekordbox playlist unavailable", 503) from exc
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("tracks"), list):
        raise RemoteError("Rekordbox playlist unavailable", 503)
    ids = []
    for entry in data["tracks"][:10000]:
        tid = str(entry.get("id", "")) if isinstance(entry, dict) else str(entry)
        if tid.isascii() and tid.isdecimal() and 1 <= len(tid) <= 20:
            ids.append(tid)
    count = data.get("count")
    total = count if type(count) is int and 0 <= count <= 100000 else len(ids)
    return {"id": playlist_id, "name": str(playlist.get("name") or "Playlist")[:160],
            "count": total, "trackIds": ids}


def read_desktop_measured_waveform(track_id, points=MOBILE_WAVEFORM_POINTS):
    """Ask the already-running localhost Music Hub for its real decoded envelope.

    A separate remote process need not duplicate Rekordbox analysis imports,
    file access and caches. The track ID is validated upstream, and the fixed
    loopback endpoint is never supplied by the phone.
    """
    connection = http.client.HTTPConnection("127.0.0.1", HUB_PORT, timeout=6)
    try:
        connection.request(
            "GET", f"/api/waveform?id={track_id}&points={MOBILE_WAVEFORM_POINTS}",
            headers={"Host": f"127.0.0.1:{HUB_PORT}"})
        response = connection.getresponse()
        if response.status != 200:
            raise RemoteError("Measured waveform service unavailable", 503)
        payload = response.read(32769)
        if len(payload) > 32768:
            raise RemoteError("Measured waveform response too large", 503)
        return json.loads(payload)
    except RemoteError:
        raise
    except (OSError, ValueError) as exc:
        raise RemoteError("Measured waveform service unavailable", 503) from exc
    finally:
        connection.close()


def safe_mobile_waveform(track_id, *, valid_track_ids=None, waveform_provider=None):
    """Authenticated, measured envelope only; no file paths, audio or native deck commands.

    A single small (96-point) downsampled amplitude series is sufficient for
    the always-visible phone deck preview. Never invent low/mid/high frequency
    data from the one available envelope.
    """
    if (not isinstance(track_id, str) or not track_id.isascii() or
            not track_id.isdecimal() or not 1 <= len(track_id) <= 20):
        raise RemoteError("Invalid local track ID", 400)
    if valid_track_ids is None:
        valid_track_ids = RemoteQueue._library_ids
    try:
        if track_id not in valid_track_ids():
            raise RemoteError("Local track not found", 404)
    except RemoteError:
        raise
    except Exception as exc:
        raise RemoteError("Local library unavailable", 503) from exc
    if waveform_provider is None:
        waveform_provider = read_desktop_measured_waveform
    try:
        data = waveform_provider(track_id, MOBILE_WAVEFORM_POINTS)
    except Exception as exc:
        raise RemoteError("Waveform analysis unavailable", 503) from exc
    if not isinstance(data, dict):
        raise RemoteError("Waveform analysis unavailable", 503)
    peaks = data.get("heights") or []
    if not isinstance(peaks, list):
        raise RemoteError("Waveform analysis unavailable", 503)
    values = []
    for value in peaks[:MOBILE_WAVEFORM_POINTS]:
        if type(value) not in (float, int) or not math.isfinite(value):
            raise RemoteError("Waveform data invalid", 503)
        values.append(round(max(0.0, min(1.0, value)), 4))
    return {"id": track_id, "heights": values}


def safe_hub_state():
    import music_hub_backend
    saved = music_hub_backend.state()
    return {"queue": saved["queue"], "favorites": saved["favorites"],
            "playlists": [{"id": x["id"], "name": x["name"], "trackIds": x["trackIds"]}
                          for x in saved["playlists"] if isinstance(x, dict)]}


def save_hub_queue(body):
    """Submit to the existing loopback Hub process so all writes share its lock."""
    if not isinstance(body, dict) or body.get("action") not in {
            "queue.add", "queue.remove", "queue.reorder", "queue.clear"}:
        raise RemoteError("Only Music Hub queue edits are allowed", 403)
    connection = http.client.HTTPConnection("127.0.0.1", HUB_PORT, timeout=4)
    try:
        connection.request("POST", "/api/music-hub/action", json.dumps(body).encode("utf-8"),
                           {"Host": "127.0.0.1:" + str(HUB_PORT), "Content-Type": "application/json"})
        response = connection.getresponse()
        # The desktop response includes full playlists (up to 6,000 tracks each),
        # so a 64-KB partial read can incorrectly report failure AFTER a write.
        result = json.loads(response.read())
        if response.status != 200:
            raise RemoteError(str(result.get("error") or "Music Hub action failed"), response.status)
        return {"queue": result["queue"], "favorites": result["favorites"],
                "playlists": [{"id": x["id"], "name": x["name"], "trackIds": x["trackIds"]}
                              for x in result["playlists"] if isinstance(x, dict)]}
    except (OSError, ValueError, KeyError) as exc:
        if isinstance(exc, RemoteError):
            raise
        raise RemoteError("Local Music Hub write service unavailable", 503) from exc
    finally:
        connection.close()


def make_handler(token: str, queue: RemoteQueue, *, library_provider=None, static_root=None,
                 commands=None, tailscale_origin=None, waveform_provider=None,
                 playlist_provider=None, phone_pairing=None):
    if not isinstance(token, str) or len(token) < 32:
        raise ValueError("MUSIC_HUB_REMOTE_TOKEN must be at least 32 characters")
    # Explicit, exact HTTPS MagicDNS identity for a tailnet-only Tailscale
    # Serve proxy. Never accept arbitrary Host/Origin or enable generic CORS.
    # Tailscale Serve terminates TLS and forwards only to this loopback server.
    tail_url = urlsplit(tailscale_origin) if tailscale_origin else None
    if tail_url and (
            tail_url.scheme != "https" or not tail_url.hostname or
            not tail_url.hostname.endswith(".ts.net") or
            tail_url.username or tail_url.password or tail_url.path or
            tail_url.query or tail_url.fragment or tail_url.port is None):
        raise ValueError("Tailscale origin must be an exact https://<magicdns>.ts.net:<port> URL")
    root = Path(static_root) if static_root is not None else Path(__file__).resolve().parent / "music-hub"
    commands = commands or PreviewCommands()
    phone_pairing = phone_pairing or PhonePairing()
    desktop_paths = {"/api/remote/v1/commands", "/api/remote/v1/heartbeat",
                     "/api/remote/v1/ack", "/api/remote/v1/pair/pending",
                     "/api/remote/v1/pair/approve"}
    pair_public_paths = {"/api/remote/v1/pair/me", "/api/remote/v1/pair/start",
                         "/api/remote/v1/pair/status", "/api/remote/v1/pair/revoke"}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            return

        def reply(self, code, data, *, set_cookie=None):
            data = json.dumps(data, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if urlsplit(self.path).path in desktop_paths:
                self.desktop_cors()
            if set_cookie is not None:
                self.send_header("Set-Cookie", set_cookie)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def validate_request(self, *, api=True, desktop=False):
            if api:
                bearer_valid = hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token)
                host = self.headers.get("Host", "")
                # Tailscale Serve may preserve the public HTTPS Host or
                # rewrite it to loopback. Both routes terminate on this
                # loopback-only port; a Secure __Host- cookie is never sent
                # by Safari over direct http://127.0.0.1 connections.
                proxied_loopback = host in (f"127.0.0.1:{self.server.server_port}",
                                            f"localhost:{self.server.server_port}")
                tailnet_cookie = bool(tail_url and (
                    host == tail_url.netloc or proxied_loopback or
                    self.headers.get("Origin") == tailscale_origin))
                cookie_valid = (not desktop and tailnet_cookie and
                                phone_pairing.authorized(self.headers.get("Cookie", "")))
                if not (bearer_valid or cookie_valid):
                    raise RemoteError("Unauthorized", 401)
            host = self.headers.get("Host", "")
            if not host or any(c in host for c in " /\\@"):
                raise RemoteError("Invalid Host", 403)
            parts = urlsplit("http://" + host)
            host_name = parts.hostname
            try:
                port = parts.port
            except ValueError:
                raise RemoteError("Invalid Host port", 403)
            bound_host, bound_port = self.server.server_address[:2]
            tailnet_request = bool(tail_url and host_name == tail_url.hostname and
                                   port == bound_port and tail_url.port == bound_port)
            if tail_url and tail_url.port != bound_port:
                raise RemoteError("Configured Tailscale port does not match server", 403)
            host_ip = None
            if not tailnet_request:
                try:
                    host_ip = ipaddress.ip_address(host_name)
                except (ValueError, TypeError):
                    raise RemoteError("Numeric Host or configured Tailscale Host required", 403)
                if not (host_ip.is_private or host_ip.is_loopback):
                    raise RemoteError("LAN Host required", 403)
            if port not in (None, bound_port):
                raise RemoteError("Host port mismatch", 403)
            if not tailnet_request and host_ip != ipaddress.ip_address(bound_host) and not (
                    host_ip.is_loopback and ipaddress.ip_address(bound_host).is_loopback):
                raise RemoteError("Host must match bound interface", 403)
            origin = self.headers.get("Origin")
            if origin:
                parsed = urlsplit(origin)
                same = ((parsed.scheme == "http" and parsed.hostname == host_name and
                         parsed.port == bound_port) or
                        (tail_url is not None and origin == tailscale_origin and
                         (tailnet_request or (host_ip is not None and host_ip.is_loopback))))
                desktop_origin = desktop and origin == "http://127.0.0.1:18769"
                if not (same or desktop_origin) or parsed.username or parsed.password:
                    raise RemoteError("Origin must match this remote bridge", 403)
            fetch_site = self.headers.get("Sec-Fetch-Site", "").lower()
            allowed = ("", "same-origin", "none", "same-site", "cross-site") if desktop and origin == "http://127.0.0.1:18769" else ("", "same-origin", "none")
            if fetch_site not in allowed:
                raise RemoteError("Cross-site requests are prohibited", 403)

        def require_tailnet_pairing(self, *, write=False):
            # Pairing never opens on plain LAN HTTP. A strict same-origin HTTPS
            # request is needed even when Tailscale Serve rewrites Host to 127.
            if not tail_url:
                raise RemoteError("Secure phone pairing unavailable", 403)
            if self.headers.get("Origin") != tailscale_origin:
                raise RemoteError("Phone pairing requires the private HTTPS app", 403)
            if self.headers.get("Sec-Fetch-Site", "") not in ("", "same-origin", "none"):
                raise RemoteError("Cross-site pairing prohibited", 403)
            if write and not commands.active():
                raise RemoteError("Open Music Hub on the laptop first", 409)

        def require_desktop(self):
            origin = self.headers.get("Origin", "")
            if origin not in ("", "http://127.0.0.1:18769"):
                raise RemoteError("Desktop endpoint required", 403)
            if not origin and not ipaddress.ip_address(self.client_address[0]).is_loopback:
                raise RemoteError("Loopback desktop client required", 403)

        def desktop_cors(self):
            if self.headers.get("Origin") == "http://127.0.0.1:18769":
                self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:18769")
                self.send_header("Vary", "Origin")

        def do_OPTIONS(self):
            try:
                path = urlsplit(self.path).path
                if path not in desktop_paths:
                    raise RemoteError("Unknown endpoint", 404)
                self.validate_request(api=False, desktop=True)
                self.require_desktop()
                requested = self.headers.get("Access-Control-Request-Headers", "").lower().replace(" ", "")
                if any(x not in ("authorization", "content-type") for x in requested.split(",") if x):
                    raise RemoteError("Unsupported request header", 403)
                self.send_response(204)
                self.desktop_cors()
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Max-Age", "0")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except RemoteError as exc:
                self.reply(exc.status, {"error": str(exc)})

        def static(self, path):
            filename = ASSETS.get(path)
            if filename is None:
                raise RemoteError("Unknown endpoint", 404)
            try:
                body = (root / filename).read_bytes()
            except OSError:
                raise RemoteError("Mobile interface unavailable", 503)
            content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            try:
                parsed = urlsplit(self.path)
                path = parsed.path
                desktop = path in desktop_paths
                unauthenticated = path in pair_public_paths
                self.validate_request(api=path not in ASSETS and not unauthenticated, desktop=desktop)
                if desktop:
                    self.require_desktop()
                if path in ASSETS:
                    return self.static(path)
                if path == "/api/remote/v1/pair/me":
                    self.reply(200, {"connected": phone_pairing.authorized(self.headers.get("Cookie", "")),
                                     "laptopOnline": commands.active()})
                    return
                if path == "/api/remote/v1/pair/pending":
                    self.reply(200, {"requests": phone_pairing.awaiting_approval()})
                    return
                if path == "/api/remote/v1/status":
                    result = {"capabilities": capabilities(commands), "queue": queue.snapshot(),
                              "hub": safe_hub_state(), "preview": commands.preview_snapshot()}
                elif path == "/api/remote/v1/queue":
                    result = queue.snapshot()
                elif path in ("/api/remote/v1/library", "/api/library"):
                    if path == "/api/library":
                        result = safe_library(provider=library_provider)
                    else:
                        from urllib.parse import parse_qs
                        args = parse_qs(parsed.query)
                        try:
                            offset = int(args.get("offset", ["0"])[0])
                            limit = int(args.get("limit", ["500"])[0])
                        except ValueError:
                            raise RemoteError("Invalid pagination")
                        if offset < 0 or offset > 1000000 or not 1 <= limit <= MAX_LIBRARY_PAGE:
                            raise RemoteError("Pagination outside allowed range")
                        result = safe_library(limit, offset, provider=library_provider)
                elif path == "/api/remote/v1/waveform":
                    from urllib.parse import parse_qs
                    args = parse_qs(parsed.query)
                    identifiers = args.get("id", [])
                    if len(identifiers) != 1:
                        raise RemoteError("Exactly one local track ID required")
                    result = safe_mobile_waveform(
                        identifiers[0], valid_track_ids=queue._valid_track_ids,
                        waveform_provider=waveform_provider)
                elif path == "/api/remote/v1/native-playlist":
                    from urllib.parse import parse_qs
                    args = parse_qs(parsed.query)
                    identifiers = args.get("id", [])
                    if len(identifiers) != 1:
                        raise RemoteError("Exactly one native playlist ID required")
                    result = safe_native_playlist(
                        identifiers[0], library_provider=library_provider,
                        playlist_provider=playlist_provider)
                elif path in ("/api/music-hub/state", "/api/remote/v1/hub"):
                    result = safe_hub_state()
                elif path == "/api/music-hub/decks":
                    from music_hub_decks import deck_status
                    result = deck_status()
                elif path == "/api/remote/v1/commands":
                    result = commands.poll()
                else:
                    raise RemoteError("Unknown endpoint", 404)
                self.reply(200, result)
            except RemoteError as exc:
                self.reply(exc.status, {"error": str(exc)})
            except Exception:
                self.reply(503, {"error": "Local bridge data unavailable"})

        def do_POST(self):
            try:
                path = urlsplit(self.path).path
                desktop = path in desktop_paths
                phone_public = path in pair_public_paths
                self.validate_request(api=not phone_public, desktop=desktop)
                if desktop:
                    self.require_desktop()
                if path not in ("/api/remote/v1/queue", "/api/music-hub/action", "/api/remote/v1/command", "/api/remote/v1/heartbeat", "/api/remote/v1/ack",
                                "/api/remote/v1/pair/start", "/api/remote/v1/pair/status", "/api/remote/v1/pair/approve",
                                "/api/remote/v1/pair/enroll", "/api/remote/v1/pair/revoke"):
                    raise RemoteError("Unknown endpoint", 404)
                if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                    raise RemoteError("JSON required", 415)
                length = self.headers.get("Content-Length", "")
                if not length.isdecimal() or not 0 < int(length) <= MAX_BODY:
                    raise RemoteError("Invalid body length", 413)
                try:
                    body = json.loads(self.rfile.read(int(length)))
                except (ValueError, UnicodeDecodeError):
                    raise RemoteError("Invalid JSON")
                if path == "/api/remote/v1/pair/start":
                    self.require_tailnet_pairing(write=True)
                    if not isinstance(body, dict) or set(body) != {"label"}:
                        raise RemoteError("A device label is required", 400)
                    try:
                        result = phone_pairing.start(body["label"])
                    except ValueError as exc:
                        raise RemoteError(str(exc), 429) from exc
                elif path == "/api/remote/v1/pair/status":
                    self.require_tailnet_pairing()
                    if not isinstance(body,dict) or set(body)!={"requestId","secret"}:
                        raise RemoteError("Request ID and secret required",400)
                    state,cookie=phone_pairing.finish(body["requestId"],body["secret"])
                    return self.reply(200,{"state":state,"laptopOnline":commands.active()},set_cookie=cookie)
                elif path == "/api/remote/v1/pair/approve":
                    if not isinstance(body, dict) or set(body) != {"requestId", "code"}:
                        raise RemoteError("Request and matching code required", 400)
                    if not phone_pairing.approve(body["requestId"], body["code"]):
                        raise RemoteError("Pairing expired or code mismatch", 409)
                    result = {"approved": True}
                elif path == "/api/remote/v1/pair/enroll":
                    self.require_tailnet_pairing()
                    if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                        raise RemoteError("Existing pairing token required", 401)
                    if body != {}:
                        raise RemoteError("No fields accepted", 400)
                    return self.reply(200, {"connected": True}, set_cookie=phone_pairing.enroll_existing_bearer())
                elif path == "/api/remote/v1/pair/revoke":
                    self.require_tailnet_pairing()
                    if body != {}:
                        raise RemoteError("No fields accepted", 400)
                    phone_pairing.revoke(self.headers.get("Cookie", ""))
                    return self.reply(200, {"connected": False}, set_cookie=COOKIE_CLEAR)
                elif path == "/api/music-hub/action":
                    result = save_hub_queue(body)
                elif path == "/api/remote/v1/queue":
                    result = queue.mutate(body)
                elif path == "/api/remote/v1/command":
                    result = commands.submit(body)
                elif path == "/api/remote/v1/heartbeat":
                    result = commands.heartbeat(body)
                else:
                    result = commands.ack(body)
                self.reply(200, result)
            except RemoteError as exc:
                self.reply(exc.status, {"error": str(exc)})
            except Exception:
                self.reply(503, {"error": "Local bridge operation unavailable"})

    return Handler


def serve():
    if os.environ.get("MUSIC_HUB_REMOTE_ENABLED") != "1":
        raise SystemExit("Remote bridge disabled; set MUSIC_HUB_REMOTE_ENABLED=1 to opt in")
    token = os.environ.get("MUSIC_HUB_REMOTE_TOKEN", "")
    tailscale_origin = os.environ.get("MUSIC_HUB_REMOTE_TAILSCALE_ORIGIN") or None
    handler = make_handler(
        token, RemoteQueue(), tailscale_origin=tailscale_origin,
        phone_pairing=PhonePairing(Path(__file__).resolve().parent / ".cache" / "music_hub_phone_devices.json"))
    host = os.environ.get("MUSIC_HUB_REMOTE_HOST", "127.0.0.1")
    address = ipaddress.ip_address(host)
    if address.version != 4 or not (address.is_private or address.is_loopback) or address.is_unspecified:
        raise SystemExit("Bind to an explicit IPv4 LAN interface or 127.0.0.1")
    port = int(os.environ.get("MUSIC_HUB_REMOTE_PORT", "18770"))
    if port in (18765, 18766, 18767, 18769):
        raise SystemExit("Port reserved for existing Music Hub services")
    with ThreadingHTTPServer((host, port), handler) as server:
        print(f"Music Hub remote intent bridge on {host}:{port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    serve()
