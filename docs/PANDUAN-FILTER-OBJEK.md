# Filter Objek & Latih Ulang Model (Fine-tune)

**Filter objek** membuat pemicu photocell virtual hanya diteruskan bila yang
melintas garis finish benar-benar objek yang dipilih (perahu, motor, …).
Orang lewat, burung, ranting, riak, dan bayangan diabaikan otomatis.

- **Waktu finish tetap dari photocell virtual** (presisi per frame). Filter
  hanya memeriksa *apa* yang memicu, memakai detektor YOLO.
- **Aman bila gagal:** bila model belum terpasang/gagal dimuat, semua pemicu
  tetap diteruskan (tidak ada finish yang hilang) dan halaman Pengaturan
  Kamera menampilkan peringatan.

---

## 1. Memasang & menyalakan

Sekali di laptop agent (unduhan ±1 GB, PyTorch):

```bash
cd agent && .venv/bin/pip install -e ".[detect]"
```

Lalu restart agent (`npm run dev:local` / `npm run prod:restart`).

Di web: **Pengaturan Kamera → Filter objek**

1. Nyalakan **Teruskan pemicu hanya bila objek ini yang melintas**
   (photocell virtual harus aktif).
2. Pilih **jenis objek**: Perahu, Motor, Sepeda, … atau ketik kelas lain
   (mis. `raft` untuk model hasil latih ulang).
3. Pilih **Model** dan **Keyakinan minimal** (bawaan 35%).
4. **Terapkan.** Statistik *Lolos / Diabaikan* dan objek terakhir tampil
   langsung di kartu itu.

Atau lewat `.env` (nilai awal):

```
PF_OBJECT_FILTER=boat,motorcycle   # kosong/off = tanpa filter
PF_OBJECT_MODEL=yolo11n.pt         # atau nama file di data/models/
PF_OBJECT_CONF=0.35
```

| Model bawaan | Kecepatan (Mac M-series) | Catatan |
|---|---|---|
| `yolo11n.pt` | ±40–80 ms per pemeriksaan | Cepat, cukup untuk motor/orang |
| `yolo11s.pt` | ±2× lebih lambat | Lebih akurat untuk objek kecil/jauh |

Model bawaan dilatih dengan dataset umum (COCO): **motor dikenali baik**,
tetapi **perahu karet** (buih, awak berhelm, sudut samping) sering lemah
sebagai `boat`. Untuk itu latih ulang dengan foto Anda sendiri — bagian 2.

---

## 2. Latih ulang dengan foto sendiri

Ringkasnya: **kumpulkan foto → beri kotak (label) → latih → pilih model di web.**
Semua perintah dijalankan dari folder `agent/`.

### Langkah 1 — Kumpulkan foto

Foto lomba Anda **sudah terkumpul otomatis**: setiap tangkapan menyimpan
foto frame di `data/captures/`. Ambil sebagian, foto yang hampir sama dilewati:

```bash
.venv/bin/pf-dataset collect                       # dari data/captures → data/dataset/raw
.venv/bin/pf-dataset collect rekaman-latihan.mp4 --every-s 0.5   # atau dari video (HP/kamera)
```

Target yang baik:

| | Jumlah | Tips |
|---|---|---|
| Foto **dengan** perahu | 300–500 (minimal 150) | Berbagai jarak, cahaya (pagi/siang/mendung), warna perahu, R4 & R6, perahu berdempetan, sebagian keluar frame |
| Foto **tanpa** perahu | 10–20% dari total | Air kosong, riak, orang di tepi, ranting — supaya model belajar *apa yang bukan perahu* |

Ambil dari **sudut kamera yang sama** dengan saat lomba — itulah yang dilihat model.

### Langkah 2 — Beri kotak (label)

Setiap perahu di foto diberi kotak persegi dan nama kelas. Agar lebih cepat,
buat kotak awal otomatis dulu dari model bawaan, lalu tinggal koreksi:

