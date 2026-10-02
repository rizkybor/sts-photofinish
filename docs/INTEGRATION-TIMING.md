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

- Sinyal dikirim **tanpa `deviceTime`**. API mencapnya dengan **jam Photo
  Finish** pada `hostNs`, yaitu waktu terima frame dikurangi waktu transmisi
  serial (20 byte × 10 bit ÷ 1200 baud ≈ 167 ms, field `serialLatencyNs`).
- Agar waktu itu sama dengan tampilan RaceTime2, **admin mengkalibrasi jam
  PF** (Set ke waktu + Trim) sebelum lomba, lalu operator melakukan
  **kalibrasi kamera** per sesi. Sebelum dikalibrasi, jam PF = jam laptop.
- Kalau suatu saat RaceTime2 mengirim frame **berisi waktu**, frame itu
  otomatis dipakai: waktu sinyal dari perangkat dan heartbeat untuk mode jam
  "auto". Tidak perlu perubahan kode.
- Frame START bare **tidak** dikirim (belum dipastikan per-tekan atau terus-menerus).

## File di sts-timingsystem

| File | Peran |
|---|---|
| `src/services/photofinishCore.js` | Klien murni: antrean sinyal (persist), HMAC, sinkron jam, terima hasil (persist), status. Diuji interop dari repo ini |
| `src/services/photofinishMain.js` | Wiring Electron main: konfigurasi, penyimpanan di `userData`, IPC |
| `src/services/photofinish.js` | Renderer: `reportFrame()`, `onVerified()`, `markApplied()`, status |
| `src/utils/microGateReader.js` | + argumen ke-4 `meta = { recvUs, frameBytes }` untuk callback |
| `src/mixins/serialPortMixin.js` | `onFinish`/`onLap` → sinyal; `onStart` berwaktu → heartbeat |
| `src/mixins/photofinishMixin.js` | Menerapkan hasil ke view (cek Event + format lomba, konfirmasi bila menimpa) |
| `src/components/photofinish/PhotofinishBadge.vue` | Status koneksi / antrean / hasil menunggu |
| `src/components/photofinish/PhotofinishBadge.vue` | Badge **Photo Finish terhubung / terputus** di halaman race |
| `src/background.js` | Memanggil `setupPhotofinish()` |
| `HeadToHead.vue`, `RaftingCross.vue`, `DownRiverRace.vue` | `pfCategory`, `pfBucket()` (hanya eventId), `pfLocateTeam()` + PhotofinishBadge |

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

## Sesi Photo Finish

Halaman race di sts-timingsystem hanya menampilkan badge **Photo Finish
terhubung / terputus** (tidak ada tombol kirim heat). Sesi dibuat admin di
aplikasi Photo Finish dan cukup terhubung ke **Event (Id Event)** — format
lomba, Division/Race/Initial tidak dipilih. Nama Event dibaca dari
`eventsCollection` (database `PF_TIMING_DB`, hanya baca). Pembeda antar sesi
ditulis admin di **Keterangan** sesi.

## Aturan penerapan hasil di view

- Diterapkan bila **Event** sama dan tim ada di heat/babak yang sedang tampil.
  Format lomba, Division/Race/Initial tidak dicek (sesi lama yang masih
  membawa format tetap dicocokkan formatnya).
- Baris pemicu kamera ("Photo Finish" di panel waktu) muncul di halaman race
  mana pun dari Event yang sama.
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
- [ ] H2H: dua perahu berdekatan → satu kelompok finish berisi dua sinyal
- [ ] Konfirmasi juri → Finish Time terisi di H2H tanpa klik "BIB Finish"
- [ ] Cabut Wi-Fi saat finish → badge "sinyal antre" → terkirim setelah tersambung
- [ ] Tutup aplikasi timing sebelum hasil diterapkan → buka lagi → hasil tetap masuk
