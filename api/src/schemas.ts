// Kontrak pesan antara sts-timingsystem, Capture Agent, Web App, dan API.
// Satu sumber kebenaran — ubah di sini, lalu sesuaikan pihak lain.
import { z } from "zod";

export const NsString = z.string().regex(/^-?\d+$/, "harus bilangan bulat ns dalam string");
export const ClockString = z.string().regex(/^\d{1,2}:\d{2}:\d{2}(\.\d{1,9})?$/, "format HH:MM:SS.fff");
const Sig = z.string().regex(/^[0-9a-f]{64}$/);

export const RaceCategory = z.enum(["H2H", "RX", "DRR", "SPRINT", "SLALOM"]);
export const Role = z.enum(["admin", "judge", "operator", "viewer", "device"]);
export type Role = z.infer<typeof Role>;

// ---------- sts-timingsystem → API (ditandatangani HMAC) ----------

/** Dikirim di `onFinish` serialPortMixin.js untuk setiap impuls RaceTime2. */
export const TimingImpulse = z.object({
  type: z.literal("timing:impulse"),
  /** UUID acak per start aplikasi timing — seq di-reset saat aplikasi restart. */
  bootId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  // Wajib (tanpa default): field yang ditambahkan parser akan merusak verifikasi HMAC.
  channel: z.enum(["FINISH", "START"]),
  /**
   * Waktu perangkat dari RaceTime2, mis. "10:42:13.482". TIDAK dikirim bila
   * frame "bare" (tanpa payload waktu — perilaku RaceTime2 di lapangan saat
   * ini); API lalu memakai jam Photo Finish pada `hostNs`.
   */
  deviceTime: ClockString.optional(),
  /** Jam epoch host timing saat kejadian (ns), sudah dikurangi `serialLatencyNs`. */
  hostNs: NsString,
  /** Estimasi waktu transmisi frame serial yang sudah dikurangkan dari hostNs. */
  serialLatencyNs: NsString.optional(),
  sig: Sig,
});
export type TimingImpulse = z.infer<typeof TimingImpulse>;

/** Offset jam perangkat, dihitung timing system dari heartbeat RaceTime2 (min-filter). */
export const TimingClock = z.object({
  type: z.literal("timing:clock"),
  bootId: z.string().uuid(),
  /** hostEpochNs − deviceTimeOfDayNs, nilai minimum atas jendela heartbeat. */
  deviceOffsetNs: NsString,
  samples: z.number().int().positive(),
  windowMs: z.number().int().positive(),
  hostNs: NsString,
  sig: Sig,
});
export type TimingClock = z.infer<typeof TimingClock>;

/**
 * Tombol "Kirim heat ke Photo Finish" di sts-timingsystem: buat (atau pakai
 * ulang) sesi untuk heat tersebut lalu langsung aktifkan. HMAC diverifikasi
 * pada objek MENTAH sebelum parse (default Zod tidak boleh mengubah payload).
 */
export const TimingSessionRequest = z.object({
  type: z.literal("timing:session"),
  eventId: z.string().min(1).max(64),
  bucket: z.object({
    divisionId: z.string().min(1).max(64),
    raceId: z.string().min(1).max(64),
    initialId: z.string().min(1).max(64),
  }),
  raceCategory: RaceCategory,
  heatId: z.string().max(64).nullable(),
  label: z.string().min(1).max(128),
  lanes: z.array(z.object({
    lane: z.string().min(1).max(16),
    teamId: z.string().min(1).max(64),
    bib: z.string().max(16).nullable(),
    teamName: z.string().max(128).nullable(),
    crewExpected: z.number().int().min(1).max(12).nullable(),
  })).max(64),
  cameraId: z.string().min(1).max(64).optional(),
  sig: Sig,
});

// ---------- API → sts-timingsystem (ditandatangani HMAC) ----------

/** Diterima timing system → panggil updateTime(finishTime, index, 'finish'). */
export interface PhotofinishVerified {
  type: "photofinish:verified";
  crossingId: string;
  sessionId: string;
  eventId: string;
  bucket: z.infer<typeof Bucket> | null;
  raceCategory: z.infer<typeof RaceCategory>;
  heatId: string | null;
  teamId: string;
  bib: string | null;
  rank: number;
  /** Format sama dengan digitTimeFinish (HH:MM:SS.mmm) agar updateTime() tidak berubah. */
  finishTime: string;
  officialTime: string;
  timeSource: "impulse" | "camera" | "manual";
  penalties: { crewIncomplete: boolean; capsized: boolean; secondCrossing: boolean };
  revision: number;
  verifiedBy: string;
  verifiedAt: string;
  sig: string;
}

/**
 * Setiap pemicu photocell virtual (perahu lewat garis di kamera) → baris
 * "Photo Finish" di panel waktu timing system + Buffer-Timer-Finish.
 * Notifikasi langsung (tanpa antrean): bila timing sedang terputus, baris
 * ini tidak muncul, tetapi hasil juri (photofinish:verified) tetap terkirim.
 */
