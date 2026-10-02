# STS Photo Finish — Arsitektur

Photo finish berbasis web untuk lomba arung jeram & kayak FAJI, terhubung ke
**sts-timingsystem** (STiming System 424). Dokumen ini adalah acuan desain;
ubah dokumen ini setiap kali keputusan arsitektur berubah.

## 1. Tujuan & ruang lingkup

| Prioritas | Format | Masalah yang diselesaikan |
|---|---|---|
| **Inti** | Head-to-Head (H2H) | 2 perahu finish berdekatan — siapa duluan, waktu masing-masing |
| **Inti** | Rafting Cross (RX) | 4 perahu sekaligus — urutan 1–4, eliminasi pelanggaran finish |
| **Inti** | Down River Race (DRR) | Banyak perahu tiba acak — sinyal mana milik tim mana |
| Opsional | Sprint, Slalom | Verifikasi waktu 1 perahu (pakai fitur inti apa adanya) |

### Masalah di sistem saat ini

Di sts-timingsystem, `onFinish` (`src/mixins/serialPortMixin.js`) menulis
sinyal STOP RaceTime2 ke **satu variabel** `digitTimeFinish`, lalu operator
mengklik tombol "BIB xx" (`OperationTeamPanel.vue`) untuk menempelkannya ke
tim. Saat 2–4 perahu finish < 1 detik:

1. Sinyal berikutnya **menimpa** sinyal sebelumnya sebelum sempat diklik.
2. Operator **menebak** perahu mana pemicu sinyal mana, tanpa bukti gambar.

Photo finish menggantinya dengan **antrean sinyal + gambar garis finish**.

### Prinsip: kamera menentukan **urutan**, RaceTime2 menentukan **waktu**

Cukup **satu kamera di tepi sungai** yang membidik garis finish. Tugas
utamanya adalah menjawab *perahu mana yang lebih dulu*. Juri menandai
urutan tiba di gambar, lalu sinyal RaceTime2 dipasangkan ke tim sesuai
urutan itu (sinyal ke-1 → perahu urutan 1, dst.).

Waktu dari frame kamera hanya dipakai sebagai **cadangan**, yaitu saat
jumlah sinyal lebih sedikit daripada jumlah perahu (photocell terhalang
perahu pertama sehingga perahu kedua tidak memicu sinyal sendiri).

## 2. Aturan FAJI 2026 yang mengikat desain

Sumber: *Draft Peraturan Penyelenggaraan Kompetisi Arung Jeram Indonesia 2026 V4*.

| Aturan | Konsekuensi desain |
|---|---|
| Akurasi waktu **1/100 detik** | Kamera 120–240 fps cukup (4–8 ms/frame). Internal simpan ns; tampilan resmi 1/100 (mode pembulatan bisa dikonfigurasi, default **truncate** — konfirmasi ke Chief Judge). |
| Waktu berhenti saat **bagian mana pun dari perahu** menyentuh garis finish | Yang ditandai adalah ujung haluan pertama yang menyentuh garis. |
| Finish sah hanya jika perahu **tidak terbalik & seluruh awak di dalam** (+50 dtk; RX: **eliminasi**) | Form konfirmasi punya `crewInBoat`, `crewExpected`, `upright`. |
| **Dilarang melintas finish > 1 kali** (DSQ) | Agent merekam beberapa detik setelah finish; flag `secondCrossing`. |
| Perahu wajib lewat di antara tiang photocell | Garis finish di kamera dikalibrasi sejajar tiang photocell. |
| Protes memakai **video/foto resmi** sebagai bukti | Setiap file di-hash SHA-256; setiap keputusan masuk audit log berantai hash. |
| Waktu sama persis (H2H/RX) → **lempar koin**; ≥3 tim → *additional run* | Aplikasi **tidak** memutus seri di bawah 1/100; hanya memberi status `tie`. |

## 3. Topologi

