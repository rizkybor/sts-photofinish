from __future__ import annotations

import argparse
import logging

import cv2

from .camera import CameraError, CameraSource
from .client import AgentClient
from .config import AgentConfig
from .extract import preview_with_line
from .pipeline import Pipeline
from .settings import CameraSettings


def main() -> None:
    parser = argparse.ArgumentParser(prog="pf-agent", description="STS Photo Finish Capture Agent")
    parser.add_argument("--preview", action="store_true", help="simpan satu frame + garis finish ke preview.png lalu keluar")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    cfg = AgentConfig.from_env()
    camera = CameraSource(cfg.camera_source, cfg.camera_fps, cfg.frame_width, cfg.frame_height)

    if args.preview:
        try:
            frame = camera.snapshot()
        except CameraError as err:
            raise SystemExit(str(err)) from err
        out = cfg.captures_dir / "preview.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), preview_with_line(frame, cfg.finish_line))
        print(f"Frame {frame.shape[1]}x{frame.shape[0]} disimpan ke {out}")
        return

    pipeline = Pipeline(CameraSettings.from_agent_config(cfg), cfg.buffer_seconds)
    try:
        pipeline.start()
    except CameraError as err:
        raise SystemExit(str(err)) from err
    client = AgentClient(cfg, pipeline)
    try:
        client.run()
    finally:
        pipeline.stop()


if __name__ == "__main__":
    main()
