<script setup lang="ts">
// Standby kamera: gambar live + garis imajiner tegak lurus untuk memastikan
// kamera lurus terhadap garis finish/tiang photocell sebelum lomba.
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { pfNow } from "../lib/clock";
import { armedSession, closeQueue, fmtGap, fmtTime, isTyping } from "../lib/sessions";
import { getSocket } from "../lib/socket";
import type { FinishEvent } from "../lib/types";
import FinishFeed from "./FinishFeed.vue";
import TriggerLog from "./TriggerLog.vue";
import { midX, tiltFromVerticalDeg, tiltLevel, xAtY, type Line } from "../lib/geometry";
import { toast } from "../lib/ui";
import RecIndicator from "./RecIndicator.vue";
import AppIcon, { type IconName } from "./ui/AppIcon.vue";

const emit = defineEmits<{ back: []; review: [f: FinishEvent] }>();

interface PreviewFrame {
  cameraId: string; width: number; height: number; fps: number; finishLine: Line; jpeg: ArrayBuffer; receivedAt: number;
}

const cameraId = ref("cam-1");
const frame = ref<Omit<PreviewFrame, "jpeg"> | null>(null);
const imgUrl = ref<string | null>(null);
const error = ref("");
const now = ref(Date.now());
const guideX = ref<number | null>(null);
const show = reactive({ guide: true, finish: true, level: true, grid: true, center: false });

const LAYERS: Array<{ key: keyof typeof show; label: string; icon: IconName; color: string }> = [
  { key: "guide", label: "Garis imajiner tegak lurus", icon: "vertical", color: "#22d3ee" },
  { key: "finish", label: "Garis finish (konfigurasi)", icon: "finish", color: "#ff3b30" },
  { key: "level", label: "Garis datar", icon: "level", color: "#facc15" },
  { key: "grid", label: "Grid 10%", icon: "grid", color: "rgba(255,255,255,.7)" },
  { key: "center", label: "Titik tengah", icon: "focus", color: "#ffffff" },
];

const socket = getSocket();
// Kelurusan diukur dari TIANG PHOTOCELL di gambar (dua titik yang diklik
// operator), bukan dari koordinat garis finish — garis otomatis selalu tegak
// sehingga tidak mengatakan apa-apa tentang posisi kamera.
const measuring = ref(false);
const polePts = ref<Array<{ x: number; y: number }>>([]);
const pole = computed<Line | null>(() => {
  if (polePts.value.length < 2) return null;
  const [a, b] = polePts.value as [{ x: number; y: number }, { x: number; y: number }];
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
});
const tilt = computed(() => (pole.value ? tiltFromVerticalDeg(pole.value) : null));
const level = computed(() => (tilt.value === null ? null : tiltLevel(tilt.value)));
/** Selisih garis finish terhadap tiang (px, di tengah tiang) — slit-scan harus tepat di tiang. */
const finishOffset = computed(() => {
  if (!pole.value || !frame.value) return null;
  const y = (pole.value.y1 + pole.value.y2) / 2;
  const px = xAtY(frame.value.finishLine, y) - xAtY(pole.value, y);
  return { px, bad: Math.abs(px) > frame.value.width * 0.01 };
});
/** Titik terlalu berdekatan → sudut tidak akurat. */
const MIN_POLE_SPAN = 0.3;

function startMeasure() {
  polePts.value = [];
  measuring.value = true;
}
function resetPole() {
  polePts.value = [];
  measuring.value = false;
}
const gx = computed(() => guideX.value ?? (frame.value ? midX(frame.value.finishLine) : 0));
const ageMs = computed(() => (frame.value ? now.value - frame.value.receivedAt : Infinity));
const live = computed(() => ageMs.value < 2500);
const ticks = computed(() => (frame.value ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ x: (frame.value!.width * i) / 10, y: (frame.value!.height * i) / 10 })) : []));
const LEVEL = {
  ok: { text: "Lurus", cls: "status-success", note: "Tiang photocell tegak di gambar — kamera lurus." },
  warn: { text: "Sedikit miring", cls: "status-upcoming", note: "Putar sedikit dudukan kamera, lalu ukur ulang." },
  bad: { text: "Miring", cls: "status-danger", note: "Atur ulang dudukan kamera sebelum lomba dimulai." },
} as const;

