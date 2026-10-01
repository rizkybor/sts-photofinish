"""Photocell virtual: memicu rekaman saat ada benda (haluan perahu) menyentuh garis finish.

Bekerja pada garis piksel finish yang sudah diambil tiap frame (bukan frame penuh),
jadi murah dijalankan di 240 fps.

Cara kerja:
- Latar garis finish (air, tepi sungai) dimodelkan per piksel dengan rata-rata
  bergerak — beradaptasi dengan perubahan cahaya, tapi TIDAK diperbarui selama
  ada benda di garis.
- Piksel dianggap "berubah" bila selisih TERBESAR di antara kanal B/G/R
  terhadap latar > ``threshold``. Warna, bukan kecerahan: perahu karet
  merah bisa hampir sama terangnya dengan air, tapi warnanya jauh berbeda.
- Perahu adalah satu blok utuh, sedangkan riak/percikan air tersebar. Karena
  itu yang diukur adalah **rangkaian piksel berubah terpanjang** (relatif
  terhadap panjang garis), bukan jumlah total piksel berubah.
- Pemicu terjadi bila rangkaian itu ≥ ``min_run`` selama ``confirm_frames``
  frame berturut-turut. Waktu pemicu = frame PERTAMA yang aktif.
- Setelah memicu, detektor menunggu garis bersih selama ``release_s`` detik
  sebelum boleh memicu lagi. Perahu berdempetan tetap masuk satu rekaman
  karena API menggabungkan pemicu ≤ 3 dtk menjadi satu kelompok finish.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class TriggerConfig:
    threshold: float = 30.0      # selisih warna (0–255, kanal terbesar) agar piksel dianggap berubah
    min_run: float = 0.06        # rangkaian berubah minimal, fraksi panjang garis
    confirm_frames: int = 2      # frame aktif berturut-turut sebelum memicu
    release_s: float = 0.5       # garis harus bersih selama ini sebelum boleh memicu lagi
    alpha: float = 0.03          # kecepatan adaptasi latar
    warmup_frames: int = 15      # frame awal untuk membangun latar (tidak memicu)


def longest_run(mask: np.ndarray) -> int:
    """Panjang rangkaian True terpanjang dalam array 1-D."""
    if not mask.any():
        return 0
    padded = np.concatenate(([0], mask.astype(np.int8), [0]))
    edges = np.flatnonzero(np.diff(padded))
    return int((edges[1::2] - edges[::2]).max())


class LineTrigger:
    def __init__(self, cfg: TriggerConfig | None = None) -> None:
        self.cfg = cfg or TriggerConfig()
        self._bg: np.ndarray | None = None
        self._frames = 0
        self._active_since: int | None = None  # ts frame pertama yang aktif
        self._active_count = 0
        self._armed = True                     # boleh memicu
        self._clear_since: int | None = None
        self.last_score = 0.0                  # untuk log/diagnosa

    @staticmethod
    def _pixels(line: np.ndarray) -> np.ndarray:
        line = line.astype(np.float32)
        return line if line.ndim == 2 else line[:, None]

    def update(self, ts_ns: int, line: np.ndarray) -> int | None:
        """Masukkan satu garis frame; kembalikan ts pemicu (ns) bila memicu."""
        g = self._pixels(line)
        if self._bg is None or self._bg.shape != g.shape:
            self._bg = g.copy()
            self._frames = 0
        self._frames += 1

        changed = np.abs(g - self._bg).max(axis=1) > self.cfg.threshold
        score = longest_run(changed) / max(1, g.shape[0])
        self.last_score = score
        active = score >= self.cfg.min_run and self._frames > self.cfg.warmup_frames

        fired: int | None = None
        if active:
            self._clear_since = None
            if self._active_count == 0:
                self._active_since = ts_ns
            self._active_count += 1
            if self._armed and self._active_count >= self.cfg.confirm_frames:
                fired = self._active_since
                self._armed = False
        else:
            self._active_count = 0
            self._active_since = None
            if not self._armed:
                if self._clear_since is None:
                    self._clear_since = ts_ns
                elif ts_ns - self._clear_since >= self.cfg.release_s * 1e9:
                    self._armed = True
            # Latar hanya belajar saat garis bersih (benda tidak "terserap" ke latar).
            self._bg += self.cfg.alpha * (g - self._bg) if self._frames > self.cfg.warmup_frames else (g - self._bg) / self._frames
        return fired
