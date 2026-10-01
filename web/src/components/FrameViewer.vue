<script setup lang="ts">
// Foto frame asli dari kamera pada detik yang sama dengan kolom slit-scan
// yang ditunjuk. Slit-scan menampilkan WAKTU di sumbu horizontal sehingga
// benda tampak gepeng/melebar; di sini perahu terlihat dengan proporsi asli.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../lib/api";
import type { Capture } from "../lib/types";
import AppIcon from "./ui/AppIcon.vue";

interface FrameInfo { url: string; column: number }
interface Line { x1: number; y1: number; x2: number; y2: number }

const props = defineProps<{ capture: Capture; column: number | null; pfTimes: string[] | null }>();
const emit = defineEmits<{ focus: [column: number] }>();

const frames = ref<FrameInfo[]>([]);
const finishLine = ref<Line | null>(null);
const loading = ref(false);
const index = ref(0);
const natural = ref<{ w: number; h: number } | null>(null);

watch(() => props.capture._id, async (id) => {
  frames.value = [];
  natural.value = null;
  if (!props.capture.frameCount) return;
  loading.value = true;
  try {
    const d = await api<{ frames: FrameInfo[]; finishLine: Line | null }>("GET", `/api/captures/${id}/frames`);
    frames.value = d.frames;
    finishLine.value = d.finishLine;
    // muat lebih dulu agar langkah frame-demi-frame tidak berkedip
    for (const f of d.frames) new Image().src = f.url;
  } finally {
    loading.value = false;
  }
}, { immediate: true });

/** Frame terdekat dengan kolom slit-scan yang ditunjuk. */
watch(() => props.column, (c) => {
  if (c === null || !frames.value.length) return;
  let best = 0;
  for (let i = 1; i < frames.value.length; i++) {
    if (Math.abs(frames.value[i]!.column - c) < Math.abs(frames.value[best]!.column - c)) best = i;
  }
  index.value = best;
});

const current = computed(() => frames.value[index.value]);
const label = computed(() => {
  const f = current.value;
  if (!f) return "";
  return props.pfTimes?.[f.column] ?? `kolom ${f.column}`;
});

function step(d: number) {
  if (!frames.value.length) return;
  index.value = Math.min(frames.value.length - 1, Math.max(0, index.value + d));
  emit("focus", current.value!.column);
}

const onKey = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
  if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
};
// Tombol panah aktif selama kursor berada di panel slit-scan/frame kelompok ini.
const hovering = ref(false);
const onWindowKey = (e: KeyboardEvent) => hovering.value && onKey(e);
onMounted(() => window.addEventListener("keydown", onWindowKey));
onUnmounted(() => window.removeEventListener("keydown", onWindowKey));
defineExpose({ setActive: (v: boolean) => (hovering.value = v) });
</script>

<template>
  <div class="frame-panel" @mouseenter="hovering = true" @mouseleave="hovering = false">
    <div class="frame-head">
      <span class="section-label" style="margin: 0; color: #b6c2cf">Foto frame</span>
      <span v-if="current" class="readout">{{ label }}</span>
    </div>

    <div v-if="!capture.frameCount" class="empty" style="color: #b6c2cf; padding: 28px 12px">
      <AppIcon name="camera" />
      <span>Rekaman ini tidak menyimpan frame utuh.</span>
      <span class="hint">Aktifkan <code>PF_FRAMES=on</code> di agent untuk rekaman berikutnya.</span>
    </div>
    <div v-else-if="loading" class="empty" style="color: #b6c2cf; padding: 28px 12px"><AppIcon name="pending" />Memuat frame…</div>
    <template v-else-if="current">
      <div class="frame-stage">
        <img :src="current.url" alt="Frame kamera" @load="natural = { w: ($event.target as HTMLImageElement).naturalWidth, h: ($event.target as HTMLImageElement).naturalHeight }" />
        <svg v-if="natural && finishLine" :viewBox="`0 0 ${natural.w} ${natural.h}`" preserveAspectRatio="none">
          <line :x1="finishLine.x1" :y1="finishLine.y1" :x2="finishLine.x2" :y2="finishLine.y2" class="fl" />
        </svg>
      </div>
      <div class="frame-nav">
        <button class="btn btn-sm" :disabled="index === 0" title="Frame sebelumnya (←)" @click="step(-1)">◀</button>
        <span class="mono">{{ index + 1 }} / {{ frames.length }}</span>
        <button class="btn btn-sm" :disabled="index >= frames.length - 1" title="Frame berikutnya (→)" @click="step(1)">▶</button>
      </div>
      <p class="hint" style="margin: 6px 0 0">Arahkan kursor ke gambar slit-scan, atau pakai ◀ ▶ / tombol panah untuk frame demi frame.</p>
    </template>
  </div>
</template>

<style scoped>
.frame-panel { background: var(--race-2); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 10px; }
.frame-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.frame-stage { position: relative; line-height: 0; border-radius: 8px; overflow: hidden; background: #000; }
.frame-stage img { width: 100%; height: auto; display: block; }
.frame-stage svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.fl { stroke: #ff3b30; stroke-width: 2; stroke-dasharray: 8 5; vector-effect: non-scaling-stroke; }
.frame-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 8px; color: #e6eef6; }
</style>
