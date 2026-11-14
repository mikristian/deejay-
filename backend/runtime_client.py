"""Synchronous client/proxy for the persistent Rekordbox runtime."""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from websockets.sync.client import connect

BASE_DIR = Path(__file__).resolve().parent
RUNTIME_HOST = "127.0.0.1"
RUNTIME_PORT = 18765
RUNTIME_HTTP_PORT = 18766
RUNTIME_WS = f"ws://{RUNTIME_HOST}:{RUNTIME_PORT}"
RUNTIME_LOG = Path("/tmp/rekordbox-live-runtime.log")
RUNTIME_PID = Path("/tmp/rekordbox-live-runtime.pid")
RUNTIME_SERVER = (BASE_DIR / "runtime_server.py").resolve()
RUNTIME_PYTHON = (BASE_DIR / ".venv/bin/python").resolve()


def discover_runtime_pids() -> list[int]:
    """Return only exact Rekordbox runtime processes, never shell wrappers."""
    proc = subprocess.run(
        ["ps", "-axo", "pid=,command="],
        capture_output=True,
        text=True,
        check=False,
    )
    found: list[int] = []
    runtime_python_link = BASE_DIR / ".venv/bin/python"
    expected_commands = {
        f"{runtime_python_link} {RUNTIME_SERVER}",
        f"{RUNTIME_PYTHON} {RUNTIME_SERVER}",
    }
    # macOS framework Python can rewrite argv[0] from the .venv interpreter
    # to its Python.app executable after launch. Match that exact interpreter
    # form only when the script argument is this project's runtime_server.py;
    # never match a shell wrapper or an unrelated Python process.
    runtime_suffix = f" {RUNTIME_SERVER}"
    for raw in proc.stdout.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            pid = int(parts[0])
        except Exception:
            continue
        command = parts[1].strip()
        framework_runtime = False
        if command.endswith(runtime_suffix):
            executable = command[:-len(runtime_suffix)]
            framework_runtime = (
                executable.startswith("/")
                and executable.endswith("/Resources/Python.app/Contents/MacOS/Python")
                and Path(executable).is_file()
            )
        if command in expected_commands or framework_runtime:
            found.append(pid)
    return found


def repair_runtime_pidfile() -> int | None:
    pids = discover_runtime_pids()
    if len(pids) == 1:
        RUNTIME_PID.write_text(str(pids[0]), encoding="utf-8")
        return pids[0]
    return None


