"""CPU / memory / disk / temperature / GPU stats via psutil and sysfs."""

import glob
import os
import time

import psutil

HWMON_ROOT = "/sys/class/hwmon"


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def _read_int(path):
    v = _read(path)
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class HwmonSensors:
    """Discovers hwmon temperature/fan sensors once, reads them each tick."""

    def __init__(self):
        self.cpu_temp_path = None
        self.nvme_temp_path = None
        self.fan_paths = []  # (label, path)

        for hwmon in sorted(glob.glob(os.path.join(HWMON_ROOT, "hwmon*"))):
            name = _read(os.path.join(hwmon, "name"))
            if name == "k10temp":
                # Prefer the Tctl reading
                for tp in sorted(glob.glob(os.path.join(hwmon, "temp*_input"))):
                    label = _read(tp.replace("_input", "_label"))
                    if label in (None, "Tctl"):
                        self.cpu_temp_path = tp
                        break
            elif name == "coretemp" and self.cpu_temp_path is None:
                inputs = sorted(glob.glob(os.path.join(hwmon, "temp*_input")))
                if inputs:
                    self.cpu_temp_path = inputs[0]
            elif name == "nvme" and self.nvme_temp_path is None:
                inputs = sorted(glob.glob(os.path.join(hwmon, "temp*_input")))
                if inputs:
                    self.nvme_temp_path = inputs[0]

            for fp in sorted(glob.glob(os.path.join(hwmon, "fan*_input"))):
                label = _read(fp.replace("_input", "_label")) or f"{name} fan"
                self.fan_paths.append((label, fp))

    def read(self):
        out = {}
        v = _read_int(self.cpu_temp_path) if self.cpu_temp_path else None
        out["cpuTemp"] = v / 1000 if v is not None else None
        v = _read_int(self.nvme_temp_path) if self.nvme_temp_path else None
        out["nvmeTemp"] = v / 1000 if v is not None else None
        fans = []
        for label, path in self.fan_paths:
            rpm = _read_int(path)
            if rpm is not None:
                fans.append({"label": label, "rpm": rpm})
        out["fans"] = fans
        return out


class AmdGpu:
    """AMD GPU stats from /sys/class/drm + amdgpu hwmon."""

    def __init__(self):
        self.dev = None
        self.hwmon = None
        for card in sorted(glob.glob("/sys/class/drm/card*/device/gpu_busy_percent")):
            self.dev = os.path.dirname(card)
            hw = glob.glob(os.path.join(self.dev, "hwmon", "hwmon*"))
            self.hwmon = hw[0] if hw else None
            break

    @property
    def available(self):
        return self.dev is not None

    def read(self):
        if not self.dev:
            return None
        out = {
            "busy": _read_int(os.path.join(self.dev, "gpu_busy_percent")),
            "vramUsed": _read_int(os.path.join(self.dev, "mem_info_vram_used")),
            "vramTotal": _read_int(os.path.join(self.dev, "mem_info_vram_total")),
            "temp": None,
            "powerW": None,
            "freqMHz": None,
        }
        if self.hwmon:
            t = _read_int(os.path.join(self.hwmon, "temp1_input"))
            out["temp"] = t / 1000 if t is not None else None
            p = _read_int(os.path.join(self.hwmon, "power1_average")) or _read_int(
                os.path.join(self.hwmon, "power1_input")
            )
            out["powerW"] = p / 1_000_000 if p is not None else None
            f = _read_int(os.path.join(self.hwmon, "freq1_input"))
            out["freqMHz"] = f // 1_000_000 if f is not None else None
        return out


class StatsCollector:
    def __init__(self, disks):
        self.hwmon = HwmonSensors()
        self.gpu = AmdGpu()
        self.disks = disks
        psutil.cpu_percent(percpu=True)  # prime the counters

    def read(self):
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()
        freq = psutil.cpu_freq()
        sys_stats = {
            "cpu": psutil.cpu_percent(),
            "cores": psutil.cpu_percent(percpu=True),
            "freqMHz": int(freq.current) if freq else None,
            "load": list(os.getloadavg()),
            "mem": {"used": vm.used, "total": vm.total, "pct": vm.percent},
            "swap": {"used": sw.used, "total": sw.total, "pct": sw.percent},
            "uptime": int(time.time() - psutil.boot_time()),
            "disks": [],
        }
        seen_devices = set()
        for mount in self.disks:
            try:
                dev = None
                for p in psutil.disk_partitions(all=False):
                    if p.mountpoint == mount:
                        dev = p.device
                        break
                if dev in seen_devices:
                    continue
                du = psutil.disk_usage(mount)
                seen_devices.add(dev)
                sys_stats["disks"].append(
                    {"mount": mount, "used": du.used, "total": du.total, "pct": du.percent}
                )
            except OSError:
                continue
        sys_stats.update(self.hwmon.read())
        return {"sys": sys_stats, "gpu": self.gpu.read()}
