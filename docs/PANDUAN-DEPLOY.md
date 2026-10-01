# Panduan Deploy & Menjalankan STS Photo Finish

Panduan ini untuk tim yang memasang dan mengoperasikan STS Photo Finish,
baik **lokal** (uji coba di laptop pengembang) maupun **production** (hari
lomba di lokasi). Cara memakai aplikasinya sendiri (sesi, tandai urutan,
konfirmasi juri) ada di bagian 6.

---

## 1. Gambaran deploy

STS Photo Finish **tidak di-deploy ke internet**. Seluruh sistem berjalan di
**satu laptop/mini-PC di lokasi lomba**, karena sungai sering tanpa sinyal dan
jeda internet membuat waktu meleset. Perangkat lain (laptop timing, tablet
juri, HP) tersambung lewat **Wi-Fi/hotspot lokal**.

```
                     LAPTOP PHOTO FINISH  (mis. 192.168.1.10)
 ┌──────────────────────────────────────────────────────────────────┐
 │  pf-mongo   MongoDB             127.0.0.1:27018 (lokal saja)     │
 │  pf-api     API + Web App + Realtime   :4100  ◀── semua perangkat│
 │  pf-agent   Capture Agent ◀── kamera (USB / iPhone / IP camera)  │
 └──────────────────────────────────────────────────────────────────┘
        ▲ Wi-Fi/hotspot lokal                    ▲
        │                                        │
 Laptop sts-timingsystem + RaceTime2      Tablet/HP juri & operator
 (PF_API_URL=http://192.168.1.10:4100)    (browser: http://192.168.1.10:4100)
```

| Mode | Untuk | Web app dibuka di | Cara menjalankan |
|---|---|---|---|
| **Lokal / dev** | Uji coba, pengembangan | `http://localhost:5173` | 4–5 terminal (`npm run dev:*`) |
| **Production** | Hari lomba | `http://<ip-laptop>:4100` | 1 perintah: `npm run prod:start` (PM2) |

sts-timingsystem boleh berjalan di laptop yang sama atau laptop lain di
jaringan yang sama.

Ingin server yang bisa diakses dari internet (demo, uji jarak jauh)? Lihat
[PANDUAN-VPS.md](PANDUAN-VPS.md): API di VPS dengan HTTPS, agent kamera tetap di
lokasi dan mengunggah rekaman (`PF_UPLOAD_CAPTURES=on`).

---

## 2. Kebutuhan

**Perangkat lunak** (laptop Photo Finish)

| Komponen | Versi | Cek |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| Python | ≥ 3.10 | `python3 -V` |
| MongoDB Community | 7 atau 8 | `mongod --version` |
| Git | — | `git --version` |

macOS: `brew install node python mongodb/brew/mongodb-community`.

**Perangkat keras**

| | Uji coba | Lomba |
|---|---|---|
| Laptop | Apa saja | ≥ 8 GB RAM, SSD, **charger + power bank/power station** |
| Kamera | Kamera laptop / iPhone (24–30 fps) | Kamera **120–240 fps** (USB3/GigE), tripod, housing tahan air |
| Jaringan | Wi-Fi rumah | **Router/hotspot khusus** (WPA2), bukan Wi-Fi publik |

Kamera 30 fps cukup untuk menguji alur, tetapi akurasi 1/100 detik di lomba
membutuhkan kamera ≥ 120 fps.

---

## 3. Persiapan pertama kali (lokal & production)

```bash
git clone <repo> ~/Sites/sts-photofinish
cd ~/Sites/sts-photofinish
npm run setup
```

`npm run setup` (aman dijalankan ulang):

1. memeriksa Node, Python, MongoDB;
2. memasang dependensi (`npm install` + virtualenv agent);
3. membuat `.env` dengan **secret acak** bila belum ada (tidak menimpa yang lama);
4. membuat folder `data/`;
5. mem-build web app dan API.

### 3.1 Isi `.env`

