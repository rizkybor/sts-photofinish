"""Pengaturan kamera yang bisa diubah dari web (halaman Pengaturan Kamera).

Nilai awal diambil dari .env (AgentConfig); pengaturan dari web menimpanya
dan disimpan API, sehingga tetap berlaku setelah agent restart.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path

from .config import REPO_ROOT, AgentConfig
from .frames import FrameArchiveConfig
from .objfilter import ObjectFilterConfig, resolve_model
from .slitscan import FinishLine
from .trigger import TriggerConfig

VIDEO_DIR = REPO_ROOT / "data" / "test-video"
SOURCE_TYPES = ("laptop", "iphone", "external", "ip", "video")


@dataclass(frozen=True)
class CameraSettings:
    source_type: str
    source: str                       # nomor kamera, URL (http/rtsp), atau path video uji
    fps: float
    width: int | None
    height: int | None
    finish_line: FinishLine | None    # None = garis tegak otomatis di tengah frame
    trigger: TriggerConfig | None
    frames: FrameArchiveConfig | None
    object_filter: ObjectFilterConfig | None = None   # None = semua pemicu photocell diteruskan

    @classmethod
    def from_agent_config(cls, cfg: AgentConfig) -> "CameraSettings":
        src = cfg.camera_source
        kind = "ip" if re.match(r"^(https?|rtsp)://", src) else "video" if not src.isdigit() else "laptop"
        return cls(kind, src, cfg.camera_fps, cfg.frame_width, cfg.frame_height, cfg.finish_line, cfg.trigger, cfg.frames, cfg.object_filter)

    def merged(self, data: dict | None, buffer_seconds: float) -> "CameraSettings":
        """Gabungkan pengaturan dari web (dict) di atas pengaturan ini. Melempar ValueError bila tidak valid."""
        if not data:
            return self
        kind = str(data.get("sourceType", self.source_type))
        if kind not in SOURCE_TYPES:
            raise ValueError(f"Jenis sumber tidak dikenal: {kind}")
        source = str(data.get("source", self.source)).strip()
        validate_source(kind, source)
        fl = data.get("finishLine", "keep")
        finish_line = self.finish_line if fl == "keep" else None if fl is None else FinishLine(
            float(fl["x1"]), float(fl["y1"]), float(fl["x2"]), float(fl["y2"]))
        t = data.get("trigger")
        trigger = self.trigger if t is None else (
            TriggerConfig(threshold=float(t.get("threshold", 30)), min_run=float(t.get("minRun", 0.06))) if t.get("enabled") else None)
        f = data.get("frames")
        frames = self.frames if f is None else (
            FrameArchiveConfig(max_fps=float(f.get("fps", 60)), width=int(f.get("width", 1280)),
                               quality=(self.frames.quality if self.frames else 85), seconds=buffer_seconds) if f.get("enabled") else None)
        o = data.get("objectFilter")
        object_filter = self.object_filter if o is None else _object_filter(o)
        return replace(
            self, source_type=kind, source=source, fps=float(data.get("fps", self.fps)),
            width=_opt_int(data.get("width", self.width)), height=_opt_int(data.get("height", self.height)),
            finish_line=finish_line, trigger=trigger, frames=frames, object_filter=object_filter,
        )

    def to_dict(self) -> dict:
        fl = self.finish_line
        return {
            "sourceType": self.source_type, "source": self.source, "fps": self.fps, "width": self.width, "height": self.height,
            "finishLine": None if fl is None else {"x1": fl.x1, "y1": fl.y1, "x2": fl.x2, "y2": fl.y2},
            "trigger": {"enabled": self.trigger is not None,
                        "threshold": self.trigger.threshold if self.trigger else 30.0,
                        "minRun": self.trigger.min_run if self.trigger else 0.06},
            "frames": {"enabled": self.frames is not None,
                       "fps": self.frames.max_fps if self.frames else 60.0,
                       "width": self.frames.width if self.frames else 1280},
            "objectFilter": {"enabled": self.object_filter is not None,
                             "classes": list(self.object_filter.classes) if self.object_filter else ["boat"],
                             "model": self.object_filter.model if self.object_filter else "yolo11s.pt",
                             "conf": self.object_filter.conf if self.object_filter else 0.35},
        }


CLASS_RE = re.compile(r"^[\w][\w .-]{0,39}$")


def _object_filter(o: dict) -> ObjectFilterConfig | None:
    """Filter objek dari web. Kelas = nama kelas model (mis. boat, motorcycle, raft)."""
    if not o.get("enabled"):
        return None
    classes = tuple(dict.fromkeys(str(c).strip() for c in (o.get("classes") or []) if str(c).strip()))
    if not classes or len(classes) > 10 or not all(CLASS_RE.match(c) for c in classes):
        raise ValueError("Pilih 1–10 jenis objek (huruf/angka, mis. boat, motorcycle)")
    model = str(o.get("model") or "yolo11s.pt")
    resolve_model(model)  # ValueError bila di luar data/models/
    conf = float(o.get("conf", 0.35))
    if not 0.05 <= conf <= 0.95:
        raise ValueError("Keyakinan minimal harus 0,05–0,95")
    return ObjectFilterConfig(classes=classes, model=model, conf=conf)


def _opt_int(v) -> int | None:
    return None if v in (None, "", 0) else int(v)


def validate_source(kind: str, source: str) -> None:
    """Sumber dari web dibatasi: nomor kamera, URL kamera IP, atau file di data/test-video/."""
    if kind in ("laptop", "iphone", "external"):
        if not source.isdigit() or int(source) > 15:
            raise ValueError("Pilih nomor kamera hasil pindai (0–15)")
    elif kind == "ip":
        if not re.match(r"^(https?|rtsp)://[^\s]+$", source):
            raise ValueError("Alamat kamera IP harus diawali http://, https://, atau rtsp://")
    elif kind == "video":
        p = Path(source).resolve()
        if VIDEO_DIR.resolve() not in p.parents or not p.is_file():
            raise ValueError("Video uji harus berada di data/test-video/")