```
 ┌──────────────── LOKASI LOMBA — LAN/hotspot, tanpa internet ─────────────────┐
 │                                                                              │
 │  RaceTime2 ──serial──▶ sts-timingsystem (Electron)                           │
 │                          │  ▲                                                │
 │        timing:impulse    │  │ photofinish:verified                           │
 │        timing:clock      ▼  │                                                │
 │                       Photo Finish API (Node/Fastify) ── MongoDB             │
 │                          ▲  │                    └──── data/captures (file)  │
 │   agent:capture (HTTP)   │  │ agent:extract (socket)                         │
 │                          │  ▼                                                │
 │  Kamera tepi sungai ──▶ Capture Agent (Python)                               │
 │                              ring buffer · sinkron jam · slit-scan           │
 │                                                                              │
 │  Browser/tablet juri ──HTTPS/WSS──▶ Photo Finish API  (Web App Vue 3)        │
 └───────────────────────────────────────┬──────────────────────────────────────┘
                                         │ sinkron setelah lomba (fase berikut)
                                   Cloud: Atlas + R2/S3 + halaman hasil publik
```

**Offline-first.** Seluruh alur waktu berjalan di LAN lokasi. Broker
racehub di render.com **tidak** dipakai untuk sinyal/hasil (latensi
internet = waktu meleset; sungai sering tanpa sinyal).

## 4. Komponen & teknologi

| Komponen | Folder | Teknologi | Peran |
|---|---|---|---|
| Capture Agent | `agent/` | Python ≥3.10, OpenCV, NumPy, python-socketio, httpx | Baca kamera, ring buffer garis finish bertimestamp, sinkron jam, potong jendela waktu sekitar sinyal, buat gambar slit-scan. Tidak membuka port masuk — hanya koneksi keluar ke API |
| Photo Finish API | `api/` | Node ≥20, TypeScript, Fastify 5, Socket.IO 4, Zod, MongoDB driver | Sumber kebenaran: sesi, sinyal, capture, crossing, audit; jembatan ke timing system |
| Web App | `web/` | Vue 3, Vite, TypeScript, Canvas 2D | Review slit-scan, tandai haluan, tetapkan tim/lintasan, konfirmasi |
| Database | — | MongoDB 7 | Sama dengan timing system, ID event/race/tim dipakai bersama |
| Penyimpanan file | `data/captures` | Filesystem lokal + signed URL | Fase berikut: MinIO (S3) saat agent & API beda mesin, R2/S3 di cloud |

**Tanpa Docker.** Semua komponen berjalan native: MongoDB lewat
`brew services` (sama seperti timing system), API & Web lewat Node, Agent
lewat Python. Selain lebih ringan untuk laptop lapangan, ini penting untuk
waktu: agent butuh akses langsung ke kamera, dan semua proses di satu host
berbagi jam yang sama (VM Docker di macOS punya jam sendiri).

### Perangkat keras

**Satu kamera di tepi sungai** untuk semua format, dipasang tegak lurus
garis finish dan sejajar tiang photocell. Kamera USB3/GigE 120–240 fps,
housing IP66, tudung + filter polarisasi (silau air). GigE/PoE bila kabel
> 3 m. HP/GoPro hanya untuk video bukti, **bukan** sumber waktu resmi.

**Standby kamera (cek kelurusan).** Menu *Standby kamera* (operator ke
atas) menampilkan gambar live ±4 fps dari agent dengan lapisan: garis finish
(`PF_FINISH_LINE`), **garis imajiner tegak lurus** yang bisa diklik ke posisi
tiang photocell, garis datar, dan grid, ditambah kemiringan garis finish
terhadap tegak lurus (≤0,5° lurus · ≤2° rapikan · >2° miring). Kamera
dianggap lurus bila tiang photocell berimpit dengan garis imajiner dari
atas sampai bawah. Cuplikan hanya dikirim selama ada yang membuka tampilan
ini (room `preview:<cameraId>`), jadi tidak membebani perekaman.

