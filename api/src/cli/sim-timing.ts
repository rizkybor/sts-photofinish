// Simulator sts-timingsystem + RaceTime2 untuk uji lokal tanpa perangkat.
// Pemakaian: npm run sim:timing -w api
//   Enter          → satu impuls FINISH (frame bare, seperti RaceTime2 di lapangan)
//   2 + Enter      → dua impuls berjarak 300 ms (dua perahu berdekatan, H2H)
//   4 + Enter      → empat impuls berjarak 200 ms (Rafting Cross)
//   q + Enter      → keluar
// Hasil photo finish (photofinish:verified) dari juri dicetak dan di-ack.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { io } from "socket.io-client";
import { issueToken } from "../auth.js";
import { signPayload, verifyPayload } from "../canonical.js";
import { loadConfig } from "../config.js";
import { nowEpochNs } from "../time.js";

const cfg = loadConfig();
const url = process.env.PF_API_URL ?? `http://127.0.0.1:${cfg.PF_PORT}`;
const token = issueToken({ sub: "device:timing:sim", name: "Simulator Timing", role: "device", deviceKind: "timing" }, cfg.PF_JWT_SECRET, "1d");
const bootId = randomUUID();
const SERIAL_LATENCY_NS = 166_666_666n; // 20 byte @ 1200 baud
let seq = 0;

const socket = io(url, { auth: { token }, transports: ["websocket"] });
socket.on("connect", () => console.log(`[sim] terhubung ke ${url} — Enter = impuls finish, 2/4 = beberapa perahu, q = keluar`));
socket.on("connect_error", (err) => console.error(`[sim] gagal terhubung: ${err.message}`));

socket.on("photofinish:verified", (msg: Record<string, any>, ack: (r: unknown) => void) => {
  const valid = verifyPayload(msg, cfg.PF_HMAC_SECRET);
  console.log(
    `[sim] HASIL ${valid ? "✔" : "✖ HMAC TIDAK VALID"} urutan ${msg.rank} · tim ${msg.teamId}${msg.bib ? ` #${msg.bib}` : ""} · finish ${msg.finishTime} · resmi ${msg.officialTime}` +
      ` · bucket ${msg.bucket ? `${msg.bucket.divisionId}/${msg.bucket.raceId}/${msg.bucket.initialId}` : "-"} · rev ${msg.revision}`,
  );
  ack({ ok: valid });
});

async function impulse() {
  const hostNs = nowEpochNs() - SERIAL_LATENCY_NS;
  const res = await socket.emitWithAck("timing:impulse", signPayload({
    type: "timing:impulse", bootId, seq: seq++, channel: "FINISH",
    hostNs: hostNs.toString(), serialLatencyNs: SERIAL_LATENCY_NS.toString(),
  }, cfg.PF_HMAC_SECRET));
  console.log(res.ok ? `[sim] impuls #${seq} terkirim` : `[sim] impuls ditolak: ${res.error}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const cmd = line.trim();
  if (cmd === "q") {
    socket.close();
    rl.close();
    return;
  }
  const count = Number(cmd) > 0 ? Math.min(Number(cmd), 8) : 1;
  const gapMs = count === 2 ? 300 : 200;
  for (let i = 0; i < count; i++) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    await impulse();
  }
});
