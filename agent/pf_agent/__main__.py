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
from .frames import FrameArchive
from .trigger import LineTrigger


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
    archive = FrameArchive(cfg.frames, cfg.camera_fps) if cfg.frames else None
    if archive:
        logging.info("Arsip frame utuh AKTIF (%.0f fps, lebar %d px)", archive.fps, cfg.frames.width)
    client = AgentClient(cfg, ring, latest=latest, camera=camera, archive=archive)
    trigger = LineTrigger(cfg.trigger) if cfg.trigger else None
    if trigger:
        logging.info("Photocell virtual AKTIF (ambang %.0f, rangkaian min %.0f%% garis)", cfg.trigger.threshold, cfg.trigger.min_run * 100)

    def on_frame(ts: int, frame) -> None:
        line = slitscan.sample_line(frame, coords)
        ring.push(ts, line)
        latest.set(ts, frame)  # hanya referensi — untuk cuplikan standby
        if archive is not None:
            archive.push(ts, frame)
        if trigger is not None:
            fired = trigger.update(ts, line)
            if fired is not None:
                client.report_trigger(fired)

    camera.start(on_frame)
    try:
        client.run()
    finally:
        camera.stop()


if __name__ == "__main__":
    main()
