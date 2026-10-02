"""Pipeline kamera yang bisa diganti saat berjalan (dari halaman Pengaturan Kamera).

Satu pipeline = kamera + ring buffer garis finish + photocell virtual + arsip
frame. `reconfigure()` menghentikan pipeline lama, mencoba yang baru, dan bila
gagal (mis. kamera tidak bisa dibuka) otomatis kembali ke pengaturan lama.
"""
from __future__ import annotations

import logging
import threading
from typing import Callable

from . import slitscan
from .camera import CameraError, CameraSource
from .clock import now_ns
from .frames import FrameArchive
from .ringbuffer import LineRing
from .settings import CameraSettings
from .trigger import LineTrigger

log = logging.getLogger(__name__)


class LatestFrame:
    """Frame terakhir dari kamera (untuk cuplikan standby), aman antar-thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ts = 0
        self._frame = None

    def set(self, ts: int, frame) -> None:
        with self._lock:
            self._ts, self._frame = ts, frame

    def get(self):
        with self._lock:
            return self._ts, self._frame


class Pipeline:
    def __init__(self, settings: CameraSettings, buffer_seconds: float) -> None:
        self.settings = settings
        self.buffer_seconds = buffer_seconds
        self.latest = LatestFrame()
        self.on_trigger: Callable[[int], None] | None = None
        self.camera: CameraSource | None = None
        self.ring: LineRing | None = None
        self.archive: FrameArchive | None = None
        self.trigger: LineTrigger | None = None
        self.finish_line: slitscan.FinishLine | None = None  # garis efektif (otomatis = tengah)
        self.size: tuple[int, int] | None = None
        self.last_error: str | None = None
        self.notice: str | None = None  # peringatan non-fatal (mis. garis finish disesuaikan)
        self._lock = threading.Lock()

    # ------------------------------------------------------------ siklus hidup
    def start(self) -> None:
        s = self.settings
        camera = CameraSource(s.source, s.fps, s.width, s.height)
        first = camera.snapshot()  # CameraError bila gagal
        h, w = first.shape[:2]
        auto = slitscan.FinishLine(w / 2, 0, w / 2, h - 1)
        line = s.finish_line or auto
        self.notice = None
        fl = s.finish_line
        if fl and not all(0 <= v <= lim for v, lim in ((fl.x1, w), (fl.x2, w), (fl.y1, h), (fl.y2, h))):
            # Koordinat dari kamera/resolusi lain — jangan diam-diam memakai tepi gambar.
            self.notice = f"Garis finish di luar gambar {w}×{h} — memakai garis tegak otomatis di tengah. Atur ulang garis finish."
            log.warning(self.notice)
            line = auto
        coords = slitscan.line_coords(line, w, h)
        capacity = max(1, int(s.fps * self.buffer_seconds))
        ring = LineRing(capacity, line_len=len(coords[0]), channels=first.shape[2] if first.ndim == 3 else 1)
        archive = FrameArchive(s.frames, s.fps) if s.frames else None
        trigger = LineTrigger(s.trigger) if s.trigger else None

        def on_frame(ts: int, frame) -> None:
            sample = slitscan.sample_line(frame, coords)
            ring.push(ts, sample)
            self.latest.set(ts, frame)
            if archive is not None:
                archive.push(ts, frame)
            if trigger is not None:
                fired = trigger.update(ts, sample)
                if fired is not None and self.on_trigger:
                    self.on_trigger(fired)

        self.camera, self.ring, self.archive, self.trigger = camera, ring, archive, trigger
        self.finish_line, self.size = line, (w, h)
        camera.start(on_frame)
        log.info("Kamera %s (%s) %dx%d, buffer %d frame (%.0f dtk @ %.0f fps)", s.source, s.source_type, w, h, capacity, self.buffer_seconds, s.fps)
        if archive:
            log.info("Arsip frame utuh AKTIF (%.0f fps, lebar %d px)", archive.fps, s.frames.width)
        if trigger:
            log.info("Photocell virtual AKTIF (ambang %.0f, rangkaian min %.0f%% garis)", s.trigger.threshold, s.trigger.min_run * 100)

    def stop(self) -> None:
        if self.camera:
            self.camera.stop()
        if self.archive:
            self.archive.stop()
        self.camera = None

    def reconfigure(self, new: CameraSettings) -> tuple[bool, str | None]:
        """Ganti pengaturan saat berjalan. Gagal → kembali ke pengaturan lama."""
        with self._lock:
            old = self.settings
            self.stop()
            self.settings = new
            try:
                self.start()
                self.last_error = None
                return True, None
            except CameraError as err:
                log.error("Pengaturan baru gagal (%s) — kembali ke pengaturan lama", err)
                self.settings = old
                try:
                    self.start()
                except CameraError as err2:
                    log.error("Pengaturan lama juga gagal: %s", err2)
                self.last_error = str(err)
                return False, str(err)

    # ------------------------------------------------------------ status untuk web
    def status(self) -> dict:
        w, h = self.size or (0, 0)
        fl = self.finish_line
        return {
            "settings": self.settings.to_dict(),
            "running": self.camera is not None,
            "width": w, "height": h,
            "measuredFps": round(getattr(self.camera, "measured_fps", 0.0), 1) if self.camera else 0.0,
            # ms sejak frame terakhir — besar berarti kamera tidak mengirim gambar
            "lastFrameAgeMs": (now_ns() - self.latest.get()[0]) // 1_000_000 if self.latest.get()[0] else None,
            "finishLine": None if fl is None else {"x1": fl.x1, "y1": fl.y1, "x2": fl.x2, "y2": fl.y2},
            "lastError": self.last_error,
            "notice": self.notice,
        }