Saran pemasangan agar urutan tetap terbaca di H2H/RX (perahu dekat bisa
menutupi perahu jauh): pasang kamera **setinggi mungkin di tepi** (tripod
tinggi/tiang 2–3 m) dan sedikit menunduk, sehingga haluan perahu di
lintasan jauh masih terlihat di atas perahu dekat. Kamera kedua bisa
ditambahkan nanti tanpa mengubah arsitektur (`cameraId` sudah ada di data).

## 5. Waktu & sinkronisasi jam (bagian paling kritis)

Ada tiga jam: **perangkat** (RaceTime2), **host timing** (laptop Electron),
**host agent** (bisa laptop yang sama atau mini-PC lain).

**Basis waktu resmi = jam perangkat RaceTime2**, karena waktu start juga
berasal dari situ. Hasil photo finish harus dikonversi kembali ke basis ini.

1. **Perangkat → host timing.** RaceTime2 mengirim *heartbeat* berisi jam
   berjalan. Di 1200 baud satu frame ±30 byte butuh ±250 ms untuk terkirim,
   jadi waktu terima ≠ waktu kejadian. Timing system menghitung
   `deviceOffsetNs = min(hostRecvNs − deviceTimeNs)` atas jendela heartbeat
   (filter minimum membuang jitter; delay transmisi konstan ikut terserap)
   dan mengirimnya sebagai `timing:clock` tiap ±5 dtk.
2. **Host agent → host API.** Agent melakukan ping-pong gaya NTP
   (`clock:ping` via socket), memakai sampel RTT terkecil → `agentOffsetNs`.
3. **Kalibrasi lapangan** sebelum heat pertama: satu perahu/orang melintasi
   garis. `calibrationOffsetNs = waktu sinyal photocell − waktu frame
   haluan`. Ini menyerap sisa bias (posisi garis kamera vs photocell,
   latensi sensor kamera).

```
deviceTime(frame) = frameHostNs + agentOffsetNs − deviceOffsetNs + calibrationOffsetNs
```

### Frame RaceTime2 tanpa waktu (kondisi lapangan saat ini)

RaceTime2 yang dipakai mengirim frame *bare* tanpa payload waktu, sehingga
langkah 1 (heartbeat) belum bisa berjalan. Sinyal lalu dicap dengan **jam
Photo Finish** saat frame diterima, dikurangi waktu transmisi serial
(`timeBasis: "pf-clock"`). Ketepatan terhadap RaceTime2 datang dari
kalibrasi admin di bawah. Kalau belum dikalibrasi, jam PF = jam lokal laptop
(`source: "host-local"`, ditandai di UI).

### Jam Photo Finish & kalibrasi manual oleh admin

Photo Finish punya **jam berjalan sendiri** (basis RaceTime2) yang tampil di
Web App dan **terekam di setiap rekaman**:

```
jam PF = jam host − effectiveOffset
effectiveOffset = base − trim          (trim positif = jam PF maju)
base = offset heartbeat RaceTime2 (mode auto) | offset dikunci admin (mode manual)
```

| Aksi admin | Kegunaan |
|---|---|
| **Kunci dari RaceTime2** | Cara paling presisi: offset heartbeat (sudah difilter) dikunci sebagai mode manual. Jam PF tetap tepat walau laptop timing terputus |
| **Set ke waktu** | Ketik `HH:MM:SS.mmm` saat tidak ada heartbeat. Presisi ± reaksi, rapikan dengan trim |
| **Trim ±1/10/100 ms** (atau nilai bebas, resolusi 0,001 ms) | Koreksi halus sambil memantau indikator **Δ vs RaceTime2** |
| **Ikuti otomatis** | Kembali ke heartbeat RaceTime2 |

Setiap perubahan menaikkan `revision` dan tercatat di audit log (beserta alasan).

