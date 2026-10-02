# Panduan Menggunakan STS Photo Finish

Panduan untuk tim yang memasang dan mengoperasikan STS Photo Finish bersama
**sts-timingsystem**:

- **A. Lokal**: menjalankan dan mencoba Photo Finish di satu laptop.
- **B. Production**: hari lomba, di **B1. laptop lokasi (LAN)** atau **B2. VPS**,
  beserta **B3. cara menggunakan saat lomba**.

Bagian **0. Persiapan** dikerjakan sekali per laptop dan berlaku untuk A dan B.

---

## 0. Persiapan (sekali per laptop)

### 0.1 Komponen

| Komponen | Fungsi | Berjalan di |
|---|---|---|
| **API + web app** | Sesi, rekaman, konfirmasi juri, realtime | Laptop Photo Finish / VPS |
| **Capture Agent** | Membaca kamera, photocell virtual, slit-scan & foto frame | **Selalu** di laptop yang tersambung ke kamera |
| **Database** | MongoDB Atlas yang sama dengan sts-timingsystem (database `sts_photofinish`), atau MongoDB lokal | Atlas (internet) / laptop |
| **sts-timingsystem** | RaceTime2, Finish Time, hasil resmi | Laptop timing |

### 0.2 Perangkat lunak

| | Versi | Cek |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| Python | ≥ 3.10 | `python3 -V` |
| MongoDB (hanya bila memakai database lokal) | 7/8 | `mongod --version` |

macOS: `brew install node python` (tambah `mongodb/brew/mongodb-community` bila perlu).

### 0.3 Pasang aplikasi

```bash
git clone <URL_REPO> ~/Sites/sts-photofinish
cd ~/Sites/sts-photofinish
npm run setup
```

`npm run setup` (aman dijalankan ulang):

- memeriksa perangkat lunak,
- memasang dependensi (Node + virtualenv agent),
- membuat `.env` dengan **secret acak** (tidak menimpa `.env` yang sudah ada),
- membuat folder `data/`,
- mem-build aplikasi.

Semua perintah `npm run …` dijalankan dari **folder utama** `sts-photofinish`.
Perintah agent (`.venv/bin/pf-agent`) dijalankan dari folder `agent/`.

### 0.4 Database (`.env`)

**Pilihan utama: MongoDB Atlas yang sama dengan sts-timingsystem.** Cluster
dan akunnya sama, databasenya terpisah supaya data tidak tercampur.

```
PF_MONGO_URL=<connection string Atlas, sama dengan MONGO_URI di sts-timingsystem/app/.env>
PF_MONGO_DB=sts_photofinish
PF_PM2_MONGO=off
```

- Butuh **internet**. IP laptop/VPS harus diizinkan di **Atlas → Network Access**.
- Connection string adalah **rahasia**: hanya di `.env`, jangan di-commit atau dikirim lewat chat.
- Tulis **dengan tanda kutip** karena berisi `&`: `PF_MONGO_URL="mongodb://…&…"`.

**Alternatif tanpa internet: MongoDB lokal di laptop**

```
PF_MONGO_URL=mongodb://127.0.0.1:27018
PF_MONGO_DB=sts_photofinish
PF_PM2_MONGO=on        # production: PM2 ikut menjalankan MongoDB (data/mongo)
```

Akun pengguna tersimpan di database yang dipakai. Setelah pindah database,
buat ulang akun (0.6).

### 0.5 Kamera (`.env`)

Cari nomor kamera:

```bash
cd agent && .venv/bin/python -c "
import cv2, time
for i in range(4):
    c = cv2.VideoCapture(i); ok = False; t = time.time()
    while time.time() - t < 3:
        ok, f = c.read()
        if ok: break
    print(f'kamera {i}:', f'BISA, {f.shape[1]}x{f.shape[0]}' if ok else 'gagal')
    c.release()
"
```

