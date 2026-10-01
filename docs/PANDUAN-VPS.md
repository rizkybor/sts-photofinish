# Panduan Deploy STS Photo Finish ke VPS

Panduan ini memasang **API + web app + database** di VPS (Ubuntu 24.04) dengan
domain dan HTTPS. **Agent kamera tetap berjalan di laptop lokasi** (harus dekat
kamera) dan mengirim rekaman ke VPS lewat internet.

Untuk lomba resmi, mode **lokal/LAN** di [PANDUAN-DEPLOY.md](PANDUAN-DEPLOY.md)
tetap yang paling andal. Mode VPS cocok untuk demo, uji bersama dari lokasi
berbeda, atau lokasi lomba dengan internet stabil.

---

## 1. Gambaran

```
        LOKASI LOMBA                                   VPS (https://pf.domain-anda.id)
┌──────────────────────────────┐   internet   ┌─────────────────────────────────────────┐
│ Laptop kamera                │   HTTPS/WSS  │ Nginx :443 (HTTPS, WebSocket)           │
│  pf-agent (kamera, slit-scan)│ ───────────▶ │   └─▶ pf-api :4100 (API + web + realtime)│
│  PF_UPLOAD_CAPTURES=on       │              │        └─▶ MongoDB 127.0.0.1:27017      │
│                              │              │        └─▶ data/captures (rekaman)      │
│ Laptop sts-timingsystem      │ ───────────▶ │                                         │
│  + RaceTime2                 │              └─────────────────────────────────────────┘
└──────────────────────────────┘                    ▲
                                                    │ browser (juri, operator, pelatih)
```

### Yang perlu dipahami sebelum memilih VPS

| Hal | Dampak |
|---|---|
| **Butuh internet di lokasi** | Tanpa internet, impuls tetap antre di sts-timingsystem, tetapi rekaman kamera tidak bisa diunggah, sehingga tinjauan tertunda |
| **Jeda internet tidak stabil** | Jam agent disinkronkan ke VPS lewat internet (sampel jeda terkecil dipakai). Ketelitian lebih rendah daripada LAN. Lakukan **Kalibrasi kamera** di setiap sesi |
| **Upload rekaman** | Satu tangkapan ≈ 2–25 MB (slit-scan + foto frame). Di koneksi seluler, turunkan `PF_FRAMES_FPS` / `PF_FRAMES_WIDTH`, atau `PF_FRAMES=off` |
| **Data atlet di internet** | Wajib HTTPS, password kuat, dan firewall (bagian 9) |

---

## 2. Yang disiapkan

| Item | Rekomendasi |
|---|---|
| VPS | Ubuntu **24.04 LTS**, **2 vCPU, 4 GB RAM, ≥ 40 GB SSD**, region **Jakarta/Singapura** (jeda kecil) |
| Domain | Mis. `pf.domain-anda.id` |
| DNS | Record **A** `pf` → IP publik VPS (tunggu sampai `ping pf.domain-anda.id` menjawab IP VPS) |
| Akses | SSH ke VPS sebagai `root` (atau user sudo) |

Di semua perintah di bawah, ganti `pf.domain-anda.id` dengan domain Anda.

---

## 3. Siapkan server

```bash
ssh root@IP_VPS

# user khusus aplikasi (jangan jalankan aplikasi sebagai root)
adduser photofinish
usermod -aG sudo photofinish

# update & firewall: hanya SSH, HTTP, HTTPS
apt update && apt upgrade -y
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable
```

Disarankan login SSH memakai kunci (`ssh-copy-id photofinish@IP_VPS`) dan
mematikan login password.

---

## 4. Pasang perangkat lunak

Masih sebagai `root`:

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git nginx certbot python3-certbot-nginx

# MongoDB 8.0 (repositori resmi) — LEWATI bila memakai MongoDB Atlas yang
# sama dengan sts-timingsystem (lihat 5.1)
apt install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt update && apt install -y mongodb-org
systemctl enable --now mongod

# cek
node -v && mongod --version | head -1 && systemctl is-active mongod
```

MongoDB bawaan hanya mendengarkan `127.0.0.1` (lihat `bindIp` di
`/etc/mongod.conf`). **Jangan dibuka ke internet.**

---

## 5. Pasang aplikasi

Login sebagai user aplikasi:

```bash
su - photofinish
git clone <URL_REPO> ~/sts-photofinish
cd ~/sts-photofinish
npm install
npm run build
```

Di VPS **tidak perlu** Python atau agent kamera, karena agent berjalan di lokasi.

### 5.1 Konfigurasi `.env`

```bash
cp .env.example .env
for k in PF_JWT_SECRET PF_HMAC_SECRET PF_FILE_URL_SECRET; do
  sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
