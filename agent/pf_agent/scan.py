"""Pindai kamera yang tersedia di mesin agent (untuk halaman Pengaturan Kamera)."""
from __future__ import annotations

import base64
import json
import platform
import subprocess
import time

import cv2

from .preview import encode_preview
from .settings import VIDEO_DIR

THUMB_WIDTH = 320


def thumbnail(frame) -> str | None:
    """Gambar kecil (data URL JPEG) agar operator mengenali kamera dari isinya, bukan nomornya."""
    if frame is None:
        return None
    try:
        return "data:image/jpeg;base64," + base64.b64encode(encode_preview(frame, THUMB_WIDTH, 70)).decode()
    except Exception:  # noqa: BLE001
        return None


def _probe(index: int, timeout_s: float = 2.5):
    cap = cv2.VideoCapture(index)
    try:
        if not cap.isOpened():
            return None
        t = time.time()
        while time.time() - t < timeout_s:
            ok, frame = cap.read()
            if ok and frame is not None:
                return frame
            time.sleep(0.05)
        return None
    finally:
        cap.release()


def camera_kind(name: str, model: str) -> str:
    """Jenis kamera dari nama/model sistem: iphone | laptop | external."""
    if model.startswith(("iPhone", "iPad")):
        return "iphone"
    if "FaceTime" in name or "FaceTime" in model or "Built-in" in model:
        return "laptop"
    return "external"


def device_modes() -> dict[str, list[dict]]:
    """Mode yang benar-benar didukung tiap kamera (macOS/AVFoundation), per uniqueID.

    [{"width", "height", "maxFps"}] — fps tertinggi per resolusi. Kosong bila
    AVFoundation tidak tersedia; web lalu memakai pilihan umum.
    """
    if platform.system() != "Darwin":
        return {}
    try:
        import AVFoundation as AV  # noqa: PLC0415 — opsional, hanya macOS
    except Exception:  # noqa: BLE001
        return {}
    out: dict[str, list[dict]] = {}
    try:
        for dev in AV.AVCaptureDevice.devicesWithMediaType_(AV.AVMediaTypeVideo):
            best: dict[tuple[int, int], float] = {}
            for fmt in dev.formats():
                dims = AV.CMVideoFormatDescriptionGetDimensions(fmt.formatDescription())
                fps = max((r.maxFrameRate() for r in fmt.videoSupportedFrameRateRanges()), default=0.0)
                key = (int(dims.width), int(dims.height))
                best[key] = max(best.get(key, 0.0), float(fps))
            out[str(dev.uniqueID())] = [
                {"width": w, "height": h, "maxFps": round(f)} for (w, h), f in sorted(best.items())
            ]
    except Exception:  # noqa: BLE001
        return {}
    return out


def system_cameras() -> list[dict]:
    """Kamera menurut macOS, diurutkan seperti nomor kamera OpenCV.

    Backend AVFoundation OpenCV mengurutkan perangkat menurut uniqueID, jadi
    urutan uniqueID = nomor kamera (0, 1, …) — bukan urutan system_profiler.
    """
    if platform.system() != "Darwin":
        return []
    try:
        out = subprocess.run(["system_profiler", "-json", "SPCameraDataType"], capture_output=True, text=True, timeout=10).stdout
        items = json.loads(out).get("SPCameraDataType", [])
    except Exception:  # noqa: BLE001
        return []
    cams = [
        {"name": d.get("_name", "?"), "model": d.get("spcamera_model-id", ""), "uid": d.get("spcamera_unique-id", "")}
        for d in items
    ]
    cams.sort(key=lambda c: c["uid"])
    modes = device_modes()
    for c in cams:
        c["kind"] = camera_kind(c["name"], c["model"])
        c["modes"] = modes.get(c["uid"], [])
    return cams


def scan(in_use: str | None, in_use_size: tuple[int, int] | None, max_index: int = 5, in_use_frame=None) -> dict:
    """Coba buka kamera 0..max_index. Kamera yang sedang dipakai agent tidak dibuka ulang."""
    system = system_cameras()
    cameras = []
    misses = 0
    for i in range(max_index + 1):
        if in_use is not None and in_use == str(i):
            w, h = in_use_size or (0, 0)
            cameras.append({"index": i, "width": w, "height": h, "inUse": True, "thumb": thumbnail(in_use_frame)})
            misses = 0
            continue
        frame = _probe(i)
        if frame is not None:
            cameras.append({"index": i, "width": int(frame.shape[1]), "height": int(frame.shape[0]), "inUse": False, "thumb": thumbnail(frame)})
            misses = 0
        else:
            misses += 1
            if misses >= 2:  # nomor kamera berurutan; dua kosong berturut-turut = selesai
                break
    # Nama & jenis hanya bila jumlahnya cocok — bila tidak, lebih baik "tidak dikenali" daripada salah.
    if system and len(system) == len(cameras) and all(c["index"] < len(system) for c in cameras):
        for c in cameras:
            sc = system[c["index"]]
            c["name"], c["kind"], c["modes"] = sc["name"], sc["kind"], sc["modes"]
    videos = sorted(str(p) for p in VIDEO_DIR.glob("*") if p.suffix.lower() in (".mp4", ".mov", ".avi", ".mkv")) if VIDEO_DIR.exists() else []
    return {"cameras": cameras, "deviceNames": [c["name"] for c in system], "videos": videos}