export interface PhotofinishTrigger {
  type: "photofinish:trigger";
  impulseId: string;
  sessionId: string;
  eventId: string;
  bucket: { divisionId: string; raceId: string; initialId: string } | null;
  raceCategory: z.infer<typeof RaceCategory>;
  heatId: string | null;
  cameraId: string;
  /** Waktu terekam, format sama dengan digitTimeFinish (HH:MM:SS.mmm). */
  time: string;
  sig: string;
}

// ---------- Capture Agent → API ----------

export const CaptureCreate = z.object({
  groupId: z.string().length(24),
  cameraId: z.string().min(1).max(64),
  /** Path relatif terhadap PF_CAPTURES_DIR. */
  file: z.string().min(1).max(512),
  columnsFile: z.string().min(1).max(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  columnsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fromAgentNs: NsString,
  toAgentNs: NsString,
  /** Jam API − jam agent saat capture dibuat. */
  agentOffsetNs: NsString,
  agentRttNs: NsString,
  /** Indeks frame utuh (opsional — arsip frame bisa dimatikan di agent). */
  framesFile: z.string().min(1).max(512).optional(),
  framesSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  frameCount: z.number().int().nonnegative().max(10_000).optional(),
});

/** Photocell virtual: agent melihat benda menyentuh garis finish di gambar kamera. */
export const AgentTrigger = z.object({
  cameraId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  bootId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  /** Timestamp frame pertama yang aktif (jam agent, ns). */
  agentNs: NsString,
  /** Jam API − jam agent saat pemicu dikirim. */
  agentOffsetNs: NsString,
});

// ---------- Web App → API ----------

export const Lane = z.object({
  lane: z.string().min(1).max(16),
  teamId: z.string().min(1).max(64),
  bib: z.string().max(16).nullable().default(null),
  teamName: z.string().max(128).nullable().default(null),
  crewExpected: z.number().int().min(1).max(12).nullable().default(null),
});

/** Kategori di sts-timingsystem — hasil hanya diterapkan ke bucket yang sama persis. */
export const Bucket = z.object({
  divisionId: z.string().min(1).max(64),
  raceId: z.string().min(1).max(64),
  initialId: z.string().min(1).max(64),
});

export const SessionCreate = z.object({
  eventId: z.string().min(1).max(64),
  bucket: Bucket.nullable().default(null),
  raceCategory: RaceCategory,
  heatId: z.string().max(64).nullable().default(null),
  label: z.string().min(1).max(128),
  lanes: z.array(Lane).max(64).default([]),
  cameraId: z.string().min(1).max(64).default("cam-1"),
});

export const CalibrateBody = z.object({
  captureId: z.string().length(24),
  column: z.number().int().nonnegative(),
  impulseId: z.string().length(24),
});

/** Juri menandai haluan perahu di gambar sesuai urutan tiba. */
export const CrossingMark = z.object({
  captureId: z.string().length(24),
  column: z.number().int().nonnegative(),
  rank: z.number().int().min(1).max(64),
  lane: z.string().max(16).nullable().default(null),
  teamId: z.string().max(64).nullable().default(null),
});

export const CrossingConfirm = z.object({
  teamId: z.string().min(1).max(64),
  lane: z.string().max(16).nullable().default(null),
  crewInBoat: z.number().int().min(0).max(12),
  crewExpected: z.number().int().min(1).max(12),
  upright: z.boolean(),
  secondCrossing: z.boolean().default(false),
  /** Wajib bila mengubah hasil yang sudah dikonfirmasi. */
  reason: z.string().max(500).optional(),
  /** Hanya bila timeSource null (tanpa impuls & jam tidak sinkron). */
  manualTime: ClockString.optional(),
});

/** Kalibrasi jam Photo Finish oleh admin. */
export const ClockSettingsUpdate = z.discriminatedUnion("action", [
  /** Ikuti heartbeat RaceTime2 secara otomatis. */
  z.object({ action: z.literal("use-auto"), reason: z.string().max(500).optional() }),
  /** Kunci offset heartbeat RaceTime2 saat ini sebagai jam manual (paling presisi). */
  z.object({ action: z.literal("freeze-from-racetime"), reason: z.string().max(500).optional() }),
  /** Set jam PF ke waktu yang diketik admin (presisi ±reaksi; rapikan dengan trim). */
  z.object({ action: z.literal("set-time"), deviceTime: ClockString, reason: z.string().max(500).optional() }),
  /** Koreksi halus, resolusi 0,001 ms. */
  z.object({ action: z.literal("trim"), deltaMs: z.number().min(-60_000).max(60_000).refine((v) => v !== 0), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal("reset-trim"), reason: z.string().max(500).optional() }),
]);

export const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