let decoding = false;
async function onFrame(f: PreviewFrame) {
  if (f.cameraId !== cameraId.value || decoding) return; // lewati frame bila yang sebelumnya belum siap
  decoding = true;
  const url = URL.createObjectURL(new Blob([f.jpeg], { type: "image/jpeg" }));
  try {
    // Decode dulu baru tukar — tidak ada jeda kosong antar-frame (anti kedip).
    const img = new Image();
    img.src = url;
    await img.decode();
    const old = imgUrl.value;
    imgUrl.value = url;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
    const { jpeg: _j, ...meta } = f;
    frame.value = { ...meta, receivedAt: Date.now() };
  } catch {
    URL.revokeObjectURL(url);
  } finally {
    decoding = false;
  }
}

async function subscribe() {
  error.value = "";
  frame.value = null;
  resetPole(); // ukuran tiang hanya berlaku untuk kamera yang diukur
  const res = await socket.emitWithAck("preview:subscribe", cameraId.value);
  if (!res.ok) error.value = res.error;
  else if (!res.agents) error.value = "Capture Agent belum terhubung ke API.";
}

function clickStage(ev: MouseEvent) {
  if (!frame.value) return;
  // Layar penuh: ketukan yang memunculkan kontrol tidak ikut memindahkan garis (tablet).
  if (fs.value && Date.now() - wokeAt < 400) return;
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const x = Math.round(((ev.clientX - rect.left) / rect.width) * frame.value.width);
  const y = Math.round(((ev.clientY - rect.top) / rect.height) * frame.value.height);
  if (!measuring.value) {
    guideX.value = x;
    return;
  }
  const pts = [...polePts.value, { x, y }];
  if (pts.length < 2) {
    polePts.value = pts;
    return;
  }
  const [a, b] = pts[0]!.y <= pts[1]!.y ? [pts[0]!, pts[1]!] : [pts[1]!, pts[0]!];
  if (b.y - a.y < frame.value.height * MIN_POLE_SPAN) {
    polePts.value = [];
    toast("warning", "Titik terlalu berdekatan", "Klik ujung ATAS lalu ujung BAWAH tiang yang terlihat, sejauh mungkin, agar sudut akurat.");
    return;
  }
  polePts.value = [a, b];
  measuring.value = false;
  guideX.value = Math.round(xAtY({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }, frame.value.height / 2));
}
// ---------------------------------------------------------------- layar penuh
// Seperti siaran langsung: gambar memenuhi layar, info (jam PF, REC, pemicu,
// finish) tetap tampil di atasnya; tombol kontrol hilang saat mouse diam.
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
const viewer = ref<HTMLElement | null>(null);
const fs = ref(false);
const showInfo = ref(true);
const controls = ref(true);
let idleTimer: number | undefined;
let wokeAt = 0;
function poke() {
  if (!controls.value) wokeAt = Date.now();
  controls.value = true;
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => (controls.value = false), 3000);
}
async function enterFs() {
  fs.value = true;
  poke();
  const el = viewer.value as FsEl | null;
  try {
    if (el?.requestFullscreen) await el.requestFullscreen();
    else await el?.webkitRequestFullscreen?.();
  } catch { /* tidak didukung (mis. iPhone) — tetap memenuhi jendela browser */ }
}
async function exitFs() {
  fs.value = false;
  const d = document as FsDoc;
  try {
    if (d.fullscreenElement) await d.exitFullscreen();
    else if (d.webkitFullscreenElement) await d.webkitExitFullscreen?.();
  } catch { /* abaikan */ }
}
const toggleFs = () => (fs.value ? exitFs() : enterFs());
function onFsChange() {
  const d = document as FsDoc;
  if (!d.fullscreenElement && !d.webkitFullscreenElement) fs.value = false; // keluar lewat Esc
}
/** Tinjau dari layar penuh: keluar dulu agar halaman sesi tampil normal. */
function review(f: FinishEvent) {
  void exitFs();
  emit("review", f);
}
const pfClock = computed(() => (now.value, pfNow()));

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && measuring.value) return resetPole();
  if (e.key === "Escape" && fs.value) return void exitFs();
  if ((e.key === "f" || e.key === "F") && !isTyping(e)) {
    e.preventDefault();
    void toggleFs();
  }
};

