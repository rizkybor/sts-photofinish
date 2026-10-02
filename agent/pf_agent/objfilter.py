"""Filter objek: pemicu photocell virtual hanya diteruskan bila yang melintas
garis finish benar-benar objek yang dipilih (perahu, motor, …).

Photocell virtual tetap menjadi PENENTU WAKTU (cepat, per frame, presisi
kolom). Filter ini hanya MEMERIKSA pemicunya: frame saat pemicu dijalankan
lewat detektor objek (YOLO) di thread terpisah; bila tidak ada objek kelas
terpilih yang menyentuh garis finish, pemicu dibuang (orang lewat, burung,
ranting, riak, bayangan). Bila frame pertama belum jelas (haluan baru masuk
garis), satu frame sesudahnya diperiksa lagi.

Fail-open: bila detektor tidak tersedia/gagal dimuat, pemicu TETAP diteruskan
(waktu finish tidak boleh hilang karena filter) dan status menampilkan error.

Detektor: paket opsional `ultralytics` (pip install -e ".[detect]").
Model bawaan COCO (`yolo11n.pt`) mengenal mis. "boat", "motorcycle",
"person". Model hasil latih ulang (`best.pt`) disalin ke data/models/ —
lihat docs/PANDUAN-FILTER-OBJEK.md.
"""
from __future__ import annotations

import importlib.util
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from .clock import now_ns

log = logging.getLogger(__name__)

MODELS_DIR = Path(__file__).resolve().parents[2] / "data" / "models"
BUILTIN_MODELS = ("yolo11n.pt", "yolo11s.pt")  # diunduh otomatis ke data/models/ saat pertama dipakai
MODEL_SUFFIXES = (".pt", ".onnx")


@dataclass(frozen=True)
class ObjectFilterConfig:
    classes: tuple[str, ...] = ("boat",)
    model: str = "yolo11n.pt"
    conf: float = 0.35          # keyakinan minimal deteksi
    margin: float = 0.08        # toleransi jarak kotak objek ke garis finish (fraksi lebar frame)
    recheck_s: float = 0.25     # frame pemicu belum jelas → periksa lagi frame sesudah selang ini
    imgsz: int = 640


@dataclass(frozen=True)
class Detection:
    label: str
    conf: float
    x1: float
    y1: float
    x2: float
    y2: float


class Detector(Protocol):
    names: list[str]

    def detect(self, frame: np.ndarray, conf: float, imgsz: int) -> list[Detection]: ...


def detector_available() -> bool:
    return importlib.util.find_spec("ultralytics") is not None


def resolve_model(name: str) -> Path:
    """Model bawaan (diunduh ke data/models/) atau file di data/models/. ValueError bila di luar folder itu."""
    name = name.strip()
    p = (MODELS_DIR / name).resolve()
    if MODELS_DIR.resolve() not in p.parents or p.suffix not in MODEL_SUFFIXES:
        raise ValueError("Model harus berupa file .pt/.onnx di data/models/ atau model bawaan (yolo11n.pt / yolo11s.pt)")
    if name not in BUILTIN_MODELS and not p.is_file():
        raise ValueError(f"Model tidak ditemukan: data/models/{name}")
    return p


def list_models() -> list[str]:
    found = sorted(p.name for p in MODELS_DIR.glob("*") if p.suffix in MODEL_SUFFIXES) if MODELS_DIR.is_dir() else []
    return list(dict.fromkeys([*found, *BUILTIN_MODELS]))


class YoloDetector:
    """Detektor ultralytics YOLO. Model dimuat sekali per path (dipakai ulang saat pengaturan berganti)."""

    _cache: dict[str, "YoloDetector"] = {}
    _cache_lock = threading.Lock()

    def __init__(self, path: Path) -> None:
        from ultralytics import YOLO  # impor lambat — paket opsional & berat

        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        self.model = YOLO(str(path))
        self.names = [str(n) for n in (self.model.names.values() if isinstance(self.model.names, dict) else self.model.names)]
        self.device = self._device()
        # Pemanasan: inferensi pertama lambat (kompilasi kernel) — jangan terjadi saat finish.
        self.model.predict(np.zeros((320, 320, 3), dtype=np.uint8), verbose=False, device=self.device, imgsz=320)

    @staticmethod
    def _device() -> str:
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
            if torch.backends.mps.is_available():
                return "mps"
        except Exception:  # noqa: BLE001
            pass
        return "cpu"

    @classmethod
    def load(cls, model: str) -> "YoloDetector":
        path = resolve_model(model)
        with cls._cache_lock:
            if str(path) not in cls._cache:
                cls._cache[str(path)] = cls(path)
            return cls._cache[str(path)]

    def detect(self, frame: np.ndarray, conf: float, imgsz: int) -> list[Detection]:
        r = self.model.predict(frame, conf=conf, imgsz=imgsz, verbose=False, device=self.device)[0]
        out = []
        for (x1, y1, x2, y2), c, k in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist(), r.boxes.cls.int().tolist()):
            out.append(Detection(self.names[k], float(c), x1, y1, x2, y2))
        return out


@dataclass
class _Job:
    ts: int
    frame: np.ndarray
    line_x: float
    forward: Callable[[int], None]


@dataclass
class FilterStats:
    passed: int = 0
    rejected: int = 0
    last_label: str | None = None      # objek terakhir yang lolos, mis. "boat 0.82"
    last_rejected: str | None = None   # alasan penolakan terakhir, mis. "person 0.71"
    last_ms: float | None = None       # waktu periksa terakhir
    recent: list[dict] = field(default_factory=list)


