"""Pengaturan kamera dari web: validasi & ganti kamera saat berjalan (dengan rollback)."""
import time
from pathlib import Path

import pytest

from pf_agent.camera import CameraError
from pf_agent.config import AgentConfig
from pf_agent.pipeline import Pipeline
from pf_agent.settings import VIDEO_DIR, CameraSettings

VIDEO = VIDEO_DIR / "sungai-h2h.mp4"


def base_settings(**env):
    cfg = AgentConfig.from_env({"PF_DEVICE_TOKEN": "t", "PF_FINISH_LINE": "320,0,320,359", "PF_CAMERA_SOURCE": str(VIDEO),
                                "PF_CAMERA_FPS": "60", "PF_TRIGGER": "camera", **env})
    return CameraSettings.from_agent_config(cfg)


def test_pengaturan_web_divalidasi_dan_digabung_di_atas_env():
    base = base_settings()
    assert base.source_type == "video" and base.trigger is not None and base.frames is not None

    s = base.merged({"sourceType": "external", "source": "2", "fps": 120, "finishLine": None,
                     "trigger": {"enabled": True, "threshold": 45, "minRun": 0.1}, "frames": {"enabled": False}}, 20)
    assert (s.source_type, s.source, s.fps) == ("external", "2", 120.0)
    assert s.finish_line is None                    # garis otomatis di tengah
    assert s.trigger.threshold == 45 and s.trigger.min_run == 0.1
    assert s.frames is None
    assert s.to_dict()["trigger"] == {"enabled": True, "threshold": 45.0, "minRun": 0.1}

    ip = base.merged({"sourceType": "ip", "source": "http://192.168.1.20:8080/video"}, 20)
    assert ip.source == "http://192.168.1.20:8080/video" and ip.finish_line == base.finish_line  # field lain tetap

    for bad in ({"sourceType": "laptop", "source": "abc"}, {"sourceType": "ip", "source": "file:///etc/passwd"},
                {"sourceType": "video", "source": "/etc/passwd"}, {"sourceType": "drone", "source": "0"}):
        with pytest.raises(ValueError):
            base.merged(bad, 20)


@pytest.mark.skipif(not VIDEO.exists(), reason="video uji belum dibuat (data/test-video/sungai-h2h.mp4)")
def test_ganti_pengaturan_saat_berjalan_dan_kembali_otomatis_bila_gagal():
    base = base_settings()
    pipe = Pipeline(base, buffer_seconds=2)
    pipe.start()
    try:
        time.sleep(0.5)
        assert pipe.status()["running"] and pipe.size == (640, 360)
        assert pipe.ring.latest_ns is not None

        # Ganti: garis otomatis di tengah + photocell mati → berhasil
        ok, err = pipe.reconfigure(base.merged({"finishLine": None, "trigger": {"enabled": False}}, 2))
        assert ok and err is None
        assert pipe.finish_line.x1 == 320 and pipe.trigger is None

        # Ganti ke video yang tidak bisa dibuka → gagal, kembali ke pengaturan sebelumnya
        broken = base.merged({"sourceType": "video", "source": str(VIDEO)}, 2)
        object.__setattr__(broken, "source", str(Path(VIDEO).with_name("tidak-ada.mp4")))
        ok, err = pipe.reconfigure(broken)
        assert not ok and "tidak bisa dibuka" in err
        assert pipe.settings.source == str(VIDEO) and pipe.status()["running"]
        assert pipe.status()["lastError"] == err
    finally:
        pipe.stop()


def test_kamera_error_bisa_ditangkap():
    from pf_agent.camera import CameraSource
    with pytest.raises(CameraError):
        CameraSource("/tidak/ada.mp4", 30, None, None).snapshot(warmup_s=0.2)


@pytest.mark.skipif(not VIDEO.exists(), reason="video uji belum dibuat")
def test_garis_finish_dari_resolusi_lain_diganti_otomatis_dengan_peringatan():
    # Garis dari kamera 1920×1080 (x=960) dipakai untuk video 640×360 → di luar gambar.
    settings = base_settings(PF_FINISH_LINE="960,0,960,1079")
    pipe = Pipeline(settings, buffer_seconds=1)
    pipe.start()
    try:
        assert pipe.finish_line.x1 == 320, "memakai garis tengah, bukan tepi kanan gambar"
        st = pipe.status()
        assert st["notice"] and "di luar gambar 640×360" in st["notice"]
    finally:
        pipe.stop()
