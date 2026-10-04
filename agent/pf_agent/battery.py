"""Baterai laptop agent (macOS). Laptop mati = kamera & rekaman ikut mati.

Baterai iPhone (Continuity Camera) tidak bisa dibaca dari Mac — kondisi itu
terdeteksi sebagai kamera berhenti mengirim gambar.
"""
from __future__ import annotations

import platform
import re
import subprocess
import time

CACHE_S = 30.0
_cache: tuple[float, dict | None] = (0.0, None)


def parse_pmset(out: str) -> dict | None:
    """'-InternalBattery-0 (id=…)	18%; discharging; 0:35 remaining' → {percent, charging}."""
    m = re.search(r"(\d+)%;\s*([a-zA-Z ]+);", out)
    if not m:
        return None
    state = m.group(2).strip().lower()
    on_ac = "AC Power" in out
    return {"percent": int(m.group(1)), "charging": on_ac or state in ("charging", "charged", "finishing charge")}


def host_battery() -> dict | None:
    """None bila bukan macOS / tanpa baterai (desktop)."""
    global _cache
    at, value = _cache
    if time.monotonic() - at < CACHE_S:
        return value
    value = None
    if platform.system() == "Darwin":
        try:
            value = parse_pmset(subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=3).stdout)
        except Exception:  # noqa: BLE001
            value = None
    _cache = (time.monotonic(), value)
    return value