class ObjectFilter:
    def __init__(
        self,
        cfg: ObjectFilterConfig,
        latest: Callable[[], tuple[int, np.ndarray | None]],
        loader: Callable[[str], Detector] | None = None,
    ) -> None:
        self.cfg = cfg
        self._latest = latest
        self._loader = loader or YoloDetector.load
        self._jobs: queue.Queue[_Job | None] = queue.Queue(maxsize=32)
        self._thread: threading.Thread | None = None
        self.detector: Detector | None = None
        self.error: str | None = None
        self.stats = FilterStats()

    # ------------------------------------------------------------ siklus hidup
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="object-filter", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._thread:
            try:
                self._jobs.put_nowait(None)
            except queue.Full:
                pass
            self._thread.join(timeout=2)
            self._thread = None

    def submit(self, ts: int, frame: np.ndarray, line_x: float, forward: Callable[[int], None]) -> None:
        """Dipanggil dari thread kamera — salin frame, jangan blok."""
        try:
            self._jobs.put_nowait(_Job(ts, frame.copy(), line_x, forward))
        except queue.Full:
            log.warning("Antrean filter objek penuh — pemicu diteruskan tanpa diperiksa")
            forward(ts)

    # ------------------------------------------------------------ pemeriksaan
    def match(self, dets: list[Detection], line_x: float, width: int) -> Detection | None:
        """Objek kelas terpilih yang kotaknya menyentuh garis finish (dengan toleransi)."""
        m = self.cfg.margin * width
        wanted = {c.lower() for c in self.cfg.classes}
        hits = [d for d in dets if d.label.lower() in wanted and d.x1 - m <= line_x <= d.x2 + m]
        return max(hits, key=lambda d: d.conf, default=None)

    def _ensure_detector(self) -> bool:
        if self.detector is not None:
            return True
        if self.error:
            return False
        try:
            t0 = time.perf_counter()
            self.detector = self._loader(self.cfg.model)
            log.info("Filter objek siap: %s (%s) dalam %.1f dtk — kelas: %s",
                     self.cfg.model, getattr(self.detector, "device", "?"), time.perf_counter() - t0, ", ".join(self.cfg.classes))
            missing = [c for c in self.cfg.classes if c.lower() not in {n.lower() for n in self.detector.names}]
            if missing:
                log.warning("Kelas %s tidak dikenal model %s", ", ".join(missing), self.cfg.model)
            return True
        except Exception as err:  # noqa: BLE001 — fail-open, tampilkan di web
            self.error = f"Filter objek tidak aktif: {err}"
            log.error("%s — pemicu diteruskan tanpa filter", self.error)
            return False

    def _check(self, frame: np.ndarray, line_x: float) -> tuple[Detection | None, list[Detection]]:
        dets = self.detector.detect(frame, self.cfg.conf, self.cfg.imgsz)  # type: ignore[union-attr]
        return self.match(dets, line_x, frame.shape[1]), dets

    def _run(self) -> None:
        self._ensure_detector()  # gagal → tetap jalan, setiap pemicu diteruskan (fail-open)
        while True:
            job = self._jobs.get()
            if job is None:
                return
            if self.detector is None:
                job.forward(job.ts)
                continue
            t0 = time.perf_counter()
            try:
                hit, dets = self._check(job.frame, job.line_x)
                if hit is None and self.cfg.recheck_s > 0:
                    # Haluan baru menyentuh garis — objek belum utuh di frame pemicu.
                    wait = job.ts / 1e9 + self.cfg.recheck_s - now_ns() / 1e9
                    if wait > 0:
                        time.sleep(min(wait, 1.0))
                    _ts, later = self._latest()
                    if later is not None:
                        hit, more = self._check(later, job.line_x)
                        dets = dets + more
            except Exception as err:  # noqa: BLE001
                log.error("Filter objek gagal memeriksa (%s) — pemicu diteruskan", err)
                job.forward(job.ts)
                continue
            self.stats.last_ms = round((time.perf_counter() - t0) * 1000, 1)
            seen = ", ".join(sorted({f"{d.label} {d.conf:.2f}" for d in dets})) or "tidak ada objek"
            if hit is not None:
                self.stats.passed += 1
                self.stats.last_label = f"{hit.label} {hit.conf:.2f}"
                log.info("Filter objek: %s melintas — pemicu diteruskan (%.0f ms)", self.stats.last_label, self.stats.last_ms)
                job.forward(job.ts)
            else:
                self.stats.rejected += 1
                self.stats.last_rejected = seen
                log.info("Filter objek: pemicu diabaikan — terlihat: %s", seen)
            self.stats.recent = ([{"at": job.ts, "ok": hit is not None, "seen": self.stats.last_label if hit else seen}] + self.stats.recent)[:10]

    def status(self) -> dict:
        s = self.stats
        return {
            "enabled": True, "ready": self.detector is not None, "error": self.error,
            "classes": list(self.cfg.classes), "model": self.cfg.model, "conf": self.cfg.conf,
            "modelClasses": list(self.detector.names) if self.detector else [],
            "passed": s.passed, "rejected": s.rejected, "lastLabel": s.last_label, "lastRejected": s.last_rejected,
            "lastMs": s.last_ms, "recent": s.recent,
        }
