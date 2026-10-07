"""Filter objek: pemicu photocell diteruskan hanya bila objek kelas terpilih menyentuh garis finish."""
import time
from pathlib import Path

import numpy as np
import pytest

from pf_agent import objfilter
from pf_agent.objfilter import Detection, ObjectFilter, ObjectFilterConfig, detector_available, resolve_model
from pf_agent.settings import CameraSettings


class FakeDetector:
    names = ["person", "motorcycle", "boat"]

    def __init__(self, script):
        self.script = list(script)  # daftar deteksi per panggilan detect()

    def detect(self, frame, conf, imgsz):
        return self.script.pop(0) if self.script else []


def run_filter(cfg, script, latest=None):
    det = FakeDetector(script)
    forwarded = []
    f = ObjectFilter(cfg, latest or (lambda: (0, np.zeros((360, 640, 3), np.uint8))), loader=lambda _m: det)
    f.start()
    return f, forwarded


def wait_until(cond, s=2.0):
    end = time.time() + s
    while not cond() and time.time() < end:
        time.sleep(0.01)


def test_hanya_kelas_terpilih_yang_menyentuh_garis_diteruskan():
    cfg = ObjectFilterConfig(classes=("boat",), recheck_s=0, crop=False)
    frame = np.zeros((360, 640, 3), np.uint8)
    script = [
        [Detection("boat", 0.8, 280, 100, 330, 200)],     # menyentuh garis x=320 → lolos
        [Detection("person", 0.9, 300, 50, 340, 300)],    # bukan perahu → ditolak
        [Detection("boat", 0.9, 10, 100, 80, 200)],       # perahu jauh dari garis → ditolak
        [Detection("boat", 0.7, 330, 100, 400, 200)],     # 10 px di kanan garis, dalam toleransi 8% → lolos
    ]
    f, out = run_filter(cfg, script)
    for ts in (1, 2, 3, 4):
        f.submit(ts, frame, 320.0, out.append)
    wait_until(lambda: f.stats.passed + f.stats.rejected == 4)
    f.stop()
    assert out == [1, 4]
    st = f.status()
    assert (st["passed"], st["rejected"]) == (2, 2)
    assert st["ready"] and st["lastLabel"] == "boat 0.70"
    assert "boat 0.90" in st["lastRejected"]


def test_frame_kedua_diperiksa_bila_frame_pemicu_belum_jelas():
    cfg = ObjectFilterConfig(classes=("motorcycle",), recheck_s=0.05, crop=False)
    later = np.ones((360, 640, 3), np.uint8)
    script = [[], [Detection("motorcycle", 0.6, 290, 0, 350, 300)]]
    f, out = run_filter(cfg, script, latest=lambda: (0, later))
    f.submit(time.time_ns(), np.zeros((360, 640, 3), np.uint8), 320.0, out.append)
    wait_until(lambda: f.stats.passed == 1)
    f.stop()
    assert len(out) == 1


def test_model_gagal_dimuat_pemicu_tetap_diteruskan():
    def broken(_m):
        raise RuntimeError("ultralytics tidak terpasang")

    forwarded = []
    f = ObjectFilter(ObjectFilterConfig(), lambda: (0, None), loader=broken)
    f.start()
    f.submit(7, np.zeros((10, 10, 3), np.uint8), 5.0, forwarded.append)
    wait_until(lambda: forwarded)
    f.stop()
    assert forwarded == [7], "fail-open: waktu finish tidak boleh hilang karena filter"
    assert "tidak aktif" in f.status()["error"]


def test_pengaturan_web_divalidasi(tmp_path, monkeypatch):
    monkeypatch.setattr(objfilter, "MODELS_DIR", tmp_path)
    (tmp_path / "perahu-karet.pt").write_bytes(b"x")
    base = CameraSettings("laptop", "0", 30, None, None, None, None, None)
    s = base.merged({"objectFilter": {"enabled": True, "classes": ["raft", " raft ", "motorcycle"], "model": "perahu-karet.pt", "conf": 0.5}}, 5)
    assert s.object_filter.classes == ("raft", "motorcycle") and s.object_filter.model == "perahu-karet.pt"
    assert s.to_dict()["objectFilter"] == {"enabled": True, "classes": ["raft", "motorcycle"], "model": "perahu-karet.pt", "conf": 0.5}
    assert base.merged({"objectFilter": {"enabled": False}}, 5).object_filter is None
    for bad in ({"classes": []}, {"classes": ["boat; rm -rf"]}, {"model": "../../etc/passwd.pt"},
                {"model": "tidak-ada.pt"}, {"conf": 2}):
        with pytest.raises(ValueError):
            base.merged({"objectFilter": {"enabled": True, "classes": ["boat"], **bad}}, 5)
    assert resolve_model("yolo11n.pt") == (tmp_path / "yolo11n.pt").resolve(), "model bawaan diunduh ke data/models/"


