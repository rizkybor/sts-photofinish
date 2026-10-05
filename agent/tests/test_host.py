import os

from pf_agent.config import AgentConfig
from pf_agent import host
from pf_agent.host import load_env_file, single_instance


def test_env_file_dibaca_apa_adanya(tmp_path, monkeypatch):
    f = tmp_path / ".env.render"
    f.write_text('PF_API_URL=https://x.onrender.com\nPF_MONGO_URL="mongodb://a?tls=true&replicaSet=b"\n# komentar\nPF_DEVICE_TOKEN=abc\r\n')
    for k in ("PF_API_URL", "PF_MONGO_URL", "PF_DEVICE_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    load_env_file(f)
    assert os.environ["PF_API_URL"] == "https://x.onrender.com"
    assert os.environ["PF_MONGO_URL"] == "mongodb://a?tls=true&replicaSet=b"
    assert os.environ["PF_DEVICE_TOKEN"] == "abc"


def test_garis_finish_boleh_kosong():
    cfg = AgentConfig.from_env({"PF_DEVICE_TOKEN": "t"})
    assert cfg.finish_line is None
    assert cfg.camera_fps == 30
    assert AgentConfig.from_env({"PF_DEVICE_TOKEN": "t", "PF_FINISH_LINE": "auto"}).finish_line is None


def test_hanya_satu_agent_per_komputer(monkeypatch):
    monkeypatch.setattr(host, "LOCK_PORT", 47899)  # bukan port agent sungguhan yang mungkin sedang jalan
    assert single_instance() is True
    assert single_instance() is False