| Kamera | `PF_CAMERA_SOURCE` | `PF_CAMERA_FPS` | `PF_FINISH_LINE` (garis tegak di tengah) |
|---|---|---|---|
| **iPhone (Continuity Camera)**, biasanya 1920×1080 | nomor dari skrip (mis. `0`) | 30 | `960,0,960,1079` |
| Kamera laptop 1280×720 | nomor dari skrip (mis. `1`) | 30 | `640,0,640,719` |
| Kamera USB/industri | nomornya | sesuai kamera (120–240) | sesuai resolusi |
| HP lewat aplikasi kamera IP | `http://…/video` atau `rtsp://…` | 30 | sesuai resolusi |
| Video uji (tanpa kamera) | `…/data/test-video/sungai-h2h.mp4` | 60 | `320,0,320,359` |

| Variabel | Default | Fungsi |
|---|---|---|
| `PF_TRIGGER` | `camera` | **Photocell virtual**: rekaman terpicu otomatis saat perahu menyentuh garis |
| `PF_TRIGGER_THRESHOLD` / `PF_TRIGGER_MIN_RUN` | 30 / 0.06 | Naikkan bila riak atau bayangan ikut memicu; turunkan bila perahu terlewat |
| `PF_FRAMES` | `on` | Simpan **foto frame** utuh (tinjauan frame demi frame) |
| `PF_FRAMES_FPS` / `PF_FRAMES_WIDTH` | 60 / 1280 | Turunkan bila laptop berat atau koneksi lambat |

- **iPhone:** Apple ID sama dengan Mac, Wi-Fi + Bluetooth nyala, iPhone
  **landscape, diam (tripod), terkunci**.
- **Izin kamera macOS** untuk aplikasi terminal: **System Settings → Privacy &
  Security → Camera**, lalu buka ulang terminal.

Cek gambar & garis finish:

```bash
cd agent && source ../scripts/lib-env.sh && load_env ../.env && .venv/bin/pf-agent --preview
# buka data/captures/preview.png
```

**Lebih mudah lewat web:** setelah agent jalan, buka menu **Pengaturan Kamera**
(akun operator/admin). Di sana bisa:

- memilih sumber: **Kamera laptop / iPhone / Kamera eksternal / Kamera IP / Video uji**,
  lalu **Pindai kamera** untuk melihat nomor & nama perangkat;
- mengatur fps, resolusi, garis finish (**Otomatis** atau **Atur di gambar**: klik
  dua titik, tombol **Luruskan**), photocell virtual, dan foto frame;
- **Terapkan**: diterapkan langsung tanpa restart agent. Bila kamera baru gagal
  dibuka, agent kembali ke pengaturan lama dan tidak ada yang tersimpan;
- **Kembalikan ke .env**: menghapus pengaturan web, agent memakai nilai `.env` lagi.

Pengaturan web disimpan di database (`pf_camera_configs`) dan dikirim ulang ke
agent setiap kali agent tersambung, jadi `.env` cukup diisi nilai awal.

### 0.6 Akun & token

Database (0.4) harus bisa diakses.

```bash
npm run user:create -w api -- admin admin "Nama Admin"
npm run user:create -w api -- operator1 operator "Nama Operator"
npm run user:create -w api -- juri1 judge "Nama Juri"

npm run token:device -w api -- agent "Kamera Finish"     # → PF_DEVICE_TOKEN di .env laptop kamera
npm run token:device -w api -- timing "Laptop Timing"    # → konfigurasi sts-timingsystem (0.7)
```

| Peran | Bisa |
|---|---|
| `viewer` | Melihat sesi & rekaman |
| `operator` | Sesi, Standby Kamera, kalibrasi kamera, tandai urutan, hapus tangkapan |
| `judge` | + Konfirmasi/koreksi hasil (dikirim ke timing) |
| `admin` | + Kalibrasi jam Photo Finish, audit log |

Token perangkat berlaku 30 hari. Buat ulang sebelum event bila sudah lewat.

### 0.7 sts-timingsystem

Gunakan branch timing yang berisi integrasi Photo Finish. Isi
`sts-timingsystem/app/.env` (salin dari `app/.env.example`):

```
MONGO_URI=<connection string Atlas>          # wajib — tidak lagi ditulis di kode
PF_API_URL=http://127.0.0.1:4100             # alamat API Photo Finish (lihat A / B)
PF_DEVICE_TOKEN=<token timing dari 0.6>
PF_HMAC_SECRET=<sama persis dengan PF_HMAC_SECRET di .env Photo Finish>
```

