"""Cuplikan live untuk tampilan standby kamera (cek kelurusan sebelum lomba).

Hanya dikirim selama ada operator yang membuka tampilan standby — perekaman
garis finish (ring buffer) tidak terpengaruh.
"""
from __future__ import annotations

import cv2
import numpy as np

MAX_PREVIEW_WIDTH = 960
JPEG_QUALITY = 75


def encode_preview(frame: np.ndarray, max_width: int = MAX_PREVIEW_WIDTH, quality: int = JPEG_QUALITY) -> bytes:
    """Frame BGR → JPEG (diperkecil bila lebih lebar dari max_width).

    Koordinat overlay di web tetap memakai ukuran frame ASLI (dikirim terpisah),
    jadi pengecilan di sini tidak menggeser garis.
    """
    h, w = frame.shape[:2]
    if w > max_width:
        frame = cv2.resize(frame, (max_width, round(h * max_width / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("Gagal meng-encode cuplikan JPEG")
    return buf.tobytes()
