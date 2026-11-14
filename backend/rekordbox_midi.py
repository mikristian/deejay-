import json
import hashlib
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Dict, Optional

import mido

BASE_DIR = Path(__file__).resolve().parent
MAPPING_PATH = Path(os.environ.get("REKORDBOX_MAPPING", BASE_DIR / "mapping.json"))
TWO_WAY_PROOF_PATH = BASE_DIR / ".cache" / "rekordbox_two_way_proof.json"
_FLX4_HARDWARE_CACHE = {"at": 0.0, "audio_visible": False}
_FLX4_HARDWARE_LOCK = threading.Lock()


def _flx4_usb_audio_visible(ttl: float = 8.0) -> bool:
    """Detect the real FLX4 when macOS exposes it as USB audio, not CoreMIDI.

    DDJ-FLX4 can appear in Audio MIDI Setup/system_profiler as an audio device
    without publishing a normal mido input/output endpoint. Cache this slower
    system_profiler probe because controller status is polled frequently.
    """
    now = time.monotonic()
    with _FLX4_HARDWARE_LOCK:
        if now - float(_FLX4_HARDWARE_CACHE.get("at", 0.0)) < ttl:
            return bool(_FLX4_HARDWARE_CACHE.get("audio_visible"))
        visible = False
        try:
            proc = subprocess.run(
                ["system_profiler", "SPAudioDataType"],
                capture_output=True,
                text=True,
                timeout=4.0,
                check=False,
            )
            text = (proc.stdout or "").lower()
            visible = "ddj-flx4" in text and "alphatheta" in text
        except Exception:
            visible = False
        _FLX4_HARDWARE_CACHE.update({"at": now, "audio_visible": visible})
        return visible

