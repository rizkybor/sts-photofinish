"""Ring buffer berisi garis piksel finish per frame, bertimestamp.

Hanya garis di posisi finish yang disimpan (bukan frame penuh): 240 fps × 20 dtk
frame 1080p penuh ≈ 9 GB, sedangkan garisnya saja ≈ 15 MB — cukup untuk slit-scan.
"""
from __future__ import annotations

import threading

import numpy as np


class LineRing:
    def __init__(self, capacity: int, line_len: int, channels: int = 3) -> None:
        if capacity <= 0:
            raise ValueError("capacity harus > 0")
        self._ts = np.zeros(capacity, dtype=np.int64)
        self._lines = np.zeros((capacity, line_len, channels), dtype=np.uint8)
        self._capacity = capacity
        self._count = 0  # total frame yang pernah masuk
        self._lock = threading.Lock()

    def push(self, ts_ns: int, line: np.ndarray) -> None:
        with self._lock:
            i = self._count % self._capacity
            self._ts[i] = ts_ns
            self._lines[i] = line
            self._count += 1

    @property
    def latest_ns(self) -> int | None:
        with self._lock:
            return None if self._count == 0 else int(self._ts[(self._count - 1) % self._capacity])

    @property
    def oldest_ns(self) -> int | None:
        with self._lock:
            if self._count == 0:
                return None
            start = max(0, self._count - self._capacity)
            return int(self._ts[start % self._capacity])

    def window(self, from_ns: int, to_ns: int) -> tuple[np.ndarray, np.ndarray]:
        """Salinan (timestamps, lines) dengan from_ns <= ts <= to_ns, urut waktu."""
        with self._lock:
            n = min(self._count, self._capacity)
            start = self._count - n
            idx = np.arange(start, self._count) % self._capacity
            ts = self._ts[idx]
            mask = (ts >= from_ns) & (ts <= to_ns)
            return ts[mask].copy(), self._lines[idx[mask]].copy()
