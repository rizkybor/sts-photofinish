// Jam Photo Finish di browser: sinkron ke jam server (RTT minimum), lalu
// ditampilkan berjalan. Hanya untuk tampilan — waktu resmi dihitung di server.
import { reactive } from "vue";
import { api } from "./api";

export interface ClockStatus {
  serverNs: string;
  mode: "auto" | "manual";
  source: "manual" | "racetime" | "host-local";
  revision: number;
  manualOffsetNs: string | null;
  trimNs: string;
  effectiveOffsetNs: string | null;
  pfTime: string | null;
  auto: { deviceOffsetNs: string; samples: number; ageMs: number } | null;
  diffVsRaceTimeNs: string | null;
  updatedBy: string;
  updatedAt: string;
  origin?: "photofinish" | "longrange";
}

const DAY_NS = 86_400_000_000_000n;
const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

export const clock = reactive<{ status: ClockStatus | null; skewUs: number; rttUs: number }>({ status: null, skewUs: 0, rttUs: Infinity });

export async function refreshClock() {
  let best: { skew: number; rtt: number; status: ClockStatus } | null = null;
  for (let i = 0; i < 3; i++) {
    const t0 = nowUs();
    const status = await api<ClockStatus>("GET", "/api/clock/status");
    const t1 = nowUs();
    const skew = Number(BigInt(status.serverNs) / 1000n) - (t0 + t1) / 2;
    if (!best || t1 - t0 < best.rtt) best = { skew, rtt: t1 - t0, status };
  }
  clock.status = best!.status;
  clock.skewUs = best!.skew;
  clock.rttUs = best!.rtt;
}

export function applyStatus(status: ClockStatus) {
  clock.status = status;
}

/** Waktu PF saat ini "HH:MM:SS.mmm", atau null bila belum terkalibrasi. */
export function pfNow(): string | null {
  return pfAt(BigInt(Math.round(nowUs() + clock.skewUs)) * 1000n);
}

/** Jam server (ns epoch) → waktu PF "HH:MM:SS.mmm", atau null bila belum terkalibrasi. */
export function pfAt(serverNs: bigint): string | null {
  const off = clock.status?.effectiveOffsetNs;
  if (!off) return null;
  let tod = (serverNs - BigInt(off)) % DAY_NS;
  if (tod < 0n) tod += DAY_NS;
  const ms = Number(tod / 1_000_000n);
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

export const nsToMs = (ns: string | null | undefined) => (ns == null ? null : Number(BigInt(ns)) / 1e6);
