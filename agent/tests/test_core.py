import json

import numpy as np
import pytest

from pf_agent import slitscan
from pf_agent.clock import OffsetEstimator
from pf_agent.extract import extract
from pf_agent.ringbuffer import LineRing


def test_offset_estimator_memilih_rtt_terkecil():
    est = OffsetEstimator()
    est.add(t0_ns=1_000, server_ns=6_000, t1_ns=3_000)   # rtt 2000, offset 4000
    est.add(t0_ns=10_000, server_ns=15_100, t1_ns=10_200)  # rtt 200, offset 5000 (paling akurat)
    est.add(t0_ns=20_000, server_ns=30_000, t1_ns=29_000)  # rtt 9000
    assert est.best().offset_ns == 5_000
    assert est.host_to_agent(105_000) == 100_000
    with pytest.raises(ValueError):
        est.add(5, 0, 1)


def test_ring_buffer_menimpa_frame_terlama_dan_memotong_jendela():
    ring = LineRing(capacity=5, line_len=2, channels=1)
    for i in range(8):
        ring.push(i * 10, np.full((2, 1), i, dtype=np.uint8))
    assert ring.oldest_ns == 30 and ring.latest_ns == 70
    ts, lines = ring.window(35, 60)
    assert ts.tolist() == [40, 50, 60]
    assert lines[:, 0, 0].tolist() == [4, 5, 6]


def synthetic_race(n_frames=60, w=120, h=40, line_x=60, boats=((0, 2.0), (20, 3.0))):
    """Dua 'perahu' (blok putih) bergerak ke kanan; kembalikan frame & frame pertama menyentuh garis."""
    frames, first_touch = [], {}
    for f in range(n_frames):
        img = np.zeros((h, w, 3), dtype=np.uint8)
        for b, (start_x, speed) in enumerate(boats):
            bow = int(start_x + speed * f)
            y0 = 5 + b * 18
            img[y0:y0 + 12, max(0, bow - 15):max(0, bow + 1)] = 255
            if bow >= line_x and b not in first_touch:
                first_touch[b] = f
        frames.append(img)
    return frames, first_touch


def test_slitscan_menampilkan_haluan_pertama_di_kolom_yang_benar():
    frames, first_touch = synthetic_race()
    line = slitscan.FinishLine(60, 0, 60, 39)
    coords = slitscan.line_coords(line, 120, 40)
    image = slitscan.build(np.stack([slitscan.sample_line(f, coords) for f in frames]))
    assert image.shape == (40, 60, 3)
    # Kolom pertama yang terang di baris lintasan tiap perahu = frame haluan menyentuh garis.
    for boat, row in ((0, 10), (1, 28)):
        assert int(np.argmax(image[row, :, 0] > 0)) == first_touch[boat]
    # Perahu 1 (start lebih depan, lebih cepat) tiba lebih dulu.
    assert first_touch[1] < first_touch[0]


def test_extract_menulis_png_dan_waktu_per_kolom(tmp_path):
    frames, _ = synthetic_race(n_frames=20)
    coords = slitscan.line_coords(slitscan.FinishLine(60, 0, 60, 39), 120, 40)
    ring = LineRing(capacity=100, line_len=len(coords[0]))
    for i, f in enumerate(frames):
        ring.push(1_000_000_000 + i * 4_166_667, slitscan.sample_line(f, coords))  # ~240 fps
    r = extract(ring, 1_000_000_000, 1_000_000_000 + 10 * 4_166_667, tmp_path, "s1", "g1", "cam-1")
    assert r.file == "s1/g1/cam-1-slit.png" and r.width == 11 and r.height == 40 + 46  # + pita waktu
    assert 239 < r.fps < 241
    cols = json.loads((tmp_path / r.columns_file).read_text())["columns"]
    assert len(cols) == r.width and cols[0] == "1000000000"
    with pytest.raises(ValueError, match="tidak aman"):
        extract(ring, 1_000_000_000, 1_100_000_000, tmp_path, "../x", "g1", "cam-1")


def test_waktu_pf_terekam_per_kolom_dan_tercetak_di_gambar(tmp_path):
    from pf_agent.extract import RULER_HEIGHT, ClockSnapshot, fmt_clock

    frames, _ = synthetic_race(n_frames=240)
    coords = slitscan.line_coords(slitscan.FinishLine(60, 0, 60, 39), 120, 40)
    ring = LineRing(capacity=500, line_len=len(coords[0]))
    day = 86_400 * 1_000_000_000
    host_start = 20 * day + (10 * 3600 + 42 * 60 + 13) * 1_000_000_000  # host 10:42:13.000 (tanpa offset hari)
    for i, f in enumerate(frames):
        ring.push(host_start + i * 4_166_667, slitscan.sample_line(f, coords))

    # Jam PF = host − 20 hari − 250 ms (+ trim admin sudah di dalam offset), kalibrasi kamera +5 ms.
    clock = ClockSnapshot(device_offset_ns=20 * day + 250 * 1_000_000, calibration_offset_ns=5_000_000, revision=3, mode="manual")
    r = extract(ring, host_start, host_start + day, tmp_path, "s1", "g1", "cam-1", clock=clock, agent_offset_ns=0)

    data = json.loads((tmp_path / r.columns_file).read_text())
    assert data["pfTimes"][0] == "10:42:12.755"  # 13.000 − 0.250 + 0.005
    assert len(data["pfTimes"]) == r.width == 240
    assert data["clock"]["revision"] == 3 and data["clock"]["mode"] == "manual"
    assert r.height == 40 + RULER_HEIGHT and data["sliceHeight"] == 40
    assert fmt_clock(10 * 3600 * 1_000_000_000 + 999_999_999) == "10:00:00.99"  # dipotong, bukan dibulatkan

    import cv2
    img = cv2.imread(str(tmp_path / r.file))
    assert img.shape[0] == 40 + RULER_HEIGHT
    assert img[40:].max() == 255  # pita waktu berisi tanda & label putih


