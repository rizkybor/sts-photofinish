from __future__ import annotations

import argparse
import logging

import cv2

from . import slitscan
from .camera import CameraSource
from .client import AgentClient, LatestFrame
from .config import AgentConfig
from .extract import preview_with_line
from .ringbuffer import LineRing


def main() -> None:
    parser = argparse.ArgumentParser(prog="pf-agent", description="STS Photo Finish Capture Agent")
    parser.add_argument("--preview", action="store_true", help="simpan satu frame + garis finish ke preview.png lalu keluar")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    cfg = AgentConfig.from_env()
    camera = CameraSource(cfg.camera_source, cfg.camera_fps, cfg.frame_width, cfg.frame_height)

    if args.preview:
        frame = camera.snapshot()
        out = cfg.captures_dir / "preview.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), preview_with_line(frame, cfg.finish_line))
        print(f"Frame {frame.shape[1]}x{frame.shape[0]} disimpan ke {out}")
        return

    first = camera.snapshot()
    height, width = first.shape[:2]
    coords = slitscan.line_coords(cfg.finish_line, width, height)
    capacity = int(cfg.camera_fps * cfg.buffer_seconds)
    ring = LineRing(capacity, line_len=len(coords[0]), channels=first.shape[2] if first.ndim == 3 else 1)
    logging.info("Kamera %s %dx%d, buffer %d frame (%.0f dtk @ %.0f fps)", cfg.camera_id, width, height, capacity, cfg.buffer_seconds, cfg.camera_fps)

    latest = LatestFrame()

    def on_frame(ts: int, frame) -> None:
        ring.push(ts, slitscan.sample_line(frame, coords))
        latest.set(ts, frame)  # hanya referensi — untuk cuplikan standby

    camera.start(on_frame)
    try:
        AgentClient(cfg, ring, latest=latest, camera=camera).run()
    finally:
        camera.stop()


if __name__ == "__main__":
    main()
