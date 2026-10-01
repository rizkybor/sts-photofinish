<script setup lang="ts">
// Standby kamera: gambar live + garis imajiner tegak lurus untuk memastikan
// kamera lurus terhadap garis finish/tiang photocell sebelum lomba.
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { getSocket } from "../lib/socket";
import { midX, tiltFromVerticalDeg, tiltLevel, type Line } from "../lib/geometry";
import AppIcon, { type IconName } from "./ui/AppIcon.vue";

const emit = defineEmits<{ back: [] }>();

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
const tilt = computed(() => (frame.value ? tiltFromVerticalDeg(frame.value.finishLine) : 0));
const level = computed(() => tiltLevel(tilt.value));
const gx = computed(() => guideX.value ?? (frame.value ? midX(frame.value.finishLine) : 0));
const ageMs = computed(() => (frame.value ? now.value - frame.value.receivedAt : Infinity));
const live = computed(() => ageMs.value < 2500);
const ticks = computed(() => (frame.value ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ x: (frame.value!.width * i) / 10, y: (frame.value!.height * i) / 10 })) : []));
const LEVEL = {
  ok: { text: "Lurus", cls: "status-success", note: "Garis finish tegak lurus. Kamera siap dipakai." },
  warn: { text: "Sedikit miring", cls: "status-upcoming", note: "Rapikan posisi kamera atau koordinat PF_FINISH_LINE." },
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
  const res = await socket.emitWithAck("preview:subscribe", cameraId.value);
  if (!res.ok) error.value = res.error;
  else if (!res.agents) error.value = "Capture Agent belum terhubung ke API.";
}

function placeGuide(ev: MouseEvent) {
  if (!frame.value) return;
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  guideX.value = Math.round(((ev.clientX - rect.left) / rect.width) * frame.value.width);
}

let timer: number | undefined;
const resubscribe = () => void subscribe();
onMounted(() => {
  socket.on("preview:frame", onFrame);
  socket.on("connect", resubscribe);
  subscribe();
  timer = window.setInterval(() => (now.value = Date.now()), 500);
});
onUnmounted(() => {
  socket.emit("preview:unsubscribe", cameraId.value);
  socket.off("preview:frame", onFrame);
  socket.off("connect", resubscribe);
  clearInterval(timer);
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value);
});
</script>

<template>
  <div class="crumbs"><button @click="emit('back')">Sesi Lomba</button><AppIcon name="chevron" /><span>Standby Kamera</span></div>
  <div class="page-head">
    <div class="grow">
      <h1 class="page-title">Standby Kamera</h1>
      <p class="page-subtitle">Pastikan kamera lurus terhadap garis finish sebelum heat pertama dimulai.</p>
    </div>
    <label class="field" style="width: 160px">
      <span class="field-label">Kamera</span>
      <span class="input-group"><AppIcon name="camera" /><input v-model="cameraId" class="input mono" @change="subscribe" /></span>
    </label>
  </div>

  <div class="layout">
    <section class="race-window">
      <div class="race-toolbar">
        <span class="status-pill" :class="live ? 'status-live' : 'status-muted'"><span class="dot" />{{ live ? "LIVE" : "Tidak ada gambar" }}</span>
        <span v-if="frame" class="readout">{{ frame.width }}×{{ frame.height }} · {{ frame.fps || "?" }} fps</span>
        <span class="spacer" />
        <span v-if="frame && show.guide" class="readout">garis imajiner x = {{ Math.round(gx) }}</span>
        <button v-if="guideX !== null" class="btn btn-sm" @click="guideX = null"><AppIcon name="refresh" /> Ke garis finish</button>
      </div>

      <div v-if="frame && imgUrl" class="stage" @click="placeGuide">
        <img :src="imgUrl" alt="Gambar live kamera finish" draggable="false" />
        <svg :viewBox="`0 0 ${frame.width} ${frame.height}`" preserveAspectRatio="none">
          <g v-if="show.grid" class="grid">
            <line v-for="t in ticks" :key="'x' + t.x" :x1="t.x" :x2="t.x" y1="0" :y2="frame.height" />
            <line v-for="t in ticks" :key="'y' + t.y" x1="0" :x2="frame.width" :y1="t.y" :y2="t.y" />
          </g>
          <line v-if="show.level" class="level" x1="0" :x2="frame.width" :y1="frame.height / 2" :y2="frame.height / 2" />
          <line v-if="show.finish" class="finish" :x1="frame.finishLine.x1" :y1="frame.finishLine.y1" :x2="frame.finishLine.x2" :y2="frame.finishLine.y2" />
          <line v-if="show.guide" class="guide" :x1="gx" :x2="gx" y1="0" :y2="frame.height" />
          <g v-if="show.center" class="center">
            <circle :cx="frame.width / 2" :cy="frame.height / 2" r="14" />
            <line :x1="frame.width / 2 - 24" :x2="frame.width / 2 + 24" :y1="frame.height / 2" :y2="frame.height / 2" />
            <line :x1="frame.width / 2" :x2="frame.width / 2" :y1="frame.height / 2 - 24" :y2="frame.height / 2 + 24" />
          </g>
        </svg>
        <span v-if="!live" class="stale">Gambar tidak diperbarui</span>
      </div>
      <div v-else class="empty" style="color: #b6c2cf">
        <AppIcon :name="error ? 'error' : 'camera'" />
        <strong style="color: #fff">{{ error || "Menunggu gambar dari kamera…" }}</strong>
        <span>Jalankan Capture Agent untuk kamera <span class="mono">{{ cameraId }}</span>.</span>
      </div>
      <p class="hint" style="margin: 10px 0 0"><AppIcon name="touch" /> Klik gambar untuk memindahkan garis imajiner ke posisi tiang photocell.</p>
    </section>

    <aside class="side">
      <section class="card">
        <div class="section-label">Kelurusan garis finish</div>
        <div class="gauge">
          <svg viewBox="-60 -60 120 120" class="dial" aria-hidden="true">
            <circle r="52" class="dial-ring" />
            <line x1="0" y1="-52" x2="0" y2="52" class="dial-ref" />
            <line x1="0" y1="-46" x2="0" y2="46" class="dial-needle" :class="level" :transform="`rotate(${-tilt})`" />
          </svg>
          <div>
            <div class="deg mono">{{ frame ? `${tilt >= 0 ? "+" : ""}${tilt.toFixed(2)}°` : "—" }}</div>
            <span v-if="frame" class="status-pill" :class="LEVEL[level].cls"><span class="dot" />{{ LEVEL[level].text }}</span>
          </div>
        </div>
        <p class="muted" style="margin: 10px 0 0">{{ frame ? LEVEL[level].note : "Menunggu gambar." }}</p>
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

      <section class="card">
        <div class="section-label">Cara cek kelurusan</div>
        <ol class="steps">
          <li>Arahkan kamera <strong>tegak lurus</strong> ke garis finish dari tepi sungai.</li>
          <li>Klik gambar tepat di <strong>tiang photocell</strong> — garis biru pindah ke sana.</li>
          <li>Tiang harus <strong>berimpit</strong> dengan garis biru dari atas sampai bawah. Bila condong, kamera miring.</li>
          <li><strong>Garis datar</strong> kuning sejajar permukaan air / horizon.</li>
          <li>Indikator kelurusan garis finish <strong>hijau</strong>.</li>
        </ol>
      </section>
    </aside>
  </div>
</template>

<style scoped>
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
</style>
