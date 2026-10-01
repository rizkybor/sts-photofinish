// File capture disajikan lewat URL bertanda tangan berumur pendek, bukan
// folder publik — rekaman atlet adalah data pribadi (UU PDP).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./canonical.js";

const URL_TTL_SEC = 15 * 60;

/** Menolak path absolut dan `..` agar tidak keluar dari folder captures. */
export function resolveCapturePath(capturesDir: string, rel: string): string {
  const root = path.resolve(capturesDir);
  const full = path.resolve(root, rel);
  if (path.isAbsolute(rel) || !full.startsWith(root + path.sep)) {
    throw new Error(`Path di luar folder captures: ${rel}`);
  }
  return full;
}

function mac(secret: string, rel: string, exp: number): Buffer {
  return createHmac("sha256", secret).update(`${rel}\n${exp}`).digest();
}

export function signFileUrl(secret: string, rel: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + URL_TTL_SEC;
  const sig = mac(secret, rel, exp).toString("hex");
  return `/files/${rel.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
}

export function verifyFileUrl(secret: string, rel: string, exp: string, sig: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const expNum = Number(exp);
  if (!Number.isInteger(expNum) || expNum < nowSec || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(mac(secret, rel, expNum), Buffer.from(sig, "hex"));
}

export async function fileSha256(full: string): Promise<string> {
  return sha256Hex(await readFile(full));
}

/** columns.json dari agent: waktu jam agent (ns) untuk setiap kolom slit-scan. */
export async function readColumns(full: string): Promise<string[]> {
  const data = JSON.parse(await readFile(full, "utf8")) as { columns?: unknown };
  if (!Array.isArray(data.columns) || !data.columns.every((c) => typeof c === "string" && /^-?\d+$/.test(c))) {
    throw new Error("columns.json tidak valid");
  }
  return data.columns as string[];
}

export async function openFile(full: string) {
  const st = await stat(full);
  return { size: st.size, stream: createReadStream(full) };
}

export interface FramesIndex {
  cameraId: string;
  scale: number;
  finishLine: { x1: number; y1: number; x2: number; y2: number } | null;
  frames: Array<{ file: string; agentNs: string; sha256: string }>;
}

export async function readFramesIndex(full: string): Promise<FramesIndex> {
  const d = JSON.parse(await readFile(full, "utf8")) as FramesIndex;
  if (!Array.isArray(d.frames) || !d.frames.every((f) => typeof f.file === "string" && /^-?\d+$/.test(f.agentNs) && /^[0-9a-f]{64}$/.test(f.sha256))) {
    throw new Error("Indeks frame tidak valid");
  }
  return d;
}
