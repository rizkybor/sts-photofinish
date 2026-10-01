# Integrasi sts-timingsystem ↔ Photo Finish

Panduan untuk menambahkan dukungan photo finish ke **sts-timingsystem**
(Electron + Vue 2). Perubahannya kecil dan terisolasi. Kalau photo finish
dinonaktifkan atau API tidak terhubung, alur lama (klik "BIB Finish") tetap
berjalan seperti biasa.

Kontrak pesan resmi ada di `api/src/schemas.ts`. Kalau dokumen ini berbeda
dengan file itu, yang berlaku adalah `schemas.ts`.

## 0. Persiapan

1. Buat token perangkat untuk laptop timing (dijalankan di mesin API):
   ```bash
   npm run token:device -w api -- timing "Laptop Timing Finish"
   ```
2. Tambahkan ke `.env` timing system. File ini sudah ada di `.gitignore`;
   jangan pakai prefix `VUE_APP_` untuk secret:
   ```
   PF_API_URL=https://192.168.1.10:4100
   PF_DEVICE_TOKEN=<token dari langkah 1>
   PF_HMAC_SECRET=<sama dengan PF_HMAC_SECRET di API>
   ```
   > Saat ini renderer berjalan dengan `nodeIntegration`, sehingga `process.env`
   > dan `crypto` bisa diakses langsung. Kalau nanti `nodeIntegration`
   > dimatikan, pindahkan modul di bawah ke main process dan akses lewat IPC.

## 1. Modul klien: `src/services/photofinish.js`

```js
// src/services/photofinish.js
import { createHmac, randomUUID } from "crypto";
import { io } from "socket.io-client";

const SECRET = process.env.PF_HMAC_SECRET;
const BOOT_ID = randomUUID(); // seq di-reset setiap aplikasi dibuka
let seq = 0;
let socket = null;

// HARUS identik dengan canonicalJson() di api/src/canonical.ts
function canonical(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const sign = (p) => ({ ...p, sig: createHmac("sha256", SECRET).update(JSON.stringify(canonical(p))).digest("hex") });
function verify(msg) {
  const { sig, ...rest } = msg;
  const expected = createHmac("sha256", SECRET).update(JSON.stringify(canonical(rest))).digest("hex");
  return typeof sig === "string" && sig.length === expected.length && sig === expected;
}

/** Jam epoch host dalam ns (string), presisi mikrodetik. */
export function hostNowNs() {
  const us = Math.round((performance.timeOrigin + performance.now()) * 1000);
  return (BigInt(us) * 1000n).toString();
}

// Antrean lokal: impuls tidak hilang saat Wi-Fi putus, dikirim ulang saat reconnect.
const outbox = [];
async function flush() {
  while (socket && socket.connected && outbox.length) {
    const res = await socket.timeout(3000).emitWithAck("timing:impulse", outbox[0]).catch(() => null);
    if (!res || !res.ok) break;
    outbox.shift();
  }
}

export function connectPhotofinish({ onVerified }) {
  if (!process.env.PF_API_URL || !process.env.PF_DEVICE_TOKEN) return null;
  socket = io(process.env.PF_API_URL, { auth: { token: process.env.PF_DEVICE_TOKEN }, transports: ["websocket"] });
  socket.on("connect", flush);
  socket.on("photofinish:verified", (msg, ack) => {
    if (!verify(msg)) return ack({ ok: false, error: "HMAC tidak valid" });
    try {
      onVerified(msg);          // lihat langkah 3
      ack({ ok: true });        // tanpa ack, API akan mengirim ulang
    } catch (err) {
      ack({ ok: false, error: String(err) });
    }
  });
  return socket;
}

/** Dipanggil untuk SETIAP impuls finish RaceTime2 (langkah 2). */
export function sendImpulse(deviceTime, hostNs) {
  outbox.push(sign({ type: "timing:impulse", bootId: BOOT_ID, seq: seq++, channel: "FINISH", deviceTime, hostNs }));
  flush();
}

// ---------------------------------------------------------------- sinkron jam perangkat
// deviceOffsetNs = min(hostRecvNs − deviceTimeNs) atas jendela heartbeat.
// Filter minimum membuang jitter USB/OS; delay transmisi serial yang konstan
// (±250 ms di 1200 baud) ikut terserap dan dikoreksi oleh kalibrasi lapangan.
const WINDOW_MS = 5000;
let samples = [];

function clockToNs(clock) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(clock);
  if (!m) return null;
  return ((BigInt(m[1]) * 60n + BigInt(m[2])) * 60n + BigInt(m[3])) * 1000000000n + BigInt((m[4] || "").padEnd(9, "0"));
}

/** Dipanggil untuk setiap frame heartbeat RaceTime2 (flag '0'). */
export function onHeartbeat(deviceTime, hostNs) {
  const dev = clockToNs(deviceTime);
  if (dev === null) return;
  const now = Date.now();
  samples.push({ at: now, offset: BigInt(hostNs) - dev });
  samples = samples.filter((s) => now - s.at <= WINDOW_MS);
}

setInterval(() => {
  if (!socket || !socket.connected || samples.length < 5) return;
  const min = samples.reduce((m, s) => (s.offset < m ? s.offset : m), samples[0].offset);
  socket.emit("timing:clock", sign({
    type: "timing:clock", bootId: BOOT_ID, deviceOffsetNs: min.toString(),
    samples: samples.length, windowMs: WINDOW_MS, hostNs: hostNowNs(),
  }));
}, 5000);
```

