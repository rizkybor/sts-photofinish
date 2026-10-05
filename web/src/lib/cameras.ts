// Status kamera realtime (dari "camera:status" yang dikirim agent tiap ±2 dtk)
// digabung dengan sesi aktif → apakah finish BENAR-BENAR sedang direkam.
// Dipakai indikator REC di navbar, halaman sesi, dan Standby Kamera.
import { computed, reactive, ref, watch } from "vue";
import { auth } from "./api";
import { getSocket } from "./socket";
import { armedSession, beep } from "./sessions";
import { toast } from "./ui";

export interface TriggerDecision { at: number; ok: boolean; seen: string; reason?: string | null }
interface CameraStatus {
  cameraId: string; connected?: boolean; running?: boolean; retrying?: boolean;
  measuredFps?: number; lastFrameAgeMs?: number | null; lastError?: string | null;
  hostBattery?: { percent: number; charging: boolean } | null;
  objectFilter?: { enabled: boolean; classes?: string[]; recent?: TriggerDecision[] };
}

/** Laporan agent dianggap basi bila tidak ada kabar selama ini (agent macet / API putus). */
const STALE_MS = 7000;
/** Frame terakhir lebih tua dari ini = kamera tidak mengirim gambar. */
const FRAME_STALE_MS = 2000;

const statuses = reactive(new Map<string, CameraStatus & { receivedAt: number }>());
const now = ref(Date.now());

export const cameraStatus = (cameraId: string) => statuses.get(cameraId) ?? null;

export type CameraHealth = { live: true; fps: number } | { live: false; reason: string };

export function cameraHealth(cameraId: string): CameraHealth {
  const st = statuses.get(cameraId);
  if (!st) return { live: false, reason: `Belum ada laporan dari Capture Agent "${cameraId}" — agent belum dijalankan?` };
  if (!st.connected) return { live: false, reason: `Capture Agent "${cameraId}" terputus dari API.` };
  if (now.value - st.receivedAt > STALE_MS) return { live: false, reason: `Tidak ada kabar dari Capture Agent "${cameraId}" lebih dari ${STALE_MS / 1000} dtk.` };
  if (!st.running) return { live: false, reason: st.lastError ? `Kamera tidak bisa dibuka: ${st.lastError}` : "Kamera belum terbuka — agent sedang mencoba membukanya." };
  if (st.lastFrameAgeMs == null || st.lastFrameAgeMs > FRAME_STALE_MS) return { live: false, reason: "Kamera terbuka tetapi tidak mengirim gambar." };
  return { live: true, fps: st.measuredFps ?? 0 };
}

/**
 * - recording: sesi aktif + kamera sesi mengirim gambar → finish direkam.
 * - not-recording: sesi aktif tetapi kamera bermasalah → finish TIDAK terekam.
 * - standby: kamera hidup tanpa sesi aktif → sinyal tidak direkam.
 * - offline: tidak ada sesi aktif dan kamera tidak hidup.
 */
export type RecState =
  | { kind: "recording"; cameraId: string; sessionLabel: string; fps: number }
  | { kind: "not-recording"; cameraId: string; sessionLabel: string; reason: string }
  | { kind: "standby"; cameraIds: string[] }
  | { kind: "offline" };

export const recState = computed<RecState>(() => {
  const s = armedSession.value;
  if (s && s.status === "open") {
    const h = cameraHealth(s.cameraId);
    return h.live
      ? { kind: "recording", cameraId: s.cameraId, sessionLabel: s.label, fps: h.fps }
      : { kind: "not-recording", cameraId: s.cameraId, sessionLabel: s.label, reason: h.reason };
  }
  const live = [...statuses.keys()].filter((id) => cameraHealth(id).live).sort();
  return live.length ? { kind: "standby", cameraIds: live } : { kind: "offline" };
});

// Socket dibuat ulang setelah logout → login; pasang listener di socket yang baru.
let bound: ReturnType<typeof getSocket> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
watch(() => auth.token, (token) => {
  if (!token) return statuses.clear();
  const socket = getSocket();
  if (socket !== bound) {
    bound = socket;
    socket.on("camera:status", (st: CameraStatus) => {
      if (st?.cameraId) statuses.set(st.cameraId, { ...st, receivedAt: Date.now() });
    });
  }
  ticker ??= setInterval(() => (now.value = Date.now()), 1000);
}, { immediate: true });

// ---------------------------------------------------------------- alarm & baterai

/** Laptop agent di bawah ini (tanpa charger) = peringatan; laptop mati = kamera & rekaman ikut mati. */
export const LOW_BATTERY = 20;
/** Baterai laptop agent yang perlu diwaspadai (kamera sesi aktif dulu, lalu kamera lain). */
export const lowBattery = computed(() => {
  const ids = [armedSession.value?.cameraId, ...statuses.keys()].filter((x): x is string => !!x);
  for (const id of new Set(ids)) {
    const b = statuses.get(id)?.hostBattery;
    if (b && !b.charging && b.percent <= LOW_BATTERY && cameraHealth(id).live) return { cameraId: id, percent: b.percent };
  }
  return null;
});

// Status kamera baru lengkap beberapa detik setelah tersambung — jangan alarm saat halaman baru dibuka.
const GRACE_MS = 8000;
let since = Date.now();
watch(() => auth.token, () => (since = Date.now()));

function alarm() {
  beep();
  setTimeout(beep, 450);
  setTimeout(beep, 900);
}

/** Putus sesaat (internet, kamera dibuka ulang) pulih sendiri — alarm hanya bila bertahan. */
const ALARM_AFTER_MS = 5000;
let pendingAlarm: ReturnType<typeof setTimeout> | null = null;
let alarmed = false;

watch(() => recState.value.kind, (kind) => {
  if (kind === "not-recording") {
    if (pendingAlarm || alarmed || Date.now() - since < GRACE_MS) return;
    pendingAlarm = setTimeout(() => {
      pendingAlarm = null;
      const st = recState.value;
      if (st.kind !== "not-recording") return;
      alarmed = true;
      alarm();
      toast("error", `Kamera ${st.cameraId} TIDAK MEREKAM`, `${st.reason} Finish di sesi "${st.sessionLabel}" tidak terekam sampai kamera pulih — sinyal RaceTime2 tetap tercatat.`, 15000);
    }, ALARM_AFTER_MS);
    return;
  }
  if (pendingAlarm) clearTimeout(pendingAlarm);
  pendingAlarm = null;
  const st = recState.value;
  if (alarmed && st.kind === "recording") toast("success", `Kamera ${st.cameraId} merekam lagi`, "Gambar kamera kembali normal.");
  alarmed = false;
});

let warnedAt: number | null = null;
watch(() => lowBattery.value?.percent ?? null, (pct) => {
  if (pct === null) return void (warnedAt = null);
  // Peringatan sekali di ≤20%, lalu lagi tiap turun 5%.
  if (warnedAt !== null && pct > warnedAt - 5) return;
  warnedAt = pct;
  if (pct <= 10) alarm();
  toast("warning", `Baterai laptop kamera ${pct}%`, "Colokkan charger ke laptop agent — bila laptop mati, kamera dan rekaman ikut mati.", 10000);
});
