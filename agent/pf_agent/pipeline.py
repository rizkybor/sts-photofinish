"""Pipeline kamera yang bisa diganti saat berjalan (dari halaman Pengaturan Kamera).

Satu pipeline = kamera + ring buffer garis finish + photocell virtual + arsip
frame. `reconfigure()` menghentikan pipeline lama, mencoba yang baru, dan bila
gagal (mis. kamera tidak bisa dibuka) otomatis kembali ke pengaturan lama.
Bila kamera tidak bisa dibuka sama sekali (dicabut, iPhone menjauh, dipakai
aplikasi lain), `run_forever()` terus mencoba membukanya setiap beberapa detik —
agent tetap tersambung sehingga sumber kamera bisa diganti dari web.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from . import slitscan
from .camera import CameraError, CameraSource
from .clock import now_ns
from .frames import FrameArchive
from .objfilter import ObjectFilter, detector_available, list_models
from .ringbuffer import LineRing
from .settings import CameraSettings
from .trigger import LineTrigger
from .battery import host_battery

log = logging.getLogger(__name__)

RETRY_S = 3.0
# Tanpa frame selama ini (iPhone mati/baterai habis, kabel lepas, driver macet)
# → kamera dibuka ulang dari luar thread pembaca (grab() bisa macet selamanya).
STALL_S = 6.0


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
        self.object_filter: ObjectFilter | None = None
        self.finish_line: slitscan.FinishLine | None = None  # garis efektif (otomatis = tengah)
        self.size: tuple[int, int] | None = None
        self.last_error: str | None = None
        self.notice: str | None = None  # peringatan non-fatal (mis. garis finish disesuaikan)
        self._lock = threading.RLock()
        self._closed = threading.Event()
        self._watchdog: threading.Thread | None = None

    # ------------------------------------------------------------ siklus hidup
    def run_forever(self) -> None:
        """Buka kamera sekarang bila bisa, lalu jaga di latar: bila tidak berjalan, coba lagi."""
        self._try_start()
        if self._watchdog is None:
            self._watchdog = threading.Thread(target=self._watch, name="camera-watchdog", daemon=True)
            self._watchdog.start()

    def _try_start(self) -> bool:
        with self._lock:
            if self.camera is not None or self._closed.is_set():
                return True
            try:
                self.start()
                if self.last_error:
                    log.info("Kamera %s berhasil dibuka", self.settings.source)
                self.last_error = None
                return True
            except CameraError as err:
                if str(err) != self.last_error:
                    log.error("%s — mencoba lagi setiap %.0f dtk", err, RETRY_S)
                self.last_error = str(err)
                return False

    def frame_age_ms(self) -> int | None:
        ts = self.latest.get()[0]
        return (now_ns() - ts) // 1_000_000 if ts else None

    def _watch(self) -> None:
        while not self._closed.wait(RETRY_S):
            if self.camera is None:
                self._try_start()
                continue
            age = self.frame_age_ms()
            if age is not None and age > STALL_S * 1000:
                with self._lock:
                    if self.camera is None or self._closed.is_set():
                        continue
                    self.last_error = f"Kamera {self.settings.source} berhenti mengirim gambar ({age / 1000:.0f} dtk) — mati, baterai habis, atau terputus. Membuka ulang…"
                    log.error(self.last_error)
                    self.stop()
                    self.latest.set(0, None)  # jangan anggap frame lama masih segar
                self._try_start()

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            self.stop()

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
        # Filter objek hanya bermakna bila photocell virtual aktif (ia memeriksa pemicunya).
        object_filter = ObjectFilter(s.object_filter, self.latest.get) if (s.object_filter and trigger) else None
        line_x = (line.x1 + line.x2) / 2

        def emit(ts: int) -> None:
            if self.on_trigger:
                self.on_trigger(ts)

        def on_frame(ts: int, frame) -> None:
            sample = slitscan.sample_line(frame, coords)
            ring.push(ts, sample)
            self.latest.set(ts, frame)
            if archive is not None:
                archive.push(ts, frame)
            if trigger is not None:
                fired = trigger.update(ts, sample)
                if fired is not None:
                    if object_filter is not None:
                        object_filter.submit(fired, frame, line_x, emit)
                    else:
                        emit(fired)

        if object_filter is not None:
            object_filter.start()
        self.camera, self.ring, self.archive, self.trigger, self.object_filter = camera, ring, archive, trigger, object_filter
        self.finish_line, self.size = line, (w, h)
        camera.start(on_frame)
        log.info("Kamera %s (%s) %dx%d, buffer %d frame (%.0f dtk @ %.0f fps)", s.source, s.source_type, w, h, capacity, self.buffer_seconds, s.fps)
        if archive:
            log.info("Arsip frame utuh AKTIF (%.0f fps, lebar %d px)", archive.fps, s.frames.width)
        if object_filter:
            log.info("Filter objek AKTIF: %s (model %s) — memuat model di latar", ", ".join(s.object_filter.classes), s.object_filter.model)
        if trigger:
            log.info("Photocell virtual AKTIF (ambang %.0f, rangkaian min %.0f%% garis)", s.trigger.threshold, s.trigger.min_run * 100)

    def stop(self) -> None:
        if self.camera:
            self.camera.stop()
        if self.archive:
            self.archive.stop()
        if self.object_filter:
            self.object_filter.stop()
            self.object_filter = None
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
                    self.last_error = str(err)
                    return False, f"{err} — agent kembali ke pengaturan sebelumnya, perubahan tidak disimpan."
                except CameraError as err2:
                    # Watchdog terus mencoba membuka kamera lama; status web menampilkannya.
                    log.error("Pengaturan lama juga gagal: %s — terus mencoba", err2)
                    self.last_error = f"Kamera sebelumnya juga tidak bisa dibuka: {err2}"
                    return False, (
                        f"{err} Kamera sebelumnya ({old.source_type} {old.source}) juga tidak bisa dibuka — "
                        "agent terus mencoba membukanya. Periksa sambungan kamera atau pilih sumber lain."
                    )

    # ------------------------------------------------------------ status untuk web
    def status(self) -> dict:
        w, h = self.size or (0, 0)
        fl = self.finish_line
        return {
            "settings": self.settings.to_dict(),
            "running": self.camera is not None,
            "retrying": self.camera is None and not self._closed.is_set(),
            "width": w, "height": h,
            # fps terukur hanya diperbarui saat ada frame — gambar macet = 0, bukan angka lama.
            "measuredFps": round(getattr(self.camera, "measured_fps", 0.0), 1) if self.camera and (age := self.frame_age_ms()) is not None and age < 2000 else 0.0,
            # ms sejak frame terakhir — besar berarti kamera tidak mengirim gambar
            "lastFrameAgeMs": self.frame_age_ms(),
            "hostBattery": host_battery(),
            "finishLine": None if fl is None else {"x1": fl.x1, "y1": fl.y1, "x2": fl.x2, "y2": fl.y2},
            "lastError": self.last_error,
            "notice": self.notice,
            "objectFilter": self.object_filter.status() if self.object_filter else {"enabled": False},
            "detector": {"available": detector_available(), "models": list_models()},
        }