| Variabel | Isi | Keterangan |
|---|---|---|
| `PF_MONGO_URL` | `mongodb://127.0.0.1:27018` | Port 27018 dipakai MongoDB khusus Photo Finish |
| `PF_JWT_SECRET`, `PF_HMAC_SECRET`, `PF_FILE_URL_SECRET` | (otomatis dari setup) | **Jangan dibagikan.** `PF_HMAC_SECRET` juga dipasang di sts-timingsystem |
| `PF_DEVICE_TOKEN` | token agent (lihat 3.3) | |
| `PF_CAMERA_SOURCE` | `0`, `1`, `http://…/video`, `rtsp://…`, atau path video | Lihat 3.2 |
| `PF_CAMERA_FPS` | fps kamera | 30 untuk kamera laptop/iPhone |
| `PF_FINISH_LINE` | `x1,y1,x2,y2` | Garis tegak di tengah: 1280×720 → `640,0,640,719`; 1920×1080 → `960,0,960,1079` |
| `PF_TRIGGER` | `camera` / `off` | Photocell virtual (pemicu otomatis saat perahu lewat) |
| `PF_TRIGGER_THRESHOLD`, `PF_TRIGGER_MIN_RUN` | 30, 0.06 | Naikkan bila riak/percikan ikut memicu |
| `PF_OFFICIAL_ROUNDING` | `truncate` / `round` | Pembulatan 1/100 detik (konfirmasi Chief Judge) |
| `PF_FRAMES` | `on` / `off` | Simpan foto frame utuh untuk panel **Foto frame** (tinjauan frame demi frame) |
| `PF_FRAMES_FPS`, `PF_FRAMES_WIDTH` | 60, 1280 | Batas fps & lebar foto frame. Turunkan bila laptop berat atau RAM terbatas |
| `PF_CORS_ORIGINS` | `http://localhost:5173` | Hanya untuk mode dev. Production tidak perlu diubah |

### 3.1b Database: MongoDB yang sama dengan sts-timingsystem

sts-timingsystem memakai **MongoDB Atlas** (cluster `mongo-jeko…`, database
`sustainabledb_atlas`). Photo Finish dapat memakai **cluster dan akun Atlas
yang sama** dengan **database terpisah** `sts_photofinish`, supaya koleksinya
tidak tercampur dengan data timing dan tidak tersentuh fitur backup/reset timing.

```
PF_MONGO_URL=<connection string Atlas yang sama dengan sts-timingsystem>
PF_MONGO_DB=sts_photofinish        # atau sustainabledb_atlas bila ingin satu database
PF_PM2_MONGO=off                   # tidak perlu MongoDB lokal
```

Yang perlu diperhatikan:

- **Butuh internet** di lokasi. Aturan ini sama dengan sts-timingsystem saat
  memakai Atlas. Tanpa internet, gunakan MongoDB lokal (`mongodb://127.0.0.1:27018`).
- **Atlas → Network Access**: izinkan IP laptop lokasi dan IP VPS.
- Akun pengguna Photo Finish (`pf_users`) ada di database Photo Finish.
  Setelah pindah database, buat ulang akun dengan `user:create`, atau salin dari database lama.

### 3.2 Memilih kamera

Cari nomor kamera yang terpasang:

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

| Kamera | `PF_CAMERA_SOURCE` |
|---|---|
| Kamera USB / laptop | nomor dari skrip (`0`, `1`, …) |
| **iPhone (Continuity Camera)**, biasanya 1920×1080 | nomornya dari skrip. Syarat: Apple ID sama, Wi-Fi + Bluetooth nyala, iPhone **landscape, diam, terkunci** |
| HP lewat aplikasi kamera IP | alamat dari aplikasi, mis. `http://192.168.1.20:8080/video` atau `rtsp://…` |
| Video uji (tanpa kamera) | path file, mis. `…/data/test-video/sungai-h2h.mp4` |

macOS meminta **izin kamera** untuk aplikasi terminal pada percobaan
pertama: **System Settings → Privacy & Security → Camera**. Aktifkan, lalu
tutup dan buka lagi terminal.

Cek gambar dan garis finish:

```bash
cd agent && set -a && source ../.env && set +a && .venv/bin/pf-agent --preview
# buka data/captures/preview.png
```

