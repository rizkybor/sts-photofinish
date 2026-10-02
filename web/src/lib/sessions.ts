// Daftar sesi & feed finish bersama untuk perpindahan heat cepat: satu sumber
// data yang diperbarui realtime (event "sessions:changed" / "session:armed"),
// dipakai bar heat, Standby Kamera, daftar sesi, dan halaman sesi.
import { computed, reactive, watch } from "vue";
import { api, auth } from "./api";
import { getSocket } from "./socket";
import type { FinishEvent, SessionSummary } from "./types";
import { attempt, confirmDialog } from "./ui";

export const sessions = reactive<{ list: SessionSummary[]; feed: FinishEvent[]; loaded: boolean; error: string | null }>({
  list: [], feed: [], loaded: false, error: null,
});

export const armedSession = computed(() => sessions.list.find((s) => s.armed) ?? null);

/** Sesi terbuka yang masih punya finish berdekatan belum ditinjau. */
export const pendingSessions = computed(() => sessions.list.filter((s) => s.status === "open" && s.progress.pending > 0));

/** Finish berdekatan yang menunggu tinjauan, terlama dulu (urutan kerja). */
export const closeQueue = computed(() => sessions.feed.filter((f) => f.needsReview).slice().reverse());

// ---------------------------------------------------------------- finish berdekatan baru
type Listener = (f: FinishEvent) => void;
const listeners = new Set<Listener>();
/** Dipanggil sekali untuk tiap finish berdekatan yang baru muncul (bukan saat muat awal). */
export function onCloseFinish(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let seen: Set<string> | null = null;

export async function loadSessions() {
  try {
    const [list, feed] = await Promise.all([api<SessionSummary[]>("GET", "/api/sessions"), api<FinishEvent[]>("GET", "/api/finishes")]);
    sessions.list = list;
    sessions.feed = feed;
    sessions.error = null;
    const first = seen === null;
    seen ??= new Set();
    for (const f of feed) {
      if (!f.close || seen.has(f.groupId)) continue;
      seen.add(f.groupId);
      if (!first && f.needsReview) listeners.forEach((fn) => fn(f));
    }
  } catch (e) {
    sessions.error = (e as Error).message;
  } finally {
    sessions.loaded = true;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Banyak event beruntun (mis. 4 perahu RX) cukup satu kali muat. */
function scheduleReload() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void loadSessions(); }, 200);
}

let started = false;
watch(() => auth.token, (token) => {
  if (!token) {
    Object.assign(sessions, { list: [], feed: [], loaded: false });
    seen = null;
    return;
  }
  void loadSessions();
  if (started) return;
  started = true;
  const socket = getSocket();
  socket.on("connect", scheduleReload);
  socket.on("sessions:changed", scheduleReload);
  socket.on("session:armed", scheduleReload);
}, { immediate: true });

// ---------------------------------------------------------------- preferensi

const SOUND_KEY = "pf.closeSound";
function readSound() {
  try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch { return true; }
}
/** Bunyi singkat saat ada finish berdekatan — operator sedang memandang kamera. */
export const prefs = reactive({ sound: readSound() });
watch(() => prefs.sound, (v) => {
  try { localStorage.setItem(SOUND_KEY, v ? "1" : "0"); } catch { /* abaikan */ }
});

let audio: AudioContext | null = null;
export function beep() {
  if (!prefs.sound) return;
  try {
    audio ??= new AudioContext();
    for (const [i, f] of [880, 1175].entries()) {
      const o = audio.createOscillator(), g = audio.createGain();
      const t = audio.currentTime + i * 0.16;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.15);
    }
  } catch { /* browser menolak audio sebelum ada interaksi — abaikan */ }
}

/** Pintasan keyboard aman: abaikan saat mengetik atau saat dialog terbuka. */
export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return e.ctrlKey || e.metaKey || e.altKey || !!t?.closest("input, textarea, select, [contenteditable=true]") || !!document.querySelector(".modal-backdrop");
}

export const fmtTime = (d: string) => new Date(d).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const fmtGap = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2).replace(".", ",")} dtk`);

/**
 * Hapus sesi (aktif maupun tidak aktif) setelah konfirmasi. Ditolak API bila
 * ada hasil yang sudah dikonfirmasi juri. Mengembalikan true bila terhapus.
 */
export async function deleteSessionWithConfirm(s: { _id: string; label: string; armed: boolean }): Promise<boolean> {
  const ok = await confirmDialog({
    title: "Hapus sesi?", danger: true, okText: "Hapus sesi",
    text: `${s.label} beserta semua tangkapan, foto frame, dan tanda perahu akan dihapus permanen.` +
      (s.armed ? " Sesi ini sedang AKTIF — setelah dihapus, sinyal RaceTime2 masuk ke daftar \"tanpa sesi\" sampai ada sesi lain yang diaktifkan." : "") +
      " Sinyal RaceTime2 tidak hilang. Sesi dengan hasil yang sudah dikonfirmasi juri tidak bisa dihapus.",
  });
  if (!ok) return false;
  const res = await attempt(() => api("DELETE", `/api/sessions/${s._id}`), "Sesi dihapus");
  if (res === undefined) return false;
  void loadSessions();
  return true;
}
