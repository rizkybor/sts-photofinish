<script setup lang="ts">
// Gambar slit-scan: sumbu horizontal = waktu (kiri lebih awal). Klik haluan
// perahu → indeks kolom = frame saat haluan menyentuh garis finish.
//
// Pita waktu yang dicetak agent di bawah PNG tetap ada di file (bukti), tetapi
// di layar dipotong dan diganti skala waktu yang digambar ulang dengan tajam —
// cetakan aslinya rusak bila gambar diperbesar tidak seragam.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Capture, Crossing, Impulse } from "../lib/types";

// zoom = skala sumbu waktu (px per kolom); null = pas selebar panel.
const props = defineProps<{
  capture: Capture; crossings: Crossing[]; impulses?: Impulse[]; canMark: boolean; zoom: number | null; markColor?: string;
  /** true = diperhalus saat diperbesar (enak dilihat); false = piksel tajam per kolom (cek presisi). */
  smooth?: boolean;
  /** Kolom yang sedang ditampilkan di panel foto frame. */
  focusColumn?: number | null;
}>();
const emit = defineEmits<{
  mark: [column: number]; hover: [info: { column: number; label: string } | null]; scale: [zoom: number]; times: [pfTimes: string[] | null];
}>();

const MAX_HEIGHT = 520; // sumbu garis finish dibatasi agar halaman tidak terlalu tinggi
const RULER_H = 36;
const scroller = ref<HTMLElement | null>(null);
const boxWidth = ref(0);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(([e]) => (boxWidth.value = e!.contentRect.width));
  if (scroller.value) ro.observe(scroller.value);
});
onUnmounted(() => ro?.disconnect());

// ---------------------------------------------------------------- data kolom
const pfTimes = ref<string[] | null>(null);
const sliceHeight = ref<number | null>(null);
watch(() => props.capture.columnsUrl, async (url) => {
  try {
    const d = (await (await fetch(url)).json()) as { pfTimes?: string[] | null; sliceHeight?: number };
    pfTimes.value = d.pfTimes ?? null;
    emit("times", pfTimes.value);
    sliceHeight.value = typeof d.sliceHeight === "number" ? d.sliceHeight : null;
  } catch {
    pfTimes.value = null;
  }
}, { immediate: true });

