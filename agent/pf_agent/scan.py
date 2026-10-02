"""Pindai kamera yang tersedia di mesin agent (untuk halaman Pengaturan Kamera)."""
from __future__ import annotations

import json
import platform
import subprocess
import time

import cv2

from .settings import VIDEO_DIR


def _probe(index: int, timeout_s: float = 2.5) -> tuple[int, int] | None:
    cap = cv2.VideoCapture(index)
    try:
        if not cap.isOpened():
            return None
        t = time.time()
        while time.time() - t < timeout_s:
            ok, frame = cap.read()
            if ok and frame is not None:
                return int(frame.shape[1]), int(frame.shape[0])
            time.sleep(0.05)
        return None
    finally:
        cap.release()


def device_names() -> list[str]:
    """Nama kamera menurut sistem (macOS). Urutan TIDAK dijamin sama dengan nomor OpenCV."""
    if platform.system() != "Darwin":
        return []
    try:
        out = subprocess.run(["system_profiler", "-json", "SPCameraDataType"], capture_output=True, text=True, timeout=10).stdout
        return [d.get("_name", "?") for d in json.loads(out).get("SPCameraDataType", [])]
    except Exception:  # noqa: BLE001
        return []


def scan(in_use: str | None, in_use_size: tuple[int, int] | None, max_index: int = 5) -> dict:
    """Coba buka kamera 0..max_index. Kamera yang sedang dipakai agent tidak dibuka ulang."""
    cameras = []
    misses = 0
    for i in range(max_index + 1):
        if in_use is not None and in_use == str(i):
            w, h = in_use_size or (0, 0)
            cameras.append({"index": i, "width": w, "height": h, "inUse": True})
            misses = 0
            continue
        size = _probe(i)
        if size:
            cameras.append({"index": i, "width": size[0], "height": size[1], "inUse": False})
            misses = 0
        else:
            misses += 1
            if misses >= 2:  # nomor kamera berurutan; dua kosong berturut-turut = selesai
                break
    videos = sorted(str(p) for p in VIDEO_DIR.glob("*") if p.suffix.lower() in (".mp4", ".mov", ".avi", ".mkv")) if VIDEO_DIR.exists() else []
    return {"cameras": cameras, "deviceNames": device_names(), "videos": videos}