done
nano .env
```

Ubah baris berikut:

```
PF_HOST=127.0.0.1                      # hanya bisa diakses lewat Nginx
PF_PORT=4100
PF_TRUST_PROXY=true                    # IP asli pengguna dari Nginx (batas login)
PF_MONGO_URL=mongodb://127.0.0.1:27017 # MongoDB service dari langkah 4, ATAU
                                       # connection string Atlas yang sama dengan sts-timingsystem
PF_MONGO_DB=sts_photofinish
PF_CORS_ORIGINS=https://pf.domain-anda.id
PF_PM2_MONGO=off                       # MongoDB sudah jalan sebagai service
PF_PM2_AGENT=off                       # agent kamera ada di lokasi, bukan di VPS
```

**Memakai MongoDB Atlas yang sama dengan sts-timingsystem:** isi `PF_MONGO_URL`
dengan connection string Atlas timing, `PF_MONGO_DB=sts_photofinish`, lalu di
**Atlas → Network Access** tambahkan **IP publik VPS**. Langkah instalasi
MongoDB di bagian 4 boleh dilewati. Backup bagian 10 cukup untuk folder
rekaman, karena Atlas punya backup sendiri.

Catat nilai `PF_HMAC_SECRET`, karena nanti dipasang juga di sts-timingsystem.
**Jangan bagikan isi `.env`.**

### 5.2 Jalankan dengan PM2 (otomatis menyala setelah reboot)

```bash
npm run prod:start
npm run prod:status          # pf-api harus "online"
curl -s http://127.0.0.1:4100/health   # → {"ok":true}

npx pm2 save
npx pm2 startup systemd      # jalankan perintah sudo yang ditampilkan
```

---

## 6. Nginx + HTTPS

```bash
sudo cp ~/sts-photofinish/deploy/nginx-photofinish.conf /etc/nginx/sites-available/photofinish
sudo sed -i "s/DOMAIN_ANDA/pf.domain-anda.id/" /etc/nginx/sites-available/photofinish
sudo ln -s /etc/nginx/sites-available/photofinish /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# sertifikat HTTPS gratis (Let's Encrypt), perpanjangan otomatis
sudo certbot --nginx -d pf.domain-anda.id --redirect -m email@anda.id --agree-tos -n
```

Buka **https://pf.domain-anda.id**. Halaman login STS Photo Finish akan tampil.

Template Nginx sudah mengatur **WebSocket** (wajib untuk realtime) dan batas
unggahan **32 MB** (rekaman dari agent).

---

## 7. Akun & token (di VPS)

```bash
cd ~/sts-photofinish
npm run user:create -w api -- admin admin "Nama Admin"
npm run user:create -w api -- operator1 operator "Nama Operator"
npm run user:create -w api -- juri1 judge "Nama Juri"

npm run token:device -w api -- agent "Kamera Finish"     # → laptop kamera (bagian 8)
npm run token:device -w api -- timing "Laptop Timing"    # → sts-timingsystem (bagian 8)
```

Gunakan password kuat (≥ 12 karakter), karena server ini bisa diakses dari internet.

---

## 8. Hubungkan perangkat di lokasi

### 8.1 Laptop kamera (agent)

Di laptop lokasi, siapkan repo seperti [PANDUAN-DEPLOY.md §3](PANDUAN-DEPLOY.md),
lalu ubah `.env` laptop tersebut:

```
PF_API_URL=https://pf.domain-anda.id
PF_DEVICE_TOKEN=<token agent dari VPS>
PF_UPLOAD_CAPTURES=on              # rekaman diunggah ke VPS
PF_CAMERA_SOURCE=0                 # sesuaikan kamera (PANDUAN-DEPLOY §3.2)
PF_CAMERA_FPS=30
PF_FINISH_LINE=960,0,960,1079
PF_TRIGGER=camera
# koneksi lemah? hemat unggahan:
# PF_FRAMES_FPS=30
# PF_FRAMES_WIDTH=960
```

Jalankan **hanya agent** (laptop ini tidak menjalankan API/MongoDB):

```bash
cd ~/Sites/sts-photofinish/agent
set -a && source ../.env && set +a
.venv/bin/pf-agent -v
```

Agent siap bila muncul `Terhubung ke API https://pf.domain-anda.id`. Setiap
rekaman menampilkan `… file rekaman diunggah ke API`. Salinan rekaman tetap
tersimpan di laptop (`data/captures`) sebagai cadangan.

