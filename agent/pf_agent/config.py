from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .slitscan import FinishLine

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class AgentConfig:
    api_url: str
    device_token: str
    camera_id: str
    camera_source: str
    camera_fps: float
    finish_line: FinishLine
    captures_dir: Path
    buffer_seconds: float
    frame_width: int | None
    frame_height: int | None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "AgentConfig":
        e = dict(os.environ if env is None else env)
        token = e.get("PF_DEVICE_TOKEN", "")
        if not token:
            raise SystemExit("PF_DEVICE_TOKEN kosong — buat dengan: npm run token:device -w api -- agent <nama>")
        line = e.get("PF_FINISH_LINE", "")
        if not line:
            raise SystemExit("PF_FINISH_LINE kosong — isi x1,y1,x2,y2 (jalankan `pf-agent --preview` untuk melihat frame)")
        return cls(
            api_url=e.get("PF_API_URL", "http://127.0.0.1:4100").rstrip("/"),
            device_token=token,
            camera_id=e.get("PF_CAMERA_ID", "cam-1"),
            camera_source=e.get("PF_CAMERA_SOURCE", "0"),
            camera_fps=float(e.get("PF_CAMERA_FPS", "240")),
            finish_line=FinishLine.parse(line),
            captures_dir=Path(e.get("PF_CAPTURES_DIR", REPO_ROOT / "data" / "captures")).resolve(),
            buffer_seconds=float(e.get("PF_BUFFER_SECONDS", "20")),
            frame_width=int(e["PF_FRAME_WIDTH"]) if e.get("PF_FRAME_WIDTH") else None,
            frame_height=int(e["PF_FRAME_HEIGHT"]) if e.get("PF_FRAME_HEIGHT") else None,
        )