@pytest.mark.skipif(not detector_available(), reason="ultralytics belum terpasang (pip install -e '.[detect]')")
def test_yolo_sungguhan_mengenali_objek_di_gambar_contoh():
    import cv2
    import ultralytics

    img = cv2.imread(str(Path(ultralytics.__file__).parent / "assets" / "bus.jpg"))
    try:
        det = objfilter.YoloDetector.load("yolo11n.pt")
    except Exception as err:  # noqa: BLE001 — unduhan model butuh internet
        pytest.skip(f"model tidak bisa diunduh: {err}")
    labels = {d.label for d in det.detect(img, 0.35, 640)}
    assert {"bus", "person"} <= labels
    f = ObjectFilter(ObjectFilterConfig(classes=("bus",), recheck_s=0), lambda: (0, None))
    f.detector = det
    hit = f.match(det.detect(img, 0.35, 640), img.shape[1] / 2, img.shape[1])
    assert hit is not None and hit.label == "bus"


def test_alasan_pemicu_diabaikan_mudah_dibaca():
    f = ObjectFilter(ObjectFilterConfig(classes=("boat",), recheck_s=0), lambda: (0, None))
    assert "Tidak ada objek" in f.reason([], 50, 100)
    jauh = Detection("boat", 0.9, 0, 0, 10, 10)
    assert "tidak menyentuh garis finish" in f.reason([jauh], 50, 100)
    bangku = Detection("bench", 0.6, 40, 0, 60, 10)
    assert f.reason([bangku], 50, 100) == "Bukan jenis objek yang dipilih — terlihat: bench 0.60."


def test_jendela_garis_finish_persegi_dan_dijepit():
    from pf_agent.objfilter import line_window
    assert line_window(1920, 1080, 960) == (420, 1500)       # tengah
    assert line_window(1920, 1080, 100) == (0, 1080)          # dekat tepi kiri → dijepit
    assert line_window(1920, 1080, 1900) == (840, 1920)       # dekat tepi kanan → dijepit
    assert line_window(1000, 1000, 500) is None               # sudah persegi


def test_deteksi_di_jendela_dikembalikan_ke_koordinat_gambar_penuh():
    class Fake:
        names = ["boat"]
        def __init__(self): self.calls = []
        def detect(self, frame, conf, imgsz):
            self.calls.append(frame.shape[1])
            # objek di tengah potongan (x 500–600 dalam potongan selebar 1080)
            return [Detection("boat", 0.9, 500, 10, 600, 50)] if frame.shape[1] == 1080 else []
    f = ObjectFilter(ObjectFilterConfig(classes=("boat",), recheck_s=0), lambda: (0, None))
    f.detector = Fake()
    hit, dets = f._check(np.zeros((1080, 1920, 3), dtype=np.uint8), 960)
    assert hit is not None and (hit.x1, hit.x2) == (920, 1020)  # + x0 = 420
    assert f.detector.calls == [1080]                          # ketemu di jendela → tanpa periksa penuh


def test_tanpa_objek_di_jendela_seluruh_gambar_tetap_diperiksa():
    class Fake:
        names = ["boat"]
        def __init__(self): self.calls = []
        def detect(self, frame, conf, imgsz):
            self.calls.append(frame.shape[1])
            return [Detection("boat", 0.8, 700, 0, 1300, 900)] if frame.shape[1] == 1920 else []
    f = ObjectFilter(ObjectFilterConfig(classes=("boat",), recheck_s=0), lambda: (0, None))
    f.detector = Fake()
    hit, _ = f._check(np.zeros((1080, 1920, 3), dtype=np.uint8), 960)
    assert hit is not None and f.detector.calls == [1080, 1920]


def test_gambar_keputusan_disimpan_dan_dibatasi(tmp_path, monkeypatch):
    from pf_agent import objfilter as of
    monkeypatch.setattr(of, "DECISION_KEEP", 3)
    frame = np.zeros((720, 1280, 3), np.uint8)
    dets = [Detection("motorcycle", 0.8, 600, 100, 700, 400), Detection("person", 0.9, 10, 10, 50, 50)]
    for i in range(5):
        p = of.save_decision([(frame, dets), (frame, [])], 640, i % 2 == 0, {"motorcycle"}, 1_791_000_000_000_000_000 + i * 10**9, tmp_path)
    files = sorted(tmp_path.glob("*.jpg"))
    assert len(files) == 3 and files[-1] == p
    assert p.name.endswith("-diteruskan.jpg")
