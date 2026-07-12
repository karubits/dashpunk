"""System-audio capture for the visualizer page.

Keeps a long-lived `parec` (ships with libpulse) reading the default sink's
monitor source and hands ~fps base64 PCM chunks (1024 s16le mono samples) to a
callback. Capture only runs while the visualizer page is visible — the webview
toggles it over the bridge — so idle sinks can still suspend.
"""

import base64
import subprocess
import threading
import time

from . import audio

RATE = 44100
CHUNK_SAMPLES = 1024  # ~23 ms at 44.1 kHz
CHUNK_BYTES = CHUNK_SAMPLES * 2  # s16le mono


class AudioCapture(threading.Thread):
    def __init__(self, push_cb, fps=30):
        super().__init__(daemon=True)
        self.push_cb = push_cb  # called from this thread with a base64 str
        self.interval = 1.0 / max(15, min(60, int(fps)))
        self._active = threading.Event()  # visualizer page visible
        self._stop = threading.Event()
        self._proc = None
        self._proc_lock = threading.Lock()

    def set_active(self, on):
        if on:
            self._active.set()
        else:
            self._active.clear()
            self._kill_proc()

    def stop(self):
        self._stop.set()
        self._active.set()  # unblock the wait in run()
        self._kill_proc()

    def _kill_proc(self):
        with self._proc_lock:
            proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        except OSError:
            pass

    def run(self):
        backoff = 0.5
        while not self._stop.is_set():
            self._active.wait()
            if self._stop.is_set():
                break
            started = time.monotonic()
            self._session()
            if time.monotonic() - started > 5:
                backoff = 0.5
            if self._active.is_set() and not self._stop.is_set():
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 2.0)

    def _session(self):
        """One parec run; returns on deactivate/stop/parec death/sink change."""
        sink = audio._pactl("get-default-sink")
        if not sink:
            return
        try:
            proc = subprocess.Popen(
                ["parec", "--format=s16le", f"--rate={RATE}", "--channels=1",
                 "--latency-msec=30", "-d", sink + ".monitor"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            print(f"[viz] parec failed to start: {e}")
            return
        with self._proc_lock:
            self._proc = proc

        last_push = 0.0
        last_sink_check = time.monotonic()
        try:
            while self._active.is_set() and not self._stop.is_set():
                chunk = self._read_exact(proc.stdout, CHUNK_BYTES)
                if chunk is None:
                    return  # parec died (or was killed) — run() respawns
                now = time.monotonic()
                if now - last_push >= self.interval:
                    last_push = now
                    self.push_cb(base64.b64encode(chunk).decode())
                if now - last_sink_check >= 1.0:
                    last_sink_check = now
                    if audio._pactl("get-default-sink") not in (sink, None):
                        return  # default sink changed — respawn on new monitor
        finally:
            self._kill_proc()

    @staticmethod
    def _read_exact(stream, n):
        buf = b""
        while len(buf) < n:
            try:
                part = stream.read(n - len(buf))
            except (OSError, ValueError):
                return None
            if not part:
                return None  # EOF
            buf += part
        return buf