## 2. `src/mixins/serialPortMixin.js`

Catat `hostNowNs()` **saat frame selesai diterima**, yaitu saat `\r` tiba di
`handleChunk()` milik `microGateReader.js`, lalu teruskan ke callback:

```js
import { sendImpulse, onHeartbeat, hostNowNs } from "@/services/photofinish";

// di dalam createMicroGateReader({...}):
onStart: (formatted) => {
  this.digitTimeStart = formatted;
  onHeartbeat(formatted, hostNowNs()); // heartbeat idle RaceTime2 = flag '0'
},
onFinish: (formatted) => {
  this.digitTimeFinish = formatted;     // perilaku lama tetap
  sendImpulse(formatted, hostNowNs());  // BARU: setiap impuls tersimpan di API
},
```

> Lebih akurat: ambil `hostNowNs()` di `handleChunk()` tepat saat byte `\r`
> diterima, lalu teruskan sebagai argumen ke `onStart`/`onFinish`. Mengambil
> waktu di callback menambah jitter event loop, meski ini juga ikut
> tersaring oleh filter minimum.

`onHeartbeat` hanya boleh dipanggil untuk frame yang membawa jam berjalan.
Frame famili kedua (19 karakter, berakhiran `R`, tanpa payload) belum
diketahui encoding waktunya, jadi **jangan** dipakai untuk sinkron jam.

## 3. Menerima hasil: `HeadToHead.vue`, `RaftingCross.vue`, `DownRiverRace.vue`

```js
import { connectPhotofinish } from "@/services/photofinish";

mounted() {
  this.pfSocket = connectPhotofinish({
    onVerified: (msg) => {
      // Cocokkan dengan view & bucket yang sedang terbuka.
      if (msg.eventId !== this.eventId) throw new Error("event lain");
      const index = this.participant.findIndex((p) => p.teamId === msg.teamId);
      if (index < 0) throw new Error(`tim ${msg.teamId} tidak ada di heat ini`);
      this.updateTime(msg.finishTime, index, "finish"); // fungsi yang SUDAH ada
      // msg.penalties.{crewIncomplete,capsized,secondCrossing} → isi penalti finish
      // sesuai aturan FAJI (50 dtk; RX: eliminasi) lewat alur penalti yang sudah ada.
    },
  });
},
beforeDestroy() {
  this.pfSocket && this.pfSocket.close();
},
```

`msg.finishTime` memakai format yang sama dengan `digitTimeFinish`
(`HH:MM:SS.mmm`), jadi `updateTime()` tidak perlu diubah. Kalau `onVerified`
melempar error, API **tidak** menandai hasil sebagai terkirim dan akan
mengirim ulang saat timing reconnect. Untuk koreksi hasil, `msg.revision`
akan naik; timpa hasil lama dengan yang baru.

Sesuaikan nama field (`participant`, `teamId`, `eventId`) dengan struktur di
masing-masing view. Lihat `MEMORY-H2H.md` / `MEMORY-DRR.md` di repo timing.

## 4. Pengaturan per event

Tambahkan toggle "Photo Finish" di Event Settings. Kalau nonaktif, jangan
panggil `connectPhotofinish` dan jangan kirim impuls.

## Checklist uji lapangan

- [ ] `timing:clock` terkirim; di Web App, impuls menampilkan offset (bukan "belum sinkron")
- [ ] Kalibrasi: satu perahu melintas → tombol **Kalibrasi** → klik haluan → offset tercatat
- [ ] H2H: dua perahu berdekatan → satu kelompok finish berisi dua impuls
- [ ] Konfirmasi juri → waktu muncul di `HeadToHead.vue` tanpa klik "BIB Finish"
- [ ] Cabut Wi-Fi saat finish → impuls tetap terkirim setelah tersambung lagi
- [ ] Matikan timing → konfirmasi → nyalakan lagi → hasil terkirim ulang otomatis