let timer: number | undefined;
const resubscribe = () => void subscribe();
onMounted(() => {
  socket.on("preview:frame", onFrame);
  socket.on("connect", resubscribe);
  window.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  subscribe();
  timer = window.setInterval(() => (now.value = Date.now()), 500);
});
onUnmounted(() => {
  socket.emit("preview:unsubscribe", cameraId.value);
  socket.off("preview:frame", onFrame);
  socket.off("connect", resubscribe);
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("fullscreenchange", onFsChange);
  document.removeEventListener("webkitfullscreenchange", onFsChange);
  clearTimeout(idleTimer);
  clearInterval(timer);
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value);
});
</script>

<template>
  <div class="page-head">
    <div class="grow">
      <h1 class="page-title">Standby Kamera</h1>
      <p class="page-subtitle">Posisi operator selama lomba. Buka detail sesi hanya saat ada finish berdekatan.</p>
    </div>
    <label class="field" style="width: 160px">
      <span class="field-label">Kamera</span>
      <span class="input-group"><AppIcon name="camera" /><input v-model="cameraId" class="input mono" @change="subscribe" /></span>
    </label>
  </div>

  <RecIndicator variant="banner" :camera-id="cameraId" />

  <div v-if="closeQueue.length" class="close-alert" role="alert">
    <span class="close-icon"><AppIcon name="compare" /></span>
    <div class="grow">
      <strong>Finish berdekatan — {{ closeQueue[0]!.boats }} perahu<template v-if="closeQueue[0]!.gapMs !== null">, selisih {{ fmtGap(closeQueue[0]!.gapMs) }}</template></strong>
      <span>{{ closeQueue[0]!.sessionLabel }} · {{ fmtTime(closeQueue[0]!.createdAt) }}<template v-if="closeQueue.length > 1"> · +{{ closeQueue.length - 1 }} antre</template></span>
    </div>
    <button class="btn btn-primary" @click="emit('review', closeQueue[0]!)">
      <AppIcon name="search" /> Tinjau sekarang <kbd>T</kbd>
    </button>
  </div>

  <div class="layout">
    <section
      ref="viewer" class="race-window" :class="{ fs, idle: fs && !controls }"
      :style="frame ? { '--ar': String(frame.width / frame.height) } : undefined"
      @mousemove="fs && poke()" @touchstart.passive="fs && poke()"
    >
      <div class="race-toolbar">
        <span class="status-pill" :class="live ? 'status-live' : 'status-muted'"><span class="dot" />{{ live ? "LIVE" : "Tidak ada gambar" }}</span>
        <span v-if="frame" class="readout">{{ frame.width }}×{{ frame.height }} · {{ frame.fps || "?" }} fps</span>
        <span class="spacer" />
        <span v-if="frame && show.guide" class="readout">garis imajiner x = {{ Math.round(gx) }}</span>
        <button class="btn btn-sm" title="Layar penuh (F)" @click="enterFs"><AppIcon name="fullscreen" /> Layar penuh</button>
      </div>

      <div v-if="frame && imgUrl" class="stage" :class="{ measuring }" @click="clickStage">
        <img :src="imgUrl" alt="Gambar live kamera finish" draggable="false" />
        <svg :viewBox="`0 0 ${frame.width} ${frame.height}`" preserveAspectRatio="none">
          <g v-if="show.grid" class="grid">
            <line v-for="t in ticks" :key="'x' + t.x" :x1="t.x" :x2="t.x" y1="0" :y2="frame.height" />
            <line v-for="t in ticks" :key="'y' + t.y" x1="0" :x2="frame.width" :y1="t.y" :y2="t.y" />
          </g>
          <line v-if="show.level" class="level" x1="0" :x2="frame.width" :y1="frame.height / 2" :y2="frame.height / 2" />
          <line v-if="show.finish" class="finish" :x1="frame.finishLine.x1" :y1="frame.finishLine.y1" :x2="frame.finishLine.x2" :y2="frame.finishLine.y2" />
          <line v-if="show.guide" class="guide" :x1="gx" :x2="gx" y1="0" :y2="frame.height" />
          <line v-if="pole" class="pole" :x1="pole.x1" :y1="pole.y1" :x2="pole.x2" :y2="pole.y2" />
          <circle v-for="(p, i) in polePts" :key="i" class="pole-pt" :cx="p.x" :cy="p.y" r="6" />
          <g v-if="show.center" class="center">
            <circle :cx="frame.width / 2" :cy="frame.height / 2" r="14" />
            <line :x1="frame.width / 2 - 24" :x2="frame.width / 2 + 24" :y1="frame.height / 2" :y2="frame.height / 2" />
            <line :x1="frame.width / 2" :x2="frame.width / 2" :y1="frame.height / 2 - 24" :y2="frame.height / 2 + 24" />
          </g>
        </svg>
        <span v-if="!live" class="stale">Gambar tidak diperbarui</span>
        <span v-if="measuring" class="measure-tip">{{ polePts.length ? "Klik ujung BAWAH tiang" : "Klik ujung ATAS tiang photocell" }} · Esc batal</span>
      </div>
      <div v-else class="empty" style="color: #b6c2cf">
        <AppIcon :name="error ? 'error' : 'camera'" />
        <strong style="color: #fff">{{ error || "Menunggu gambar dari kamera…" }}</strong>
        <span>Jalankan Capture Agent untuk kamera <span class="mono">{{ cameraId }}</span>.</span>
      </div>
      <template v-if="fs">
        <div class="ov-top">
          <span class="status-pill" :class="live ? 'status-live' : 'status-muted'"><span class="dot" />{{ live ? "LIVE" : "Tidak ada gambar" }}</span>
          <RecIndicator />
          <span class="ov-chip ov-clock mono" title="Jam Photo Finish">{{ pfClock ?? "--:--:--.---" }}</span>
          <span v-if="armedSession" class="ov-chip">{{ armedSession.label }}</span>
          <span class="ov-chip mono">{{ cameraId }}</span>
        </div>
        <div class="ov-banner"><RecIndicator variant="banner" :camera-id="cameraId" /></div>
        <div v-if="closeQueue.length" class="ov-alert" role="alert">
          <div class="grow">
            <strong>Finish berdekatan — {{ closeQueue[0]!.boats }} perahu<template v-if="closeQueue[0]!.gapMs !== null">, selisih {{ fmtGap(closeQueue[0]!.gapMs) }}</template></strong>
            <span>{{ closeQueue[0]!.sessionLabel }}<template v-if="closeQueue.length > 1"> · +{{ closeQueue.length - 1 }} antre</template></span>
          </div>
          <button class="btn btn-primary btn-sm" @click="review(closeQueue[0]!)"><AppIcon name="search" /> Tinjau</button>
        </div>
        <aside v-show="showInfo" class="ov-side">
          <TriggerLog :camera-id="cameraId" :limit="4" overlay />
          <FinishFeed overlay :limit="4" @review="review" />
        </aside>
        <div class="ov-controls">
          <button class="ov-btn" @click="exitFs"><AppIcon name="fullscreenExit" /> Keluar <kbd>F</kbd></button>
          <button class="ov-btn" @click="showInfo = !showInfo"><AppIcon :name="showInfo ? 'visibilityOff' : 'visibility'" /> {{ showInfo ? "Sembunyikan info" : "Tampilkan info" }}</button>
          <span class="grow" />
          <button class="ov-btn" :class="{ on: show.finish }" @click="show.finish = !show.finish">Garis finish</button>
          <button class="ov-btn" :class="{ on: show.guide }" @click="show.guide = !show.guide">Garis imajiner</button>
          <button class="ov-btn" :class="{ on: show.grid }" @click="show.grid = !show.grid">Grid</button>
        </div>
      </template>
      <p class="hint" style="margin: 10px 0 0"><AppIcon name="touch" /> Klik gambar untuk memindahkan garis imajiner. Untuk mengukur kelurusan, pakai <strong>Ukur tiang</strong> di panel kanan.</p>
    </section>

    <aside class="side">
      <FinishFeed @review="emit('review', $event)" />
      <TriggerLog :camera-id="cameraId" :limit="5" />

      <section class="card">
        <div class="section-label">Kelurusan kamera (tiang photocell)</div>
        <div class="gauge">
          <svg viewBox="-60 -60 120 120" class="dial" aria-hidden="true">
            <circle r="52" class="dial-ring" />
            <line x1="0" y1="-52" x2="0" y2="52" class="dial-ref" />
            <line v-if="tilt !== null" x1="0" y1="-46" x2="0" y2="46" class="dial-needle" :class="level" :transform="`rotate(${-tilt})`" />
          </svg>
          <div>
            <div class="deg mono">{{ tilt !== null ? `${tilt >= 0 ? "+" : ""}${tilt.toFixed(2)}°` : "—" }}</div>
            <span v-if="level" class="status-pill" :class="LEVEL[level].cls"><span class="dot" />{{ LEVEL[level].text }}</span>
            <span v-else class="status-pill status-muted"><span class="dot" />Belum diukur</span>
          </div>
        </div>
        <p class="muted" style="margin: 10px 0 0">
          <template v-if="measuring">{{ polePts.length ? "Sekarang klik ujung BAWAH tiang." : "Klik ujung ATAS tiang photocell di gambar." }}</template>
          <template v-else-if="level">{{ LEVEL[level].note }}</template>
          <template v-else>Klik dua titik pada tiang photocell di gambar — sudut tiang = kemiringan kamera.</template>
        </p>
        <div v-if="finishOffset" class="offset" :class="{ bad: finishOffset.bad }">
          <AppIcon :name="finishOffset.bad ? 'warning' : 'check'" />
          <span>Garis finish {{ Math.abs(finishOffset.px) < 1 ? "tepat di tiang" : `${Math.abs(Math.round(finishOffset.px))} px di ${finishOffset.px > 0 ? "kanan" : "kiri"} tiang` }}<template v-if="finishOffset.bad"> — atur garis finish di Pengaturan Kamera agar berimpit dengan tiang.</template></span>
        </div>
        <div class="row" style="margin-top: 10px">
          <button class="btn btn-sm" :class="{ 'is-active': measuring }" :disabled="!frame" @click="measuring ? resetPole() : startMeasure()">
            <AppIcon name="ruler" /> {{ measuring ? "Batal" : pole ? "Ukur ulang" : "Ukur tiang" }}
          </button>
        </div>
        <p class="hint" style="margin: 6px 0 0">Toleransi: ≤ 0,5° lurus · ≤ 2° rapikan · &gt; 2° atur ulang.</p>
      </section>

      <section class="card">
        <div class="section-label">Lapisan</div>
        <label v-for="l in LAYERS" :key="l.key" class="layer">
          <span class="swatch" :style="{ background: l.color }" />
          <AppIcon :name="l.icon" />
          <span class="grow">{{ l.label }}</span>
          <input v-model="show[l.key]" type="checkbox" class="switch" />
        </label>
      </section>

      <details class="card">
        <summary class="section-label" style="cursor: pointer">Cara cek kelurusan</summary>
        <ol class="steps">
          <li>Arahkan kamera <strong>tegak lurus</strong> ke garis finish dari tepi sungai.</li>
          <li>Tekan <strong>Ukur tiang</strong>, lalu klik ujung <strong>atas</strong> dan ujung <strong>bawah</strong> tiang photocell di gambar (sejauh mungkin).</li>
          <li>Indikator kelurusan <strong>hijau</strong> (≤ 0,5°). Bila tidak, putar dudukan kamera dan ukur ulang — ukuran lama tidak ikut bergerak.</li>
          <li>Garis finish merah harus <strong>berimpit</strong> dengan tiang (panel menunjukkan selisihnya). Bila bergeser, atur di Pengaturan Kamera.</li>
          <li><strong>Garis datar</strong> kuning sejajar permukaan air / horizon.</li>
        </ol>
      </details>
    </aside>
  </div>
