# Integrasi sts-timingsystem ↔ Photo Finish

Integrasi sudah diterapkan di repo **sts-timingsystem** (branch
`feat/photofinish-integration`). Dokumen ini menjelaskan cara kerjanya dan
cara mengaktifkannya. Kontrak pesan: `api/src/schemas.ts`.

## Ringkasan alur

```
RaceTime2 ──serial──▶ microGateReader.js ──(waktu terima, panjang frame)──▶ serialPortMixin.js
                                                                              │ IPC "pf:impulse"
                                                                              ▼
                     photofinishMain.js + photofinishCore.js (MAIN process: token & HMAC)
                                      │  socket.io  ▲ photofinish:verified
                                      ▼             │
                               STS Photo Finish API ─┘
                                                     │ IPC "pf:verified"
                                                     ▼
            photofinishMixin.js di HeadToHead / RaftingCross / DownRiverRace → updateTime(..., 'finish')
```

## Fakta RaceTime2 yang menentukan desain

RaceTime2 di lapangan mengirim frame **"bare"** (19 digit + marker, tanpa
payload waktu; lihat `microGateReader.js`). Akibatnya:

- Impuls dikirim **tanpa `deviceTime`**. API mencapnya dengan **jam Photo
  Finish** pada `hostNs`, yaitu waktu terima frame dikurangi waktu transmisi
  serial (20 byte × 10 bit ÷ 1200 baud ≈ 167 ms, field `serialLatencyNs`).
- Agar waktu itu sama dengan tampilan RaceTime2, **admin mengkalibrasi jam
  PF** (Set ke waktu + Trim) sebelum lomba, lalu operator melakukan
  **kalibrasi kamera** per sesi. Sebelum dikalibrasi, jam PF = jam laptop.
- Kalau suatu saat RaceTime2 mengirim frame **berisi waktu**, frame itu
  otomatis dipakai: waktu impuls dari perangkat dan heartbeat untuk mode jam
  "auto". Tidak perlu perubahan kode.
- Frame START bare **tidak** dikirim (belum dipastikan per-tekan atau terus-menerus).

## File di sts-timingsystem

| File | Peran |
|---|---|
| `src/services/photofinishCore.js` | Klien murni: antrean impuls (persist), HMAC, sinkron jam, terima hasil (persist), status. Diuji interop dari repo ini |
| `src/services/photofinishMain.js` | Wiring Electron main: konfigurasi, penyimpanan di `userData`, IPC |
| `src/services/photofinish.js` | Renderer: `reportFrame()`, `onVerified()`, `markApplied()`, status |
| `src/utils/microGateReader.js` | + argumen ke-4 `meta = { recvUs, frameBytes }` untuk callback |
| `src/mixins/serialPortMixin.js` | `onFinish`/`onLap` → impuls; `onStart` berwaktu → heartbeat |
| `src/mixins/photofinishMixin.js` | Menerapkan hasil ke view (cek kategori + bucket, konfirmasi bila menimpa) |
| `src/components/photofinish/PhotofinishBadge.vue` | Status koneksi / antrean / hasil menunggu |
| `src/components/photofinish/PhotofinishBar.vue` | Badge + tombol & modal **Kirim heat ke Photo Finish** |
| `src/background.js` | Memanggil `setupPhotofinish()` |
| `HeadToHead.vue`, `RaftingCross.vue`, `DownRiverRace.vue` | `pfCategory`, `pfBucket()`, `pfLocateTeam()`, `pfHeats()` + PhotofinishBar |

## Mengaktifkan

1. Di mesin API: `npm run token:device -w api -- timing "Laptop Timing"`.
2. Di laptop timing, pilih salah satu:
   - `.env` (mode dev, dibaca dotenv di main process):
     ```
     PF_API_URL=http://192.168.1.10:4100
     PF_DEVICE_TOKEN=<token>
     PF_HMAC_SECRET=<sama dengan API>
     ```
   - Aplikasi terpasang: buat `photofinish.json` di folder `userData` aplikasi
     (macOS: `~/Library/Application Support/<nama app>/`):
     ```json
     { "apiUrl": "http://192.168.1.10:4100", "deviceToken": "<token>", "hmacSecret": "<secret>" }
     ```
   Secret **tidak pernah** masuk bundle renderer (tidak memakai `VUE_APP_`).
3. Tanpa konfigurasi, integrasi nonaktif dan aplikasi berjalan seperti sebelumnya.

## Tombol "Kirim heat ke Photo Finish"

Di halaman H2H / Rafting Cross / DRR (di samping badge status) ada tombol
**Kirim heat ke Photo Finish**. Operator memilih heat dari daftar, lalu
API membuat sesi (atau memakai ulang sesi terbuka untuk heat yang sama) dan
**langsung mengaktifkannya**. Event/Division/Race/Initial, heat, dan tim
terisi otomatis, jadi operator tidak perlu menyalin ID dari DevTools.

| Format | Isi satu "heat" | Lintasan |
|---|---|---|
| H2H | Tim babak aktif dengan nomor `result.heat` sama | A/B mengikuti team1/team2 di bagan |
| Rafting Cross | `currentRound.heats[n].teams` | 1–4 sesuai slot |
| DRR | Semua tim kategori yang sedang dibuka (tanpa heat) | BIB |

Jumlah awak dibaca dari nama Division (R4 → 4, R6 → 6). Pesan
`timing:session` ditandatangani HMAC, dan API memverifikasinya pada payload
mentah sebelum validasi.

## Aturan penerapan hasil di view

- Diterapkan hanya bila `raceCategory` sesuai halaman **dan** Event +
  Division + Race + Initial sama persis (aturan "Scope by 4 Categories").
  Karena itu sesi Photo Finish **wajib** diisi Division/Race/Initial ID.
- Tim dicari berdasarkan `teamId`, lalu BIB, di list yang sedang tampil
  (heat/babak aktif).
- Kalau tim sudah punya Finish Time berbeda, operator ditanya dulu ("Ganti" /
  "Pertahankan").
- Hasil yang belum bisa diterapkan (kategori lain sedang dibuka, Heat belum
  ditentukan) **tetap tersimpan** di main process dan dicoba lagi tiap 5 dtk
  atau saat halaman dibuka.
- Penalti finish (awak tidak lengkap, terbalik, melintas 2×) **ditampilkan**
  sebagai peringatan; operator menerapkannya lewat alur penalti yang sudah
  ada. Penerapan otomatis belum dibuat karena model penalti tiap format berbeda.

## Uji

```bash
npm run test:interop -w api   # menjalankan photofinishCore.js milik sts-timingsystem terhadap API
```

## Checklist uji lapangan

- [ ] Badge "Photo Finish terhubung" muncul di halaman H2H/RX/DRR
- [ ] Admin: jam PF di-set sama dengan tampilan RaceTime2, Δ dipantau
- [ ] Kalibrasi kamera: satu perahu melintas → Kalibrasi kamera → klik haluan
- [ ] H2H: dua perahu berdekatan → satu kelompok finish berisi dua impuls
- [ ] Konfirmasi juri → Finish Time terisi di H2H tanpa klik "BIB Finish"
- [ ] Cabut Wi-Fi saat finish → badge "impuls antre" → terkirim setelah tersambung
- [ ] Tutup aplikasi timing sebelum hasil diterapkan → buka lagi → hasil tetap masuk
