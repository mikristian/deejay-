"""Small, local sampler configuration API. Audio is rendered by the Music Hub browser."""
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

_LOCK = threading.RLock()
_FILE = Path(__file__).resolve().parent / ".cache" / "sampler-pad-bank.json"
_MODES = {"deck", "sampler"}
_ENGINES = {"vsl", "browser", "direct", "ableton"}
_KIT_ROOT = Path(__file__).resolve().parent.parent / "music-remix-open-source-20261106" / "akai-sample-packs" / "Barbara_Mason_Yes_Im_Ready" / "VSL_16_PAD_KIT"
_EVENT_LOCK = threading.Lock()
_EVENT_SEQUENCE = 0
_EVENTS = []


class SamplerError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _default():
    return {"mode": "deck", "engine": "vsl", "bank": 1, "pads": [None] * 16}


def kit_status():
    files = [_KIT_ROOT / f"pad_{i:02d}.wav" for i in range(1, 17)]
    available = all(p.is_file() and not p.is_symlink() and p.stat().st_size > 44 for p in files)
    return {"available": available, "id": "vsl-16-pad", "name": "Vintage Sampler Lab · 16 Slice Kit", "padCount": 16 if available else 0}


def kit_audio(pad):
    if type(pad) is not int or not 1 <= pad <= 16:
        raise SamplerError("Pad must be 1–16")
    if not kit_status()["available"]:
        raise SamplerError("Local 16-pad kit unavailable", 404)
    path = _KIT_ROOT / f"pad_{pad:02d}.wav"
    return path, "audio/wav", path.stat().st_size


def bridge_status():
    """Read the active FLX4 bridge's hardware/audio counters over loopback."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:18778/status", timeout=0.25) as response:
            data = json.loads(response.read(8192))
        if isinstance(data, dict) and data.get("ok") is True:
            return data
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, TypeError):
        pass
    return {"ok": False, "error": "Local FLX4 sampler bridge is not reachable"}


def physical_event(payload):
    global _EVENT_SEQUENCE
    if not isinstance(payload, dict) or type(payload.get("pad")) is not int or not 1 <= payload["pad"] <= 16 or payload.get("pressed") is not True:
        raise SamplerError("Expected pad 1–16 and pressed=true")
    active = status()
    if active["mode"] != "sampler" or active["engine"] != "browser":
        raise SamplerError("Sampler mode inactive", 409)
    with _EVENT_LOCK:
        _EVENT_SEQUENCE += 1
        event = {"seq": _EVENT_SEQUENCE, "pad": payload["pad"], "pressed": True}
        _EVENTS.append(event)
        del _EVENTS[:-64]
        return {"ok": True, **event}


def direct_trigger(payload):
    """Proxy a local UI pad press to native direct audio or Ableton MIDI.

    Route is deliberately same-origin/loopback only at dashboard_http.py.
    Both native destinations are separate from browser and VSL audio output.
    """
    active = status()
    if active["mode"] != "sampler" or active["engine"] not in ("direct", "ableton"):
        raise SamplerError("Select Direct FLX4 Audio or Ableton Simpler in sampler mode", 409)
    if not isinstance(payload, dict) or type(payload.get("pad")) is not int or not 1 <= payload["pad"] <= 16:
        raise SamplerError("Pad must be 1–16")
    action_name = payload.get("action", "trigger")
    if action_name not in ("trigger", "stop"):
        raise SamplerError("Invalid direct audio action")
    body = json.dumps({"pad": payload["pad"], "action": action_name,
                       "velocity": 110}).encode("utf-8")
    request = urllib.request.Request("http://127.0.0.1:18778/trigger", data=body,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=0.7) as response:
            result = json.load(response)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise SamplerError(f"Native FLX4 audio bridge unavailable: {exc}", 503) from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise SamplerError("Direct FLX4 audio trigger failed", 503)
    return {"ok": True, "pad": payload["pad"], "action": action_name}


def events(after):
    if type(after) is not int or after < 0:
        raise SamplerError("Invalid sequence")
    with _EVENT_LOCK:
        return {"ok": True, "latest": _EVENT_SEQUENCE,
                "events": [item for item in _EVENTS if item["seq"] > after][-32:]}


def status():
    with _LOCK:
        try:
            state = json.loads(_FILE.read_text(encoding="utf-8"))
            if (state.get("mode") not in _MODES or state.get("bank") != 1
                    or not isinstance(state.get("pads"), list) or len(state["pads"]) != 16):
                return _default()
            state["pads"] = [x if isinstance(x, str) and x.isdecimal() else None for x in state["pads"]]
            state["engine"] = state.get("engine") if state.get("engine") in _ENGINES else "vsl"
            return state
        except (FileNotFoundError, ValueError, OSError, TypeError, AttributeError):
            return _default()


def action(payload, collection):
    if not isinstance(payload, dict):
        raise SamplerError("Expected an object")
    kind = payload.get("action")
    if kind not in {"mode", "engine", "assign", "clear", "trigger", "stop"}:
        raise SamplerError("Unsupported sampler action")
    with _LOCK:
        state = status()
        if kind == "mode":
            if payload.get("mode") not in _MODES:
                raise SamplerError("Mode must be deck or sampler")
            state["mode"] = payload["mode"]
        elif kind == "engine":
            if payload.get("engine") not in _ENGINES:
                raise SamplerError("Engine must be vsl, browser, direct, or ableton")
            state["engine"] = payload["engine"]
        else:
            pad = payload.get("pad")
            if type(pad) is not int or not 1 <= pad <= 16:
                raise SamplerError("Pad must be an integer from 1 to 16")
            if kind == "assign":
                tid = payload.get("trackId")
                if not isinstance(tid, str) or not tid.isdecimal():
                    raise SamplerError("Invalid track ID")
                if tid not in {str(t.get("id")) for t in collection}:
                    raise SamplerError("Track does not exist in local library", 404)
                state["pads"][pad - 1] = tid
            elif kind == "clear":
                state["pads"][pad - 1] = None
            elif kind == "trigger":
                if state["mode"] != "sampler":
                    raise SamplerError("Enable sampler mode before triggering", 409)
                if state["pads"][pad - 1] is None:
                    raise SamplerError("Pad is empty", 409)
        if kind in {"mode", "engine", "assign", "clear"}:
            _FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = _FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
            tmp.replace(_FILE)
        return {"ok": True, "action": kind, **state}