def test_tanpa_kalibrasi_jam_tetap_merekam_waktu_relatif(tmp_path):
    frames, _ = synthetic_race(n_frames=30)
    coords = slitscan.line_coords(slitscan.FinishLine(60, 0, 60, 39), 120, 40)
    ring = LineRing(capacity=100, line_len=len(coords[0]))
    for i, f in enumerate(frames):
        ring.push(1_000_000_000 + i * 4_166_667, slitscan.sample_line(f, coords))
    r = extract(ring, 0, 2_000_000_000, tmp_path, "s1", "g2", "cam-1")
    assert json.loads((tmp_path / r.columns_file).read_text())["pfTimes"] is None


def test_cuplikan_standby_diperkecil_dan_berformat_jpeg():
    import cv2
    from pf_agent.preview import encode_preview

    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    frame[:, 960] = 255  # garis tegak di tengah
    jpeg = encode_preview(frame)
    assert jpeg[:2] == b"\xff\xd8" and len(jpeg) < 200_000
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[:2] == (540, 960)
    assert img[270, 478:482].max() > 100  # garis tetap di tengah setelah diperkecil

    small = np.zeros((360, 640, 3), dtype=np.uint8)
    assert cv2.imdecode(np.frombuffer(encode_preview(small), np.uint8), cv2.IMREAD_COLOR).shape[:2] == (360, 640)


def test_arsip_frame_utuh_dibatasi_fps_dan_ditulis_bersama_slitscan(tmp_path):
    import hashlib
    from pf_agent.frames import FrameArchive, FrameArchiveConfig

    archive = FrameArchive(FrameArchiveConfig(max_fps=60, width=320, quality=80, seconds=5), camera_fps=240)
    frames, _ = synthetic_race(n_frames=240)               # 1 detik @ 240 fps
    coords = slitscan.line_coords(slitscan.FinishLine(60, 0, 60, 39), 120, 40)
    ring = LineRing(capacity=500, line_len=len(coords[0]))
    import time
    for i, f in enumerate(frames):
        ts = 1_000_000_000 + i * 4_166_667
        ring.push(ts, slitscan.sample_line(f, coords))
        archive.push(ts, f)
        time.sleep(0.004)  # laju kamera sungguhan (240 fps)
    archive.flush()
    time.sleep(0.2)
    kept = archive.window(0, 10**12)
    assert 55 <= len(kept) <= 61, len(kept)                 # 240 fps → ±60 frame arsip
    assert archive.scale == 1.0                              # 120 px < batas lebar 320

    r = extract(ring, 1_000_000_000, 2_000_000_000, tmp_path, "s1", "g9", "cam-1",
                frames=kept, frame_scale=archive.scale, finish_line=slitscan.FinishLine(60, 0, 60, 39))
    assert r.frame_count == len(kept)
    index = json.loads((tmp_path / r.frames_file).read_text())
    assert index["finishLine"] == {"x1": 60.0, "y1": 0.0, "x2": 60.0, "y2": 39.0}
    first = index["frames"][0]
    assert first["file"] == "s1/g9/cam-1-frames/00001.jpg"
    assert hashlib.sha256((tmp_path / first["file"]).read_bytes()).hexdigest() == first["sha256"]
    archive.stop()


def test_mode_vps_mengunggah_semua_file_rekaman(tmp_path):
    """Agent di lokasi, API di VPS: frame, slit-scan, kolom, lalu indeks frame diunggah."""
    from pf_agent.client import AgentClient
    from pf_agent.config import AgentConfig

    frames, _ = synthetic_race(n_frames=30)
    coords = slitscan.line_coords(slitscan.FinishLine(60, 0, 60, 39), 120, 40)
    ring = LineRing(capacity=100, line_len=len(coords[0]))
    import cv2
    jpegs = []
    for i, f in enumerate(frames):
        ts = 1_000_000_000 + i * 4_166_667
        ring.push(ts, slitscan.sample_line(f, coords))
        jpegs.append((ts, cv2.imencode(".jpg", f)[1].tobytes()))
    r = extract(ring, 0, 10**12, tmp_path, "a" * 24, "b" * 24, "cam-1", frames=jpegs[:3], finish_line=slitscan.FinishLine(60, 0, 60, 39))

    cfg = AgentConfig.from_env({"PF_DEVICE_TOKEN": "t", "PF_FINISH_LINE": "60,0,60,39", "PF_CAPTURES_DIR": str(tmp_path), "PF_UPLOAD_CAPTURES": "on"})
    assert cfg.upload_captures is True
    client = AgentClient(cfg)
    sent = []

    class FakeResp:
        status_code = 201
        text = ""

    client.http.put = lambda url, content, headers, timeout: sent.append((url, len(content))) or FakeResp()
    client._upload(r)
    paths = [u.removeprefix("/api/capture-files/") for u, _ in sent]
    assert paths[:3] == [f"{'a'*24}/{'b'*24}/cam-1-frames/0000{i}.jpg" for i in (1, 2, 3)]
    assert paths[3:] == [r.file, r.columns_file, r.frames_file]  # indeks frame paling akhir
    assert all(n > 0 for _, n in sent)
