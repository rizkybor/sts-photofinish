"""pf-dataset — alat latih ulang (fine-tune) model filter objek dari foto lomba sendiri.

  pf-dataset collect   kumpulkan foto dari arsip foto frame (data/captures) dan/atau video
  pf-dataset prelabel  beri kotak awal otomatis (model bawaan) agar pelabelan lebih cepat
  pf-dataset prepare   bagi foto berlabel (format YOLO) ke train/val + tulis data.yaml
  pf-dataset train     latih model, salin best.pt ke data/models/<nama>.pt

Panduan lengkap: docs/PANDUAN-FILTER-OBJEK.md
"""
from __future__ import annotations

import argparse
import random
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

from .objfilter import MODELS_DIR, resolve_model

REPO_ROOT = Path(__file__).resolve().parents[2]
DATASET_DIR = REPO_ROOT / "data" / "dataset"
IMG_EXT = (".jpg", ".jpeg", ".png")
VIDEO_EXT = (".mp4", ".mov", ".avi", ".mkv")


# ---------------------------------------------------------------- collect

def _too_similar(a: np.ndarray | None, b: np.ndarray, threshold: float) -> bool:
    """Foto berurutan yang hampir sama (perahu diam, air tenang) tidak menambah ilmu model."""
    if a is None:
        return False
    return float(np.mean(cv2.absdiff(a, b))) < threshold