### 8.2 sts-timingsystem

`app/.env` (mode dev) atau `photofinish.json` (aplikasi terpasang, lihat
[PANDUAN-DEPLOY.md §5](PANDUAN-DEPLOY.md)):

```
PF_API_URL=https://pf.domain-anda.id
PF_DEVICE_TOKEN=<token timing dari VPS>
PF_HMAC_SECRET=<PF_HMAC_SECRET dari .env VPS>
```

Badge **"Photo Finish terhubung"** muncul di halaman H2H/RX/DRR.

### 8.3 Juri & operator

Buka **https://pf.domain-anda.id** dari laptop, tablet, atau HP mana pun.

---

## 9. Keamanan

- **HTTPS wajib.** Token login dan device token tidak boleh lewat HTTP biasa di internet.
- Firewall hanya membuka 22/80/443. MongoDB dan port 4100 tidak terbuka ke luar.
- Ganti semua password uji. Buat akun per orang, jangan dipakai bersama.
- Batas login 10 percobaan per 5 menit per IP (`PF_LOGIN_RATE_MAX`) sudah aktif.
  `PF_TRUST_PROXY=true` membuat batas ini berlaku per pengguna asli, bukan per Nginx.
- Token perangkat berlaku 30 hari. Bila laptop lokasi hilang, buat ulang
  **PF_JWT_SECRET** (semua token & login jadi tidak berlaku) lalu terbitkan token baru.
- Opsional: `sudo apt install fail2ban` untuk memblokir percobaan SSH berulang.

---

## 10. Backup otomatis

```bash
mkdir -p ~/backup
crontab -e
```

Tambahkan (setiap malam pukul 02.00, simpan 14 hari):

```
0 2 * * * mongodump --uri mongodb://127.0.0.1:27017/sts_photofinish --archive=$HOME/backup/db-$(date +\%F).gz --gzip && tar czf $HOME/backup/captures-$(date +\%F).tgz -C $HOME/sts-photofinish/data captures && find $HOME/backup -mtime +14 -delete
```

Salin backup ke tempat lain secara berkala, misalnya
`rsync -a photofinish@IP_VPS:backup/ ~/Backup-PF/` dari laptop kantor.

---

## 11. Memperbarui versi

```bash
cd ~/sts-photofinish
git pull
npm install
npm run build
npm run prod:restart
```

Jangan memperbarui di tengah lomba.

---

## 12. Mengatasi masalah

| Gejala | Penyebab & solusi |
|---|---|
| **502 Bad Gateway** | `pf-api` mati. Jalankan `npm run prod:status` dan `npm run prod:logs` |
| Login berhasil tetapi status realtime merah / data tidak muncul langsung | WebSocket tidak lewat Nginx. Pastikan memakai template `deploy/nginx-photofinish.conf` (header `Upgrade`/`Connection`) |
| Agent: `413 Request Entity Too Large` | `client_max_body_size` Nginx kurang. Template memakai 32m |
| Agent: `Gagal mengunggah …` | Internet lokasi putus. Agent mencoba 3×. Rekaman tetap ada di laptop lokasi |
| Agent: `File capture tidak ditemukan` | `PF_UPLOAD_CAPTURES` belum `on` di laptop kamera |
| Agent/timing: `Unauthorized` | Token dibuat dengan `PF_JWT_SECRET` lain, atau sudah kedaluwarsa. Buat ulang di VPS |
| Timing: impuls/hasil ditolak (HMAC) | `PF_HMAC_SECRET` di timing ≠ di VPS |
| Semua orang terkena "terlalu banyak percobaan login" | `PF_TRUST_PROXY=true` belum diset, lalu `npm run prod:restart` |
| Sertifikat HTTPS gagal | DNS belum mengarah ke IP VPS, atau port 80 diblokir firewall |
| Waktu rekaman kurang presisi | Jeda internet. Lakukan Kalibrasi kamera di setiap sesi. Untuk lomba resmi gunakan mode LAN |

---

## 13. Ringkasan perintah (VPS)

```bash
npm run build && npm run prod:start      # pertama kali / setelah update
npm run prod:status | prod:logs | prod:restart | prod:stop
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run             # cek perpanjangan HTTPS
```