### 3.3 Akun & token perangkat

MongoDB harus sudah berjalan (`npm run prod:start`, atau terminal MongoDB di
mode lokal).

```bash
# akun pengguna (password diminta, minimal 10 karakter)
npm run user:create -w api -- admin admin "Nama Admin"
npm run user:create -w api -- operator1 operator "Nama Operator"
npm run user:create -w api -- juri1 judge "Nama Juri"

# token perangkat (tempel hasilnya)
npm run token:device -w api -- agent "Kamera Finish"     # → PF_DEVICE_TOKEN di .env
npm run token:device -w api -- timing "Laptop Timing"    # → konfigurasi sts-timingsystem (bagian 5)
```

| Peran | Bisa |
|---|---|
| `viewer` | Melihat sesi & rekaman |
| `operator` | Membuat/mengaktifkan sesi, Standby Kamera, kalibrasi kamera, menandai urutan |
| `judge` | + Konfirmasi/koreksi hasil (dikirim ke timing) |
| `admin` | + Kalibrasi jam Photo Finish, cek audit log |

Token berlaku 30 hari (`PF_DEVICE_TOKEN_TTL`). Buat ulang sebelum event bila
sudah lewat.

---

## 4. Menjalankan

### 4.1 Mode LOKAL (uji coba / pengembangan)

Buka satu terminal untuk masing-masing komponen dan **biarkan tetap terbuka**:

| # | Komponen | Perintah (dari folder `sts-photofinish`) |
|---|---|---|
| 1 | MongoDB | `mongod --dbpath ~/pf-mongo-data --port 27018 --bind_ip 127.0.0.1` |
| 2 | API | `npm run dev:api` |
| 3 | Web | `npm run dev:web` → **http://localhost:5173** |
| 4 | Agent kamera | `cd agent && set -a && source ../.env && set +a && .venv/bin/pf-agent -v` |
| 5 | Simulator RaceTime2 (opsional) | `npm run sim:timing -w api` (Enter = 1 perahu, `2` = H2H, `4` = RX) |

Aturan penting:

- Perintah `npm run …` dijalankan dari **folder utama** (`sts-photofinish`),
  bukan dari `agent/`.
- **Satu kamera = satu agent.** Sebelum menjalankan agent baru, hentikan
  yang lama (Ctrl+C). Agent kedua dengan kamera sama ditolak otomatis.
- Setelah mengubah `.env`, restart komponen yang memakainya (agent dan/atau API).

### 4.2 Mode PRODUCTION (hari lomba)

```bash
cd ~/Sites/sts-photofinish
npm run build        # setiap kali kode diperbarui
npm run prod:start   # MongoDB + API/web + agent kamera, sekaligus
```

Buka di laptop ini atau perangkat mana pun di jaringan yang sama:

```
http://<ip-laptop-photofinish>:4100
```

Cari IP laptop: `ipconfig getifaddr en0` (macOS).

| Perintah | Fungsi |
|---|---|
| `npm run prod:status` | Status ketiga proses (`online` = jalan) |
| `npm run prod:logs` | Log langsung (Ctrl+C untuk keluar) |
| `npm run prod:restart` | Restart semua (setelah ubah `.env`) |
| `npm run prod:stop` | Hentikan semua |
| `npm run prod:delete` | Hapus dari daftar PM2 |
| `npx pm2 restart pf-agent` | Restart satu komponen saja |

PM2 otomatis menyalakan ulang komponen yang mati (kamera tercabut, crash),
dan log tersimpan di `~/.pm2/logs/`.

**Variasi:**

- MongoDB sudah berjalan di tempat lain (mis. service sendiri): tambahkan
  `PF_PM2_MONGO=off` di `.env`.
- Kamera dipasang di **mesin lain** (mis. mini-PC di tepi garis finish): di
  laptop utama set `PF_PM2_AGENT=off`. Di mesin kamera, jalankan
  `scripts/run-agent.sh` dengan `PF_API_URL=http://<ip-laptop-utama>:4100`.
  Kamera berbeda perlu `PF_CAMERA_ID` berbeda (`cam-1`, `cam-2`).
