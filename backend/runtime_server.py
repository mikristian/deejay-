import atexit
import os
import signal
from pathlib import Path

from runtime_core import main

PID_FILE = Path("/tmp/rekordbox-live-runtime.pid")


def _write_pid():
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")


def _remove_pid():
    try:
        if PID_FILE.is_file() and PID_FILE.read_text(encoding="utf-8").strip() == str(os.getpid()):
            PID_FILE.unlink()
    except Exception:
        pass


def _handle_stop(_signum, _frame):
    raise KeyboardInterrupt

if __name__ == "__main__":
    _write_pid()
    atexit.register(_remove_pid)
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
    except KeyboardInterrupt:
        pass