def load_mapping(path: Path = MAPPING_PATH) -> Dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_two_way_proof(path: Path = TWO_WAY_PROOF_PATH) -> Dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _sha256_file(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with Path(path).open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _installed_rekordbox_mapping_path(port_name: str) -> Path:
    return (
        Path.home()
        / "Library/Application Support/Pioneer/rekordbox6/MidiMappings"
        / f"{port_name}.midi.csv"
    )


def _proof_evidence_items(section_name: str, section: Dict):
    """Return evidence entries as (label, path, expected_sha256).

    Supports both the original independent-direction proof schema and the
    newer same-control round-trip schema.
    """
    section = section if isinstance(section, dict) else {}
    items = []

    def add(path_key: str, hash_key: str, label: Optional[str] = None):
        path_value = section.get(path_key)
        expected_hash = section.get(hash_key)
        items.append((label or path_key, path_value, expected_hash))

    if section_name == "command_direction":
        if any(k in section for k in ("baseline", "on_events", "off_events")):
            add("baseline", "baseline_sha256")
            add("on", "on_sha256")
            add("restored", "restored_sha256")
            add("on_events", "on_events_sha256")
            add("off_events", "off_events_sha256")
        else:
            add("before", "before_sha256")
            add("after", "after_sha256")
            add("restored", "restored_sha256")
        return items

    if section_name == "feedback_direction":
        observed = section.get("observed_events")
        if isinstance(observed, list):
            hashes = [section.get("on_events_sha256"), section.get("off_events_sha256")]
            for i, rel in enumerate(observed):
                expected = hashes[i] if i < len(hashes) else None
                items.append((f"observed_events[{i}]", rel, expected))
            # A same-control proof may only need the event files here; if it
            # also includes screenshots, validate them too.
            for path_key, hash_key in (
                ("before", "before_sha256"),
                ("baseline", "baseline_sha256"),
                ("on", "on_sha256"),
                ("restored", "restored_sha256"),
            ):
                if path_key in section or hash_key in section:
                    add(path_key, hash_key)
        else:
            add("observed_events", "events_sha256")
            for path_key, hash_key in (
                ("before", "before_sha256"),
                ("on", "on_sha256"),
                ("restored", "restored_sha256"),
            ):
                if path_key in section or hash_key in section:
                    add(path_key, hash_key)
        return items

    if section_name == "round_trip":
        add("on_events", "on_events_sha256")
        add("off_events", "off_events_sha256")
        return items

    if section_name == "reconnect_validation":
        if "restart_events" in section or "restart_events_sha256" in section:
            add("restart_events", "restart_events_sha256")
            # Optional visual artifacts can still be retained and verified.
            for path_key, hash_key in (
                ("before", "before_sha256"),
                ("after", "after_sha256"),
                ("restored", "restored_sha256"),
                ("midi_setting", "midi_setting_sha256"),
            ):
                if path_key in section or hash_key in section:
                    add(path_key, hash_key)
        else:
            add("before", "before_sha256")
            add("after", "after_sha256")
            add("restored", "restored_sha256")
            add("midi_setting", "midi_setting_sha256")
        return items

    return items


def validate_two_way_proof(
    proof: Dict,
    *,
    port_name: str = "Claude Virtual Controller",
    base_dir: Path = BASE_DIR,
    installed_mapping_path: Optional[Path] = None,
) -> Dict:
    """Validate persisted two-way evidence against the current installed mapping.

    A proof is only accepted while the installed Rekordbox CSV hash and every
    referenced evidence artifact still match the stored SHA-256 values.
    """
    proof = proof if isinstance(proof, dict) else {}
    installed_mapping_path = Path(installed_mapping_path or _installed_rekordbox_mapping_path(port_name))
    expected_mapping_hash = str(proof.get("mapping_sha256") or "").lower()
    actual_mapping_hash = _sha256_file(installed_mapping_path)
    mapping_ok = bool(expected_mapping_hash and actual_mapping_hash == expected_mapping_hash)

    result = {
        "valid": False,
        "mapping_ok": mapping_ok,
        "mapping_path": str(installed_mapping_path),
        "mapping_sha256": actual_mapping_hash,
        "command_ok": False,
        "feedback_ok": False,
        "round_trip_ok": False,
        "reconnect_ok": None,
        "errors": [],
    }
    if not mapping_ok:
        result["errors"].append("installed Rekordbox mapping hash does not match proof")

    for section_name, result_key in (
        ("command_direction", "command_ok"),
        ("feedback_direction", "feedback_ok"),
    ):
        section = proof.get(section_name, {})
        section_ok = bool(section.get("confirmed")) and mapping_ok
        if not section.get("confirmed"):
            result["errors"].append(f"{section_name} is not marked confirmed")
        for label, rel, expected in _proof_evidence_items(section_name, section):
            expected_hash = str(expected or "").lower()
            if not rel or not expected_hash:
                section_ok = False
                result["errors"].append(f"{section_name}.{label} evidence is incomplete")
                continue
            evidence_path = Path(rel)
            if not evidence_path.is_absolute():
                evidence_path = Path(base_dir) / evidence_path
            actual_hash = _sha256_file(evidence_path)
            if actual_hash != expected_hash:
                section_ok = False
                result["errors"].append(f"{section_name}.{label} SHA-256 mismatch")
        result[result_key] = section_ok

    round_trip = proof.get("round_trip")
    if isinstance(round_trip, dict) and round_trip:
        section_ok = bool(round_trip.get("confirmed")) and mapping_ok
        if not round_trip.get("confirmed"):
            result["errors"].append("round_trip is not marked confirmed")
        for label, rel, expected in _proof_evidence_items("round_trip", round_trip):
            expected_hash = str(expected or "").lower()
            if not rel or not expected_hash:
                section_ok = False
                result["errors"].append(f"round_trip.{label} evidence is incomplete")
                continue
            evidence_path = Path(rel)
            if not evidence_path.is_absolute():
                evidence_path = Path(base_dir) / evidence_path
            actual_hash = _sha256_file(evidence_path)
            if actual_hash != expected_hash:
                section_ok = False
                result["errors"].append(f"round_trip.{label} SHA-256 mismatch")
        result["round_trip_ok"] = section_ok
    else:
        result["round_trip_ok"] = True

    reconnect = proof.get("reconnect_validation")
    if isinstance(reconnect, dict) and reconnect:
        section_ok = bool(reconnect.get("confirmed")) and mapping_ok
        if not reconnect.get("confirmed"):
            result["errors"].append("reconnect_validation is not marked confirmed")
        for label, rel, expected in _proof_evidence_items("reconnect_validation", reconnect):
            expected_hash = str(expected or "").lower()
            if not rel or not expected_hash:
                section_ok = False
                result["errors"].append(f"reconnect_validation.{label} evidence is incomplete")
                continue
            evidence_path = Path(rel)
            if not evidence_path.is_absolute():
                evidence_path = Path(base_dir) / evidence_path
            actual_hash = _sha256_file(evidence_path)
            if actual_hash != expected_hash:
                section_ok = False
                result["errors"].append(f"reconnect_validation.{label} SHA-256 mismatch")
        result["reconnect_ok"] = section_ok

    result["valid"] = bool(result["command_ok"] and result["feedback_ok"] and result["round_trip_ok"])
    return result

def _validate_deck(deck: int) -> int:
    if deck not in (1, 2):
        raise ValueError("deck must be 1 or 2")
    return deck

def _validate_unit(value: float, name: str) -> float:
    value = float(value)
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0.0 and 1.0")
    return value

class RekordboxController:
    def __init__(self, broadcast_fn: Optional[Callable[[dict], None]] = None, mapping_path: Path = MAPPING_PATH):
        self.mapping_path = Path(mapping_path)
        self.mapping = load_mapping(self.mapping_path)
        self.broadcast_fn = broadcast_fn or (lambda event: None)
        self._send_lock = threading.Lock()
        self.port = None
        self.feedback_port = None
        self.feedback_error = None
        self.feedback_messages = 0
        self.feedback_last_at = None
        # Deliberately independent from MIDI feedback. Receiving a genuine
        # Rekordbox OUT packet proves Rekordbox -> bridge, but it does not by
        # itself prove that Rekordbox consumed/executed a bridge command.
        self.two_way_proof = load_two_way_proof()
        self.is_virtual = False
        self.port_name = self.mapping.get("port_name", "Claude Virtual Controller")
        self.resolved_port_name = None
        self.two_way_proof_validation = {}
        self._proof_signature = None
        self._apply_two_way_proof_validation()

    @property
    def verified(self) -> bool:
        return bool(self.mapping.get("verified"))

    def refresh_mapping(self) -> None:
        self.mapping = load_mapping(self.mapping_path)
        self.port_name = self.mapping.get("port_name", self.port_name)
        self._refresh_two_way_proof_if_changed(force=True)

    def _proof_signature_for(self, proof: Optional[Dict] = None):
        proof = proof if isinstance(proof, dict) else self.two_way_proof
        paths = [TWO_WAY_PROOF_PATH, _installed_rekordbox_mapping_path(self.port_name)]
        for section_name in ("command_direction", "feedback_direction", "round_trip", "reconnect_validation"):
            section = proof.get(section_name, {}) if isinstance(proof, dict) else {}
            for _, rel, _ in _proof_evidence_items(section_name, section):
                if not rel:
                    continue
                rels = rel if isinstance(rel, list) else [rel]
                for rel_item in rels:
                    if not isinstance(rel_item, (str, os.PathLike)):
                        continue
                    p = Path(rel_item)
                    if not p.is_absolute():
                        p = BASE_DIR / p
                    paths.append(p)
        signature = []
        for p in paths:
            try:
                st = Path(p).stat()
                signature.append((str(p), st.st_mtime_ns, st.st_size))
            except Exception:
                signature.append((str(p), None, None))
        return tuple(signature)

    def _apply_two_way_proof_validation(self) -> None:
        validation = validate_two_way_proof(
            self.two_way_proof,
            port_name=self.port_name,
            base_dir=BASE_DIR,
        )
        self.two_way_proof_validation = validation
        command_proof = self.two_way_proof.get("command_direction", {})
        self.control_execution_confirmed = bool(validation.get("command_ok"))
        self.control_execution_evidence = command_proof.get("summary") if self.control_execution_confirmed else None
        self.feedback_direction_confirmed = bool(validation.get("feedback_ok"))
        self._proof_signature = self._proof_signature_for(self.two_way_proof)

    def _refresh_two_way_proof_if_changed(self, force: bool = False) -> None:
        current_signature = self._proof_signature_for(self.two_way_proof)
        if not force and self._proof_signature == current_signature:
            return
        self.two_way_proof = load_two_way_proof()
        self._apply_two_way_proof_validation()

    def available_ports(self):
        return list(mido.get_output_names())

    def connect(self) -> str:
        self.refresh_mapping()
        if self.port is not None:
            self.resolved_port_name = self.port.name
            return self.port.name
        if self.mapping.get("virtual_port", True):
            self.port = mido.open_output(self.port_name, virtual=True)
            self.is_virtual = True
            self.resolved_port_name = self.port.name
            self.connect_feedback()
            return self.port.name
        available = self.available_ports()
        match = next((p for p in available if self.port_name in p), None)
        if not match:
            raise RuntimeError(f"MIDI port '{self.port_name}' not found. Available outputs: {available}")
        self.port = mido.open_output(match)
        self.is_virtual = False
        self.resolved_port_name = match
        self.connect_feedback()
        return match

    def connect_feedback(self) -> Optional[str]:
        """Create a passive virtual destination for Rekordbox controller feedback."""
        if self.feedback_port is not None:
            return self.feedback_port.name
        try:
            self.feedback_port = mido.open_input(
                self.port_name,
                virtual=True,
                callback=self._handle_feedback,
            )
            self.feedback_error = None
            return self.feedback_port.name
        except Exception as exc:
            self.feedback_port = None
            self.feedback_error = str(exc)
            return None

    def _handle_feedback(self, msg) -> None:
        self.feedback_messages += 1
        self.feedback_last_at = time.time()
        event = {
            "action": "midi_feedback",
            "type": msg.type,
            "channel": int(getattr(msg, "channel", -1)),
            "raw": str(msg),
        }
        if hasattr(msg, "note"):
            event["note"] = int(msg.note)
        if hasattr(msg, "velocity"):
            event["velocity"] = int(msg.velocity)
        if hasattr(msg, "control"):
            event["control"] = int(msg.control)
        if hasattr(msg, "value"):
            event["value"] = int(msg.value)

        if msg.type in ("note_on", "note_off"):
            on = msg.type == "note_on" and int(getattr(msg, "velocity", 0)) > 0
            channel = int(getattr(msg, "channel", -1))
            note = int(getattr(msg, "note", -1))
            if channel == 15 and note in (0, 1):
                event.update({"action": "feedback_loaded", "deck": note + 1, "on": on})
            elif channel == 15 and note in (4, 5):
                event.update({"action": "feedback_loop", "deck": note - 3, "on": on})
            elif channel in (0, 1) and note == 0x17:
                event.update({"action": "feedback_vinyl", "deck": channel + 1, "on": on})
            elif channel in (0, 1) and note == 0x0B:
                event.update({"action": "feedback_play", "deck": channel + 1, "on": on})
            elif channel in (0, 1) and note == 0x0C:
                event.update({"action": "feedback_cue", "deck": channel + 1, "on": on})
            elif channel in (0, 1) and note == 0x58:
                event.update({"action": "feedback_sync", "deck": channel + 1, "on": on})
            elif channel in (0, 1) and note == 0x54:
                event.update({"action": "feedback_headphone", "deck": channel + 1, "on": on})
            elif channel in (0, 1) and note == 0x1B:
                event.update({"action": "feedback_hotcue_mode", "deck": channel + 1, "on": on})
            elif channel in (7, 9) and 0 <= note <= 7:
                event.update({"action": "feedback_hotcue_pad", "deck": 1 if channel == 7 else 2, "pad": note, "on": on})
            elif channel == 6 and note == 0x00:
                event.update({"action": "feedback_smart_cfx", "on": on})
            elif channel == 6 and note == 0x01:
                event.update({"action": "feedback_smart_fader", "on": on})
            elif channel == 4 and note == 0x47:
                event.update({"action": "feedback_fx_on", "unit": 1, "on": on})
            elif channel == 5 and note == 0x47:
                event.update({"action": "feedback_fx_on", "unit": 2, "on": on})

        elif msg.type == "control_change":
            channel = int(getattr(msg, "channel", -1))
            control = int(getattr(msg, "control", -1))
            value = int(getattr(msg, "value", 0))
            if channel in (0, 1) and control == 0x02:
                event.update({"action": "feedback_channel_level", "deck": channel + 1, "value": value / 127.0})

        self.broadcast_fn(event)

    def close(self) -> None:
        if self.feedback_port is not None:
            try:
                self.feedback_port.close()
            finally:
                self.feedback_port = None
        if self.port is not None:
            try:
                self.port.close()
            finally:
                self.port = None
                self.resolved_port_name = None

    def status(self) -> dict:
        self._refresh_two_way_proof_if_changed()
        outputs = self.available_ports()
        inputs = list(mido.get_input_names())
        matching = next((p for p in outputs if self.port_name in p), None)
        def is_bridge(name: str) -> bool:
            return self.port_name.lower() in str(name).lower()

        physical_inputs = [p for p in inputs if not is_bridge(p)]
        physical_outputs = [p for p in outputs if not is_bridge(p)]
        flx4_midi_visible = any(
            token in str(name).lower()
            for name in physical_inputs + physical_outputs
            for token in ("ddj-flx4", "flx4")
        )
        flx4_audio_visible = _flx4_usb_audio_visible()
        flx4_visible = bool(flx4_midi_visible or flx4_audio_visible)
        try:
            rekordbox_running = subprocess.run(
                ["pgrep", "-f", "rekordbox.app/Contents/MacOS/rekordbox"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode == 0
        except Exception:
            rekordbox_running = False
        tx_port_open = self.port is not None
        feedback_live = self.feedback_messages > 0
        two_way_verified = bool(self.control_execution_confirmed and self.feedback_direction_confirmed)
        two_way_live = bool(two_way_verified and feedback_live and rekordbox_running)
        return {
            "mapping_path": str(self.mapping_path),
            "mapping_verified": self.verified,
            "requested_port": self.port_name,
            "virtual_port": bool(self.mapping.get("virtual_port", True)),
            # Backward-compatible alias. `connected` means the CoreMIDI TX
            # port is open; it does NOT prove rekordbox consumed the message.
            "connected": tx_port_open,
            "tx_port_open": tx_port_open,
            "resolved_port": self.resolved_port_name or (self.port.name if self.port is not None else None),
            "feedback_connected": self.feedback_port is not None,
            "feedback_port": self.feedback_port.name if self.feedback_port is not None else None,
            "feedback_error": self.feedback_error,
            "feedback_messages": self.feedback_messages,
            "feedback_last_at": self.feedback_last_at,
            "rekordbox_midi_feedback_live": feedback_live,
            "rekordbox_feedback_direction_confirmed": self.feedback_direction_confirmed,
            "rekordbox_control_execution_confirmed": self.control_execution_confirmed,
            "rekordbox_control_execution_evidence": self.control_execution_evidence,
            "rekordbox_two_way_verified": two_way_verified,
            "rekordbox_two_way_live": two_way_live,
            "rekordbox_two_way_proof": self.two_way_proof if two_way_verified else None,
            "rekordbox_two_way_proof_validation": self.two_way_proof_validation,
            "is_virtual": self.is_virtual,
            "matching_output": matching,
            "available_inputs": inputs,
            "available_outputs": outputs,
            "physical_midi_inputs": physical_inputs,
            "physical_midi_outputs": physical_outputs,
            "physical_flx4_midi_visible": flx4_midi_visible,
            "physical_flx4_audio_visible": flx4_audio_visible,
            "physical_flx4_visible": flx4_visible,
            "rekordbox_running": rekordbox_running,
            "feedback_capability": (
                "live" if feedback_live else
                "armed_no_messages" if self.feedback_port is not None and rekordbox_running else
                "armed_rekordbox_offline" if self.feedback_port is not None else
                "unavailable"
            ),
        }

    def _ensure_live(self) -> None:
        if not self.verified:
            raise RuntimeError('MIDI mapping is not verified. Complete Rekordbox MIDI Learn, update mapping.json, then set "verified": true.')
        if self.port is None:
            self.connect()

    def _note(self, spec: dict) -> None:
        self._ensure_live()
        note = int(spec["num"])
        channel = int(spec.get("channel", 0))
        if not 0 <= note <= 127:
            raise ValueError("MIDI note must be 0-127")
        with self._send_lock:
            self.port.send(mido.Message("note_on", note=note, velocity=127, channel=channel))
            time.sleep(0.03)
            self.port.send(mido.Message("note_off", note=note, velocity=0, channel=channel))

    def _note_state(self, spec: dict, on: bool) -> None:
        self._ensure_live()
        note = int(spec["num"])
        channel = int(spec.get("channel", 0))
        with self._send_lock:
            self.port.send(mido.Message("note_on" if on else "note_off", note=note, velocity=127 if on else 0, channel=channel))

    def _cc(self, spec: dict, value_0_1: float) -> None:
        self._ensure_live()
        value_0_1 = _validate_unit(value_0_1, "value")
        control = int(spec["num"])
        channel = int(spec.get("channel", 0))
        if not 0 <= control <= 127:
            raise ValueError("MIDI CC must be 0-127")
        value = int(round(value_0_1 * 127))
        with self._send_lock:
            self.port.send(mido.Message("control_change", control=control, value=value, channel=channel))

    def play(self, deck: int) -> None:
        deck = _validate_deck(deck)
        self._note(self.mapping["play"][str(deck)])
        self.broadcast_fn({"action": "play", "deck": deck})

    def cue(self, deck: int) -> None:
        deck = _validate_deck(deck)
        self._note(self.mapping["cue"][str(deck)])
        self.broadcast_fn({"action": "cue", "deck": deck})

    def set_crossfader(self, position: float) -> None:
        position = _validate_unit(position, "position")
        self._cc(self.mapping["crossfader"], position)
        self.broadcast_fn({"action": "crossfader", "value": position})

    def set_channel_fader(self, deck: int, level: float) -> None:
        deck = _validate_deck(deck)
        level = _validate_unit(level, "level")
        self._cc(self.mapping["channel_fader"][str(deck)], level)
        self.broadcast_fn({"action": "channel_fader", "deck": deck, "value": level})

    def set_tempo(self, deck: int, level: float) -> None:
        deck = _validate_deck(deck)
        level = _validate_unit(level, "level")
        self._cc(self.mapping["tempo"][str(deck)], level)
        self.broadcast_fn({"action": "tempo", "deck": deck, "value": level})

    def deck_button(self, deck: int, control: str) -> None:
        deck = _validate_deck(deck)
        control = str(control).lower()
        allowed = {"jump_start", "loop_in", "loop_out", "four_beat", "loop_half", "loop_double", "sync"}
        if control not in allowed:
            raise ValueError(f"control must be one of {sorted(allowed)}")
        self._note(self.mapping["deck_buttons"][str(deck)][control])
        self.broadcast_fn({"action": "deck_button", "deck": deck, "control": control})

    def jog_touch(self, deck: int, touched: bool) -> None:
        deck = _validate_deck(deck)
        self._note_state(self.mapping["jog"][str(deck)]["touch"], bool(touched))
        self.broadcast_fn({"action": "jog_touch", "deck": deck, "touched": bool(touched)})

    def jog_rotate(self, deck: int, delta: int, mode: str = "scratch") -> None:
        deck = _validate_deck(deck)
        mode = str(mode).lower()
        if mode not in ("scratch", "pitch"):
            raise ValueError("mode must be 'scratch' or 'pitch'")
        delta = max(-63, min(63, int(delta)))
        if delta == 0:
            return
        spec = self.mapping["jog"][str(deck)][mode]
        self._ensure_live()
        value = max(1, min(127, 64 + delta))
        with self._send_lock:
            self.port.send(mido.Message("control_change", control=int(spec["num"]), value=value, channel=int(spec.get("channel", 0))))
        self.broadcast_fn({"action": "jog_rotate", "deck": deck, "mode": mode, "delta": delta})

    def browser_rotate(self, delta: int) -> None:
        delta = max(-63, min(63, int(delta)))
        if delta == 0:
            return
        spec = self.mapping["browser"]["browse"]
        self._ensure_live()
        value = max(1, min(127, 64 + delta))
        with self._send_lock:
            self.port.send(mido.Message("control_change", control=int(spec["num"]), value=value, channel=int(spec.get("channel", 0))))
        self.broadcast_fn({"action": "browser_rotate", "delta": delta})

    def browser_press(self) -> None:
        self._note(self.mapping["browser"]["press"])
        self.broadcast_fn({"action": "browser_press"})

    def browser_back(self) -> None:
        self._note(self.mapping["browser"]["back"])
        self.broadcast_fn({"action": "browser_back"})

    def browser_load(self, deck: int) -> None:
        deck = _validate_deck(deck)
        self._note(self.mapping["browser"]["load"][str(deck)])
        self.broadcast_fn({"action": "browser_load", "deck": deck})

    def browser_related(self) -> None:
        self._note(self.mapping["browser"]["related"])
        self.broadcast_fn({"action": "browser_related"})

    def browser_switch_window(self) -> None:
        self._note(self.mapping["browser"]["switch_window"])
        self.broadcast_fn({"action": "browser_switch_window"})

    def set_eq(self, deck: int, band: str, level: float) -> None:
        deck = _validate_deck(deck)
        band = str(band).lower()
        if band not in ("low", "mid", "high"):
            raise ValueError("band must be 'low', 'mid', or 'high'")
        level = _validate_unit(level, "level")
        self._cc(self.mapping["eq"][str(deck)][band], level)
        self.broadcast_fn({"action": "eq", "deck": deck, "band": band, "value": level})

    def set_cfx(self, deck: int, level: float) -> None:
        deck = _validate_deck(deck)
        level = _validate_unit(level, "level")
        self._cc(self.mapping["cfx"][str(deck)], level)
        self.broadcast_fn({"action": "cfx", "deck": deck, "value": level})

    def smart_cfx_toggle(self) -> None:
        self._note(self.mapping["smart_cfx"]["toggle"])
        self.broadcast_fn({"action": "smart_cfx"})

    def smart_cfx_select(self) -> None:
        self._note(self.mapping["smart_cfx"]["select"])
        self.broadcast_fn({"action": "smart_cfx_select"})

    def smart_fader_toggle(self) -> None:
        self._note(self.mapping["smart_fader"])
        self.broadcast_fn({"action": "smart_fader"})

    def fx_select(self, unit: int = 1, direction: int = 1) -> None:
        if unit not in (1, 2):
            raise ValueError("unit must be 1 or 2")
        direction = 1 if int(direction) >= 0 else -1
        key = "next" if direction > 0 else "previous"
        self._note(self.mapping["beat_fx"][str(unit)][key])
        self.broadcast_fn({"action": "fx_select", "unit": unit, "direction": direction})

    def fx_beat(self, unit: int = 1, direction: int = 1) -> None:
        if unit not in (1, 2):
            raise ValueError("unit must be 1 or 2")
        direction = 1 if int(direction) >= 0 else -1
        key = "up" if direction > 0 else "down"
        self._note(self.mapping["beat_fx"][str(unit)][f"beat_{key}"])
        self.broadcast_fn({"action": "fx_beat", "unit": unit, "direction": direction})

    def fx_level(self, unit: int = 1, level: float = 0.5) -> None:
        if unit not in (1, 2):
            raise ValueError("unit must be 1 or 2")
        level = _validate_unit(level, "level")
        self._cc(self.mapping["beat_fx"][str(unit)]["level"], level)
        self.broadcast_fn({"action": "fx_level", "unit": unit, "value": level})

    def fx_toggle(self, unit: int = 1) -> None:
        if unit not in (1, 2):
            raise ValueError("unit must be 1 or 2")
        self._note(self.mapping["beat_fx"][str(unit)]["toggle"])
        self.broadcast_fn({"action": "fx_toggle", "unit": unit})

    def trigger_pad(self, deck: int, pad: int) -> None:
        deck = _validate_deck(deck)
        pad = int(pad)
        if not 0 <= pad <= 15:
            raise ValueError("pad must be 0-15")
        spec = self.mapping["pads"][str(deck)][pad]
        if isinstance(spec, int):
            spec = {"num": spec, "channel": 0}
        self._note(spec)
        self.broadcast_fn({"action": "pad", "deck": deck, "pad": pad})

    def trigger_performance_pad(self, deck: int, mode: str, pad: int) -> None:
        deck = _validate_deck(deck)
        mode = str(mode).lower()
        if mode not in self.mapping.get("pad_modes", {}):
            raise ValueError("mode must be hotcue, padfx1, beatjump, beatloop, or sampler")
        pad = int(pad)
        if not 0 <= pad <= 7:
            raise ValueError("performance pad must be 0-7")
        spec = self.mapping["pad_modes"][mode][str(deck)][pad]
        self._note(spec)
        self.broadcast_fn({"action": "performance_pad", "deck": deck, "mode": mode, "pad": pad})

if __name__ == "__main__":
    rb = RekordboxController()
    print(json.dumps(rb.status(), indent=2))
