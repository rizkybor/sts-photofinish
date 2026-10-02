// Semua waktu disimpan sebagai nanodetik bigint, diserialisasi sebagai string
// bilangan bulat di JSON/Mongo agar presisi tidak hilang.
//
// Tiga basis waktu (lihat docs/ARCHITECTURE.md §5):
//   - device: jam RaceTime2, "time of day" (ns sejak tengah malam) — basis RESMI
//   - host:   jam epoch host API/timing (ns sejak 1970)
//   - agent:  jam epoch host Capture Agent

export const NS_PER_MS = 1_000_000n;
export const NS_PER_SEC = 1_000_000_000n;
export const NS_PER_DAY = 86_400n * NS_PER_SEC;

export type Rounding = "truncate" | "round";

export function toNs(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^-?\d+$/.test(value)) throw new Error(`Bukan bilangan ns: ${value}`);
  return BigInt(value);
}

/** Waktu epoch saat ini dalam ns (presisi mikrodetik dari performance.now). */
export function nowEpochNs(): bigint {
  const ms = performance.timeOrigin + performance.now();
  return BigInt(Math.round(ms * 1000)) * 1000n;
}

/** "HH:MM:SS.fff…" (format RaceTime2) → ns sejak tengah malam. */
export function parseClock(clock: string): bigint {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(clock.trim());
  if (!m) throw new Error(`Format waktu tidak dikenal: "${clock}"`);
  const [, hh, mm, ss, frac = ""] = m;
  const h = BigInt(hh!), mi = BigInt(mm!), s = BigInt(ss!);
  if (h > 23n || mi > 59n || s > 59n) throw new Error(`Waktu di luar rentang: "${clock}"`);
  const fracNs = BigInt(frac.padEnd(9, "0"));
  return ((h * 60n + mi) * 60n + s) * NS_PER_SEC + fracNs;
}

/** Normalisasi ke rentang [0, 1 hari) — menangani lomba yang melewati tengah malam. */
export function wrapDay(ns: bigint): bigint {
  return ((ns % NS_PER_DAY) + NS_PER_DAY) % NS_PER_DAY;
}

/** ns sejak tengah malam → "HH:MM:SS" + `digits` angka desimal (dipotong). */
export function formatClock(ns: bigint, digits = 3): string {
  const t = wrapDay(ns);
  const totalSec = t / NS_PER_SEC;
  const h = totalSec / 3600n;
  const m = (totalSec % 3600n) / 60n;
  const s = totalSec % 60n;
  const pad = (v: bigint) => v.toString().padStart(2, "0");
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (digits <= 0) return base;
  const frac = (t % NS_PER_SEC).toString().padStart(9, "0").slice(0, digits);
  return `${base}.${frac}`;
}

/** Waktu resmi FAJI: akurasi 1/100 detik → "HH:MM:SS.cc". */
export function officialClock(ns: bigint, rounding: Rounding): string {
  const unit = 10n * NS_PER_MS;
  const t = wrapDay(ns);
  const q = rounding === "round" ? (t + unit / 2n) / unit : t / unit;
  return formatClock(q * unit, 2);
}

export interface ClockOffsets {
  /** Jam host API − jam agent (estimasi ping-pong RTT minimum). */
  agentOffsetNs: bigint;
  /** Jam host timing (epoch) − jam perangkat RaceTime2 (time of day). */
  deviceOffsetNs: bigint;
  /** Koreksi kalibrasi lapangan (sinyal photocell − frame haluan). */
  calibrationOffsetNs: bigint;
}

/** Timestamp frame kamera (jam agent) → waktu perangkat RaceTime2. */
export function frameToDeviceNs(frameAgentNs: bigint, o: ClockOffsets): bigint {
  return wrapDay(frameAgentNs + o.agentOffsetNs - o.deviceOffsetNs + o.calibrationOffsetNs);
}

/** Waktu perangkat → jam agent; dipakai untuk menentukan jendela ekstraksi. */
export function deviceToAgentNs(deviceNs: bigint, o: Omit<ClockOffsets, "calibrationOffsetNs">, referenceEpochNs: bigint): bigint {
  // deviceNs hanya "time of day"; ambil hari dari referensi epoch host terdekat.
  const hostTod = wrapDay(deviceNs + o.deviceOffsetNs);
  const dayStart = referenceEpochNs - wrapDay(referenceEpochNs);
  let hostEpoch = dayStart + hostTod;
  // Pilih kandidat (kemarin/hari ini/besok) yang paling dekat dengan referensi.
  if (hostEpoch - referenceEpochNs > NS_PER_DAY / 2n) hostEpoch -= NS_PER_DAY;
  else if (referenceEpochNs - hostEpoch > NS_PER_DAY / 2n) hostEpoch += NS_PER_DAY;
  return hostEpoch - o.agentOffsetNs;
}

/** Selisih a − b dalam basis time-of-day, memilih jalur terpendek melewati tengah malam. */
export function diffDayNs(a: bigint, b: bigint): bigint {
  let d = wrapDay(a - b);
  if (d > NS_PER_DAY / 2n) d -= NS_PER_DAY;
  return d;
}
