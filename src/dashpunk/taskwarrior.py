"""Taskwarrior integration: pending-task feed + mark-done.

A background thread keeps a snapshot of `task export` so a slow or hung task
binary never stalls the Collector tick. Reads are side-effect-free
(rc.gc=off rc.hooks=off); the only mutation is mark_done, where hooks stay on
so sync/hook setups see real completions.
"""

import json
import shlex
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone


def _parse_ts(ts):
    """Taskwarrior UTC timestamp ("20260615T185240Z") -> epoch seconds."""
    try:
        dt = datetime.strptime(ts, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


class TaskFeed:
    def __init__(self, cfg):
        self.filter = str(cfg.get("filter", "status:pending"))
        self.refresh = max(5.0, float(cfg.get("refresh_seconds", 30)))
        self.lock = threading.Lock()
        self.items = []
        self.error = None
        self.updated = None
        self._wake = threading.Event()
        self._available = shutil.which("task") is not None
        if self._available:
            threading.Thread(target=self._loop, daemon=True).start()
        else:
            self.error = "taskwarrior not installed"

    def invalidate(self):
        """Trigger an immediate re-read (after a mutation)."""
        self._wake.set()

    def _loop(self):
        while True:
            self._refresh()
            self._wake.wait(self.refresh)
            self._wake.clear()

    def _refresh(self):
        try:
            out = subprocess.run(
                ["task", "rc.gc=off", "rc.hooks=off", "rc.verbose=nothing",
                 *shlex.split(self.filter), "export"],
                capture_output=True, text=True, timeout=10,
            )
            if out.returncode != 0:
                raise RuntimeError((out.stderr or "task failed").strip().splitlines()[-1])
            tasks = json.loads(out.stdout or "[]")
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as e:
            with self.lock:  # keep last good items — stale beats empty
                self.error = f"{e}"[:120]
            return
        items = [{
            "uuid": t.get("uuid"),
            "description": t.get("description", ""),
            "project": t.get("project"),
            "tags": t.get("tags", []),
            "due": _parse_ts(t.get("due")),
            "urgency": t.get("urgency", 0),
        } for t in tasks if t.get("uuid")]
        items.sort(key=lambda t: -t["urgency"])
        with self.lock:
            self.items = items
            self.error = None
            self.updated = time.time()

    def read(self):
        with self.lock:
            return {"items": self.items, "error": self.error, "updated": self.updated}

    def mark_done(self, uuid):
        """Complete a task (called on a throwaway thread; uuid pre-validated)."""
        try:
            out = subprocess.run(
                ["task", "rc.confirmation=off", "rc.verbose=nothing", uuid, "done"],
                capture_output=True, text=True, timeout=15,
            )
            if out.returncode != 0:
                print(f"[tasks] done {uuid} failed: {(out.stderr or '').strip()}")
        except (OSError, subprocess.SubprocessError) as e:
            print(f"[tasks] done {uuid}: {e}")
        self.invalidate()