def runtime_alive(timeout: float = 0.15) -> bool:
    try:
        with socket.create_connection((RUNTIME_HOST, RUNTIME_HTTP_PORT), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(b"HEAD /dashboard.html HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            if not sock.recv(16).startswith(b"HTTP/"):
                return False
        # Require the actual WebSocket handshake too; HTTP-only isn't a usable
        # controller runtime for MCP control requests.
        with connect(RUNTIME_WS, open_timeout=timeout, close_timeout=max(0.1, timeout)):
            return True
    except Exception:
        return False


def ensure_runtime(timeout: float = 6.0) -> bool:
    if runtime_alive():
        repair_runtime_pidfile()
        return True
    log = RUNTIME_LOG.open("ab", buffering=0)
    try:
        proc = subprocess.Popen(
            [sys.executable, str(BASE_DIR / "runtime_server.py")],
            cwd=str(BASE_DIR),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
        RUNTIME_PID.write_text(str(proc.pid), encoding="utf-8")
    finally:
        log.close()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if runtime_alive():
            return True
        time.sleep(0.08)
    raise RuntimeError(f"Rekordbox runtime did not start; see {RUNTIME_LOG}")


def stop_runtime(timeout: float = 6.0) -> dict:
    """Stop the one exact runtime process, repairing stale/missing PID state."""
    pids = discover_runtime_pids()
    if not pids:
        RUNTIME_PID.unlink(missing_ok=True)
        return {"stopped": False, "reason": "not_running"}
    if len(pids) != 1:
        raise RuntimeError(f"Expected one Rekordbox runtime, found {pids}")
    pid = pids[0]
    RUNTIME_PID.write_text(str(pid), encoding="utf-8")
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pid not in discover_runtime_pids():
            RUNTIME_PID.unlink(missing_ok=True)
            return {"stopped": True, "pid": pid}
        time.sleep(0.08)
    raise RuntimeError(f"Runtime PID {pid} did not exit after SIGTERM")


def runtime_request(payload: dict, expect_action: str | None = None, timeout: float = 4.0) -> dict:
    ensure_runtime()
    with connect(RUNTIME_WS, open_timeout=timeout, close_timeout=1) as ws:
        request = dict(payload)
        request["_reply_only"] = True
        ws.send(json.dumps(request))
        if not expect_action:
            return {"ok": True}
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = ws.recv(timeout=max(0.05, deadline - time.time()))
            event = json.loads(raw)
            if event.get("action") == "error":
                raise RuntimeError(event.get("message", "runtime error"))
            if event.get("action") == expect_action:
                return event
    raise TimeoutError(f"Timed out waiting for runtime event {expect_action}")


class RuntimeProxy:
    def status(self) -> dict:
        return runtime_request({"type": "status_request"}, "controller_status")["status"]

    def state(self) -> dict:
        """Return one direct, deterministic runtime/controller snapshot."""
        return runtime_request({"type": "state_request"}, "runtime_state")

    def ai_dj_status(self) -> dict:
        return runtime_request({"type": "ai_dj_status"}, "ai_dj_status")["ai_dj"]

    def ai_dj_start(self, track_id: str, deck: int, bpm: float | None = None, silent_rehearsal: bool = False) -> dict:
        return runtime_request(
            {
                "type": "ai_dj_start",
                "track_id": str(track_id),
                "deck": int(deck),
                "bpm": bpm,
                "silent_rehearsal": bool(silent_rehearsal),
            },
            "ai_dj_started",
        )["ai_dj"]

    def ai_dj_arm(self, recipe: dict) -> dict:
        return runtime_request(
            {"type": "ai_dj_arm", "recipe": recipe},
            "ai_dj_armed",
        )["ai_dj"]

    def ai_dj_abort(self) -> dict:
        return runtime_request({"type": "ai_dj_abort"}, "ai_dj_abort_requested")["ai_dj"]

    def ai_dj_stop(self) -> dict:
        return runtime_request({"type": "ai_dj_stop"}, "ai_dj_stopped")["ai_dj"]

    def ai_dj_autopilot_start(
        self,
        start_track_id: str,
        length: int = 6,
        start_deck: int = 1,
        silent_rehearsal: bool = False,
    ) -> dict:
        return runtime_request(
            {
                "type": "ai_dj_autopilot_start",
                "start_track_id": str(start_track_id),
                "length": int(length),
                "start_deck": int(start_deck),
                "silent_rehearsal": bool(silent_rehearsal),
            },
            "ai_dj_autopilot_started",
            timeout=20.0,
        )["ai_dj"]

    def ai_dj_autopilot_stop(self, stop_transport: bool = True) -> dict:
        return runtime_request(
            {"type": "ai_dj_autopilot_stop", "stop_transport": bool(stop_transport)},
            "ai_dj_autopilot_stopped",
            timeout=8.0,
        )["ai_dj"]

    def _control(self, action: str, **payload) -> dict:
        request_id = uuid.uuid4().hex
        event = runtime_request(
            {"type": "control", "action": action, "request_id": request_id, **payload},
            "control_ack",
        )
        if event.get("request_id") != request_id or event.get("control_action") != action:
            raise RuntimeError(f"runtime acknowledgement mismatch for {action}")
        return event

    def play(self, deck): self._control("play", deck=deck)
    def cue(self, deck): self._control("cue", deck=deck)
    def set_crossfader(self, position): self._control("crossfader", value=position)
    def set_channel_fader(self, deck, level): self._control("channel_fader", deck=deck, value=level)
    def set_tempo(self, deck, level): self._control("tempo", deck=deck, value=level)
    def deck_button(self, deck, control): self._control("deck_button", deck=deck, control=control)
    def jog_touch(self, deck, touched): self._control("jog_touch", deck=deck, touched=bool(touched))
    def jog_rotate(self, deck, delta, mode="scratch"): self._control("jog_rotate", deck=deck, delta=delta, mode=mode)
    def browser_rotate(self, delta): self._control("browser_rotate", delta=delta)
    def browser_press(self): self._control("browser_press")
    def browser_back(self): self._control("browser_back")
    def browser_load(self, deck): self._control("browser_load", deck=deck)
    def browser_related(self): self._control("browser_related")
    def browser_switch_window(self): self._control("browser_switch_window")
    def set_eq(self, deck, band, level): self._control("eq", deck=deck, band=band, value=level)
    def trigger_pad(self, deck, pad): self._control("pad", deck=deck, pad=pad)
    def trigger_performance_pad(self, deck, mode, pad): self._control("performance_pad", deck=deck, mode=mode, pad=pad)
    def set_cfx(self, deck, level): self._control("cfx", deck=deck, value=level)
    def smart_cfx_toggle(self): self._control("smart_cfx")
    def smart_cfx_select(self): self._control("smart_cfx_select")
    def smart_fader_toggle(self): self._control("smart_fader")
    def fx_select(self, unit=1, direction=1): self._control("fx_select", unit=unit, direction=direction)
    def fx_beat(self, unit=1, direction=1): self._control("fx_beat", unit=unit, direction=direction)
    def fx_level(self, unit=1, level=.5): self._control("fx_level", unit=unit, value=level)
    def fx_toggle(self, unit=1): self._control("fx_toggle", unit=unit)
    def semantic_cue(self, cue): self._control("semantic_cue", cue=cue)
