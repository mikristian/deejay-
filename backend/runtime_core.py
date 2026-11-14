"""Persistent Rekordbox dashboard/MIDI runtime.

This process owns the single CoreMIDI virtual source and stays alive independently
of Claude's MCP stdio lifecycle. Browser and MCP clients both send commands to
the same WebSocket hub, so there is only one MIDI/OSC state owner.
"""
from __future__ import annotations

import asyncio
import copy
import fcntl
import json
import os
from pathlib import Path
import socket
import threading
import time
from typing import Optional

from dashboard_hub import DashboardHub
from dashboard_http import start_dashboard_http_server
from deck_registry import get_assignment, invalidate_assignment, snapshot as deck_registry_snapshot
from flx4_physical import FLX4PhysicalMonitor
from osc_bridge import send_event_as_osc, send_semantic_cue
from rekordbox_midi import RekordboxController

hub = DashboardHub()
_controller_instance: Optional[RekordboxController] = None
_physical_monitor_instance: Optional[FLX4PhysicalMonitor] = None
_command_lock = threading.RLock()
_runtime_lock_handle = None
_expected_load_until = {"1": 0.0, "2": 0.0}
_rekordbox_attach_state = {
    "attempted": False,
    "success": False,
    "result": "not_attempted",
    "error": None,
    "attempted_at": None,
}
_runtime_state = {
    "playing": {"1": False, "2": False},
    "crossfader": 0.5,
    "channel_fader": {"1": 0.78, "2": 0.78},
    "tempo": {"1": 0.5, "2": 0.5},
    "eq": {
        "1": {"high": 0.5, "mid": 0.5, "low": 0.5},
        "2": {"high": 0.5, "mid": 0.5, "low": 0.5},
    },
    "cfx": {"1": 0.5, "2": 0.5},
    "fx_level": {"1": 0.5, "2": 0.5},
    "fx_on": {"1": False, "2": False},
    "smart_cfx": False,
    "smart_fader": False,
    "semantic_cue": "LIVE CONTROLLER",
    "feedback_loaded": {"1": False, "2": False},
    "feedback_loop": {"1": False, "2": False},
    "feedback_vinyl": {"1": False, "2": False},
    "feedback_play": {"1": False, "2": False},
    "feedback_cue": {"1": False, "2": False},
    "feedback_sync": {"1": False, "2": False},
    "feedback_headphone": {"1": False, "2": False},
    "feedback_hotcue_mode": {"1": False, "2": False},
    "feedback_hotcue_pad": {"1": [False] * 8, "2": [False] * 8},
    "feedback_channel_level": {"1": 0.0, "2": 0.0},
    "feedback_smart_cfx": False,
    "feedback_smart_fader": False,
    "feedback_fx_on": {"1": False, "2": False},
    "feedback_event_counts": {},
    "last_feedback_event": None,
}

_ai_dj_lock = threading.RLock()
_ai_dj_abort_event = threading.Event()
_ai_dj_manual_takeover_event = threading.Event()
_ai_dj_worker: Optional[threading.Thread] = None
_ai_dj_autopilot_stop_event = threading.Event()
_ai_dj_autopilot_worker: Optional[threading.Thread] = None
_AI_DJ_STATE_PATH = Path(__file__).resolve().parent / ".cache" / "ai_dj_session.json"
_ai_dj_persistence_enabled = False
_ai_dj_state = {
    "active": False,
    "phase": "idle",
    "current_deck": None,
    "current_track_id": None,
    "current_effective_bpm": None,
    "silent_rehearsal": False,
    "current_started_monotonic": None,
    "current_started_at": None,
    "incoming_deck": None,
    "incoming_track_id": None,
    "incoming_started_monotonic": None,
    "recipe": None,
    "last_error": None,
    "manual_takeover_required": False,
    "last_manual_event": None,
    "autopilot_active": False,
    "autopilot_phase": "idle",
    "set_plan": None,
    "set_index": None,
    "set_length": 0,
    "set_next_track_id": None,
    "set_started_at": None,
    "set_completed_at": None,
    "last_load_result": None,
    "transport_probe": None,
    "incoming_transport_probe": None,
    "recovery_checkpoint": None,
    "updated_at": time.time(),
}


def _persist_ai_dj_state() -> None:
    if not _ai_dj_persistence_enabled:
        return
    try:
        _AI_DJ_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _ai_dj_lock:
            payload = copy.deepcopy(_ai_dj_state)
        tmp = _AI_DJ_STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, _AI_DJ_STATE_PATH)
    except Exception:
        # Persistence is a reliability aid; never crash live MIDI control over
        # a checkpoint write failure.
        pass


