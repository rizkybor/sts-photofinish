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

/** Dikirim di `onFinish` serialPortMixin.js untuk setiap sinyal RaceTime2. */
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

// ---------- API → sts-timingsystem (ditandatangani HMAC) ----------

/** Diterima timing system → panggil updateTime(finishTime, index, 'finish'). */
export interface PhotofinishVerified {
  type: "photofinish:verified";
  crossingId: string;
  sessionId: string;
  eventId: string;
  eventName: string | null;
  /** null = sesi manual tanpa format — diterapkan di halaman race mana pun di Event itu. */
  raceCategory: z.infer<typeof RaceCategory> | null;
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
  /** Untuk panel "Hasil Photo Finish" di timing (hanya ditampilkan). */
  sessionLabel: string;
  sessionNote: string | null;
  teamName: string | null;
  verifiedByName: string | null;
  /** Alasan koreksi juri (revisi ≥ 2), null untuk konfirmasi pertama. */
  reason: string | null;
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
  eventName: string | null;
  raceCategory: z.infer<typeof RaceCategory> | null;
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
export const AgentExtractFailed = z.object({
  groupId: z.string().regex(/^[0-9a-f]{24}$/),
  error: z.string().min(1).max(300),
});

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

export const SessionNote = z.object({ note: z.string().max(300).nullable() });

/** Sesi cukup terhubung ke Event (Id Event); kategori Division/Race/Initial tidak dipakai. */
export const SessionCreate = z.object({
  eventId: z.string().min(1).max(64),
  eventName: z.string().max(200).nullable().default(null),
  note: z.string().max(300).nullable().default(null),
  /** Sesi manual tidak perlu format/heat/label: penerapannya sama untuk semua kategori. */
  raceCategory: RaceCategory.nullable().default(null),
  heatId: z.string().max(64).nullable().default(null),
  /** Kosong = dibuat otomatis "<Nama Event> · Sesi N". */
  label: z.string().max(128).nullable().default(null),
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
  /** Hanya bila timeSource null (tanpa sinyal & jam tidak sinkron). */
  manualTime: ClockString.optional(),
});

/** Kalibrasi jam Photo Finish oleh admin. */
/**
 * Kalibrasi jam dari sts-timingsystem (hasil kalibrasi Long Range Start,
 * sudah dikonversi timing ke basis jam server API ini). Diterapkan bila
 * lebih baru dari kalibrasi Photo Finish yang tersimpan. HMAC diverifikasi
 * pada payload mentah sebelum parse.
 */
export const TimingCalibration = z.object({
  type: z.literal("timing:calibration"),
  mode: z.enum(["auto", "manual"]),
  manualOffsetNs: z.string().regex(/^-?\d{1,25}$/).nullable(),
  trimNs: z.string().regex(/^-?\d{1,15}$/),
  /** Waktu kalibrasi di Long Range (ISO) — pembanding "mana yang lebih baru". */
  updatedAt: z.string().datetime(),
  note: z.string().max(200).nullable().optional(),
  sig: z.string(),
});
export type TimingCalibration = z.infer<typeof TimingCalibration>;

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

/** Pengaturan kamera dari halaman Pengaturan Kamera (diterapkan agent saat berjalan). */
export const CameraConfig = z.object({
  sourceType: z.enum(["laptop", "iphone", "external", "ip", "video"]),
  /** Nomor kamera (laptop/iPhone/eksternal), URL (ip), atau path file video uji. Divalidasi ulang oleh agent. */
  source: z.string().min(1).max(512),
  fps: z.number().min(1).max(1000),
  width: z.number().int().min(160).max(7680).nullable().default(null),
  height: z.number().int().min(120).max(4320).nullable().default(null),
  /** null = garis tegak otomatis di tengah frame. */
  finishLine: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).nullable(),
  trigger: z.object({ enabled: z.boolean(), threshold: z.number().min(5).max(150), minRun: z.number().min(0.01).max(0.5) }),
  frames: z.object({ enabled: z.boolean(), fps: z.number().min(1).max(120), width: z.number().int().min(320).max(3840) }),
  /** Filter objek (YOLO): pemicu photocell hanya diteruskan bila objek kelas ini melintas. Divalidasi ulang oleh agent. */
  objectFilter: z.object({
    enabled: z.boolean(),
    classes: z.array(z.string().regex(/^[\w][\w .-]{0,39}$/)).min(1).max(10),
    model: z.string().min(1).max(120),
    conf: z.number().min(0.05).max(0.95),
  }).optional(),
});
export type CameraConfig = z.infer<typeof CameraConfig>;

export const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
