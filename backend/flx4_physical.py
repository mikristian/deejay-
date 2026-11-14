"""Passive DDJ-FLX4 hardware mirror.

This module only listens to the real controller's CoreMIDI source. It never
sends MIDI and therefore cannot duplicate commands into Rekordbox. Decoded
events are namespaced as ``hardware_*`` so the dashboard can mirror the
physical surface without confusing hardware motion with bridge commands or
Rekordbox feedback.
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Optional

import mido


class FLX4PhysicalMonitor:
    """Read-only CoreMIDI monitor for the physical DDJ-FLX4."""

    # Standard 14-bit CC pairs used by the official DDJ-FLX4 mapping.
    # Key: (MIDI channel, MSB controller). Value: (event action, metadata).
    HIRES = {
        (6, 0x1F): ("hardware_crossfader", {}),
        (6, 0x08): ("hardware_master_level", {}),
        (6, 0x0C): ("hardware_headphone_mix", {}),
        (6, 0x0D): ("hardware_headphone_level", {}),
        (6, 0x05): ("hardware_mic_level", {}),
        (0, 0x04): ("hardware_trim", {"deck": 1}),
        (1, 0x04): ("hardware_trim", {"deck": 2}),
        (0, 0x13): ("hardware_channel_fader", {"deck": 1}),
        (1, 0x13): ("hardware_channel_fader", {"deck": 2}),
        (0, 0x07): ("hardware_eq", {"deck": 1, "band": "high"}),
        (1, 0x07): ("hardware_eq", {"deck": 2, "band": "high"}),
        (0, 0x0B): ("hardware_eq", {"deck": 1, "band": "mid"}),
        (1, 0x0B): ("hardware_eq", {"deck": 2, "band": "mid"}),
        (0, 0x0F): ("hardware_eq", {"deck": 1, "band": "low"}),
        (1, 0x0F): ("hardware_eq", {"deck": 2, "band": "low"}),
        (6, 0x17): ("hardware_cfx", {"deck": 1}),
        (6, 0x18): ("hardware_cfx", {"deck": 2}),
        (0, 0x00): ("hardware_tempo", {"deck": 1}),
        (1, 0x00): ("hardware_tempo", {"deck": 2}),
        (4, 0x02): ("hardware_fx_level", {"unit": 1}),
        (5, 0x02): ("hardware_fx_level", {"unit": 2}),
    }

    # Relative controls use 64 as center; 65 is +1 and 63 is -1.
    RELATIVE = {
        (6, 0x40): ("hardware_browser_rotate", {}),
        (0, 0x21): ("hardware_jog_rotate", {"deck": 1, "mode": "pitch"}),
        (1, 0x21): ("hardware_jog_rotate", {"deck": 2, "mode": "pitch"}),
        (0, 0x29): ("hardware_jog_rotate", {"deck": 1, "mode": "shift"}),
        (1, 0x29): ("hardware_jog_rotate", {"deck": 2, "mode": "shift"}),
        (0, 0x22): ("hardware_jog_rotate", {"deck": 1, "mode": "scratch"}),
        (1, 0x22): ("hardware_jog_rotate", {"deck": 2, "mode": "scratch"}),
        (0, 0x23): ("hardware_jog_rotate", {"deck": 1, "mode": "pitch"}),
        (1, 0x23): ("hardware_jog_rotate", {"deck": 2, "mode": "pitch"}),
    }

    BUTTONS = {
        (0, 0x0B): ("hardware_button", {"deck": 1, "control": "play"}),
        (1, 0x0B): ("hardware_button", {"deck": 2, "control": "play"}),
        (0, 0x3F): ("hardware_button", {"deck": 1, "control": "shift"}),
        (1, 0x3F): ("hardware_button", {"deck": 2, "control": "shift"}),
        (0, 0x0E): ("hardware_button", {"deck": 1, "control": "shift_play"}),
        (1, 0x0E): ("hardware_button", {"deck": 2, "control": "shift_play"}),
        (0, 0x0C): ("hardware_button", {"deck": 1, "control": "cue"}),
        (1, 0x0C): ("hardware_button", {"deck": 2, "control": "cue"}),
        (0, 0x48): ("hardware_button", {"deck": 1, "control": "shift_cue"}),
        (1, 0x48): ("hardware_button", {"deck": 2, "control": "shift_cue"}),
        (0, 0x10): ("hardware_button", {"deck": 1, "control": "loop_in"}),
        (1, 0x10): ("hardware_button", {"deck": 2, "control": "loop_in"}),
        (0, 0x11): ("hardware_button", {"deck": 1, "control": "loop_out"}),
        (1, 0x11): ("hardware_button", {"deck": 2, "control": "loop_out"}),
        (0, 0x4D): ("hardware_button", {"deck": 1, "control": "loop_4beat"}),
        (1, 0x4D): ("hardware_button", {"deck": 2, "control": "loop_4beat"}),
        (0, 0x50): ("hardware_button", {"deck": 1, "control": "loop_exit"}),
        (1, 0x50): ("hardware_button", {"deck": 2, "control": "loop_exit"}),
        (0, 0x51): ("hardware_button", {"deck": 1, "control": "loop_half"}),
        (1, 0x51): ("hardware_button", {"deck": 2, "control": "loop_half"}),
        (0, 0x53): ("hardware_button", {"deck": 1, "control": "loop_double"}),
        (1, 0x53): ("hardware_button", {"deck": 2, "control": "loop_double"}),
        (0, 0x58): ("hardware_button", {"deck": 1, "control": "sync"}),
        (1, 0x58): ("hardware_button", {"deck": 2, "control": "sync"}),
        (0, 0x54): ("hardware_button", {"deck": 1, "control": "headphone"}),
        (1, 0x54): ("hardware_button", {"deck": 2, "control": "headphone"}),
        (6, 0x19): ("hardware_button", {"control": "headphone_master"}),
        (6, 0x00): ("hardware_button", {"control": "smart_cfx"}),
        (6, 0x08): ("hardware_button", {"control": "smart_cfx_select"}),
        (6, 0x01): ("hardware_button", {"control": "smart_fader"}),
        (6, 0x41): ("hardware_button", {"control": "browser_press"}),
        (6, 0x42): ("hardware_button", {"control": "browser_back"}),
        (6, 0x46): ("hardware_button", {"deck": 1, "control": "load"}),
        (6, 0x47): ("hardware_button", {"deck": 2, "control": "load"}),
        (6, 0x68): ("hardware_button", {"control": "related"}),
        (6, 0x7A): ("hardware_button", {"control": "switch_window"}),
        (4, 0x47): ("hardware_button", {"unit": 1, "control": "fx_toggle"}),
        (5, 0x47): ("hardware_button", {"unit": 2, "control": "fx_toggle"}),
        (4, 0x4A): ("hardware_button", {"unit": 1, "control": "fx_beat_down"}),
        (5, 0x4A): ("hardware_button", {"unit": 2, "control": "fx_beat_down"}),
        (4, 0x4B): ("hardware_button", {"unit": 1, "control": "fx_beat_up"}),
        (5, 0x4B): ("hardware_button", {"unit": 2, "control": "fx_beat_up"}),
        (4, 0x63): ("hardware_button", {"unit": 1, "control": "fx_select_next"}),
        (5, 0x63): ("hardware_button", {"unit": 2, "control": "fx_select_next"}),
        (4, 0x64): ("hardware_button", {"unit": 1, "control": "fx_select_prev"}),
        (5, 0x64): ("hardware_button", {"unit": 2, "control": "fx_select_prev"}),
    }

    PAD_MODES = {
        (0, 0x1B): (1, "hotcue"),
        (1, 0x1B): (2, "hotcue"),
        (0, 0x1E): (1, "padfx1"),
        (1, 0x1E): (2, "padfx1"),
        (0, 0x20): (1, "beatjump"),
        (1, 0x20): (2, "beatjump"),
        (0, 0x6D): (1, "beatloop"),
        (1, 0x6D): (2, "beatloop"),
        (0, 0x22): (1, "sampler"),
        (1, 0x22): (2, "sampler"),
        (0, 0x6B): (1, "padfx2"),
        (1, 0x6B): (2, "padfx2"),
    }

    def __init__(
        self,
        broadcast_fn: Optional[Callable[[dict], None]] = None,
        port_name: str = "DDJ-FLX4",
    ):
        self.broadcast_fn = broadcast_fn or (lambda event: None)
        self.port_name = port_name
        self.port = None
        self.error: Optional[str] = None
        self.messages = 0
        self.decoded_messages = 0
        self.decoded_events = 0
        self.last_at: Optional[float] = None
        self.last_event: Optional[dict] = None
        self._lock = threading.Lock()
        self._hires = {}

    def available_ports(self):
        return list(mido.get_input_names())

    def connect(self) -> Optional[str]:
        if self.port is not None:
            return self.port.name
        names = self.available_ports()
        match = next((name for name in names if isinstance(name, str) and self.port_name.lower() in name.lower()), None)
        if not match:
            self.error = f"{self.port_name} input not found"
            return None
        try:
            self.port = mido.open_input(match, callback=self._handle)
            self.error = None
            return self.port.name
        except Exception as exc:
            self.port = None
            self.error = str(exc)
            return None

    def close(self) -> None:
        if self.port is not None:
            try:
                self.port.close()
            finally:
                self.port = None
        self._hires.clear()

    def status(self) -> dict:
        # Some CoreMIDI backends enumerate a transient device with no port
        # name (None) while a physical controller is connecting/disconnecting.
        # Observing hardware status must never break the entire read-only
        # controller_status endpoint on this non-string entry.
        available = any(
            isinstance(name, str) and self.port_name.lower() in name.lower()
            for name in self.available_ports()
        )
        return {
            "connected": self.port is not None,
            "available": available,
            "port": self.port.name if self.port is not None else None,
            "messages": self.messages,
            "decoded_messages": self.decoded_messages,
            "decoded_events": self.decoded_events,
            "last_at": self.last_at,
            "last_event": dict(self.last_event) if isinstance(self.last_event, dict) else None,
            "error": self.error,
        }

    @staticmethod
    def _pressed(msg) -> bool:
        return msg.type == "note_on" and int(getattr(msg, "velocity", 0)) > 0

    @staticmethod
    def _relative(value: int) -> int:
        value = int(value)
        if value == 64:
            return 0
        return max(-63, min(63, value - 64))

    def _highres_event(self, channel: int, control: int, value: int):
        base = None
        is_lsb = False
        if (channel, control) in self.HIRES:
            base = control
        elif control >= 32 and (channel, control - 32) in self.HIRES:
            base = control - 32
            is_lsb = True
        if base is None:
            return None

        key = (channel, base)
        state = self._hires.setdefault(key, {"msb": None, "lsb": 0, "have_lsb": False})
        if is_lsb:
            state["lsb"] = int(value)
            state["have_lsb"] = True
        else:
            state["msb"] = int(value)

        if state["msb"] is None:
            return None
        if state["have_lsb"]:
            normalized = ((int(state["msb"]) << 7) | int(state["lsb"])) / 16383.0
            precision = "14bit"
        else:
            normalized = int(state["msb"]) / 127.0
            precision = "7bit-msb"
        action, meta = self.HIRES[key]
        return {"action": action, **meta, "value": max(0.0, min(1.0, normalized)), "precision": precision}

    def decode_message(self, msg) -> list[dict]:
        events: list[dict] = []
        if msg.type == "control_change":
            channel = int(msg.channel)
            control = int(msg.control)
            value = int(msg.value)
            highres = self._highres_event(channel, control, value)
            if highres is not None:
                events.append(highres)
                return events
            relative = self.RELATIVE.get((channel, control))
            if relative is not None:
                delta = self._relative(value)
                if delta:
                    action, meta = relative
                    events.append({"action": action, **meta, "delta": delta})
            return events

        if msg.type not in ("note_on", "note_off"):
            return events

        channel = int(msg.channel)
        note = int(msg.note)
        pressed = self._pressed(msg)

        pad_mode = self.PAD_MODES.get((channel, note))
        if pad_mode is not None:
            deck, mode = pad_mode
            events.append({
                "action": "hardware_pad_mode",
                "deck": deck,
                "mode": mode,
                "pressed": pressed,
            })
            return events

        if channel in (0, 1) and note in (0x36, 0x67):
            events.append({
                "action": "hardware_jog_touch",
                "deck": channel + 1,
                "touched": pressed,
                "shifted": note == 0x67,
            })
            return events

        button = self.BUTTONS.get((channel, note))
        if button is not None:
            action, meta = button
            events.append({"action": action, **meta, "pressed": pressed})

        # Performance pads. Channels 7/8 are Deck 1; 9/10 are Deck 2.
        if channel in (7, 8, 9, 10):
            deck = 1 if channel in (7, 8) else 2
            shifted = channel in (8, 10)
            ranges = (
                (0x00, "hotcue"),
                (0x10, "padfx1"),
                (0x20, "beatjump"),
                (0x30, "sampler"),
                (0x50, "padfx2"),
                (0x60, "beatloop"),
            )
            for start, mode in ranges:
                if start <= note <= start + 7:
                    events.append({
                        "action": "hardware_pad",
                        "deck": deck,
                        "pad": note - start,
                        "mode": mode,
                        "shifted": shifted,
                        "pressed": pressed,
                    })
                    break
        return events

    def _handle(self, msg) -> None:
        with self._lock:
            self.messages += 1
            self.last_at = time.time()
            events = self.decode_message(msg)
            if events:
                self.decoded_messages += 1
                self.decoded_events += len(events)
        for event in events:
            event.update({
                "source": "physical_flx4",
                "raw": str(msg),
                "hardware_at": self.last_at,
            })
            with self._lock:
                self.last_event = dict(event)
            self.broadcast_fn(event)
