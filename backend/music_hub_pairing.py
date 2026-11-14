"""One-time laptop-approved pairing for the existing Music Hub phone web app.

The phone never receives the laptop's administrator bearer token. It gets an
opaque, 30-day, HTTPS-only, HttpOnly device cookie after a *local* laptop user
approves a short matching code. Only SHA256 cookie hashes are persisted.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

PAIR_TTL = 180
SESSION_TTL = 30 * 86400
COOKIE_NAME = "__Host-music-hub-device"
COOKIE_CLEAR = f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"


def cookie_value(header):
    for part in str(header or "").split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == COOKIE_NAME and re.fullmatch(r"[A-Za-z0-9_-]{40,96}", value):
            return value
    return ""


def digest(value):
    return hashlib.sha256(value.encode("ascii")).hexdigest()


class PhonePairing:
    def __init__(self, path=None, clock=None):
        self.path = Path(path) if path else None
        self.clock = clock or time.time
        self.lock = threading.RLock()
        self.pending = {}
        self.sessions = {}
        self.attempts = []
        self._load()

    def _load(self):
        if not self.path or not self.path.is_file():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return
            now = self.clock()
            self.sessions = {
                k: v for k, v in data.get("sessions", {}).items()
                if isinstance(k, str) and re.fullmatch("[a-f0-9]{64}", k)
                and isinstance(v, (int, float)) and v > now
            }
        except (OSError, ValueError, TypeError):
            # A corrupt/replaced file never grants access.
            self.sessions = {}

    def _save(self):
        if not self.path:
            return
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".phone-pair-", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({"version": 1, "sessions": self.sessions}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass

    def _prune(self):
        now = self.clock()
        self.pending = {k: v for k, v in self.pending.items() if v["expiry"] > now}
        self.sessions = {k: v for k, v in self.sessions.items() if v > now}
        self.attempts = [t for t in self.attempts if now - t < 60]

    def authorized(self, cookie_header):
        value = cookie_value(cookie_header)
        if not value:
            return False
        with self.lock:
            self._prune()
            key = digest(value)
            return key in self.sessions and self.sessions[key] > self.clock()

    def _new_session(self):
        self._prune()
        raw = secrets.token_urlsafe(32)
        self.sessions[digest(raw)] = self.clock() + SESSION_TTL
        self._save()
        return f"{COOKIE_NAME}={raw}; Path=/; Max-Age={SESSION_TTL}; HttpOnly; Secure; SameSite=Strict"

    def enroll_existing_bearer(self):
        """Migration for a phone already holding the original full bearer."""
        with self.lock:
            return self._new_session()

    def start(self, label):
        if not isinstance(label, str) or not 1 <= len(label) <= 45:
            raise ValueError("Device name must be 1–45 characters")
        label = "".join(c for c in label.strip() if c.isalnum() or c in " -_")
        if not label:
            raise ValueError("Device name required")
        with self.lock:
            self._prune()
            if len(self.pending) >= 4 or len(self.attempts) >= 10:
                raise ValueError("Too many pairing requests; try again shortly")
            self.attempts.append(self.clock())
            request_id = secrets.token_hex(16)
            secret = secrets.token_urlsafe(32)
            code = f"{secrets.randbelow(1000000):06d}"
            self.pending[request_id] = {
                "secretHash": digest(secret), "code": code, "label": label,
                "expiry": self.clock() + PAIR_TTL, "approved": False
            }
            return {"requestId": request_id, "secret": secret,
                    "code": code, "expiresInSeconds": PAIR_TTL}

    def awaiting_approval(self):
        with self.lock:
            self._prune()
            return [{"requestId": key, "label": item["label"], "code": item["code"],
                     "secondsRemaining": max(0, int(item["expiry"] - self.clock()))}
                    for key, item in self.pending.items() if not item["approved"]]

    def approve(self, request_id, code):
        with self.lock:
            self._prune()
            item = self.pending.get(request_id)
            if not item or not isinstance(code, str) or not hmac.compare_digest(item["code"], code):
                return False
            item["approved"] = True
            return True

    def finish(self, request_id, secret):
        with self.lock:
            self._prune()
            item = self.pending.get(request_id)
            if (not item or not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,96}",secret) or
                not hmac.compare_digest(item["secretHash"], digest(secret))):
                return "expired", None
            if not item["approved"]:
                return "pending", None
            # A successful poll consumes the pairing secret exactly once.
            del self.pending[request_id]
            return "connected", self._new_session()

    def revoke(self, cookie_header):
        value = cookie_value(cookie_header)
        if not value:
            return
        with self.lock:
            self.sessions.pop(digest(value), None)
            self._save()
