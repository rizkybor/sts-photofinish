// Prinsip Fase 1: kamera menentukan URUTAN, RaceTime2 menentukan WAKTU.
// Crossing urutan ke-n dipasangkan dengan sinyal ke-n (urut waktu perangkat)
// dalam satu kelompok finish. Bila sinyal kurang dari jumlah perahu
// (photocell terhalang perahu pertama), sisa crossing memakai waktu kamera.

import { diffDayNs, NS_PER_MS } from "./time.js";

export interface PairCrossing {
  id: string;
  rank: number;
  /** Waktu kamera dalam basis perangkat; null bila jam belum tersinkron. */
  cameraTimeNs: bigint | null;
}

export interface PairImpulse {
  id: string;
  deviceTimeNs: bigint;
}

export type TimeSource = "impulse" | "camera";

export interface PairResult {
  crossingId: string;
  impulseId: string | null;
  timeSource: TimeSource | null;
  timeNs: bigint | null;
  warnings: string[];
}

export interface PairOutcome {
  results: PairResult[];
  groupWarnings: string[];
}

/** Batas selisih kamera vs sinyal sebelum diberi peringatan. */
export const MISMATCH_TOLERANCE_NS = 500n * NS_PER_MS;

export function pairByOrder(crossings: PairCrossing[], impulses: PairImpulse[]): PairOutcome {
  const byRank = [...crossings].sort((a, b) => a.rank - b.rank);
  const byTime = [...impulses].sort((a, b) => (a.deviceTimeNs < b.deviceTimeNs ? -1 : a.deviceTimeNs > b.deviceTimeNs ? 1 : 0));
  const groupWarnings: string[] = [];

  const ranks = byRank.map((c) => c.rank);
  if (new Set(ranks).size !== ranks.length) groupWarnings.push("Ada urutan (rank) ganda.");

  if (byTime.length > byRank.length) {
    groupWarnings.push(
      `Sinyal (${byTime.length}) lebih banyak dari perahu yang ditandai (${byRank.length}) — ` +
        "cek percikan/dayung memicu photocell atau perahu melintas dua kali (DSQ).",
    );
  }

  const results = byRank.map((c, i): PairResult => {
    const warnings: string[] = [];
    const imp = byTime[i];

    // Urutan yang ditandai juri harus konsisten dengan posisi kolom di gambar.
    const prev = byRank[i - 1];
    if (prev?.cameraTimeNs != null && c.cameraTimeNs != null && diffDayNs(c.cameraTimeNs, prev.cameraTimeNs) < 0n) {
      warnings.push(`Ditandai urutan ${c.rank} tetapi haluannya di gambar lebih dulu dari urutan ${prev.rank}.`);
    }

    if (imp) {
      if (c.cameraTimeNs != null) {
        const d = diffDayNs(imp.deviceTimeNs, c.cameraTimeNs);
        if ((d < 0n ? -d : d) > MISMATCH_TOLERANCE_NS) {
          warnings.push(`Selisih waktu sinyal vs kamera ${Number(d / NS_PER_MS)} ms — periksa kalibrasi.`);
        }
      }
      return { crossingId: c.id, impulseId: imp.id, timeSource: "impulse", timeNs: imp.deviceTimeNs, warnings };
    }

    if (c.cameraTimeNs != null) {
      warnings.push("Tidak ada sinyal untuk perahu ini — memakai waktu kamera.");
      return { crossingId: c.id, impulseId: null, timeSource: "camera", timeNs: c.cameraTimeNs, warnings };
    }

    warnings.push("Tidak ada sinyal dan jam kamera belum tersinkron — waktu harus diisi manual.");
    return { crossingId: c.id, impulseId: null, timeSource: null, timeNs: null, warnings };
  });

  return { results, groupWarnings };
}

/**
 * Aturan FAJI: waktu sama persis (dalam 1/100) di H2H/RX → lempar koin;
 * ≥3 tim → additional run. Aplikasi hanya menandai, tidak memutuskan.
 */
export function findTies(officialTimes: Array<{ crossingId: string; officialTime: string | null }>): string[][] {
  const groups = new Map<string, string[]>();
  for (const { crossingId, officialTime } of officialTimes) {
    if (!officialTime) continue;
    groups.set(officialTime, [...(groups.get(officialTime) ?? []), crossingId]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}
