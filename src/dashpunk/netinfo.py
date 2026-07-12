"""Network interfaces, throughput, and ping quality monitoring."""

import re
import socket
import struct
import subprocess
import threading
import time
from collections import deque

import psutil

PING_HISTORY = 60


def default_gateway():
    """Default gateway IPv4 from /proc/net/route (no external deps)."""
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                fields = line.split()
                if len(fields) >= 3 and fields[1] == "00000000":
                    return socket.inet_ntoa(struct.pack("<L", int(fields[2], 16)))
    except (OSError, ValueError):
        pass
    return None


class PingMonitor:
    """Pings each target on its own thread, keeps a latency history."""

    def __init__(self, targets, interval):
        self.interval = interval
        self.lock = threading.Lock()
        self.targets = []  # {label, host, history: deque of float|None}
        gw = default_gateway()
        for t in targets:
            if t == "gateway":
                if gw:
                    self.targets.append({"label": f"GW {gw}", "host": gw,
                                         "history": deque(maxlen=PING_HISTORY)})
            else:
                self.targets.append({"label": t, "host": t,
                                     "history": deque(maxlen=PING_HISTORY)})
        self._stop = threading.Event()
        for t in self.targets:
            threading.Thread(target=self._loop, args=(t,), daemon=True).start()

    def stop(self):
        self._stop.set()

    def _loop(self, target):
        while not self._stop.is_set():
            ms = self._ping_once(target["host"])
            with self.lock:
                target["history"].append(ms)
            self._stop.wait(self.interval)

    @staticmethod
    def _ping_once(host):
        try:
            out = subprocess.run(
                ["ping", "-n", "-q", "-c", "1", "-W", "1", host],
                capture_output=True, text=True, timeout=3,
            )
            m = re.search(r"= [\d.]+/([\d.]+)/", out.stdout)
            if out.returncode == 0 and m:
                return float(m.group(1))
        except (subprocess.SubprocessError, OSError):
            pass
        return None

    def read(self):
        results = []
        with self.lock:
            for t in self.targets:
                hist = list(t["history"])
                recent = hist[-20:]
                valid = [v for v in recent if v is not None]
                loss = (1 - len(valid) / len(recent)) * 100 if recent else 0
                results.append({
                    "label": t["label"],
                    "ms": hist[-1] if hist else None,
                    "avg": sum(valid) / len(valid) if valid else None,
                    "loss": round(loss),
                    "history": [round(v, 1) if v is not None else None for v in hist],
                })
        return results


class NetCollector:
    def __init__(self, ping_targets, ping_interval):
        self.ping = PingMonitor(ping_targets, ping_interval)
        self._prev_io = psutil.net_io_counters(pernic=True)
        self._prev_ts = time.monotonic()

    def read(self):
        now = time.monotonic()
        elapsed = max(now - self._prev_ts, 1e-3)
        io = psutil.net_io_counters(pernic=True)
        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()

        ifaces = []
        for name, addr_list in addrs.items():
            if name == "lo":
                continue
            st = stats.get(name)
            if not st or not st.isup:
                continue
            ipv4 = [a.address for a in addr_list if a.family == socket.AF_INET]
            ipv6 = [a.address.split("%")[0] for a in addr_list
                    if a.family == socket.AF_INET6 and not a.address.startswith("fe80")]
            if not ipv4 and not ipv6:
                continue
            rx = tx = 0
            if name in io and name in self._prev_io:
                rx = (io[name].bytes_recv - self._prev_io[name].bytes_recv) / elapsed
                tx = (io[name].bytes_sent - self._prev_io[name].bytes_sent) / elapsed
            ifaces.append({
                "name": name,
                "ipv4": ipv4,
                "ipv6": ipv6[:1],
                "rx": max(0, rx),
                "tx": max(0, tx),
            })
        self._prev_io = io
        self._prev_ts = now
        return {"ifaces": ifaces, "ping": self.ping.read()}