</template>

<style scoped>
.close-alert { display: flex; align-items: center; gap: 14px; padding: 12px 16px; margin-bottom: 16px; border-radius: 14px; background: var(--warn-bg); border: 2px solid var(--warn); color: var(--warn-ink); animation: flash 1.4s ease-in-out 3; }
.close-alert .grow { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.close-alert strong { font-size: 1.05rem; color: var(--ink); }
.close-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--warn); color: #fff; font-size: 22px; flex: none; }
.close-alert kbd { font: 700 0.7rem var(--mono); padding: 1px 5px; border-radius: 5px; border: 1px solid currentColor; opacity: 0.8; margin-left: 4px; }
@keyframes flash { 50% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.35); } }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
.side .card { margin-bottom: 16px; }
.stage { position: relative; width: 100%; cursor: crosshair; line-height: 0; border-radius: 12px; overflow: hidden; background: var(--race-2); }
.stage img { width: 100%; height: auto; display: block; }
.stage svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.stale { position: absolute; top: 12px; right: 12px; line-height: 1; background: var(--bad); color: #fff; font-weight: 700; font-size: 0.8rem; padding: 6px 10px; border-radius: 8px; }
.finish { stroke: #ff3b30; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.guide { stroke: #22d3ee; stroke-width: 2.5; stroke-dasharray: 12 7; vector-effect: non-scaling-stroke; filter: drop-shadow(0 0 2px #000); }
.level { stroke: #facc15; stroke-width: 1.5; stroke-dasharray: 5 6; vector-effect: non-scaling-stroke; }
.grid line { stroke: rgba(255, 255, 255, 0.22); stroke-width: 1; vector-effect: non-scaling-stroke; }
.center circle, .center line { stroke: #fff; stroke-width: 2; fill: none; vector-effect: non-scaling-stroke; }
.stage.measuring { cursor: cell; box-shadow: inset 0 0 0 3px #e879f9; }
.pole { stroke: #e879f9; stroke-width: 3; vector-effect: non-scaling-stroke; filter: drop-shadow(0 0 2px #000); }
.pole-pt { fill: #e879f9; stroke: #fff; stroke-width: 2; vector-effect: non-scaling-stroke; }
.measure-tip { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); line-height: 1.2; background: #a21caf; color: #fff; font-weight: 700; font-size: 0.82rem; padding: 6px 12px; border-radius: 8px; white-space: nowrap; }
/* ---------------- layar penuh (seperti siaran langsung) ---------------- */
.race-window.fs { position: fixed; inset: 0; z-index: 3000; border: 0; border-radius: 0; padding: 0; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.race-window.fs:hover { box-shadow: none; }
.fs > .race-toolbar, .fs > .hint { display: none; }
.fs .stage { width: min(100vw, calc(100vh * var(--ar, 1.7778))); border-radius: 0; }
.fs .empty { width: 100%; }
.fs.idle, .fs.idle .stage { cursor: none; }
.ov-top { position: absolute; top: 16px; left: 16px; right: 376px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; pointer-events: none; }
.ov-chip { background: rgba(15, 23, 42, 0.72); backdrop-filter: blur(6px); color: #fff; padding: 6px 10px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; white-space: nowrap; }
.ov-clock { font-size: 1.35rem; padding: 3px 12px; letter-spacing: 0.02em; }
.ov-banner { position: absolute; top: 62px; left: 16px; right: 376px; }
.ov-alert { position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: rgba(245, 158, 11, 0.92); color: #451a03; max-width: min(560px, calc(100% - 32px)); animation: flash 1.4s ease-in-out 3; }
.ov-alert .grow { display: flex; flex-direction: column; min-width: 0; }
.ov-alert strong { color: #1c1917; }
.ov-side { position: absolute; top: 16px; right: 16px; bottom: 84px; width: 340px; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
.ov-controls { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 28px 16px 14px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.75)); transition: opacity 0.3s; }
.ov-controls .grow { flex: 1; }
.fs.idle .ov-controls { opacity: 0; pointer-events: none; }
.ov-btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; color: #fff; font-weight: 600; font-size: 0.88rem; background: rgba(255, 255, 255, 0.12); }
.ov-btn:hover { background: rgba(255, 255, 255, 0.24); }
.ov-btn.on { background: var(--brand-2); }
.ov-btn kbd { font: 700 0.7rem var(--mono); padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.5); }
/* Layar tegak (tablet/HP): gambar di tengah, info di ruang hitam di bawahnya — tidak menutupi gambar. */
@media (orientation: portrait) {
  .ov-top, .ov-banner { right: 16px; }
  .ov-side { top: auto; left: 16px; width: auto; height: calc((100vh - 100vw / var(--ar, 1.7778)) / 2 - 92px); min-height: 160px; flex-direction: row; align-items: flex-start; }
  .ov-side > * { flex: 1; min-width: 0; }
  .ov-controls { flex-wrap: wrap; }
}
.offset { display: flex; gap: 8px; align-items: flex-start; margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 0.84rem; background: var(--ok-bg); color: var(--ok-ink); }
.offset.bad { background: var(--warn-bg); color: var(--warn-ink); }
.gauge { display: flex; align-items: center; gap: 16px; }
.dial { width: 92px; height: 92px; flex: none; }
.dial-ring { fill: var(--surface-2); stroke: var(--border); stroke-width: 2; }
.dial-ref { stroke: #22d3ee; stroke-width: 2; stroke-dasharray: 4 4; }
.dial-needle { stroke-width: 5; stroke-linecap: round; transition: transform 0.3s; }
.dial-needle.ok { stroke: var(--ok); }
.dial-needle.warn { stroke: var(--warn); }
.dial-needle.bad { stroke: var(--bad); }
.deg { font-size: 1.9rem; font-weight: 800; color: var(--ink); line-height: 1.1; margin-bottom: 6px; }
.layer { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--surface-3); cursor: pointer; font-weight: 600; font-size: 0.9rem; color: var(--text-2); }
.layer:last-child { border-bottom: 0; }
.layer .grow { flex: 1; }
.swatch { width: 14px; height: 4px; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15); }
.switch { appearance: none; width: 38px; height: 22px; border-radius: 999px; background: #cbd5e1; position: relative; cursor: pointer; transition: background 0.15s; flex: none; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 999px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); transition: left 0.15s; }
.switch:checked { background: var(--brand); }
.switch:checked::after { left: 19px; }
.steps { margin: 0; padding-left: 20px; display: grid; gap: 8px; font-size: 0.88rem; color: var(--text-2); }
@media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .close-alert { flex-wrap: wrap; } .close-alert .btn { width: 100%; justify-content: center; } }
</style>