**Waktu ikut terekam.** Saat ekstraksi, API mengambil *snapshot* jam PF
(`pf_groups.clock` → `pf_captures.clock`) dan mengirimnya ke agent. Agent:
- menulis waktu PF per kolom ke `columns.json` (`pfTimes`) beserta snapshot jamnya;
- mencetak **pita skala waktu** (`HH:MM:SS.cc`, tanda tiap 10–100 ms) dan
  info `rev / mode / kalibrasi kamera` di bawah gambar slit-scan.

Kalibrasi ulang sesudahnya **tidak mengubah** rekaman maupun waktu kamera
yang sudah ada: keduanya memakai snapshot. Dengan begitu bukti protes tetap
konsisten dengan gambar yang tercetak.

Ada dua kalibrasi yang berbeda:
1. **Jam PF** (admin, global): menyamakan jam PF dengan jam RaceTime2.
2. **Kamera** (operator, per sesi, langkah 3 di atas): menyerap selisih posisi
   garis kamera vs photocell dan latensi sensor.

Semua nilai disimpan sebagai **string bilangan bulat ns** (BigInt di JS)
agar tidak kehilangan presisi di JSON.

## 5b. Photocell virtual (pemicu dari kamera)

Untuk finish berdempetan, operator tidak mungkin mengklik/menekan tombol satu
per satu. Dengan `PF_TRIGGER=camera`, agent memantau garis finish di gambar:
latar (air) dimodelkan per piksel, dan pemicu terjadi bila **rangkaian piksel
berubah warna terpanjang** ≥ `PF_TRIGGER_MIN_RUN` dari panjang garis selama 2
frame. Perahu adalah blok utuh, sedangkan riak dan percikan tersebar, sehingga
riak tidak memicu.

- Pemicu dikirim sebagai `agent:trigger` lalu disimpan sebagai sinyal `source:
  "camera"` dan masuk ke kelompok finish. Rekaman mencakup semua perahu yang
  berdempetan dalam **satu gambar**.
- Pemicu kamera **bukan waktu resmi**. Pemasangan urutan↔waktu hanya memakai
  sinyal RaceTime2. Tanpa sinyal RaceTime2, waktu tiap perahu = kolom gambar
  saat haluannya menyentuh garis (`timeSource: "camera"`), sehingga perahu yang
  selisih 1 frame tetap terpisah.
- Hanya diterima bila ada sesi **AKTIF** dengan `cameraId` yang sama.

## 5c. Foto frame (tinjauan frame demi frame)

Slit-scan memakai sumbu horizontal sebagai **waktu**, sehingga benda tampak
gepeng atau melebar tergantung kecepatannya. Untuk melihat perahu dengan
proporsi asli, agent juga menyimpan **frame utuh** (JPEG, ≤ `PF_FRAMES_FPS`,
lebar ≤ `PF_FRAMES_WIDTH`) di ring buffer terpisah. Encoding JPEG berjalan di
thread sendiri; bila kewalahan, frame arsip dilewati, sedangkan garis
slit-scan tetap utuh.

Saat ekstraksi, frame di jendela rekaman ditulis ke `<cam>-frames/` beserta
indeks `<cam>-frames.json` (waktu & SHA-256 per frame). API memverifikasi
semua hash, lalu `GET /api/captures/:id/frames` memetakan tiap frame ke kolom
slit-scan terdekat. Di web, panel **Foto frame** menampilkan frame pada kolom
yang ditunjuk (◀ ▶ / tombol panah).

## 6. Alur data — satu heat H2H

1. Operator membuka sesi: `POST /api/sessions` (event, race, heat, lintasan
   → tim dari bagan, kamera, garis finish), lalu `POST
   /api/sessions/:id/arm` — sinyal hanya masuk ke sesi yang sedang di-arm.
   Sinyal yang datang saat tidak ada sesi aktif tetap disimpan (tanpa sesi)
   dan bisa dipindahkan, jadi tidak pernah hilang.