/** "HH:MM:SS.mmm" → ms sejak tengah malam. */
function clockMs(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(t);
  if (!m) return null;
  return ((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1000 + +(m[4] ?? "0").padEnd(3, "0");
}
const fmtMs = (ms: number) => {
  const p = (v: number, n = 2) => String(Math.floor(v)).padStart(n, "0");
  return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)}.${p((ms % 1000) / 10)}`;
};

const msPerColumn = computed(() => (props.capture.fps > 0 ? 1000 / props.capture.fps : 0));
/** Waktu tiap kolom dalam ms (jam PF bila ada, selain itu relatif kolom 0). */
const colMs = computed<{ ms: number[]; absolute: boolean }>(() => {
  const abs = pfTimes.value?.map(clockMs);
  if (abs && abs.length === props.capture.width && abs.every((v) => v !== null)) return { ms: abs as number[], absolute: true };
  return { ms: Array.from({ length: props.capture.width }, (_, i) => i * msPerColumn.value), absolute: false };
});

// ---------------------------------------------------------------- skala
const zx = computed(() => {
  const z = props.zoom ?? (boxWidth.value > 0 ? boxWidth.value / props.capture.width : 2);
  return Math.min(8, Math.max(0.25, z));
});
watch(zx, (z) => emit("scale", z), { immediate: true });
const width = computed(() => props.capture.width * zx.value);
/** Tinggi bagian gambar (tanpa pita waktu cetakan) di file. */
const slicePx = computed(() => sliceHeight.value ?? props.capture.height);
const zy = computed(() => Math.min(MAX_HEIGHT, slicePx.value * Math.max(1, zx.value)) / slicePx.value);

// ---------------------------------------------------------------- pita waktu
const ruler = computed(() => {
  const { ms, absolute } = colMs.value;
  if (ms.length < 2) return { ticks: [] as Array<{ x: number; major: boolean; label?: string }> };
  const pxPerMs = zx.value / Math.max(1e-6, (ms[ms.length - 1]! - ms[0]!) / (ms.length - 1));
  const pick = (cands: number[], minPx: number) => cands.find((c) => c * pxPerMs >= minPx) ?? cands[cands.length - 1]!;
  const tick = pick([10, 20, 50, 100, 200, 500, 1000, 2000], 7);
  const label = pick([50, 100, 200, 500, 1000, 2000, 5000], 96);
  const ticks: Array<{ x: number; major: boolean; label?: string }> = [];
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1]!, b = ms[i]!;
    // garis tepat di batas interval, diinterpolasi di antara dua kolom
    for (let t = Math.ceil(a / tick) * tick; t <= b; t += tick) {
      if (t <= a) continue;
      const x = (i - 1 + (t - a) / Math.max(1e-6, b - a) + 0.5) * zx.value;
      const major = Math.round(t) % label === 0;
      ticks.push({ x, major, label: major ? (absolute ? fmtMs(t) : `+${((t - ms[0]!) / 1000).toFixed(2)} s`) : undefined });
    }
  }
  return { ticks };
});

/** Posisi impuls RaceTime2 di gambar (kolom pertama yang waktunya ≥ impuls). */
const impulseMarks = computed(() => {
  if (!colMs.value.absolute || !props.impulses) return [];
  const ms = colMs.value.ms;
  return props.impulses.flatMap((imp, n) => {
    const t = clockMs(imp.deviceTime);
    if (t === null || t < ms[0]! || t > ms[ms.length - 1]!) return [];
    const col = ms.findIndex((v) => v >= t);
    return [{ n: n + 1, x: (col + 0.5) * zx.value, camera: imp.source === "camera" }];
  });
});

// ---------------------------------------------------------------- interaksi
const hover = ref<number | null>(null);
function columnAt(ev: MouseEvent): number {
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  return Math.min(props.capture.width - 1, Math.max(0, Math.floor((ev.clientX - rect.left) / zx.value)));
}
function onMove(ev: MouseEvent) {
  const c = columnAt(ev);
  hover.value = c;
  emit("hover", { column: c, label: pfTimes.value?.[c] ?? `+${(c * msPerColumn.value).toFixed(1)} ms` });
}
function onLeave() {
  hover.value = null;
  emit("hover", null);
}
</script>

<template>
  <div ref="scroller" class="scroller">
    <div
      class="stage" :class="{ markable: canMark }" :style="{ width: width + 'px', height: slicePx * zy + 'px' }"
      @mousemove="onMove" @mouseleave="onLeave" @click="canMark && emit('mark', columnAt($event))"
    >
      <img :src="capture.url" :class="{ pixel: smooth === false }" :style="{ width: width + 'px', height: capture.height * zy + 'px' }" alt="Slit-scan garis finish" draggable="false" />
      <div v-if="focusColumn != null" class="focus" :style="{ left: (focusColumn + 0.5) * zx + 'px' }" title="Posisi foto frame" />
      <div v-for="m in impulseMarks" :key="'i' + m.n" class="impulse" :class="{ cam: m.camera }" :style="{ left: m.x + 'px' }" :title="m.camera ? `Pemicu kamera ${m.n}` : `Impuls RaceTime2 ${m.n}`">
        <span class="impulse-tag">{{ m.n }}</span>
      </div>
      <div v-for="c in crossings" :key="c._id" class="marker" :class="{ confirmed: c.status === 'confirmed' }" :style="{ left: c.column * zx + 'px', width: Math.max(2, zx) + 'px' }">
        <span class="tag">{{ c.rank }}<template v-if="c.lane"> · {{ c.lane }}</template></span>
      </div>
      <div v-if="hover !== null && canMark" class="cursor" :style="{ left: hover * zx + 'px', width: Math.max(1, zx) + 'px', background: markColor ?? '#22d3ee' }" />
    </div>
    <svg class="ruler" :width="width" :height="RULER_H" :viewBox="`0 0 ${width} ${RULER_H}`" aria-label="Skala waktu">
      <g v-for="(t, i) in ruler.ticks" :key="i">
        <line :x1="t.x" :x2="t.x" :y1="0" :y2="t.major ? 12 : 6" :class="t.major ? 'major' : 'minor'" />
        <text v-if="t.label" :x="t.x" y="27" text-anchor="middle">{{ t.label }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.scroller { overflow-x: auto; border-radius: 12px; background: var(--race-2); border: 1px solid rgba(255, 255, 255, 0.08); }
.stage { position: relative; line-height: 0; overflow: hidden; }
.stage.markable { cursor: crosshair; }
.stage img { display: block; image-rendering: auto; object-fit: fill; }
.stage img.pixel { image-rendering: pixelated; }
.focus { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid rgba(255, 255, 255, 0.85); box-shadow: 0 0 6px rgba(0, 0, 0, 0.8); pointer-events: none; }
.impulse { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px dashed rgba(251, 191, 36, 0.9); pointer-events: none; }
.impulse.cam { border-left-color: rgba(34, 211, 238, 0.9); }
.impulse.cam .impulse-tag { background: #22d3ee; }
.impulse-tag { position: absolute; bottom: 6px; left: 4px; line-height: 1; background: #fbbf24; color: #1f2937; font: 700 11px var(--mono); padding: 3px 6px; border-radius: 6px; white-space: nowrap; }
.marker { position: absolute; top: 0; bottom: 0; background: var(--mark); box-shadow: 0 0 6px rgba(225, 29, 72, 0.8); pointer-events: none; }
.marker.confirmed { background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.8); }
.tag { position: absolute; top: 6px; left: 6px; line-height: 1; background: inherit; color: #fff; font: 700 12px var(--mono); padding: 4px 7px; border-radius: 6px; white-space: nowrap; }
.cursor { position: absolute; top: 0; bottom: 0; pointer-events: none; opacity: 0.85; }
.ruler { display: block; background: #111; }
.ruler line.major { stroke: #e5e7eb; stroke-width: 1.5; }
.ruler line.minor { stroke: #6b7280; stroke-width: 1; }
.ruler text { fill: #e5e7eb; font: 600 11px var(--mono); }
</style>
