"""Sinkron jam agent → API, gaya NTP.

Setiap sampel: t0 (kirim, jam agent), server_ns (jam API), t1 (terima, jam agent).
offset = server_ns − (t0 + t1) / 2, dengan error maksimum ±RTT/2. Sampel dengan
RTT terkecil di jendela terakhir dipakai — sampel ber-RTT besar (Wi-Fi sibuk)
paling mungkin asimetris dan tidak akurat.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass


def now_ns() -> int:
    """Jam epoch agent. Satu sumber untuk timestamp frame dan sinkron jam."""
    return time.time_ns()


@dataclass(frozen=True)
class ClockSample:
    offset_ns: int
    rtt_ns: int


class OffsetEstimator:
    def __init__(self, window: int = 32) -> None:
        self._samples: deque[ClockSample] = deque(maxlen=window)

    def add(self, t0_ns: int, server_ns: int, t1_ns: int) -> ClockSample:
        if t1_ns < t0_ns:
            raise ValueError("t1 lebih kecil dari t0")
        sample = ClockSample(offset_ns=server_ns - (t0_ns + t1_ns) // 2, rtt_ns=t1_ns - t0_ns)
        self._samples.append(sample)
        return sample

    @property
    def ready(self) -> bool:
        return bool(self._samples)

    def best(self) -> ClockSample:
        if not self._samples:
            raise RuntimeError("Belum ada sampel sinkron jam")
        return min(self._samples, key=lambda s: s.rtt_ns)

    def host_to_agent(self, host_ns: int) -> int:
        """Jam API → jam agent (offset = API − agent)."""
        return host_ns - self.best().offset_ns