- **Port 27018 sudah terpakai** oleh MongoDB yang Anda jalankan manual
  (mode lokal): hentikan dulu sebelum `prod:start`.

**Menyala otomatis saat laptop dinyalakan** (opsional):

```bash
npm run prod:start
npx pm2 save
npx pm2 startup      # ikuti perintah sudo yang ditampilkan
```

### 4.3 Jaringan di lokasi

1. Gunakan **router/hotspot khusus** dengan password WPA2/WPA3. Jangan
   memakai Wi-Fi publik.
2. Beri laptop Photo Finish **IP tetap** (DHCP reservation di router), agar
   alamat `http://<ip>:4100` tidak berubah di tengah lomba.
3. Saat pertama kali dibuka, macOS menanyakan **firewall** untuk Node.
   Pilih **Allow**. Bila tablet tidak bisa membuka: **System Settings →
   Network → Firewall → Options**, lalu izinkan `node`.
4. Uji dari tablet juri: buka `http://<ip>:4100` dan login.

---

## 5. Menghubungkan sts-timingsystem

Gunakan branch sts-timingsystem yang sudah berisi integrasi Photo Finish.

**Mode dev** (`yarn electron:serve`): tambahkan ke `sts-timingsystem/app/.env`

```
PF_API_URL=http://<ip-laptop-photofinish>:4100
PF_DEVICE_TOKEN=<token timing dari bagian 3.3>
PF_HMAC_SECRET=<sama persis dengan PF_HMAC_SECRET di .env Photo Finish>
```

Di mode lokal dengan semuanya di satu laptop: `PF_API_URL=http://127.0.0.1:4100`.

**Aplikasi terpasang** (hasil `yarn electron:build`): buat file
`photofinish.json` di folder data aplikasi.
macOS: `~/Library/Application Support/STiming System 424/photofinish.json`

```json
{ "apiUrl": "http://192.168.1.10:4100", "deviceToken": "<token timing>", "hmacSecret": "<PF_HMAC_SECRET>" }
```

Restart aplikasi timing. Di halaman H2H/RX/DRR akan muncul badge **"Photo
Finish terhubung"** dan tombol **Kirim heat ke Photo Finish**.

Tanpa konfigurasi ini, sts-timingsystem berjalan seperti biasa tanpa Photo Finish.

---

## 6. Prosedur hari lomba

### Sebelum heat pertama

| # | Siapa | Langkah |
|---|---|---|
| 1 | Teknisi | `npm run prod:start`, lalu `npm run prod:status`: ketiganya `online` |
| 2 | Admin | Login, klik **jam di navbar** → **Set ke waktu** sesuai layar RaceTime2, lalu rapikan dengan **Trim** |
| 3 | Operator | **Standby Kamera**: klik gambar di tiang photocell. Tiang harus berimpit dengan garis biru dan indikator **hijau** |
| 4 | Operator timing | sts-timingsystem: buka halaman lomba, pastikan badge **terhubung**, lalu **Connect Racetime** |

### Setiap heat

| # | Siapa | Langkah |
|---|---|---|
| 1 | Operator timing | **Kirim heat ke Photo Finish**, pilih heat, lalu **Kirim & aktifkan** |
| 2 | — | Perahu melintas. **Photocell virtual** memicu rekaman otomatis, dan baris `Photo Finish` + Buffer-Timer-Finish muncul di timing |
| 3 | Operator PF | Pilih lintasan, lalu klik **haluan** tiap perahu sesuai urutan tiba (kiri = lebih dulu) |
| 4 | Operator PF | Heat pertama saja: **Kalibrasi kamera** (butuh impuls RaceTime2) |
| 5 | Juri | **Konfirmasi** setiap perahu: jumlah awak, posisi perahu, melintas 2× |
| 6 | — | **Finish Time terisi otomatis** di sts-timingsystem. Penalti finish yang dicatat juri diterapkan operator timing |

### Setelah lomba: backup