- **Aplikasi timing terpasang** (installer) membaca `photofinish.json` di folder
  data aplikasi (macOS: `~/Library/Application Support/STiming System 424/`):
  ```json
  { "apiUrl": "http://192.168.1.10:4100", "deviceToken": "<token timing>", "hmacSecret": "<PF_HMAC_SECRET>" }
  ```
- Installer timing harus di-build di mesin yang `app/.env`-nya berisi `MONGO_URI`.
- Tanpa konfigurasi Photo Finish, timing berjalan seperti biasa.

---

## A. LOKAL: menjalankan & mencoba di satu laptop

Semua komponen di satu laptop, web dibuka di **http://localhost:5173**.

### A.1 Menjalankan: satu perintah

```bash
cd ~/Sites/sts-photofinish
npm run dev:local
```

Skrip `scripts/dev-local.sh` menjalankan semuanya secara berurutan dan
menunggu sampai tiap komponen benar-benar siap:

| # | Komponen | Keterangan |
|---|---|---|
| 1 | Persiapan | Cek `.env`, dependensi Node, virtualenv agent (dipasang otomatis bila belum ada) |
| 2 | Database | **Atlas**: langsung dipakai. **MongoDB lokal**: dinyalakan bila belum jalan (`~/pf-mongo-data`) |
| 3 | API | `:4100`. Bila database belum punya akun, skrip menawarkan membuat akun **admin** |
| 4 | Web | **http://localhost:5173** (alamat untuk tablet/HP di jaringan yang sama ikut ditampilkan) |
| 5 | Agent kamera | Token dibuat otomatis bila `PF_DEVICE_TOKEN` kosong. Dilewati bila agent lain sudah berjalan |

- Komponen yang **sudah berjalan dipakai ulang**, tidak dijalankan dobel.
- **Ctrl+C** menghentikan semua yang dinyalakan skrip ini.
- Log ada di `data/logs/` (api.log, web.log, agent.log).
- Tanpa agent kamera: `npm run dev:local -- --no-agent`.

Jalankan **terpisah** bila perlu (di terminal lain):

| Komponen | Perintah | Tanda siap |
|---|---|---|
| sts-timingsystem | `cd ~/Sites/sts-timingsystem/app && yarn electron:serve` | badge **"Photo Finish terhubung"** di halaman H2H/RX/DRR |
| Simulator RaceTime2 (tanpa alat) | `npm run sim:timing -w api` | `[sim] terhubung …` |

Bila ingin menjalankan per komponen secara manual: `npm run dev:api`,
`npm run dev:web`, dan agent dengan
`cd agent && source ../scripts/lib-env.sh && load_env ../.env && .venv/bin/pf-agent -v`.

### A.2 Cara menggunakan (uji coba)

1. **Login** `admin` di http://localhost:5173.
2. **Jam Photo Finish:** klik jam di navbar → **Set ke waktu** (jam sekarang / layar RaceTime2).
3. **Standby Kamera:** gambar live tampil. Klik gambar di tiang/penanda finish,
   lalu cek indikator kelurusan **hijau**.
4. **Siapkan sesi:** di Photo Finish **Sesi Lomba → Sesi baru** → pilih **Event**
   (Keterangan opsional) → **Buat & aktifkan**. Di sts-timingsystem cukup
   pastikan badge **Photo Finish terhubung**.
5. **Picu finish:** lewatkan benda (tangan, buku) melewati **garis tengah kamera**.
   - Photo Finish: **kelompok finish** baru muncul otomatis. Sekitar 3 detik
     kemudian, gambar **slit-scan** dan **foto frame** tampil.
   - Timing: baris **`Photo Finish`** muncul di tabel waktu, **Buffer-Timer-Finish** terisi.
   - Dengan simulator: ketik `2` + Enter (dua perahu H2H).
6. **Tandai urutan:** pilih lintasan **A** → klik ujung haluan di slit-scan.
   Pilih **B** → klik haluan berikutnya. Kiri = lebih dulu. Arahkan kursor ke
   slit-scan atau pakai ◀ ▶ untuk melihat **foto frame**.