2. RaceTime2 STOP → timing system kirim `timing:impulse {seq, deviceTime,
   hostNs}` ke API (socket, ditandatangani HMAC). API **menyimpan setiap
   sinyal** (tidak ada yang tertimpa), memasukkannya ke kelompok finish, lalu
   mengirim `agent:extract` ke agent setelah kelompok tenang 2 dtk.
3. Agent memotong frame `[sinyal pertama −1,5 dtk, sinyal terakhir +3 dtk]`
   dari ring buffer kamera,
   menyimpan slit-scan PNG + `columns.json` (waktu per kolom), menghitung
   SHA-256, lalu `POST /api/captures`.
4. Web App menerima `capture:ready` dan menampilkan slit-scan. Juri
   mengklik haluan tiap perahu **sesuai urutan tiba** dan memilih tim/
   lintasannya → `POST /api/crossings` (urutan = `rank`).
5. API memasangkan crossing urutan ke-n dengan sinyal ke-n di jendela itu
   (`timeSource: "impulse"`). Bila sinyal kurang dari jumlah perahu, sisa
   crossing memakai waktu kolom kamera (`timeSource: "camera"`, ditandai di
   UI dan PDF). Juri mengisi awak & posisi perahu → `POST
   /api/crossings/:id/confirm` (role `judge`). Tercatat di audit log.
6. API mengirim `photofinish:verified {teamId, officialTime, deviceTime, …}`
   bertanda tangan HMAC ke timing system, yang memanggil `updateTime(…,
   'finish')` yang sudah ada. Tombol "BIB Finish" manual tetap sebagai
   cadangan.

## 7. Model data (MongoDB)

```
pf_sessions  { eventId, raceCategory: "H2H"|"RX"|"DRR"|"SPRINT"|"SLALOM",
               heatId, label, lanes: [{lane, teamId, bib, teamName, crewExpected}],
               cameraId, armed, calibrationOffsetNs, calibratedAt,
               status: "open"|"closed", createdBy, createdAt }
               — posisi garis finish di frame adalah konfigurasi agent
                 (PF_FINISH_LINE), karena melekat pada pemasangan kamera
pf_impulses  { sessionId, seq, channel: "FINISH"|"START", deviceTime,
               deviceTimeNs, hostNs, receivedAt }          unique(sessionId, seq)
pf_groups    { sessionId, impulseIds[], firstDeviceNs, lastDeviceNs,
               status: "collecting"|"extracting"|"ready",
               clock: {mode, revision, baseOffsetNs, trimNs, effectiveOffsetNs} }
               — "kelompok finish": sinyal yang jaraknya ≤ 3 dtk digabung,
               lalu diekstrak sekali setelah 2 dtk tanpa sinyal baru, agar
               semua perahu yang bersaing ada di SATU gambar.
pf_clock_settings { _id: "settings", mode: "auto"|"manual", manualOffsetNs,
               trimNs, revision, updatedBy, updatedAt }       (hanya admin)
pf_captures  { sessionId, groupId, cameraId, clock (snapshot), file, columnsFile, sha256,
               fps, fromNs, toNs, createdAt }
pf_crossings { sessionId, groupId, captureId, column, rank, impulseId|null,
               timeSource: "impulse"|"camera", timeNs (basis perangkat),
               cameraTimeNs, officialTime, lane, teamId, bib, crewInBoat,
               crewExpected, upright, secondCrossing, status:
               "suggested"|"confirmed"|"disputed", confirmedBy, confirmedAt }
pf_audit     { seq, at, userId, action, entity, entityId, before, after,
               reason, prevHash, hash }                     unique(seq)
```

`pf_audit.hash = SHA-256(prevHash + JSON kanonik entri)`. Mengubah atau
menghapus satu entri memutus rantai dan terdeteksi oleh `GET /api/audit/verify`.

