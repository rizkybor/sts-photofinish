# sts-photofinish

Photo finish berbasis web untuk lomba arung jeram & kayak FAJI, terhubung ke
**sts-timingsystem**. Satu kamera di tepi sungai menentukan **urutan** perahu,
impuls RaceTime2 menentukan **waktu**. Fokus: H2H, Rafting Cross, DRR.

- Arsitektur & keputusan desain: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Integrasi ke timing system: [docs/INTEGRATION-TIMING.md](docs/INTEGRATION-TIMING.md)

| Folder | Isi | Teknologi |
|---|---|---|
| `api/` | Photo Finish API — sesi, impuls, capture, crossing, audit | Node ≥20.6, TypeScript, Fastify, Socket.IO, MongoDB |
| `web/` | Web App juri — review slit-scan, tandai urutan, konfirmasi | Vue 3, Vite |
| `agent/` | Capture Agent — kamera → slit-scan | Python ≥3.10, OpenCV |
| `data/captures/` | Rekaman (barang bukti — tidak masuk git) | |

Semua berjalan native di laptop lapangan, tanpa Docker dan tanpa internet.

## Menjalankan

```bash
# 1. MongoDB (sama seperti sts-timingsystem)
brew services start mongodb/brew/mongodb-community

# 2. Konfigurasi
cp .env.example .env          # isi ketiga secret (lihat komentar di file)
npm install

# 3. Pengguna pertama
npm run user:create -w api -- admin admin "Nama Admin"
npm run user:create -w api -- juri1 judge "Nama Juri"

# 4. API + Web App
npm run dev:api               # http://localhost:4100
npm run dev:web               # http://localhost:5173 (juga bisa dari tablet di LAN)

# 5. Capture Agent
npm run token:device -w api -- agent "Kamera Finish"   # → PF_DEVICE_TOKEN di .env
cd agent && python3 -m venv .venv && .venv/bin/pip install -e .
set -a && source ../.env && set +a
.venv/bin/pf-agent --preview  # simpan frame + garis ke data/captures/preview.png
.venv/bin/pf-agent            # jalan
```

Tanpa kamera: isi `PF_CAMERA_SOURCE` dengan path file video, dan agent akan
memutarnya seolah-olah live.

## Peran

| Peran | Bisa |
|---|---|
| `viewer` | Melihat sesi & rekaman (pelatih/atlet) |
| `operator` | Membuat & mengaktifkan sesi, kalibrasi, menandai urutan perahu |
| `judge` | + Mengonfirmasi/mengoreksi hasil (dikirim ke timing system) |
| `admin` | + Kalibrasi jam Photo Finish terhadap RaceTime2 (klik jam di header), memeriksa keutuhan audit log |

## Tes

```bash
npm test                          # API: unit + end-to-end heat H2H (MongoDB in-memory)
cd agent && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest
```
