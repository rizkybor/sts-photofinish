from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .slitscan import FinishLine
from .frames import FrameArchiveConfig
from .objfilter import ObjectFilterConfig
from .trigger import TriggerConfig

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class AgentConfig:
    api_url: str
    device_token: str
    camera_id: str
    camera_source: str
    camera_fps: float
    finish_line: FinishLine | None  # None = garis tegak otomatis di tengah (atur dari web)
    captures_dir: Path
    buffer_seconds: float
    frame_width: int | None
    frame_height: int | None
    trigger: TriggerConfig | None  # None = photocell virtual mati
    frames: FrameArchiveConfig | None  # None = arsip frame utuh mati
    upload_captures: bool  # True = API di mesin lain (VPS): file rekaman diunggah lewat HTTP
    object_filter: ObjectFilterConfig | None = None  # None = semua pemicu photocell diteruskan

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "AgentConfig":
        e = dict(os.environ if env is None else env)
        token = e.get("PF_DEVICE_TOKEN", "")
        if not token:
            raise SystemExit("PF_DEVICE_TOKEN kosong — buat dengan: npm run token:device -w api -- agent <nama>")
        # Kosong/"auto" = garis tegak di tengah; garis finish biasanya diatur dari halaman Pengaturan Kamera.
        line = e.get("PF_FINISH_LINE", "").strip()
        return cls(
            api_url=e.get("PF_API_URL", "http://127.0.0.1:4100").rstrip("/"),
            device_token=token,
            camera_id=e.get("PF_CAMERA_ID", "cam-1"),
            camera_source=e.get("PF_CAMERA_SOURCE", "0"),
            camera_fps=float(e.get("PF_CAMERA_FPS", "30")),
            finish_line=FinishLine.parse(line) if line and line.lower() != "auto" else None,
            captures_dir=Path(e.get("PF_CAPTURES_DIR", REPO_ROOT / "data" / "captures")).resolve(),
            buffer_seconds=float(e.get("PF_BUFFER_SECONDS", "20")),
            frame_width=int(e["PF_FRAME_WIDTH"]) if e.get("PF_FRAME_WIDTH") else None,
            frame_height=int(e["PF_FRAME_HEIGHT"]) if e.get("PF_FRAME_HEIGHT") else None,
            trigger=TriggerConfig(
                threshold=float(e.get("PF_TRIGGER_THRESHOLD", "30")),
                min_run=float(e.get("PF_TRIGGER_MIN_RUN", "0.06")),
                release_s=float(e.get("PF_TRIGGER_RELEASE_S", "0.5")),
            ) if e.get("PF_TRIGGER", "off").lower() in ("camera", "on", "1", "true") else None,
            frames=FrameArchiveConfig(
                max_fps=float(e.get("PF_FRAMES_FPS", "60")),
                width=int(e.get("PF_FRAMES_WIDTH", "1280")),
                quality=int(e.get("PF_FRAMES_QUALITY", "85")),
                seconds=float(e.get("PF_BUFFER_SECONDS", "20")),
            ) if e.get("PF_FRAMES", "on").lower() not in ("off", "0", "false") else None,
            upload_captures=e.get("PF_UPLOAD_CAPTURES", "off").lower() in ("on", "1", "true"),
            # PF_OBJECT_FILTER=boat,motorcycle → hanya pemicu dari objek kelas ini yang diteruskan
            object_filter=ObjectFilterConfig(
                classes=tuple(c.strip() for c in e["PF_OBJECT_FILTER"].split(",") if c.strip()),
                model=e.get("PF_OBJECT_MODEL", "yolo11s.pt"),
                conf=float(e.get("PF_OBJECT_CONF", "0.35")),
            ) if e.get("PF_OBJECT_FILTER", "").strip() not in ("", "off") else None,
        )