## 8. Keamanan

| Lapisan | Kontrol |
|---|---|
| Autentikasi pengguna | JWT HS256 berumur pendek (default 8 jam = satu hari lomba); Fase 2: refresh token di cookie `httpOnly` |
| Autentikasi perangkat | Agent & timing system memakai **token perangkat** (`role: "device"`), plus **HMAC-SHA256** per pesan waktu (`PF_HMAC_SECRET`) |
| Otorisasi | `admin` · `judge` (konfirmasi/ubah hasil) · `operator` (buka sesi, kalibrasi) · `viewer` (pelatih/atlet, baca saja) · `device` |
| Socket.IO | **Wajib token** — koneksi tanpa token ditolak (beda dengan racehub saat ini). Emit hanya ke room sesi, bukan `io.emit` global |
| Integritas | SHA-256 per file capture; audit log berantai hash; hasil tidak bisa dihapus, hanya dikoreksi dengan alasan |
| File | Disajikan lewat URL bertanda tangan berumur pendek, bukan folder publik |
| Transport | HTTPS/WSS juga di LAN (sertifikat `mkcert`/CA internal); hotspot WPA2/WPA3 |
| Secret | Hanya di `.env` server/agent. **Jangan** pakai prefix `VITE_` untuk secret — ikut ter-bundle ke browser |
| Privasi (UU PDP 27/2022) | Persetujuan saat registrasi; frame mentah dihapus 90 hari setelah lomba (bisa dikonfigurasi), gambar final disimpan; halaman publik tanpa frame mentah |

### Temuan di sistem lain yang harus dibereskan sebelum integrasi

- **sts-racehub** `server.js`: `if (!token) return next()` meloloskan koneksi
  tanpa token, dan `custom:event` di-`io.emit` ke semua klien.
- **sts-timingsystem**: kunci akses bersama di `localStorage` dengan
  `nodeIntegration` aktif — cukup untuk kiosk, tidak untuk multi-user.
  `app/.env` lokal berisi komentar yang tampak seperti kredensial MongoDB;
  hapus dan ganti password jika pernah dibagikan.

## 9. Integrasi dengan sts-timingsystem

Perubahan di sisi timing (kecil, terisolasi):

1. `serialPortMixin.js` → `onFinish`: selain mengisi `digitTimeFinish`,
   emit `timing:impulse` dengan `seq` naik monoton.
2. Hitung & kirim `timing:clock` (§5 langkah 1) dari heartbeat RaceTime2.
3. Listener `photofinish:verified` → panggil `updateTime(time, index,
   'finish')` di `HeadToHead.vue`, `RaftingCross.vue`, `DownRiverRace.vue`.
4. Pengaturan per event "Photo Finish: aktif/nonaktif".

Kontrak pesan lengkap: `api/src/schemas.ts` (satu sumber kebenaran).
Panduan implementasi + contoh kode: [INTEGRATION-TIMING.md](INTEGRATION-TIMING.md).

## 10. Roadmap

| Fase | Isi |
|---|---|
| **1 — H2H (MVP)** | 1 kamera tepi, jam PF + kalibrasi manual admin + pita waktu di rekaman, antrean sinyal, slit-scan, tandai urutan haluan manual, pasangkan urutan ↔ sinyal, waktu kamera sebagai cadangan (sinkron jam + kalibrasi), checklist awak, kirim balik ke timing, audit log |
| **2 — RX** | 4 lintasan, urutan 1–4, status eliminasi, status `tie` → koin/additional run |
| **3 — DRR** | Pilih tim dari daftar "belum finish", deteksi lintasan kedua, mulai latih model deteksi perahu (dataset dari Fase 1–2) |
| Lanjutan | Saran haluan otomatis (YOLO-seg), kamera start (sailing start / false start), sinkron cloud, halaman hasil publik |
