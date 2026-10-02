"""Pembaca kamera. Timestamp diambil tepat setelah grab() memakai jam agent.

Latensi sensor/USB yang konstan antara cahaya masuk dan grab() terserap oleh
kalibrasi lapangan (docs/ARCHITECTURE.md §5). Untuk kamera industri dengan
timestamp hardware, ganti sumber timestamp di sini.

PF_CAMERA_SOURCE:
  - angka ("0")        → kamera USB/UVC lokal
  - rtsp:// / http://  → kamera IP
  - path file video    → mode replay (uji tanpa kamera); frame diputar sesuai
                         fps file dan diberi timestamp seolah-olah live
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path

import cv2
import numpy as np

from .clock import now_ns

log = logging.getLogger(__name__)

FrameHandler = Callable[[int, np.ndarray], None]


class CameraError(RuntimeError):
    """Kamera tidak bisa dibuka/dibaca — bisa ditangkap (mis. untuk kembali ke pengaturan lama)."""


class CameraSource:
    def __init__(self, source: str, fps: float, width: int | None, height: int | None) -> None:
        self.source = source
        self.replay = not source.isdigit() and Path(source).is_file()
        self._target_fps = fps
        self._width = width
        self._height = height
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.measured_fps = 0.0
        self.frame_size: tuple[int, int] | None = None  # (width, height)

    def open(self) -> cv2.VideoCapture:
        cap = cv2.VideoCapture(int(self.source) if self.source.isdigit() else self.source)
        if not cap.isOpened():
            raise CameraError(f"Kamera tidak bisa dibuka: {self.source}")
        if not self.replay:
            if self._width:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
            if self._height:
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
            cap.set(cv2.CAP_PROP_FPS, self._target_fps)
        return cap

    def snapshot(self, warmup_s: float = 5.0) -> np.ndarray:
        # Kamera USB/FaceTime di macOS sering mengembalikan frame kosong sesaat
        # setelah dibuka (sensor belum siap) — coba terus beberapa detik.
        cap = self.open()
        try:
            deadline = time.monotonic() + warmup_s
            while True:
                ok, frame = cap.read()
                if ok and frame is not None:
                    return frame
                if time.monotonic() > deadline:
                    raise CameraError(
                        "Gagal membaca frame dari kamera. Periksa: (1) izin kamera untuk aplikasi terminal di "
                        "System Settings → Privacy & Security → Camera, lalu buka ulang terminal; "
                        "(2) kamera tidak sedang dipakai aplikasi lain (FaceTime/Zoom/Meet)."
                    )
                time.sleep(0.1)
        finally:
            cap.release()

    def start(self, on_frame: FrameHandler) -> None:
        self._thread = threading.Thread(target=self._run, args=(on_frame,), name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _run(self, on_frame: FrameHandler) -> None:
        cap = self.open()
        replay_period = 1.0 / (cap.get(cv2.CAP_PROP_FPS) or self._target_fps) if self.replay else 0.0
        next_due = time.perf_counter()
        frames, window_start = 0, time.perf_counter()
        misses = 0
        try:
            while not self._stop.is_set():
                if not cap.grab():
                    if self.replay:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # putar ulang
                        continue
                    misses += 1
                    self.measured_fps = 0.0
                    if misses % 4 == 0:
                        # ±2 dtk tanpa gambar (mis. iPhone Continuity Camera terputus,
                        # kabel USB longgar): tutup lalu buka ulang perangkat.
                        log.error("Kamera %s tidak mengirim gambar — membuka ulang perangkat", self.source)
                        cap.release()
                        try:
                            cap = self.open()
                        except CameraError as err:
                            log.error("%s — mencoba lagi", err)
                            cap = cv2.VideoCapture()  # objek kosong; grab() gagal → dicoba lagi
                    time.sleep(0.5)
                    continue
                if misses:
                    log.info("Kamera %s kembali mengirim gambar", self.source)
                    misses = 0
                ts = now_ns()
                ok, frame = cap.retrieve()
                if not ok:
                    continue
                if self.frame_size is None:
                    self.frame_size = (frame.shape[1], frame.shape[0])
                on_frame(ts, frame)

                frames += 1
                elapsed = time.perf_counter() - window_start
                if elapsed >= 2.0:
                    self.measured_fps = frames / elapsed
                    frames, window_start = 0, time.perf_counter()
                if self.replay:
                    next_due += replay_period
                    time.sleep(max(0.0, next_due - time.perf_counter()))
        finally:
            cap.release()
