"""Potong jendela waktu dari ring buffer → slit-scan PNG + columns.json."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import slitscan
from .ringbuffer import LineRing


NS_PER_MS = 1_000_000
NS_PER_DAY = 86_400 * 1_000_000_000
RULER_HEIGHT = 46


@dataclass(frozen=True)
class ClockSnapshot:
    """Jam Photo Finish dari API (lihat api/src/db.ts ClockSnapshot)."""

    device_offset_ns: int | None  # jam host − jam PF; None = belum terkalibrasi
    calibration_offset_ns: int  # kalibrasi kamera per sesi
    revision: int
    mode: str

    @classmethod
    def from_request(cls, data: dict | None) -> "ClockSnapshot":
        data = data or {}
        offset = data.get("deviceOffsetNs")
        return cls(
            device_offset_ns=int(offset) if offset is not None else None,
            calibration_offset_ns=int(data.get("calibrationOffsetNs") or 0),
            revision=int(data.get("revision") or 0),
            mode=str(data.get("mode") or "auto"),
        )


def pf_times(agent_ns: np.ndarray, agent_offset_ns: int, clock: ClockSnapshot) -> np.ndarray | None:
    """Timestamp jam agent → jam Photo Finish (ns sejak tengah malam, basis RaceTime2).

    Rumus yang sama dengan frameToDeviceNs() di api/src/time.ts.
    """
    if clock.device_offset_ns is None:
        return None
    t = agent_ns.astype(np.int64) + (agent_offset_ns - clock.device_offset_ns + clock.calibration_offset_ns)
    return np.mod(t, NS_PER_DAY)


def fmt_clock(ns: int, digits: int = 2) -> str:
    """ns sejak tengah malam → "HH:MM:SS.cc" (dipotong, akurasi resmi 1/100)."""
    ns = int(ns) % NS_PER_DAY
    total_s, frac = divmod(ns, 1_000_000_000)
    h, rem = divmod(total_s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}" + (f".{str(frac).zfill(9)[:digits]}" if digits else "")


def _pick(intervals_ms: list[int], ms_per_col: float, min_cols: float) -> int:
    for iv in intervals_ms:
        if iv / ms_per_col >= min_cols:
            return iv
    return intervals_ms[-1]


def time_ruler(times_ns: np.ndarray, width: int, absolute: bool, info: str) -> np.ndarray:
    """Pita skala waktu (BGR) di bawah slit-scan: garis tiap interval, label HH:MM:SS.cc.

    `times_ns` = waktu tiap kolom (jam PF bila `absolute`, selain itu relatif kolom pertama).
    """
    band = np.full((RULER_HEIGHT, width, 3), 24, dtype=np.uint8)
    if len(times_ns) > 1:
        span_ms = (int(times_ns[-1]) - int(times_ns[0])) % NS_PER_DAY / NS_PER_MS
        ms_per_col = max(span_ms / (len(times_ns) - 1), 1e-6)
        tick_ms = _pick([10, 20, 50, 100, 200, 500, 1000], ms_per_col, 4)
        label_ms = _pick([50, 100, 200, 500, 1000, 2000, 5000], ms_per_col, 110)
        for iv, top in ((tick_ms, 18), (label_ms, 8)):
            q = (times_ns // (iv * NS_PER_MS)).astype(np.int64)
            for col in np.nonzero(np.diff(q) != 0)[0] + 1:
                cv2.line(band, (int(col), top), (int(col), 26), (230, 230, 230), 1)
                if iv == label_ms:
                    text = fmt_clock(int(times_ns[col])) if absolute else f"+{(int(times_ns[col]) - int(times_ns[0])) / 1e9:.2f}s"
                    (tw, _), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.38, 1)
                    x = min(max(0, int(col) - tw // 2), max(0, width - tw))
                    cv2.putText(band, text, (x, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(band, info, (4, 7), cv2.FONT_HERSHEY_SIMPLEX, 0.28, (150, 200, 255), 1, cv2.LINE_AA)
    return band


@dataclass(frozen=True)
class ExtractResult:
    file: str
    columns_file: str
    sha256: str
    columns_sha256: str
    fps: float
    width: int
    height: int
    from_agent_ns: int
    to_agent_ns: int
    # Frame utuh untuk tinjauan frame-demi-frame (None bila arsip frame mati)
    frames_file: str | None = None
    frames_sha256: str | None = None
    frame_count: int = 0


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _safe(part: str) -> str:
    if not part or not all(c.isalnum() or c in "-_" for c in part):
        raise ValueError(f"Nama tidak aman untuk path: {part!r}")
    return part


def extract(
    ring: LineRing,
    from_agent_ns: int,
    to_agent_ns: int,
    captures_dir: Path,
    session_id: str,
    group_id: str,
    camera_id: str,
    clock: ClockSnapshot | None = None,
    agent_offset_ns: int = 0,
    frames: list[tuple[int, bytes]] | None = None,
    frame_scale: float = 1.0,
    finish_line: slitscan.FinishLine | None = None,
) -> ExtractResult:
    rel_dir = Path(_safe(session_id)) / _safe(group_id)
    ts, lines = ring.window(from_agent_ns, to_agent_ns)
    slit = slitscan.build(lines)

    # Waktu Photo Finish ikut terekam: per kolom di columns.json dan tercetak
    # sebagai pita skala waktu di gambar (bukti bisa dibaca tanpa aplikasi).
    clock = clock or ClockSnapshot(None, 0, 0, "auto")
    pf = pf_times(ts, agent_offset_ns, clock)
    if pf is not None:
        info = f"JAM PF rev {clock.revision} ({clock.mode}) | kalibrasi kamera {clock.calibration_offset_ns / 1e6:+.1f} ms | {camera_id}"
        ruler = time_ruler(pf, slit.shape[1], absolute=True, info=info)
    else:
        ruler = time_ruler(ts, slit.shape[1], absolute=False, info=f"JAM PF BELUM TERKALIBRASI - waktu relatif | {camera_id}")
    image = np.vstack([slit, ruler])

    out_dir = captures_dir / rel_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    png = out_dir / f"{_safe(camera_id)}-slit.png"
    cols = out_dir / f"{_safe(camera_id)}-columns.json"

    if not cv2.imwrite(str(png), image):
        raise RuntimeError(f"Gagal menulis {png}")
    cols.write_text(json.dumps({
        "cameraId": camera_id,
        "columns": [str(int(t)) for t in ts],  # jam agent (ns epoch) — dasar perhitungan API
        "pfTimes": None if pf is None else [fmt_clock(int(t), 3) for t in pf],  # jam PF per kolom
        "clock": {
            "deviceOffsetNs": None if clock.device_offset_ns is None else str(clock.device_offset_ns),
            "calibrationOffsetNs": str(clock.calibration_offset_ns),
            "revision": clock.revision,
            "mode": clock.mode,
            "agentOffsetNs": str(agent_offset_ns),
        },
        "sliceHeight": int(slit.shape[0]),
    }))

    duration_s = (int(ts[-1]) - int(ts[0])) / 1e9 if len(ts) > 1 else 0.0
    frames_file = frames_sha = None
    if frames:
        # Frame utuh di sekitar pemicu: <cam>-frames/00001.jpg + indeks berisi
        # waktu (jam agent) & SHA-256 tiap frame — diverifikasi API.
        fdir = out_dir / f"{_safe(camera_id)}-frames"
        fdir.mkdir(exist_ok=True)
        entries = []
        for i, (fts, jpeg) in enumerate(frames, start=1):
            fpath = fdir / f"{i:05d}.jpg"
            fpath.write_bytes(jpeg)
            entries.append({"file": (rel_dir / fdir.name / fpath.name).as_posix(), "agentNs": str(int(fts)), "sha256": hashlib.sha256(jpeg).hexdigest()})
        line = finish_line
        index = out_dir / f"{_safe(camera_id)}-frames.json"
        index.write_text(json.dumps({
            "cameraId": camera_id,
            "scale": frame_scale,
            # garis finish dalam koordinat frame arsip (untuk overlay di web)
            "finishLine": None if line is None else {
                "x1": line.x1 * frame_scale, "y1": line.y1 * frame_scale, "x2": line.x2 * frame_scale, "y2": line.y2 * frame_scale,
            },
            "frames": entries,
        }))
        frames_file = (rel_dir / index.name).as_posix()
        frames_sha = _sha256(index)

    return ExtractResult(
        frames_file=frames_file,
        frames_sha256=frames_sha,
        frame_count=len(frames or []),
        file=(rel_dir / png.name).as_posix(),
        columns_file=(rel_dir / cols.name).as_posix(),
        sha256=_sha256(png),
        columns_sha256=_sha256(cols),
        fps=round((len(ts) - 1) / duration_s, 2) if duration_s > 0 else 0.0,
        width=int(image.shape[1]),
        height=int(image.shape[0]),
        from_agent_ns=int(ts[0]),
        to_agent_ns=int(ts[-1]),
    )


def preview_with_line(frame: np.ndarray, line: slitscan.FinishLine) -> np.ndarray:
    """Frame + garis finish + grid 100 px, untuk menentukan PF_FINISH_LINE."""
    out = frame.copy()
    h, w = out.shape[:2]
    for x in range(0, w, 100):
        cv2.line(out, (x, 0), (x, h), (80, 80, 80), 1)
        cv2.putText(out, str(x), (x + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    for y in range(0, h, 100):
        cv2.line(out, (0, y), (w, y), (80, 80, 80), 1)
        cv2.putText(out, str(y), (2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    cv2.line(out, (int(line.x1), int(line.y1)), (int(line.x2), int(line.y2)), (0, 0, 255), 2)
    return out
