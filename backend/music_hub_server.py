#!/usr/bin/env python3
"""Separate loopback-only HTTP process for the clean DJ library.

It reuses the proven read-only dashboard library APIs and Music Hub action
handlers without restarting the live FLX4 MIDI/WebSocket runtime.
"""

from __future__ import annotations

from functools import partial
from pathlib import Path
import signal
import threading
import time

from dashboard_http import DashboardHTTPServer, QuietHandler, get_rekordbox_library_fast
import music_hub_stems


HOST = "127.0.0.1"
PORT = 18769


def serve() -> None:
    root = Path(__file__).resolve().parent
    handler = partial(QuietHandler, directory=str(root))
    server = DashboardHTTPServer((HOST, PORT), handler)
    print(f"Rekordbox Music Hub listening at http://{HOST}:{PORT}/music-hub/index.html", flush=True)
    shutdown = threading.Event()

    def resume_watcher():
        # The old daemon/SSH session may need time to settle after a crash or
        # launchd handoff. Only a previously requested whole-library job may
        # resume. The intent file is revoked on the explicit Stop action.
        if shutdown.wait(8):
            return
        previous_error = ""
        while not shutdown.is_set():
            try:
                if music_hub_stems._load_batch_control()["enabled"]:
                    result = music_hub_stems.resume_intended_batch(
                        get_rekordbox_library_fast().get("collection") or [])
                    if result.get("ok"):
                        print("Music Hub resumed the authorized Expansion stem batch", flush=True)
                previous_error = ""
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                if message != previous_error:
                    print("Stem batch resume deferred:", message[:220], flush=True)
                previous_error = message
            shutdown.wait(300)

    threading.Thread(target=resume_watcher, name="music-hub-stems-resume",
                     daemon=True).start()

    def graceful_handoff(_sig, _frame):
        shutdown.set()
        music_hub_stems.terminate_for_server_handoff()
        # shutdown() must run from a thread other than serve_forever().
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, graceful_handoff)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        shutdown.set()
        music_hub_stems.terminate_for_server_handoff()
        worker = music_hub_stems._WORKER
        if worker and worker.is_alive():
            worker.join(timeout=10)
        server.server_close()


if __name__ == "__main__":
    serve()