7. **Konfirmasi juri:** login `juri1` di tab lain → **Konfirmasi** → isi jumlah
   awak → **Konfirmasi hasil**.
8. **Hasil di timing:** Finish Time tim terisi otomatis di halaman H2H.
9. **Bersihkan data uji:** tombol **Hapus** di setiap kelompok finish.

### A.3 Aturan penting saat uji

- **Satu kamera = satu agent.** Hentikan agent lama (Ctrl+C) sebelum menjalankan
  yang baru. Agent kedua dengan kamera sama ditolak otomatis.
- Setelah mengubah `.env`, restart komponen yang memakainya (API dan/atau agent).
- Kamera laptop/iPhone (24–30 fps) cukup untuk menguji alur, tetapi bukan
  akurasi 1/100 detik. Cahaya terang membuat gambar lebih tajam.

---

## B. PRODUCTION: hari lomba

| | **B1. Laptop di lokasi (LAN)** | **B2. VPS** |
|---|---|---|
| Server | Laptop/mini-PC di lokasi | VPS + domain + HTTPS |
| Dibuka di | `http://<ip-laptop>:4100` | `https://pf.domain-anda.id` |
| Agent kamera | Laptop yang sama | Laptop lokasi, mengunggah rekaman ke VPS |
| Internet | Hanya bila memakai Atlas | **Wajib** |
| Presisi waktu | **Terbaik** (jeda LAN kecil & stabil) | Lebih rendah (jeda internet) |
| Cocok untuk | **Lomba resmi** | Demo, uji jarak jauh |

### B1. Laptop di lokasi (LAN), disarankan untuk lomba

**1. Build & jalankan (satu perintah)**

```bash
cd ~/Sites/sts-photofinish
npm run build
npm run prod:start      # API + web + agent kamera (+ MongoDB lokal bila PF_PM2_MONGO=on)
npm run prod:status     # semua "online"
```

Buka `http://<ip-laptop>:4100` dari laptop ini, tablet juri, atau HP. Cari IP
laptop dengan `ipconfig getifaddr en0`.

| Perintah | Fungsi |
|---|---|
| `npm run prod:status` | Status proses |
| `npm run prod:logs` | Log langsung (Ctrl+C keluar) |
| `npm run prod:restart` | Restart semua (setelah ubah `.env`) |
| `npm run prod:stop` | Hentikan semua |
| `npx pm2 restart pf-agent` | Restart agent saja |

PM2 menyalakan ulang komponen yang mati. Untuk menyala otomatis saat laptop
dinyalakan: `npx pm2 save && npx pm2 startup` (ikuti perintah sudo yang ditampilkan).

**2. Jaringan lokasi**

- **Router/hotspot khusus** dengan password WPA2/WPA3, bukan Wi-Fi publik.
- **IP tetap** untuk laptop Photo Finish (DHCP reservation).
- Saat ditanya firewall macOS, izinkan **node**.
- Memakai Atlas: router harus punya internet. Tanpa internet: MongoDB lokal (0.4).

**3. Laptop timing:** `PF_API_URL=http://<ip-laptop-photofinish>:4100` (0.7).

**Variasi**

- **Kamera di mesin lain** (mis. mini-PC di tepi garis finish): di laptop utama
  `PF_PM2_AGENT=off`. Di mesin kamera, jalankan agent dengan
  `PF_API_URL=http://<ip-laptop-utama>:4100`. Kamera berbeda butuh `PF_CAMERA_ID` berbeda.
- **Port 27018 sudah dipakai** MongoDB yang dijalankan manual: hentikan dulu,
  atau set `PF_PM2_MONGO=off`.

### B2. VPS (domain + HTTPS)

Langkah lengkap ada di **[PANDUAN-VPS.md](PANDUAN-VPS.md)**. Ringkasnya:

1. VPS Ubuntu 24.04, record DNS **A** → IP VPS.
2. Pasang Node 22, Nginx, Certbot (MongoDB tidak perlu bila memakai **Atlas**).
3. `git clone` → `npm install` → `npm run build`.
4. `.env` VPS: secret acak, `PF_HOST=127.0.0.1`, `PF_TRUST_PROXY=true`,
   `PF_MONGO_URL=<Atlas>`, `PF_MONGO_DB=sts_photofinish`, `PF_PM2_MONGO=off`, `PF_PM2_AGENT=off`.
