"""pf-dataset: kumpulkan foto (foto mirip dilewati) & siapkan dataset YOLO train/val."""
import cv2
import numpy as np
import pytest

from pf_agent.dataset import collect, prepare


def _img(path, value):
    cv2.imwrite(str(path), np.full((72, 128, 3), value, np.uint8))


def test_collect_melewati_foto_yang_hampir_sama(tmp_path):
    src = tmp_path / "captures" / "sesi1" / "grup1" / "cam-1-frames"
    src.mkdir(parents=True)
    for i, v in enumerate([10, 11, 120, 121, 240]):  # 11 ≈ 10, 121 ≈ 120
        _img(src / f"{i:05d}.jpg", v)
    n = collect([tmp_path / "captures"], tmp_path / "raw", every=1, every_s=0.5, min_diff=4, limit=100)
    assert n == 3
    names = sorted(p.name for p in (tmp_path / "raw").iterdir())
    assert names[0].startswith("sesi1-grup1-cam-1-frames-"), "nama unik dari sesi/kelompok"


def test_prepare_membagi_train_val_dan_menulis_data_yaml(tmp_path):
    lab = tmp_path / "label"
    lab.mkdir()
    for i in range(10):
        _img(lab / f"f{i}.jpg", i * 20)
        if i < 6:
            (lab / f"f{i}.txt").write_text("0 0.5 0.5 0.2 0.3\n")  # perahu
    info = prepare(lab, ["raft"], tmp_path / "siap", val=0.2, seed=1)
    assert (info["train"], info["val"], info["with_objects"], info["negatives"]) == (8, 2, 6, 4)
    yaml = (tmp_path / "siap" / "data.yaml").read_text()
    assert "names:\n  0: raft" in yaml and "train: images/train" in yaml
    assert len(list((tmp_path / "siap" / "labels" / "train").glob("*.txt"))) == 8, "foto negatif dapat label kosong"

    (lab / "f0.txt").write_text("3 0.5 0.5 0.2 0.3\n")
    with pytest.raises(SystemExit, match="di luar daftar kelas"):
        prepare(lab, ["raft"], tmp_path / "siap", val=0.2, seed=1)