```bash
STAMP=$(date +%Y%m%d)
mongodump --uri "mongodb://127.0.0.1:27018/sts_photofinish" --out ~/Backup-PF/$STAMP/db
cp -R data/captures ~/Backup-PF/$STAMP/captures
npm run prod:stop
```

Rekaman (`data/captures`) dan audit log adalah **barang bukti protes**.
Simpan backup minimal sampai masa protes selesai, lalu hapus frame mentah
sesuai kebijakan privasi (UU PDP).

---

## 7. Memperbarui versi

```bash
cd ~/Sites/sts-photofinish
npm run prod:stop
git pull
npm run setup          # pasang dependensi baru + build; .env tidak diubah
npm run prod:start
```

Jangan memperbarui di tengah hari lomba.

---

## 8. Keamanan

- `.env` berisi secret: **jangan di-commit, jangan dikirim lewat chat**.
  `.env` sudah ada di `.gitignore`.
- Ganti semua password akun uji (`uji-lokal-…`) dengan password baru
  untuk event sungguhan.
- MongoDB hanya mendengarkan `127.0.0.1`, jadi tidak bisa diakses dari jaringan.
- Pesan timing ↔ Photo Finish ditandatangani HMAC. Bila `PF_HMAC_SECRET`
  berbeda di kedua sisi, impuls dan hasil ditolak.
- Rekaman hanya bisa dibuka lewat aplikasi (URL bertanda tangan, berlaku 15 menit).
- Periksa keutuhan audit log (admin): `GET /api/audit/verify`.

---

## 9. Mengatasi masalah

| Gejala | Penyebab & solusi |
|---|---|
| Browser: **HTTP 500** saat login (mode dev) | API (4100) atau MongoDB mati. Cek terminal API/MongoDB |
| `prod:status`: `pf-api` **errored** | Belum di-build (`npm run build`), atau MongoDB belum siap. Lihat `npm run prod:logs` |
| `pf-mongo` errored, "address already in use" | Port 27018 dipakai MongoDB lain. Hentikan, atau set `PF_PM2_MONGO=off` |
| "Capture Agent belum terhubung" | Agent mati, kamera tidak bisa dibuka, atau `PF_DEVICE_TOKEN` salah. Lihat log agent |
| `Gagal membaca frame dari kamera` | Izin kamera terminal belum aktif, kamera dipakai aplikasi lain, atau nomor kamera salah (bagian 3.2) |
| Gambar Standby **berkedip** | Ada dua agent untuk kamera yang sama. Sisakan satu |
| Agent: "Kamera cam-1 sudah dipakai agent lain" | Hentikan agent lama, atau beri `PF_CAMERA_ID` berbeda |
| Pemicu kamera terlalu sering | Naikkan `PF_TRIGGER_THRESHOLD` / `PF_TRIGGER_MIN_RUN`, restart agent |
| Perahu lewat tapi tidak memicu | Turunkan nilai di atas. Pastikan sesi **AKTIF** |
| Timing: badge "Photo Finish terputus" | API mati, `PF_API_URL` salah, atau firewall. Impuls tetap antre dan terkirim setelah tersambung |
| Timing: "… hasil menunggu" | Buka kategori & heat yang sama dengan sesi Photo Finish |
| Tablet tidak bisa membuka `http://<ip>:4100` | Beda jaringan, atau firewall macOS memblokir `node` |
| Jam navbar "Belum kalibrasi" | Admin belum melakukan **Set ke waktu** |

---

## 10. Ringkasan perintah

```bash
# sekali
npm run setup
npm run user:create -w api -- <username> <admin|judge|operator|viewer> "<Nama>"
npm run token:device -w api -- <agent|timing> "<nama perangkat>"

# lokal
npm run dev:api            # API (4100)
npm run dev:web            # Web (5173)
npm run sim:timing -w api  # simulator RaceTime2
cd agent && set -a && source ../.env && set +a && .venv/bin/pf-agent -v

# production
npm run build && npm run prod:start
npm run prod:status | prod:logs | prod:restart | prod:stop

# tes
npm test && npm run test:interop -w api && (cd agent && .venv/bin/pytest)
```