5. `npm run prod:start` → `npx pm2 save` → `npx pm2 startup`.
6. Nginx dari `deploy/nginx-photofinish.conf` → `certbot --nginx`.
7. **Atlas → Network Access**: tambahkan IP VPS.
8. **Laptop kamera di lokasi:** `PF_API_URL=https://pf.domain-anda.id`,
   `PF_UPLOAD_CAPTURES=on`, lalu jalankan agent.
9. **Laptop timing:** `PF_API_URL=https://pf.domain-anda.id`.

### B3. Cara menggunakan saat lomba (B1 & B2)

**Sebelum heat pertama**

| # | Siapa | Langkah |
|---|---|---|
| 1 | Teknisi | Server jalan (`npm run prod:status`), agent kamera **terhubung** |
| 2 | Admin | **Jam navbar → Set ke waktu** sesuai layar RaceTime2, rapikan dengan **Trim** |
| 3 | Operator | **Standby Kamera**: tiang photocell berimpit dengan garis biru tegak lurus, indikator **hijau** |
| 4 | Operator timing | Halaman lomba: badge **"Photo Finish terhubung"** → **Connect Racetime** |

**Selama lomba: operator PF standby di layar Standby Kamera**

Jeda antar heat bisa < 2 menit, jadi operator **tidak** membuka detail sesi
untuk setiap finish. Bar heat di atas layar selalu menampilkan sesi yang
**AKTIF**; layar Standby menampilkan feed **Finish terakhir**.

| Kejadian | Yang dilakukan |
|---|---|
| Finish **satu perahu** | Tidak ada. Feed menulis "Tercatat"; waktu resmi dari RaceTime2 |
| Finish **berdekatan** (≥ 2 perahu dalam satu kelompok) | Bunyi + banner kuning **Finish berdekatan**. Tekan **Tinjau sekarang** (T): detail sesi terbuka tepat di finish itu |
| Selesai meninjau | Banner hijau. **Kembali ke Standby** (S) |
| Butuh sesi baru (opsional) | **Sesi berikutnya** (N): Event & kamera tersalin dari sesi aktif, isi Keterangan bila perlu, **Enter** = buat & aktifkan, tetap di Standby. Satu sesi boleh dipakai untuk banyak heat/kategori |
| Finish berdekatan sesi lama belum ditinjau | Muncul di bar atas sebagai "Berdekatan belum ditinjau". Klik untuk meninjau kapan saja. Sinyal baru tetap masuk ke sesi aktif |

Pintasan keyboard (di luar kolom isian): **T** tinjau finish berdekatan
berikutnya · **S** Standby · **N** sesi berikutnya · **A** detail sesi aktif.

**Sesi = Event**

Sesi cukup terhubung ke **Event** — format lomba (H2H, RX, DRR, Sprint,
Slalom), Division, Race, dan Initial tidak dipilih; penerapannya sama untuk
semua. Label sesi dibuat otomatis ("<Nama Event> · Sesi N"). Bila perlu
pembeda (mis. "R4 Putri · Heat 3"), tulis di **Keterangan** sesi.

**Meninjau finish berdekatan**

| # | Siapa | Langkah |
|---|---|---|
| 1 | Operator PF | Pilih lintasan/tim → klik **haluan** tiap perahu sesuai urutan tiba. Finish tipis: periksa **Foto frame** (◀ ▶) |
| 2 | Operator PF | Heat pertama saja: **Kalibrasi kamera** (butuh sinyal RaceTime2) |
| 3 | Juri | **Konfirmasi** tiap perahu: jumlah awak, posisi perahu, melintas 2× |
| 4 | — | **Finish Time terisi otomatis** di timing. Penalti finish yang dicatat juri diterapkan operator timing |
| 5 | Operator PF | Tangkapan palsu (orang lewat) → **Hapus**. Yang sudah dikonfirmasi juri tidak bisa dihapus |

