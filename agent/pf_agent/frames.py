"""Arsip frame utuh (JPEG) untuk tinjauan frame-demi-frame.

Slit-scan hanya menyimpan garis finish — sumbu horizontalnya waktu, sehingga
benda tampak "gepeng" atau melebar tergantung kecepatannya. Untuk melihat
perahu dengan proporsi asli, agent juga menyimpan frame utuh (diperkecil &
dikompres) di ring buffer terpisah, lalu menulis frame di sekitar pemicu ke
folder rekaman.

Encoding JPEG dilakukan di thread terpisah agar thread kamera tidak
tertahan; bila encoder kewalahan, frame arsip dilewati (garis finish untuk
slit-scan tetap utuh setiap frame).
"""
from __future__ import annotations

import logging
import queue
import threading
from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class FrameArchiveConfig:
    max_fps: float = 60.0     # batas frame arsip per detik (hemat CPU/RAM di kamera 240 fps)
    width: int = 1280         # lebar maksimum frame arsip (px)
    quality: int = 85         # kualitas JPEG
    seconds: float = 20.0     # panjang ring buffer (samakan dengan PF_BUFFER_SECONDS)


class FrameArchive:
    def __init__(self, cfg: FrameArchiveConfig, camera_fps: float) -> None:
        self.cfg = cfg
        self.fps = max(1.0, min(cfg.max_fps, camera_fps))
        self._min_gap_ns = int(1e9 / self.fps * 0.9)
        self._frames: deque[tuple[int, bytes]] = deque(maxlen=max(1, int(self.fps * cfg.seconds)))
        self._lock = threading.Lock()
        self._queue: queue.Queue[tuple[int, np.ndarray]] = queue.Queue(maxsize=16)
        self._last_kept = -(10**18)
        self._stop = threading.Event()
        self.scale = 1.0  # frame arsip / frame asli (untuk overlay garis finish)
        self.dropped = 0
        self._thread = threading.Thread(target=self._encode_loop, name="frame-archive", daemon=True)
        self._thread.start()

    def push(self, ts_ns: int, frame: np.ndarray) -> None:
        """Dipanggil dari thread kamera — tidak pernah memblokir."""
        if ts_ns - self._last_kept < self._min_gap_ns:
            return
        self._last_kept = ts_ns
        try:
            self._queue.put_nowait((ts_ns, frame))
        except queue.Full:
            self.dropped += 1

    def encode(self, frame: np.ndarray) -> bytes:
        h, w = frame.shape[:2]
        if w > self.cfg.width:
            self.scale = self.cfg.width / w
            frame = cv2.resize(frame, (self.cfg.width, round(h * self.scale)), interpolation=cv2.INTER_AREA)
        else:
            self.scale = 1.0
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.cfg.quality])
        if not ok:
            raise RuntimeError("Gagal meng-encode frame arsip")
        return buf.tobytes()

    def _encode_loop(self) -> None:
        while not self._stop.is_set():
            try:
                ts, frame = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                jpeg = self.encode(frame)
            except Exception as err:  # noqa: BLE001
                log.debug("frame arsip gagal: %s", err)
                continue
            with self._lock:
                self._frames.append((ts, jpeg))

    def flush(self, timeout_s: float = 2.0) -> None:
        """Tunggu antrean encode kosong (dipakai sebelum ekstraksi & di tes)."""
        deadline = threading.Event()
        waited = 0.0
        while not self._queue.empty() and waited < timeout_s:
            deadline.wait(0.02)
            waited += 0.02

    def window(self, from_ns: int, to_ns: int) -> list[tuple[int, bytes]]:
        with self._lock:
            return [(ts, j) for ts, j in self._frames if from_ns <= ts <= to_ns]

    def stop(self) -> None:
        self._stop.set()