```bash
.venv/bin/pf-dataset prelabel --map boat=0          # .txt di samping foto, kelas 0 = perahu
```

Lalu buka di alat label (pilih salah satu, gratis):

- **Roboflow** (web, paling mudah): buat project *Object Detection* → upload
  folder `data/dataset/raw` (foto + .txt ikut terbaca) → koreksi kotak →
  *Export* format **YOLOv8/YOLO11** → unduh & ekstrak.
- **CVAT** (web/self-host) atau **Label Studio** (`pip install label-studio`)
  → ekspor format **YOLO**.

Aturan memberi kotak:

1. Kotak **rapat** di badan perahu (termasuk awak di dalamnya), dari haluan sampai buritan.
2. **Setiap** perahu di foto diberi kotak — termasuk yang terpotong di tepi frame.
3. Satu nama kelas yang konsisten, mis. `raft`. Bila perlu dibedakan:
   `raft` (0) dan `motorcycle` (1) — urutan nomor harus sama di semua foto.
4. Foto tanpa perahu **dibiarkan tanpa kotak** (tetap disertakan).

### Langkah 3 — Siapkan dataset

Arahkan ke folder hasil ekspor (berisi foto + .txt, atau `images/` + `labels/`):

```bash
.venv/bin/pf-dataset prepare ~/Downloads/perahu-export --classes raft
# atau dua kelas:  --classes raft,motorcycle
```

Hasil: `data/dataset/siap/` (80% latih, 20% uji) dan `data.yaml`.

### Langkah 4 — Latih

```bash
.venv/bin/pf-dataset train --name perahu-karet --epochs 80
```

- Di MacBook M-series ±10–40 menit untuk 300–500 foto (memakai GPU Mac).
  Laptop dengan GPU NVIDIA lebih cepat; Google Colab (gratis) juga bisa.
- `--base yolo11s.pt` untuk model lebih akurat (lebih lambat dilatih & dipakai).
- Selesai: model tersalin ke `data/models/perahu-karet.pt`.

Baca angka akhir di log (`all … mAP50`):

| mAP50 | Arti | Tindakan |
|---|---|---|
| ≥ 0,85 | Bagus | Pakai |
| 0,6–0,85 | Cukup | Tambah foto pada kondisi yang sering salah |
| < 0,6 | Kurang | Periksa label (kotak hilang/salah kelas), tambah foto |

### Langkah 5 — Pakai

**Pengaturan Kamera → Filter objek → Model:** pilih `perahu-karet.pt`
(tertulis *latih ulang*). Jenis objek otomatis menampilkan kelas model
(`raft`) → pilih → **Terapkan**.

Uji dengan beberapa perahu lewat dan lihat *Lolos / Diabaikan*. Bila ada
perahu yang diabaikan, turunkan **Keyakinan minimal** sedikit (mis. 25%),
lalu kumpulkan foto kejadian itu untuk latihan berikutnya.

### Memperbaiki terus (disarankan tiap event)

1. Setelah lomba: `pf-dataset collect` — foto baru dari event itu.
2. Label foto yang **salah** saja (perahu diabaikan, atau benda lain lolos).
3. Gabungkan dengan dataset lama → `prepare` → `train --name perahu-karet-v2`.
4. Pilih model baru di web; model lama tetap ada sebagai cadangan.

---

## 3. Catatan

- **Lisensi:** paket `ultralytics` berlisensi **AGPL-3.0**. Untuk dipakai
  sendiri tidak masalah; bila aplikasi ini dijual/didistribusikan tertutup,
  perlu lisensi komersial Ultralytics (atau ganti detektor berlisensi bebas
  seperti YOLOX/RT-DETR lewat ONNX).
- **Privasi:** foto latih berisi atlet/penonton. Simpan dataset hanya di
  laptop/penyimpanan panitia; `data/dataset/` dan `data/models/` tidak
  masuk git.
- **Laptop lemah:** pakai `yolo11n.pt`, atau matikan filter — photocell tetap
  bekerja seperti biasa.
