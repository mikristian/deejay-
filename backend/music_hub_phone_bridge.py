"""Trusted loopback relay from the private iPhone app to laptop Music Hub.

The existing bearer token stays on the source Mac. Only the existing, strictly
validated local-preview commands and saved Next Up actions can cross this relay.
This module NEVER controls native Rekordbox MIDI, playback, or master.db.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import math
import plistlib
from pathlib import Path

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 18770
MAX_JSON = 2048


class PhoneBridgeError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.status = status
        super().__init__(message)


def check_local(handler):
    try:
        if not ipaddress.ip_address(handler.client_address[0]).is_loopback:
            raise PhoneBridgeError("Local Music Hub bridge only", 403)
    except ValueError as exc:
        raise PhoneBridgeError("Local Music Hub bridge only", 403) from exc
    host = handler.headers.get("Host", "").lower()
    if host not in ("127.0.0.1:18769", "localhost:18769"):
        raise PhoneBridgeError("Local Music Hub Host required", 403)
    origin = handler.headers.get("Origin", "")
    if origin and origin != "http://" + host:
        raise PhoneBridgeError("Same-origin only", 403)
    if handler.headers.get("Sec-Fetch-Site", "").lower() not in ("", "none", "same-origin"):
        raise PhoneBridgeError("Cross-site requests blocked", 403)


def _token():
    path = Path.home() / "Library/LaunchAgents/com.music-hub.tailscale-mobile.plist"
    try:
        config = plistlib.loads(path.read_bytes()).get("EnvironmentVariables", {})
        token = config.get("MUSIC_HUB_REMOTE_TOKEN", "")
        if (config.get("MUSIC_HUB_REMOTE_ENABLED") != "1" or
                not isinstance(token, str) or len(token) < 32):
            raise ValueError("No active private pairing")
        return token
    except (OSError, ValueError, TypeError) as exc:
        raise PhoneBridgeError("Laptop pairing unavailable", 503) from exc


def relay(path: str, body=None):
    if path not in ("/api/remote/v1/status", "/api/music-hub/decks",
                    "/api/remote/v1/command", "/api/music-hub/action"):
        raise PhoneBridgeError("Unknown bridge endpoint", 404)
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    if data is not None and len(data) > MAX_JSON:
        raise PhoneBridgeError("Command too large", 413)
    headers = {"Authorization": "Bearer " + _token(), "Accept": "application/json",
               "Host": f"{BRIDGE_HOST}:{BRIDGE_PORT}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection(BRIDGE_HOST, BRIDGE_PORT, timeout=5)
    try:
        connection.request("POST" if data is not None else "GET", path, data, headers)
        response = connection.getresponse()
        payload = response.read(100_001)
        if len(payload) > 100_000:
            raise PhoneBridgeError("Bridge response too large", 503)
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise ValueError("Non-object bridge result")
        if response.status != 200:
            raise PhoneBridgeError(str(result.get("error", "Bridge unavailable"))[:180], response.status)
        return result
    except (OSError, TimeoutError, ValueError) as exc:
        raise PhoneBridgeError("Laptop remote bridge unavailable", 503) from exc
    finally:
        connection.close()


def _id(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or not 1 <= len(value) <= 20:
        raise PhoneBridgeError("Numeric Rekordbox library ID required")
    return value


def validate_action(data):
    if not isinstance(data, dict):
        raise PhoneBridgeError("JSON object required")
    action = data.get("action")
    if action == "queue.add":
        if set(data) != {"action", "trackId"}:
            raise PhoneBridgeError("Queue accepts only a track ID")
        return "/api/music-hub/action", {"action": action, "trackId": _id(data["trackId"])}
    allowed = {"local.stage": {"action", "deck", "trackId"},
               "local.play": {"action", "deck"},
               "local.seek": {"action", "deck", "positionSec"},
               "local.fade": {"action", "target", "durationMs"}}
    if action not in allowed or set(data) != allowed[action]:
        raise PhoneBridgeError("Unsupported or malformed laptop preview command")
    if action in ("local.stage", "local.play", "local.seek"):
        if data["deck"] not in ("1", "2"):
            raise PhoneBridgeError("Deck must be A or B")
    if action == "local.stage":
        _id(data["trackId"])
    elif action == "local.seek":
        x = data["positionSec"]
        if type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 86400:
            raise PhoneBridgeError("Invalid preview seek")
    elif action == "local.fade":
        x, duration = data["target"], data["durationMs"]
        if type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 1:
            raise PhoneBridgeError("Invalid preview fade")
        if type(duration) is not int or not 100 <= duration <= 30000:
            raise PhoneBridgeError("Invalid fade duration")
    return "/api/remote/v1/command", data


def serve_get(handler, *, path):
    try:
        check_local(handler)
        if path == "/api/music-hub/phone/status":
            status = relay("/api/remote/v1/status")
            # Advertise laptop browser preview and native controller separately.
            status["nativeDecks"] = relay("/api/music-hub/decks")
            handler._music_hub_json(200, status)
        else:
            raise PhoneBridgeError("Unknown endpoint", 404)
    except PhoneBridgeError as error:
        handler._music_hub_json(error.status, {"error": str(error)})
    except Exception:
        handler._music_hub_json(503, {"error": "Laptop bridge unavailable"})


def serve_post(handler):
    try:
        check_local(handler)
        if handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise PhoneBridgeError("JSON required", 415)
        size = handler.headers.get("Content-Length", "")
        if not size.isascii() or not size.isdecimal() or not 0 < int(size) <= MAX_JSON:
            raise PhoneBridgeError("Invalid JSON size", 413)
        try:
            data = json.loads(handler.rfile.read(int(size)))
        except (ValueError, UnicodeDecodeError) as exc:
            raise PhoneBridgeError("Malformed JSON") from exc
        path, request = validate_action(data)
        handler._music_hub_json(200, relay(path, request))
    except PhoneBridgeError as error:
        handler._music_hub_json(error.status, {"error": str(error)})
    except Exception:
        handler._music_hub_json(503, {"error": "Laptop bridge unavailable"})
