"""Gambar slit-scan: setiap kolom = garis finish pada satu frame.

Sumbu horizontal adalah WAKTU (kiri = lebih awal), sumbu vertikal adalah posisi
di sepanjang garis finish. Haluan perahu yang lebih dulu menyentuh garis muncul
lebih ke kiri — ini yang dibaca juri untuk menentukan urutan.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class FinishLine:
    """Garis finish di frame kamera, sejajar tiang photocell (piksel)."""

    x1: float
    y1: float
    x2: float
    y2: float

    @classmethod
    def parse(cls, text: str) -> "FinishLine":
        parts = [float(p) for p in text.split(",")]
        if len(parts) != 4:
            raise ValueError("Format garis finish: x1,y1,x2,y2")
        return cls(*parts)

    def length(self) -> int:
        return max(2, int(round(np.hypot(self.x2 - self.x1, self.y2 - self.y1))) + 1)


def line_coords(line: FinishLine, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Koordinat piksel (nearest neighbour) di sepanjang garis, dijepit ke dalam frame."""
    n = line.length()
    xs = np.clip(np.rint(np.linspace(line.x1, line.x2, n)), 0, width - 1).astype(np.intp)
    ys = np.clip(np.rint(np.linspace(line.y1, line.y2, n)), 0, height - 1).astype(np.intp)
    return ys, xs


def sample_line(frame: np.ndarray, coords: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    ys, xs = coords
    return frame[ys, xs]


def build(lines: np.ndarray) -> np.ndarray:
    """(frames, line_len, C) → gambar (line_len, frames, C)."""
    if lines.ndim != 3 or lines.shape[0] == 0:
        raise ValueError("Tidak ada frame di jendela waktu ini")
    return np.ascontiguousarray(lines.transpose(1, 0, 2))