**Setelah lomba: backup**

```bash
STAMP=$(date +%Y%m%d)
mongodump --uri "$(grep ^PF_MONGO_URL= .env | cut -d= -f2-)" --db sts_photofinish --out ~/Backup-PF/$STAMP/db
cp -R data/captures ~/Backup-PF/$STAMP/captures
```

Rekaman dan audit log adalah **barang bukti protes**. Simpan sampai masa
protes selesai, lalu hapus frame mentah sesuai kebijakan privasi (UU PDP).

---

## C. Memperbarui versi

```bash
cd ~/Sites/sts-photofinish
npm run prod:stop        # production saja
git pull
npm run setup            # dependensi baru + build; .env tidak diubah
npm run prod:start       # production saja
```

Jangan memperbarui di tengah hari lomba.

---

## D. Keamanan

- `.env` (Photo Finish) dan `app/.env` (timing) berisi rahasia: **jangan di-commit, jangan dibagikan**.
- Connection string Atlas hanya di `.env`, tidak lagi di kode sumber timing.
- Ganti password akun uji (`uji-lokal-…`) sebelum event sungguhan. Buat akun per orang.
- `PF_HMAC_SECRET` harus sama di Photo Finish dan timing (pesan ditandatangani HMAC).
- Rekaman hanya bisa dibuka lewat aplikasi (URL bertanda tangan, 15 menit).
- VPS: wajib HTTPS, firewall 22/80/443 (PANDUAN-VPS.md).

---

## E. Mengatasi masalah

| Gejala | Penyebab & solusi |
|---|---|
| Browser **HTTP 500** saat login (lokal) | API (4100) mati, atau database tidak bisa diakses. Cek terminal API |
| API gagal start, error koneksi MongoDB | Atlas: internet / Network Access. Lokal: `mongod` 27018 belum jalan |
| `npm error No workspaces found` | Perintah dijalankan dari `agent/`. Pindah ke folder utama |
| "Capture Agent belum terhubung" | Agent mati, kamera tidak terbuka, atau `PF_DEVICE_TOKEN` salah. Lihat terminal/log agent |
| `Gagal membaca frame dari kamera` | Izin kamera, kamera dipakai aplikasi lain, atau nomor kamera salah (0.5) |
| Gambar Standby **berkedip** | Dua agent untuk kamera yang sama. Sisakan satu |
| Pemicu terlalu sering / tidak memicu | Atur `PF_TRIGGER_THRESHOLD` / `PF_TRIGGER_MIN_RUN`, restart agent. Pastikan sesi **AKTIF** |
| Foto frame "tidak menyimpan frame utuh" | Rekaman lama, atau `PF_FRAMES=off` |
| Timing: "Photo Finish terputus" | API mati, `PF_API_URL` salah, atau firewall. Sinyal tetap antre |
| Timing: "… hasil menunggu" | Buka kategori & heat yang sama dengan sesi Photo Finish |
| Timing tidak bisa membuka database | `MONGO_URI` belum ada di `app/.env` (atau installer di-build tanpa `MONGO_URI`) |
| Tablet tidak bisa membuka `http://<ip>:4100` | Beda jaringan, atau firewall macOS memblokir node |
| Jam navbar "Belum kalibrasi" | Admin belum **Set ke waktu** |

---

## F. Ringkasan perintah

```bash
# persiapan (sekali)
npm run setup
npm run user:create -w api -- <username> <admin|judge|operator|viewer> "<Nama>"
npm run token:device -w api -- <agent|timing> "<nama perangkat>"

# A. lokal
npm run dev:local                   # semua sekaligus (Ctrl+C untuk berhenti)
npm run dev:api                     # atau per komponen: API :4100
npm run dev:web                     # Web :5173
cd agent && source ../scripts/lib-env.sh && load_env ../.env && .venv/bin/pf-agent -v
npm run sim:timing -w api           # simulator RaceTime2 (opsional)

# B. production (laptop lokasi / VPS)
npm run build && npm run prod:start
npm run prod:status | prod:logs | prod:restart | prod:stop

# tes
npm test && npm run test:interop -w api && (cd agent && .venv/bin/pytest)
```