def _restore_ai_dj_checkpoint_on_startup() -> None:
    if not _AI_DJ_STATE_PATH.is_file():
        return
    try:
        checkpoint = json.loads(_AI_DJ_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(checkpoint, dict):
        return
    was_active = bool(checkpoint.get("active") or checkpoint.get("autopilot_active"))
    phase = str(checkpoint.get("phase") or "idle")
    risky_phase = phase not in {"idle", "complete", "stopped"}
    if not (was_active or risky_phase):
        return
    with _ai_dj_lock:
        _ai_dj_state.update({
            "active": False,
            "phase": "recovery_required",
            "current_deck": checkpoint.get("current_deck"),
            "current_track_id": checkpoint.get("current_track_id"),
            "current_effective_bpm": checkpoint.get("current_effective_bpm"),
            "silent_rehearsal": bool(checkpoint.get("silent_rehearsal")),
            "current_started_monotonic": None,
            "current_started_at": checkpoint.get("current_started_at"),
            "incoming_deck": checkpoint.get("incoming_deck"),
            "incoming_track_id": checkpoint.get("incoming_track_id"),
            "incoming_started_monotonic": None,
            "recipe": copy.deepcopy(checkpoint.get("recipe")),
            "last_error": "Runtime restarted during an active AI-DJ session; automation was not resumed automatically.",
            "manual_takeover_required": True,
            "last_manual_event": None,
            "autopilot_active": False,
            "autopilot_phase": "recovery_required" if checkpoint.get("autopilot_active") else "idle",
            "set_plan": copy.deepcopy(checkpoint.get("set_plan")),
            "set_index": checkpoint.get("set_index"),
            "set_length": int(checkpoint.get("set_length") or 0),
            "set_next_track_id": checkpoint.get("set_next_track_id"),
            "set_started_at": checkpoint.get("set_started_at"),
            "set_completed_at": checkpoint.get("set_completed_at"),
            "last_load_result": copy.deepcopy(checkpoint.get("last_load_result")),
            "transport_probe": copy.deepcopy(checkpoint.get("transport_probe")),
            "incoming_transport_probe": copy.deepcopy(checkpoint.get("incoming_transport_probe")),
            "recovery_checkpoint": checkpoint,
            "updated_at": time.time(),
        })
    _persist_ai_dj_state()


def _ai_dj_snapshot() -> dict:
    with _ai_dj_lock:
        state = copy.deepcopy(_ai_dj_state)
        started = state.get("current_started_monotonic")
        state["current_elapsed_sec"] = (
            max(0.0, time.monotonic() - float(started)) if state.get("active") and started is not None else None
        )
        worker = _ai_dj_worker
        state["worker_alive"] = bool(worker is not None and worker.is_alive())
        auto_worker = _ai_dj_autopilot_worker
        state["autopilot_worker_alive"] = bool(auto_worker is not None and auto_worker.is_alive())
        return state


def _ai_dj_set(**updates) -> None:
    with _ai_dj_lock:
        _ai_dj_state.update(updates)
        _ai_dj_state["updated_at"] = time.time()
    _persist_ai_dj_state()


def _ai_dj_wait_until(started_monotonic: float, target_elapsed: float) -> bool:
    while True:
        if _ai_dj_abort_event.is_set():
            return False
        remaining = float(target_elapsed) - (time.monotonic() - float(started_monotonic))
        if remaining <= 0:
            return True
        time.sleep(min(0.05, max(0.01, remaining)))


def _ai_dj_classify_play_samples(samples: list[bool]) -> dict:
    values = [bool(x) for x in samples]
    if not values:
        return {"mode": "unknown", "playing": False, "on_ratio": 0.0, "samples": values}
    ratio = sum(1 for x in values if x) / len(values)
    if ratio >= 0.94:
        mode = "playing"
        playing = True
    elif ratio <= 0.06:
        mode = "paused_off"
        playing = False
    else:
        # FLX4/Rekordbox blinks the Play/Pause LED while paused. A live deck
        # holds the Play LED steadily on, so mixed samples are paused.
        mode = "paused_blinking"
        playing = False
    return {"mode": mode, "playing": playing, "on_ratio": ratio, "samples": values}


def _ai_dj_transport_probe(deck: int, samples: int = 16, interval: float = 0.05) -> dict:
    observed = []
    for _ in range(max(8, int(samples))):
        observed.append(bool(_runtime_state.get("feedback_play", {}).get(str(int(deck)))))
        time.sleep(max(0.02, float(interval)))
    return _ai_dj_classify_play_samples(observed)


def _ai_dj_start_transport_verified(rb: RekordboxController, deck: int, verify_feedback: bool = True) -> tuple[float, dict]:
    """Jump to track start, start transport and prove the target deck is live.

    Returns the monotonic timestamp corresponding to the successful Play
    command plus the feedback probe. A second Play attempt is permitted only
    when the first probe classifies the deck as paused; faders remain muted
    while this happens.
    """
    deck = int(deck)
    last_probe = {"mode": "unverified", "playing": False, "on_ratio": 0.0, "samples": []}
    for attempt in range(2):
        rb.deck_button(deck, "jump_start")
        time.sleep(0.05)
        rb.play(deck)
        started = time.monotonic()
        if not verify_feedback:
            return started, {**last_probe, "mode": "not_required", "attempts": attempt + 1}
        time.sleep(0.10)
        last_probe = _ai_dj_transport_probe(deck)
        last_probe["attempts"] = attempt + 1
        if last_probe.get("playing"):
            return started, last_probe
    try:
        rb.cue(deck)
    except Exception:
        pass
    raise RuntimeError(
        f"Deck {deck} transport did not enter a verified playing state after 2 attempts: {last_probe}"
    )


def _ai_dj_start_session(
    rb: RekordboxController,
    track_id: str,
    deck: int,
    bpm: float | None = None,
    silent_rehearsal: bool = False,
) -> dict:
    global _ai_dj_worker
    deck = int(deck)
    if deck not in (1, 2):
        raise ValueError("deck must be 1 or 2")
    status = rb.status()
    if not status.get("rekordbox_two_way_verified"):
        raise RuntimeError("AI-DJ session requires verified two-way Rekordbox control")
    if _ai_dj_persistence_enabled:
        assignment = get_assignment(deck)
        if not assignment or str(assignment.get("track_id") or "") != str(track_id):
            raise RuntimeError(
                f"Deck {deck} identity is not verified for track {track_id}; run the safe AI-DJ loader first"
            )
    with _ai_dj_lock:
        if _ai_dj_state.get("phase") == "recovery_required" or _ai_dj_state.get("manual_takeover_required"):
            raise RuntimeError("AI-DJ recovery is required; call ai_dj_stop_session before starting a new session")
        if _ai_dj_state.get("active"):
            raise RuntimeError("AI-DJ session is already active")
        if _ai_dj_worker is not None and _ai_dj_worker.is_alive():
            raise RuntimeError("AI-DJ transition worker is still active")
    other = 2 if deck == 1 else 1
    side = 0.0 if deck == 1 else 1.0
    silent_rehearsal = bool(silent_rehearsal)
    _ai_dj_abort_event.clear()
    _ai_dj_manual_takeover_event.clear()
    rb.set_crossfader(side)
    # Keep both decks muted until the requested transport is independently
    # confirmed from genuine Rekordbox feedback.
    rb.set_channel_fader(deck, 0.0)
    rb.set_channel_fader(other, 0.0)
    verify_feedback = bool(status.get("feedback_connected") or status.get("rekordbox_midi_feedback_live"))
    started, transport_probe = _ai_dj_start_transport_verified(rb, deck, verify_feedback=verify_feedback)
    if not silent_rehearsal:
        rb.set_channel_fader(deck, 1.0)
    _ai_dj_set(
        active=True,
        phase="running",
        current_deck=deck,
        current_track_id=str(track_id),
        current_effective_bpm=float(bpm) if bpm is not None else None,
        silent_rehearsal=silent_rehearsal,
        current_started_monotonic=started,
        current_started_at=time.time() - max(0.0, time.monotonic() - started),
        incoming_deck=None,
        incoming_track_id=None,
        incoming_started_monotonic=None,
        recipe=None,
        last_error=None,
        manual_takeover_required=False,
        last_manual_event=None,
        transport_probe=copy.deepcopy(transport_probe),
    )
    _broadcast_everywhere({"action": "ai_dj_session_started", "deck": deck, "track_id": str(track_id)})
    return _ai_dj_snapshot()


def _ai_dj_transition_worker_fn(rb: RekordboxController, recipe: dict) -> None:
    outgoing = int(recipe["outgoing_deck"])
    incoming = int(recipe["incoming_deck"])
    phrase = recipe["phrase"]
    mixer = recipe["mixer"]
    incoming_started = False
    fade_started = False
    incoming_started_mono = None
    try:
        with _ai_dj_lock:
            outgoing_started = float(_ai_dj_state["current_started_monotonic"])
        if not _ai_dj_wait_until(outgoing_started, float(phrase["incoming_play_at_outgoing_sec"])):
            raise InterruptedError("AI-DJ transition aborted before incoming pre-roll")

        # Incoming deck remains inaudible because the crossfader is still fully
        # on the outgoing side. Beat Sync is enabled only if Rekordbox does not
        # already report it active.
        if not bool(_runtime_state.get("feedback_sync", {}).get(str(incoming))):
            rb.deck_button(incoming, "sync")
            time.sleep(0.06)
        status = rb.status()
        verify_feedback = bool(status.get("feedback_connected") or status.get("rekordbox_midi_feedback_live"))
        # Start from the planner's actual incoming phrase/cue, not from 00:00.
        # The old implementation jumped to track start and merely *waited* the
        # amount of the cue offset. That made the phrase math look correct in
        # state while the audible song was ~30-45 seconds behind it.
        hot_cue = recipe.get("source_plan", {}).get("suggestion", {}).get("to_hot_cue")
        if hot_cue and hot_cue.get("hot_cue") and hot_cue.get("slot") is not None:
            slot = int(hot_cue["slot"])
            if not 1 <= slot <= 8:
                raise RuntimeError(f"Incoming hot-cue slot {slot} is outside FLX4 pads 1-8")
            rb.trigger_performance_pad(incoming, "hotcue", slot - 1)
            time.sleep(0.08)
            # Hot cues can start transport immediately. Only press Play if the
            # genuine Rekordbox indicator says the deck is still paused.
            incoming_probe = _ai_dj_transport_probe(incoming, samples=10, interval=0.04) if verify_feedback else {"mode": "not_required", "playing": True}
            if incoming_probe.get("playing"):
                incoming_started_mono = time.monotonic()
            else:
                rb.play(incoming)
                incoming_started_mono = time.monotonic()
                incoming_probe = _ai_dj_transport_probe(incoming, samples=12, interval=0.04) if verify_feedback else {"mode": "not_required", "playing": True}
                if verify_feedback and not incoming_probe.get("playing"):
                    raise RuntimeError(f"Incoming deck {incoming} did not start from hot cue {slot}")
        else:
            incoming_started_mono, incoming_probe = _ai_dj_start_transport_verified(
                rb, incoming, verify_feedback=verify_feedback
            )
        incoming_started = True
        _ai_dj_set(
            phase="preroll",
            incoming_started_monotonic=incoming_started_mono,
            incoming_transport_probe=copy.deepcopy(incoming_probe),
        )
        _broadcast_everywhere({
            "action": "ai_dj_preroll_started",
            "deck": incoming,
            "track_id": str(recipe["to"]["id"]),
        })

        if not _ai_dj_wait_until(outgoing_started, float(phrase["mix_start_outgoing_sec"])):
            raise InterruptedError("AI-DJ transition aborted before crossfade")
        fade_started = True
        _ai_dj_set(phase="crossfading")
        _broadcast_everywhere({"action": "ai_dj_crossfade_started", "recipe": recipe})

        start_side = float(mixer["outgoing_crossfader"])
        end_side = float(mixer["incoming_crossfader"])
        duration = max(0.5, float(phrase["duration_sec"]))
        steps = max(8, int(mixer.get("crossfade_steps", 32)))
        fade_start_mono = time.monotonic()
        for index in range(1, steps + 1):
            if _ai_dj_abort_event.is_set():
                raise InterruptedError("AI-DJ transition aborted during crossfade")
            target_mono = fade_start_mono + duration * index / steps
            while True:
                remaining = target_mono - time.monotonic()
                if remaining <= 0:
                    break
                if _ai_dj_abort_event.is_set():
                    raise InterruptedError("AI-DJ transition aborted during crossfade")
                time.sleep(min(0.04, remaining))
            value = start_side + (end_side - start_side) * index / steps
            rb.set_crossfader(value)

        rb.set_crossfader(end_side)
        rb.set_channel_fader(outgoing, float(mixer.get("outgoing_channel_fader_after", 0.0)))
        rb.cue(outgoing)
        _ai_dj_set(
            active=True,
            phase="running",
            current_deck=incoming,
            current_track_id=str(recipe["to"]["id"]),
            current_effective_bpm=float(recipe.get("tempo", {}).get("effective_bpm") or 0.0) or None,
            current_started_monotonic=incoming_started_mono,
            current_started_at=time.time() - max(0.0, time.monotonic() - float(incoming_started_mono)),
            incoming_deck=None,
            incoming_track_id=None,
            incoming_started_monotonic=None,
            recipe=None,
            last_error=None,
            manual_takeover_required=False,
        )
        _broadcast_everywhere({
            "action": "ai_dj_handoff_complete",
            "current_deck": incoming,
            "current_track_id": str(recipe["to"]["id"]),
            "stopped_deck": outgoing,
        })
    except InterruptedError as exc:
        if _ai_dj_manual_takeover_event.is_set():
            _ai_dj_set(
                active=False,
                phase="manual_takeover",
                last_error=str(exc),
                manual_takeover_required=True,
            )
            return
        # If the incoming track was only pre-rolling behind the outgoing side,
        # safely stop it and keep the outgoing session alive. During a fade,
        # freeze controls and require manual takeover instead of making a sudden
        # audible decision.
        if not fade_started:
            if incoming_started:
                try:
                    rb.cue(incoming)
                except Exception:
                    pass
            _ai_dj_set(
                active=True,
                phase="running",
                incoming_deck=None,
                incoming_track_id=None,
                incoming_started_monotonic=None,
                recipe=None,
                last_error=str(exc),
                manual_takeover_required=False,
            )
        else:
            _ai_dj_set(
                active=False,
                phase="aborted",
                last_error=str(exc),
                manual_takeover_required=bool(fade_started),
            )
        _broadcast_everywhere({"action": "ai_dj_aborted", "message": str(exc), "during_fade": fade_started})
    except Exception as exc:
        _ai_dj_set(
            active=False,
            phase="error",
            last_error=str(exc),
            manual_takeover_required=bool(fade_started),
        )
        _broadcast_everywhere({"action": "ai_dj_error", "message": str(exc)})


def _ai_dj_arm_transition(rb: RekordboxController, recipe: dict) -> dict:
    global _ai_dj_worker
    with _ai_dj_lock:
        if not _ai_dj_state.get("active"):
            raise RuntimeError("AI-DJ session is not active")
        if _ai_dj_worker is not None and _ai_dj_worker.is_alive():
            raise RuntimeError("An AI-DJ transition is already scheduled")
        current_deck = int(_ai_dj_state["current_deck"])
        current_track = str(_ai_dj_state["current_track_id"])
        started = float(_ai_dj_state["current_started_monotonic"])
    if int(recipe.get("outgoing_deck")) != current_deck:
        raise RuntimeError("Transition outgoing deck does not match the active AI-DJ deck")
    if str(recipe.get("from", {}).get("id")) != current_track:
        raise RuntimeError("Transition source track does not match the active AI-DJ track")
    incoming = int(recipe.get("incoming_deck"))
    if incoming == current_deck:
        raise RuntimeError("Incoming deck must differ from outgoing deck")
    play_at = float(recipe.get("phrase", {}).get("incoming_play_at_outgoing_sec", 0.0))
    elapsed = time.monotonic() - started
    if elapsed >= play_at - 0.25:
        raise RuntimeError(
            f"Too late to arm this transition: current elapsed {elapsed:.3f}s, incoming pre-roll at {play_at:.3f}s"
        )

    rb.set_crossfader(float(recipe["mixer"]["outgoing_crossfader"]))
    silent = bool(_ai_dj_state.get("silent_rehearsal"))
    rb.set_channel_fader(incoming, 0.0 if silent else float(recipe["mixer"].get("incoming_channel_fader", 1.0)))
    _ai_dj_abort_event.clear()
    _ai_dj_manual_takeover_event.clear()
    _ai_dj_set(
        phase="armed",
        incoming_deck=incoming,
        incoming_track_id=str(recipe["to"]["id"]),
        incoming_started_monotonic=None,
        recipe=copy.deepcopy(recipe),
        last_error=None,
        manual_takeover_required=False,
        last_manual_event=None,
    )
    worker = threading.Thread(
        target=_ai_dj_transition_worker_fn,
        args=(rb, copy.deepcopy(recipe)),
        name="ai-dj-transition",
        daemon=True,
    )
    _ai_dj_worker = worker
    worker.start()
    _broadcast_everywhere({"action": "ai_dj_transition_armed", "recipe": recipe})
    return _ai_dj_snapshot()


def _ai_dj_autopilot_worker_fn(
    rb: RekordboxController,
    plan: dict,
    start_deck: int,
    silent_rehearsal: bool,
    loader_fn=None,
    recipe_fn=None,
) -> None:
    """Execute an already-built set plan across alternating decks."""
    try:
        if loader_fn is None:
            from ai_dj_loader import load_track as loader_fn
        if recipe_fn is None:
            from ai_dj_engine import build_transition_recipe as recipe_fn

        tracks = list(plan.get("tracks") or [])
        if len(tracks) < 2:
            raise RuntimeError("Autopilot set requires at least two tracks")

        first = tracks[0]
        if _ai_dj_autopilot_stop_event.is_set():
            raise InterruptedError("Autopilot stopped before first load")
        _ai_dj_set(autopilot_phase="loading_start", set_index=0, set_next_track_id=None)
        first_load = loader_fn(deck=int(start_deck), track_id=str(first["id"]), execute=True)
        _ai_dj_set(last_load_result=copy.deepcopy(first_load))

        if _ai_dj_autopilot_stop_event.is_set():
            raise InterruptedError("Autopilot stopped before session start")
        native_bpm = float(first.get("bpm") or first_load.get("track", {}).get("bpm") or 0.0) or None
        _ai_dj_start_session(
            rb,
            str(first["id"]),
            int(start_deck),
            native_bpm,
            bool(silent_rehearsal),
        )
        _ai_dj_set(autopilot_phase="running", set_index=0)
        _broadcast_everywhere({
            "action": "ai_dj_autopilot_started",
            "track_id": str(first["id"]),
            "deck": int(start_deck),
            "set_length": len(tracks),
        })

        for index, target in enumerate(tracks[1:], start=1):
            if _ai_dj_autopilot_stop_event.is_set():
                raise InterruptedError("Autopilot stop requested")
            if _ai_dj_manual_takeover_event.is_set():
                raise InterruptedError("Physical manual takeover")

            session = _ai_dj_snapshot()
            if not session.get("active"):
                raise RuntimeError(f"AI-DJ session is not active before track {index + 1}")
            outgoing_deck = int(session["current_deck"])
            incoming_deck = 2 if outgoing_deck == 1 else 1
            current_id = str(session["current_track_id"])
            target_id = str(target["id"])
            effective_bpm = float(session.get("current_effective_bpm") or 0.0) or None

            recipe = recipe_fn(
                current_id,
                target_id,
                outgoing_deck=outgoing_deck,
                incoming_deck=incoming_deck,
                outgoing_effective_bpm=effective_bpm,
            )
            _ai_dj_set(
                autopilot_phase="staging",
                set_next_track_id=target_id,
                recipe=copy.deepcopy(recipe),
            )
            load_result = loader_fn(deck=incoming_deck, track_id=target_id, execute=True)
            _ai_dj_set(last_load_result=copy.deepcopy(load_result))

            if _ai_dj_autopilot_stop_event.is_set():
                raise InterruptedError("Autopilot stopped after staging incoming track")
            _ai_dj_arm_transition(rb, recipe)
            _ai_dj_set(autopilot_phase="transitioning")

            while True:
                if _ai_dj_autopilot_stop_event.is_set():
                    _ai_dj_abort()
                    raise InterruptedError("Autopilot stopped during transition")
                if _ai_dj_manual_takeover_event.is_set():
                    raise InterruptedError("Physical manual takeover during transition")
                snap = _ai_dj_snapshot()
                if not snap.get("worker_alive"):
                    break
                time.sleep(0.08)

            snap = _ai_dj_snapshot()
            if snap.get("manual_takeover_required") or snap.get("phase") == "manual_takeover":
                raise InterruptedError("Physical manual takeover completed")
            if snap.get("phase") in {"error", "aborted"}:
                raise RuntimeError(snap.get("last_error") or "Transition failed")
            if str(snap.get("current_track_id")) != target_id or int(snap.get("current_deck") or 0) != incoming_deck:
                raise RuntimeError(
                    f"Transition handoff mismatch: expected track {target_id} on deck {incoming_deck}, "
                    f"got {snap.get('current_track_id')} on deck {snap.get('current_deck')}"
                )
            _ai_dj_set(
                autopilot_phase="running",
                set_index=index,
                set_next_track_id=None,
                recipe=None,
            )
            _broadcast_everywhere({
                "action": "ai_dj_autopilot_advanced",
                "set_index": index,
                "track_id": target_id,
                "deck": incoming_deck,
            })

        _ai_dj_set(
            autopilot_active=False,
            autopilot_phase="complete",
            set_next_track_id=None,
            set_completed_at=time.time(),
            recipe=None,
            last_error=None,
        )
        _broadcast_everywhere({
            "action": "ai_dj_autopilot_complete",
            "set_length": len(tracks),
            "current_track_id": str(tracks[-1]["id"]),
        })
    except InterruptedError as exc:
        takeover = _ai_dj_manual_takeover_event.is_set()
        _ai_dj_set(
            autopilot_active=False,
            autopilot_phase="manual_takeover" if takeover else "stopped",
            set_next_track_id=None,
            last_error=str(exc),
            manual_takeover_required=bool(takeover) or bool(_ai_dj_state.get("manual_takeover_required")),
        )
        _broadcast_everywhere({
            "action": "ai_dj_autopilot_stopped",
            "reason": str(exc),
            "manual_takeover": takeover,
        })
    except Exception as exc:
        # Keep the currently audible/outgoing deck untouched. A planning/load
        # failure should hand control back to the user instead of abruptly
        # stopping music.
        _ai_dj_set(
            autopilot_active=False,
            autopilot_phase="error",
            set_next_track_id=None,
            last_error=str(exc),
            manual_takeover_required=bool(_ai_dj_state.get("active")),
        )
        _broadcast_everywhere({"action": "ai_dj_autopilot_error", "message": str(exc)})


def _ai_dj_start_autopilot(
    rb: RekordboxController,
    start_track_id: str,
    length: int = 6,
    start_deck: int = 1,
    silent_rehearsal: bool = False,
) -> dict:
    global _ai_dj_autopilot_worker
    start_deck = int(start_deck)
    if start_deck not in (1, 2):
        raise ValueError("start_deck must be 1 or 2")
    length = max(2, min(int(length), 12))
    status = rb.status()
    if not status.get("rekordbox_two_way_verified"):
        raise RuntimeError("Autopilot requires verified two-way Rekordbox control")
    with _ai_dj_lock:
        if _ai_dj_state.get("phase") == "recovery_required" or _ai_dj_state.get("manual_takeover_required"):
            raise RuntimeError("AI-DJ recovery is required; clear the previous session before starting autopilot")
        if _ai_dj_state.get("active") or _ai_dj_state.get("autopilot_active"):
            raise RuntimeError("AI-DJ session/autopilot is already active")
        if _ai_dj_autopilot_worker is not None and _ai_dj_autopilot_worker.is_alive():
            raise RuntimeError("AI-DJ autopilot worker is still active")

    from ai_dj_loader import resolve_track
    from dashboard_http import load_rekordbox_set_plan

    plan = load_rekordbox_set_plan(str(start_track_id), length)
    if plan.get("error"):
        raise RuntimeError(f"Could not build set plan: {plan['error']}")
    tracks = list(plan.get("tracks") or [])
    if len(tracks) < 2:
        raise RuntimeError("Set planner returned fewer than two tracks")
    # Full preflight: every planned track must have a real playable file and a
    # search query isolated to its exact metadata/version family.
    preflight = []
    for row in tracks:
        resolved = resolve_track(track_id=str(row["id"]))
        if not resolved.search_isolated:
            raise RuntimeError(
                f"Autopilot preflight rejected ambiguous search for {row.get('title')}: {resolved.search_query!r}"
            )
        preflight.append({
            "id": str(row["id"]),
            "title": row.get("title"),
            "search_query": resolved.search_query,
            "search_match_count": len(resolved.search_matches),
            "playable_duplicate_count": len(resolved.playable_duplicates),
        })

    _ai_dj_abort_event.clear()
    _ai_dj_manual_takeover_event.clear()
    _ai_dj_autopilot_stop_event.clear()
    _ai_dj_set(
        autopilot_active=True,
        autopilot_phase="starting",
        set_plan=copy.deepcopy(plan),
        set_index=0,
        set_length=len(tracks),
        set_next_track_id=str(tracks[1]["id"]) if len(tracks) > 1 else None,
        set_started_at=time.time(),
        set_completed_at=None,
        last_load_result=None,
        last_error=None,
        manual_takeover_required=False,
    )
    worker = threading.Thread(
        target=_ai_dj_autopilot_worker_fn,
        args=(rb, copy.deepcopy(plan), start_deck, bool(silent_rehearsal)),
        name="ai-dj-autopilot",
        daemon=True,
    )
    _ai_dj_autopilot_worker = worker
    worker.start()
    state = _ai_dj_snapshot()
    state["preflight"] = preflight
    return state


def _ai_dj_stop_autopilot(rb: RekordboxController, stop_transport: bool = True) -> dict:
    global _ai_dj_autopilot_worker
    _ai_dj_autopilot_stop_event.set()
    _ai_dj_abort_event.set()
    worker = _ai_dj_autopilot_worker
    if worker is not None and worker.is_alive() and worker is not threading.current_thread():
        worker.join(timeout=8.0)
    worker_alive = bool(worker is not None and worker.is_alive())
    if not worker_alive:
        _ai_dj_autopilot_worker = None
    if stop_transport:
        state = _ai_dj_stop_session(rb)
        _ai_dj_set(
            autopilot_active=False,
            autopilot_phase="stopping" if worker_alive else "idle",
            last_error="Autopilot worker is still draining after stop" if worker_alive else None,
        )
        return state
    _ai_dj_set(
        autopilot_active=False,
        autopilot_phase="stopping" if worker_alive else "stopped",
        last_error="Autopilot worker is still draining after stop" if worker_alive else _ai_dj_state.get("last_error"),
    )
    return _ai_dj_snapshot()


def _ai_dj_abort() -> dict:
    _ai_dj_abort_event.set()
    _ai_dj_set(last_error="Abort requested")
    return _ai_dj_snapshot()


def _ai_dj_stop_session(rb: RekordboxController) -> dict:
    """Stop both decks and return the automation state to idle."""
    global _ai_dj_worker
    _ai_dj_abort_event.set()
    worker = _ai_dj_worker
    if worker is not None and worker.is_alive() and worker is not threading.current_thread():
        worker.join(timeout=1.5)
    transition_alive = bool(worker is not None and worker.is_alive())
    auto_worker = _ai_dj_autopilot_worker
    autopilot_alive = bool(auto_worker is not None and auto_worker.is_alive())
    # Mute before transport changes so stopping a rehearsal/session cannot
    # produce an audible transient through either channel.
    for deck in (1, 2):
        try:
            rb.set_channel_fader(deck, 0.0)
        except Exception:
            pass
    for deck in (1, 2):
        try:
            rb.cue(deck)
        except Exception:
            pass
    for deck in (1, 2):
        try:
            if bool(_runtime_state.get("feedback_sync", {}).get(str(deck))):
                rb.deck_button(deck, "sync")
                time.sleep(0.03)
        except Exception:
            pass
    try:
        rb.set_crossfader(0.5)
    except Exception:
        pass
    # Never clear stop/abort latches while a worker can still observe them.
    # A fresh session/autopilot explicitly clears its own latches on startup.
    if not transition_alive and not autopilot_alive:
        _ai_dj_abort_event.clear()
        _ai_dj_manual_takeover_event.clear()
    if not transition_alive:
        _ai_dj_worker = None
    _ai_dj_set(
        active=False,
        phase="idle",
        current_deck=None,
        current_track_id=None,
        current_effective_bpm=None,
        silent_rehearsal=False,
        current_started_monotonic=None,
        current_started_at=None,
        incoming_deck=None,
        incoming_track_id=None,
        incoming_started_monotonic=None,
        recipe=None,
        last_error=None,
        manual_takeover_required=False,
        last_manual_event=None,
        autopilot_active=False,
        autopilot_phase="idle",
        set_plan=None,
        set_index=None,
        set_length=0,
        set_next_track_id=None,
        set_started_at=None,
        set_completed_at=None,
        last_load_result=None,
        transport_probe=None,
        incoming_transport_probe=None,
        recovery_checkpoint=None,
    )
    _broadcast_everywhere({"action": "ai_dj_session_stopped"})
    return _ai_dj_snapshot()


def _ai_dj_consider_manual_takeover(event: dict) -> None:
    """Give genuine physical FLX4 gestures immediate authority over automation."""
    if not _ai_dj_state.get("active") and not _ai_dj_state.get("autopilot_active"):
        return
    action = str(event.get("action") or "")
    take_over = action in {
        "hardware_crossfader",
        "hardware_channel_fader",
        "hardware_tempo",
        "hardware_eq",
        "hardware_cfx",
        "hardware_fx_level",
        "hardware_jog_rotate",
        "hardware_browser_rotate",
    }
    if action == "hardware_jog_touch":
        take_over = bool(event.get("touched"))
    elif action in {"hardware_button", "hardware_pad", "hardware_pad_mode"}:
        take_over = bool(event.get("pressed"))
    if not take_over:
        return
    _ai_dj_manual_takeover_event.set()
    _ai_dj_abort_event.set()
    _ai_dj_autopilot_stop_event.set()
    _ai_dj_set(
        active=False,
        phase="manual_takeover",
        autopilot_active=False,
        autopilot_phase="manual_takeover",
        manual_takeover_required=True,
        last_error=f"Physical FLX4 manual takeover via {action}",
        last_manual_event={
            "action": action,
            "deck": event.get("deck"),
            "control": event.get("control"),
            "at": time.time(),
        },
    )


def _ai_dj_external_load_takeover(deck: int) -> None:
    """Treat an uncommanded Rekordbox deck load as immediate manual takeover."""
    if not _ai_dj_state.get("active") and not _ai_dj_state.get("autopilot_active"):
        return
    _ai_dj_manual_takeover_event.set()
    _ai_dj_abort_event.set()
    _ai_dj_autopilot_stop_event.set()
    _ai_dj_set(
        active=False,
        phase="manual_takeover",
        autopilot_active=False,
        autopilot_phase="manual_takeover",
        manual_takeover_required=True,
        last_error=f"External Rekordbox load detected on deck {deck}",
        last_manual_event={
            "action": "external_rekordbox_load",
            "deck": int(deck),
            "at": time.time(),
        },
    )


def _update_runtime_state(event: dict) -> None:
    action = event.get("action")
    if str(action or "").startswith("hardware_"):
        _ai_dj_consider_manual_takeover(event)
    if action == "browser_load":
        try:
            invalidate_assignment(int(event.get("deck")), reason="virtual_browser_load")
        except Exception:
            pass
    elif action == "hardware_button" and event.get("control") == "load" and bool(event.get("pressed")):
        try:
            invalidate_assignment(int(event.get("deck")), reason="physical_flx4_load")
        except Exception:
            pass
    if str(action or "").startswith("feedback_"):
        counts = _runtime_state["feedback_event_counts"]
        counts[str(action)] = int(counts.get(str(action), 0)) + 1
        _runtime_state["last_feedback_event"] = {
            "action": str(action),
            "at": time.time(),
            "deck": event.get("deck"),
            "unit": event.get("unit"),
            "on": event.get("on"),
            "value": event.get("value"),
        }
    if action == "play":
        deck = str(event["deck"])
        _runtime_state["playing"][deck] = not _runtime_state["playing"][deck]
    elif action == "cue":
        _runtime_state["playing"][str(event["deck"])] = False
    elif action == "crossfader":
        _runtime_state["crossfader"] = float(event["value"])
    elif action == "channel_fader":
        _runtime_state["channel_fader"][str(event["deck"])] = float(event["value"])
    elif action == "tempo":
        _runtime_state["tempo"][str(event["deck"])] = float(event["value"])
    elif action == "eq":
        _runtime_state["eq"][str(event["deck"])][str(event["band"])] = float(event["value"])
    elif action == "cfx":
        _runtime_state["cfx"][str(event["deck"])] = float(event["value"])
    elif action == "fx_level":
        _runtime_state["fx_level"][str(event["unit"])] = float(event["value"])
    elif action in ("fx_toggle", "smart_cfx", "smart_fader"):
        # These are state toggles with exact Rekordbox MIDI OUT indicators.
        # Do not infer the resulting state from the outgoing command because
        # Rekordbox feedback can arrive before this command broadcast on a
        # fast round trip. The corresponding feedback_* event below is the
        # sole authority for these state fields.
        pass
    elif action == "semantic_cue":
        _runtime_state["semantic_cue"] = str(event.get("cue", ""))
    elif action == "feedback_loaded":
        deck = str(event["deck"])
        previous = bool(_runtime_state["feedback_loaded"].get(deck))
        current = bool(event.get("on"))
        if current and not previous:
            try:
                invalidate_assignment(int(deck), reason="rekordbox_loaded_indicator_edge")
            except Exception:
                pass
            expected = time.time() <= float(_expected_load_until.get(deck, 0.0) or 0.0)
            _expected_load_until[deck] = 0.0
            if not expected:
                _ai_dj_external_load_takeover(int(deck))
        _runtime_state["feedback_loaded"][deck] = current
    elif action == "feedback_loop":
        _runtime_state["feedback_loop"][str(event["deck"])] = bool(event.get("on"))
    elif action == "feedback_vinyl":
        _runtime_state["feedback_vinyl"][str(event["deck"])] = bool(event.get("on"))
    elif action == "feedback_play":
        deck = str(event["deck"])
        _runtime_state["feedback_play"][deck] = bool(event.get("on"))
        _runtime_state["playing"][deck] = bool(event.get("on"))
    elif action == "feedback_cue":
        _runtime_state["feedback_cue"][str(event["deck"])] = bool(event.get("on"))
    elif action == "feedback_sync":
        _runtime_state["feedback_sync"][str(event["deck"])] = bool(event.get("on"))
    elif action == "feedback_headphone":
        _runtime_state["feedback_headphone"][str(event["deck"])] = bool(event.get("on"))
    elif action == "feedback_hotcue_mode":
        _runtime_state["feedback_hotcue_mode"][str(event["deck"])] = bool(event.get("on"))
    elif action == "feedback_hotcue_pad":
        deck = str(event["deck"])
        pad = int(event.get("pad", -1))
        if 0 <= pad < 8:
            _runtime_state["feedback_hotcue_pad"][deck][pad] = bool(event.get("on"))
    elif action == "feedback_channel_level":
        _runtime_state["feedback_channel_level"][str(event["deck"])] = float(event.get("value", 0.0))
    elif action == "feedback_smart_cfx":
        on = bool(event.get("on"))
        _runtime_state["feedback_smart_cfx"] = on
        _runtime_state["smart_cfx"] = on
    elif action == "feedback_smart_fader":
        on = bool(event.get("on"))
        _runtime_state["feedback_smart_fader"] = on
        _runtime_state["smart_fader"] = on
    elif action == "feedback_fx_on":
        unit = str(event["unit"])
        on = bool(event.get("on"))
        _runtime_state["feedback_fx_on"][unit] = on
        _runtime_state["fx_on"][unit] = on
    # Physical DDJ-FLX4 events are observation-only. Continuous controls may
    # safely update the mirrored runtime position, while button/toggle truth
    # continues to come from genuine Rekordbox feedback above.
    elif action == "hardware_crossfader":
        _runtime_state["crossfader"] = float(event.get("value", 0.5))
    elif action == "hardware_channel_fader":
        _runtime_state["channel_fader"][str(event["deck"])] = float(event.get("value", 0.0))
    elif action == "hardware_tempo":
        _runtime_state["tempo"][str(event["deck"])] = float(event.get("value", 0.5))
    elif action == "hardware_eq":
        _runtime_state["eq"][str(event["deck"])][str(event["band"])] = float(event.get("value", 0.5))
    elif action == "hardware_cfx":
        _runtime_state["cfx"][str(event["deck"])] = float(event.get("value", 0.5))
    elif action == "hardware_fx_level":
        _runtime_state["fx_level"][str(event["unit"])] = float(event.get("value", 0.5))


def _broadcast_everywhere(event: dict) -> None:
    _update_runtime_state(event)
    hub.broadcast(event)
    try:
        send_event_as_osc(event)
    except Exception:
        pass


def controller() -> RekordboxController:
    global _controller_instance
    if _controller_instance is None:
        _controller_instance = RekordboxController(broadcast_fn=_broadcast_everywhere)
    return _controller_instance


def physical_monitor() -> FLX4PhysicalMonitor:
    global _physical_monitor_instance
    if _physical_monitor_instance is None:
        _physical_monitor_instance = FLX4PhysicalMonitor(broadcast_fn=_broadcast_everywhere)
    return _physical_monitor_instance


def _controller_status() -> dict:
    status = controller().status()
    status["rekordbox_bridge_health"] = copy.deepcopy(_rekordbox_attach_state)
    status["rekordbox_auto_attach"] = copy.deepcopy(_rekordbox_attach_state)
    monitor = _physical_monitor_instance
    status["physical_controller_monitor"] = (
        monitor.status() if monitor is not None else {
            "connected": False,
            "port": None,
            "messages": 0,
            "decoded_messages": 0,
            "last_at": None,
            "error": None,
        }
    )
    status["deck_assignments"] = deck_registry_snapshot()
    return status


def _bridge_health_monitor(rb: RekordboxController) -> None:
    """Passive Rekordbox/FLX4 bridge health monitor.

    The Rekordbox MIDI Setting "Connected device" popup is an editor context,
    not an exclusive live-routing binding. Runtime restarts were verified to
    retain working virtual command + feedback paths even while that popup
    displays DDJ-FLX4. Never manipulate Rekordbox UI automatically here.
    """
    time.sleep(0.8)
    while True:
        try:
            status = rb.status()
            if not status.get("rekordbox_running"):
                result, success = "rekordbox_offline", False
            elif not status.get("physical_flx4_visible"):
                result, success = "flx4_not_visible", False
            elif rb.feedback_messages > 0:
                result, success = "two_way_transport_live", True
            else:
                result, success = "waiting_for_feedback", False
            _rekordbox_attach_state.update({
                "attempted": False,
                "success": success,
                "result": result,
                "error": None,
                "attempted_at": time.time(),
            })
        except Exception as exc:
            _rekordbox_attach_state.update({
                "attempted": False, "success": False, "result": "monitor_exception",
                "error": str(exc), "attempted_at": time.time(),
            })
        time.sleep(5.0)


def _physical_controller_monitor_worker(monitor: FLX4PhysicalMonitor) -> None:
    """Keep the read-only FLX4 observer attached across unplug/replug cycles."""
    while True:
        try:
            port = monitor.port
            available = any(
                isinstance(name, str) and monitor.port_name.lower() in name.lower()
                for name in monitor.available_ports()
            )
            if port is not None and (
                bool(getattr(port, "closed", False)) or not available
            ):
                monitor.close()
            if monitor.port is None:
                monitor.connect()
        except Exception as exc:
            monitor.error = str(exc)
            try:
                monitor.close()
            except Exception:
                pass
        time.sleep(2.0)


def _acquire_runtime_lock():
    """Guarantee that only one Rekordbox runtime process can exist."""
    global _runtime_lock_handle
    lock_path = Path(__file__).resolve().parent / ".cache" / "runtime.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        handle.close()
        raise RuntimeError("rekordbox runtime is already running") from exc
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
    _runtime_lock_handle = handle
    return handle


def _release_runtime_lock() -> None:
    global _runtime_lock_handle
    if _runtime_lock_handle is None:
        return
    try:
        fcntl.flock(_runtime_lock_handle.fileno(), fcntl.LOCK_UN)
    finally:
        _runtime_lock_handle.close()
        _runtime_lock_handle = None


def _assert_port_available(host: str, port: int) -> None:
    """Fail before starting any service if a required runtime port is occupied."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    except OSError as exc:
        raise RuntimeError(f"runtime port {host}:{port} is already in use") from exc
    finally:
        sock.close()


def handle_message(payload: dict) -> Optional[dict]:
    # DashboardHub dispatches each WebSocket client's message handler through
    # asyncio.to_thread(). Serialize the whole runtime transaction here so a
    # browser gesture and an MCP action can never interleave controller state,
    # MIDI sends and broadcasts in different orders.
    with _command_lock:
        kind = payload.get("type")
        if kind == "status_request":
            return {
                "action": "controller_status",
                "status": _controller_status(),
                "runtime_state": copy.deepcopy(_runtime_state),
            }
        if kind == "state_request":
            return {
                "action": "runtime_state",
                "status": _controller_status(),
                "runtime_state": copy.deepcopy(_runtime_state),
                "ai_dj": _ai_dj_snapshot(),
            }
        if kind == "ai_dj_status":
            return {
                "action": "ai_dj_status",
                "ai_dj": _ai_dj_snapshot(),
            }
        if kind == "ai_dj_start":
            state = _ai_dj_start_session(
                controller(),
                str(payload["track_id"]),
                int(payload["deck"]),
                float(payload["bpm"]) if payload.get("bpm") is not None else None,
                bool(payload.get("silent_rehearsal", False)),
            )
            return {"action": "ai_dj_started", "ai_dj": state}
        if kind == "ai_dj_arm":
            recipe = payload.get("recipe")
            if not isinstance(recipe, dict):
                raise ValueError("ai_dj_arm requires a transition recipe")
            state = _ai_dj_arm_transition(controller(), recipe)
            return {"action": "ai_dj_armed", "ai_dj": state}
        if kind == "ai_dj_abort":
            state = _ai_dj_abort()
            return {"action": "ai_dj_abort_requested", "ai_dj": state}
        if kind == "ai_dj_stop":
            state = _ai_dj_stop_session(controller())
            return {"action": "ai_dj_stopped", "ai_dj": state}
        if kind == "ai_dj_autopilot_start":
            state = _ai_dj_start_autopilot(
                controller(),
                str(payload["start_track_id"]),
                int(payload.get("length", 6)),
                int(payload.get("start_deck", 1)),
                bool(payload.get("silent_rehearsal", False)),
            )
            return {"action": "ai_dj_autopilot_started", "ai_dj": state}
        if kind == "ai_dj_autopilot_stop":
            state = _ai_dj_stop_autopilot(
                controller(),
                bool(payload.get("stop_transport", True)),
            )
            return {"action": "ai_dj_autopilot_stopped", "ai_dj": state}
        if kind != "control":
            return None

        action = str(payload.get("action", ""))
        rb = controller()
        if action == "play": rb.play(int(payload["deck"]))
        elif action == "cue": rb.cue(int(payload["deck"]))
        elif action == "crossfader": rb.set_crossfader(float(payload["value"]))
        elif action == "channel_fader": rb.set_channel_fader(int(payload["deck"]), float(payload["value"]))
        elif action == "tempo": rb.set_tempo(int(payload["deck"]), float(payload["value"]))
        elif action == "deck_button": rb.deck_button(int(payload["deck"]), str(payload["control"]))
        elif action == "jog_touch": rb.jog_touch(int(payload["deck"]), bool(payload["touched"]))
        elif action == "jog_rotate": rb.jog_rotate(int(payload["deck"]), int(payload["delta"]), str(payload.get("mode", "scratch")))
        elif action == "browser_rotate": rb.browser_rotate(int(payload["delta"]))
        elif action == "browser_press": rb.browser_press()
        elif action == "browser_back": rb.browser_back()
        elif action == "browser_load":
            deck = int(payload["deck"])
            _expected_load_until[str(deck)] = time.time() + 5.0
            rb.browser_load(deck)
        elif action == "browser_related": rb.browser_related()
        elif action == "browser_switch_window": rb.browser_switch_window()
        elif action == "eq": rb.set_eq(int(payload["deck"]), str(payload["band"]), float(payload["value"]))
        elif action == "cfx": rb.set_cfx(int(payload["deck"]), float(payload["value"]))
        elif action == "pad": rb.trigger_pad(int(payload["deck"]), int(payload["pad"]))
        elif action == "performance_pad": rb.trigger_performance_pad(int(payload["deck"]), str(payload["mode"]), int(payload["pad"]))
        elif action == "smart_cfx": rb.smart_cfx_toggle()
        elif action == "smart_cfx_select": rb.smart_cfx_select()
        elif action == "smart_fader": rb.smart_fader_toggle()
        elif action == "fx_select": rb.fx_select(int(payload.get("unit", 1)), int(payload.get("direction", 1)))
        elif action == "fx_beat": rb.fx_beat(int(payload.get("unit", 1)), int(payload.get("direction", 1)))
        elif action == "fx_level": rb.fx_level(int(payload.get("unit", 1)), float(payload["value"]))
        elif action == "fx_toggle": rb.fx_toggle(int(payload.get("unit", 1)))
        elif action == "semantic_cue":
            cue = str(payload.get("cue", ""))
            send_semantic_cue(cue)
            _broadcast_everywhere({"action": "semantic_cue", "cue": cue})
        else:
            raise ValueError(f"unsupported runtime action: {action}")
        request_id = payload.get("request_id")
        if request_id:
            return {
                "action": "control_ack",
                "request_id": str(request_id),
                "control_action": action,
            }
        return None


def main() -> None:
    global _ai_dj_persistence_enabled
    _acquire_runtime_lock()
    http_server = None
    rb = None
    physical = None
    try:
        _ai_dj_persistence_enabled = True
        _restore_ai_dj_checkpoint_on_startup()
        # The deck registry records identities proven during the prior runtime,
        # but Rekordbox can be changed while this process is offline. Fail
        # closed after every restart and let the safe loader re-establish each
        # deck identity from a genuine LoadedIndicator edge.
        for deck in (1, 2):
            try:
                invalidate_assignment(deck, reason="runtime_start_identity_unverified")
            except Exception:
                pass
        _assert_port_available("127.0.0.1", 18765)
        _assert_port_available("127.0.0.1", 18766)
        hub.on_message = handle_message
        http_server, _ = start_dashboard_http_server()
        rb = controller()
        try:
            rb.connect()
        except Exception as exc:
            print(f"MIDI port startup warning: {exc}")
        else:
            threading.Thread(
                target=_bridge_health_monitor,
                args=(rb,),
                name="rekordbox-midi-health",
                daemon=True,
            ).start()
        physical = physical_monitor()
        try:
            physical.connect()
        except Exception as exc:
            print(f"Physical FLX4 monitor startup warning: {exc}")
        threading.Thread(
            target=_physical_controller_monitor_worker,
            args=(physical,),
            name="flx4-physical-monitor",
            daemon=True,
        ).start()
        asyncio.run(hub.serve("127.0.0.1", 18765))
    finally:
        _persist_ai_dj_state()
        if http_server is not None:
            try:
                http_server.shutdown()
                http_server.server_close()
            except Exception:
                pass
        if rb is not None:
            try:
                rb.close()
            except Exception:
                pass
        if physical is not None:
            try:
                physical.close()
            except Exception:
                pass
        _release_runtime_lock()


if __name__ == "__main__":
    main()
