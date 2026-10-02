# sts-photofinish

Photo finish berbasis web untuk lomba arung jeram & kayak FAJI, terhubung ke
**sts-timingsystem**. Satu kamera di tepi sungai menentukan **urutan** perahu,
impuls RaceTime2 menentukan **waktu**. Fokus: H2H, Rafting Cross, DRR.

- **Panduan menggunakan (A. Lokal / B. Production): [docs/PANDUAN-DEPLOY.md](docs/PANDUAN-DEPLOY.md)**
- Deploy ke VPS (domain + HTTPS, agent di lokasi): [docs/PANDUAN-VPS.md](docs/PANDUAN-VPS.md)
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
npm run setup                      # sekali: dependensi, .env, build
npm run dev:local                  # uji lokal: semua sekaligus → http://localhost:5173
npm run build && npm run prod:start  # production → http://<ip-laptop>:4100
```

Persiapan, **A. Lokal** (uji coba di satu laptop), dan **B. Production**
(laptop lokasi / VPS, termasuk cara menggunakan saat lomba): lihat
**[docs/PANDUAN-DEPLOY.md](docs/PANDUAN-DEPLOY.md)**.

## Peran

| Peran | Bisa |
|---|---|
| `viewer` | Melihat sesi & rekaman (pelatih/atlet) |
| `operator` | Membuat & mengaktifkan sesi, **standby kamera** (cek kamera lurus), kalibrasi, menandai urutan perahu |
| `judge` | + Mengonfirmasi/mengoreksi hasil (dikirim ke timing system) |
| `admin` | + Kalibrasi jam Photo Finish terhadap RaceTime2 (klik jam di header), memeriksa keutuhan audit log |

## Tes

```bash
npm test                          # API: unit + end-to-end heat H2H (MongoDB in-memory)
cd agent && .venv/bin/pip install -e '.[dev]' && .venv/bin/pytest
```
