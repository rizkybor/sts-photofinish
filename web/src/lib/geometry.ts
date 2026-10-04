// Geometri garis untuk tampilan standby kamera.

export interface Line { x1: number; y1: number; x2: number; y2: number }

/**
 * Kemiringan garis terhadap tegak lurus (vertikal), dalam derajat.
 * 0 = tegak sempurna; positif = ujung bawah condong ke kanan.
 */
export function tiltFromVerticalDeg(l: Line): number {
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  if (dx === 0 && dy === 0) return 0;
  // Arahkan garis dari atas ke bawah agar tanda konsisten.
  const [sx, sy] = dy < 0 ? [-dx, -dy] : [dx, dy];
  return (Math.atan2(sx, sy) * 180) / Math.PI;
}

export type Level = "ok" | "warn" | "bad";

/** Batas toleransi: ≤0,5° lurus, ≤2° perlu dirapikan, >2° miring. */
export function tiltLevel(deg: number): Level {
  const a = Math.abs(deg);
  return a <= 0.5 ? "ok" : a <= 2 ? "warn" : "bad";
}

/** Titik tengah garis — posisi awal garis imajiner tegak lurus. */
export function midX(l: Line): number {
  return (l.x1 + l.x2) / 2;
}

/** x garis pada ketinggian y (garis tidak boleh mendatar). */
export function xAtY(l: Line, y: number): number {
  if (l.y2 === l.y1) return (l.x1 + l.x2) / 2;
  return l.x1 + ((l.x2 - l.x1) * (y - l.y1)) / (l.y2 - l.y1);
}