def _thumb(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(cv2.resize(img, (64, 36)), cv2.COLOR_BGR2GRAY)


def collect(sources: list[Path], out: Path, every: int, every_s: float, min_diff: float, limit: int) -> int:
    out.mkdir(parents=True, exist_ok=True)
    saved, last = 0, None

    def keep(img: np.ndarray, name: str) -> bool:
        nonlocal saved, last
        t = _thumb(img)
        if _too_similar(last, t, min_diff):
            return False
        last = t
        cv2.imwrite(str(out / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        saved += 1
        return saved >= limit

    for src in sources:
        if src.is_file() and src.suffix.lower() in VIDEO_EXT:
            cap = cv2.VideoCapture(str(src))
            fps = cap.get(cv2.CAP_PROP_FPS) or 30
            step, i = max(1, round(fps * every_s)), 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if i % step == 0 and keep(frame, f"{src.stem}-{i:06d}"):
                    cap.release()
                    return saved
                i += 1
            cap.release()
            continue
        files = sorted(p for p in (src.rglob("*") if src.is_dir() else [src]) if p.suffix.lower() in IMG_EXT)
        for i, p in enumerate(files):
            if i % every:
                continue
            img = cv2.imread(str(p))
            if img is None:
                continue
            # nama unik dari path: <sesi>-<kelompok>-<frame>
            name = "-".join(p.relative_to(src).with_suffix("").parts)[-120:] if src.is_dir() else p.stem
            if keep(img, name):
                return saved
    return saved


# ---------------------------------------------------------------- prelabel

def prelabel(images: Path, model: str, mapping: dict[str, int], conf: float) -> int:
    """Tulis label YOLO (.txt di samping foto) dari deteksi model bawaan; koreksi lalu di alat label."""
    from ultralytics import YOLO

    m = YOLO(str(resolve_model(model)))
    names = m.names
    n = 0
    for p in sorted(x for x in images.iterdir() if x.suffix.lower() in IMG_EXT):
        r = m.predict(str(p), conf=conf, verbose=False)[0]
        lines = []
        for (cx, cy, w, h), k in zip(r.boxes.xywhn.tolist(), r.boxes.cls.int().tolist()):
            label = names[k]
            if label in mapping:
                lines.append(f"{mapping[label]} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
        p.with_suffix(".txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        n += bool(lines)
    return n


# ---------------------------------------------------------------- prepare

def prepare(labeled: Path, classes: list[str], out: Path, val: float, seed: int) -> dict:
    """labeled/ berisi foto + .txt YOLO (nama sama). Foto tanpa .txt = contoh negatif (tanpa objek)."""
    imgs = sorted(p for p in labeled.rglob("*") if p.suffix.lower() in IMG_EXT)
    if not imgs:
        raise SystemExit(f"Tidak ada foto di {labeled}")
    pairs = []
    for img in imgs:
        txt = img.with_suffix(".txt")
        if not txt.exists():
            alt = labeled / "labels" / (img.stem + ".txt")  # ekspor CVAT/Roboflow: images/ + labels/
            txt = alt if alt.exists() else txt
        if txt.exists():
            for line in txt.read_text().split("\n"):
                if line.strip() and int(line.split()[0]) >= len(classes):
                    raise SystemExit(f"{txt.name}: kelas {line.split()[0]} di luar daftar kelas ({len(classes)} kelas)")
        pairs.append((img, txt if txt.exists() else None))
    random.Random(seed).shuffle(pairs)
    n_val = max(1, round(len(pairs) * val))
    if out.exists():
        shutil.rmtree(out)
    counts = {}
    for split, items in (("val", pairs[:n_val]), ("train", pairs[n_val:])):
        (out / "images" / split).mkdir(parents=True)
        (out / "labels" / split).mkdir(parents=True)
        for img, txt in items:
            shutil.copy2(img, out / "images" / split / img.name)
            dst = out / "labels" / split / (img.stem + ".txt")
            if txt:
                shutil.copy2(txt, dst)
            else:
                dst.write_text("")
        counts[split] = len(items)
    yaml = out / "data.yaml"
    yaml.write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\nnames:\n"
        + "".join(f"  {i}: {c}\n" for i, c in enumerate(classes))
    )
    labeled_n = sum(1 for _i, t in pairs if t and t.read_text().strip())
    return {"yaml": str(yaml), **counts, "with_objects": labeled_n, "negatives": len(pairs) - labeled_n}


# ---------------------------------------------------------------- train

def train(data: Path, base: str, epochs: int, imgsz: int, name: str, batch: int) -> Path:
    from ultralytics import YOLO

    model = YOLO(str(resolve_model(base)))
    project = DATASET_DIR / "runs"
    model.train(data=str(data), epochs=epochs, imgsz=imgsz, batch=batch, project=str(project), name=name, exist_ok=True, patience=20)
    best = project / name / "weights" / "best.pt"
    if not best.exists():
        raise SystemExit(f"best.pt tidak ditemukan di {best.parent}")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dst = MODELS_DIR / f"{name}.pt"
    shutil.copy2(best, dst)
    return dst


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="pf-dataset", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("collect", help="kumpulkan foto dari arsip foto frame / video")
    c.add_argument("sources", nargs="*", type=Path, help="folder foto atau file video (bawaan: data/captures)")
    c.add_argument("--out", type=Path, default=DATASET_DIR / "raw")
    c.add_argument("--every", type=int, default=3, help="ambil 1 dari tiap N foto arsip (bawaan 3)")
    c.add_argument("--every-s", type=float, default=0.5, help="untuk video: 1 foto tiap N detik (bawaan 0,5)")
    c.add_argument("--min-diff", type=float, default=4.0, help="lewati foto yang hampir sama dengan sebelumnya")
    c.add_argument("--limit", type=int, default=2000)

    pl = sub.add_parser("prelabel", help="kotak awal otomatis dari model bawaan")
    pl.add_argument("images", type=Path, nargs="?", default=DATASET_DIR / "raw")
    pl.add_argument("--map", default="boat=0", help="kelas model bawaan → nomor kelas Anda, mis. boat=0,motorcycle=1")
    pl.add_argument("--model", default="yolo11s.pt")
    pl.add_argument("--conf", type=float, default=0.25)

    pr = sub.add_parser("prepare", help="bagi foto berlabel ke train/val + data.yaml")
    pr.add_argument("labeled", type=Path, help="folder foto + label YOLO (.txt)")
    pr.add_argument("--classes", required=True, help="nama kelas sesuai urutan nomor, mis. raft atau raft,motorcycle")
    pr.add_argument("--out", type=Path, default=DATASET_DIR / "siap")
    pr.add_argument("--val", type=float, default=0.2)
    pr.add_argument("--seed", type=int, default=42)

    t = sub.add_parser("train", help="latih model & salin ke data/models/")
    t.add_argument("--data", type=Path, default=DATASET_DIR / "siap" / "data.yaml")
    t.add_argument("--base", default="yolo11n.pt", help="model awal (yolo11n.pt cepat, yolo11s.pt lebih akurat)")
    t.add_argument("--epochs", type=int, default=80)
    t.add_argument("--imgsz", type=int, default=640)
    t.add_argument("--batch", type=int, default=16)
    t.add_argument("--name", default="perahu-karet", help="nama file model hasil (data/models/<nama>.pt)")

    a = ap.parse_args(argv)
    if a.cmd == "collect":
        srcs = a.sources or [REPO_ROOT / "data" / "captures"]
        n = collect(srcs, a.out, a.every, a.every_s, a.min_diff, a.limit)
        print(f"{n} foto disimpan di {a.out}")
    elif a.cmd == "prelabel":
        mapping = {k.strip(): int(v) for k, v in (x.split("=") for x in a.map.split(","))}
        n = prelabel(a.images, a.model, mapping, a.conf)
        print(f"{n} foto mendapat kotak awal (.txt di samping foto) — periksa & koreksi di alat label")
    elif a.cmd == "prepare":
        info = prepare(a.labeled, [c.strip() for c in a.classes.split(",") if c.strip()], a.out, a.val, a.seed)
        print(f"Dataset siap: {info['train']} latih, {info['val']} uji ({info['with_objects']} berobjek, {info['negatives']} negatif)\n{info['yaml']}")
    elif a.cmd == "train":
        dst = train(a.data, a.base, a.epochs, a.imgsz, a.name, a.batch)
        print(f"Model tersimpan: {dst}\nPilih '{dst.name}' di Pengaturan Kamera → Filter objek → Model.")


if __name__ == "__main__":
    main(sys.argv[1:])
