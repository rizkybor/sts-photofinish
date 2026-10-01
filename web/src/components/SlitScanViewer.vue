<script setup lang="ts">
// Gambar slit-scan: sumbu horizontal = waktu (kiri lebih awal). Klik haluan
// perahu → indeks kolom = frame saat haluan menyentuh garis finish.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Capture, Crossing } from "../lib/types";

// zoom = skala sumbu waktu (px per kolom); null = pas selebar panel.
const props = defineProps<{ capture: Capture; crossings: Crossing[]; canMark: boolean; zoom: number | null; markColor?: string }>();
const emit = defineEmits<{ mark: [column: number]; hover: [info: { column: number; label: string } | null]; scale: [zoom: number] }>();

const MAX_HEIGHT = 520; // sumbu garis finish dibatasi agar halaman tidak terlalu tinggi
const scroller = ref<HTMLElement | null>(null);
const boxWidth = ref(0);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(([e]) => (boxWidth.value = e!.contentRect.width));
  if (scroller.value) ro.observe(scroller.value);
});
onUnmounted(() => ro?.disconnect());

const zx = computed(() => {
  const z = props.zoom ?? (boxWidth.value > 0 ? boxWidth.value / props.capture.width : 2);
  return Math.min(8, Math.max(0.25, z));
});
watch(zx, (z) => emit("scale", z), { immediate: true });
const displayHeight = computed(() => Math.min(MAX_HEIGHT, props.capture.height * Math.max(1, zx.value)));

const hover = ref<number | null>(null);
const pfTimes = ref<string[] | null>(null);
watch(() => props.capture.columnsUrl, async (url) => {
  try {
    pfTimes.value = ((await (await fetch(url)).json()) as { pfTimes?: string[] | null }).pfTimes ?? null;
  } catch {
    pfTimes.value = null;
  }
}, { immediate: true });

const msPerColumn = computed(() => (props.capture.fps > 0 ? 1000 / props.capture.fps : 0));
const width = computed(() => props.capture.width * zx.value);

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
      class="stage" :class="{ markable: canMark }" :style="{ width: width + 'px' }"
      @mousemove="onMove" @mouseleave="onLeave" @click="canMark && emit('mark', columnAt($event))"
    >
      <img :src="capture.url" :style="{ width: width + 'px', height: displayHeight + 'px' }" alt="Slit-scan garis finish" draggable="false" />
      <div v-for="c in crossings" :key="c._id" class="marker" :class="{ confirmed: c.status === 'confirmed' }" :style="{ left: c.column * zx + 'px', width: Math.max(2, zx) + 'px' }">
        <span class="tag">{{ c.rank }}<template v-if="c.lane"> · {{ c.lane }}</template></span>
      </div>
      <div v-if="hover !== null && canMark" class="cursor" :style="{ left: hover * zx + 'px', background: markColor ?? '#22d3ee' }" />
    </div>
  </div>
</template>

<style scoped>
.scroller { overflow-x: auto; border-radius: 12px; background: var(--race-2); border: 1px solid rgba(255, 255, 255, 0.08); }
.stage { position: relative; line-height: 0; }
.stage.markable { cursor: crosshair; }
.stage img { display: block; image-rendering: pixelated; object-fit: fill; }
.marker { position: absolute; top: 0; bottom: 0; background: var(--mark); box-shadow: 0 0 6px rgba(225, 29, 72, 0.8); pointer-events: none; }
.marker.confirmed { background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.8); }
.tag { position: absolute; top: 6px; left: 6px; line-height: 1; background: inherit; color: #fff; font: 700 12px var(--mono); padding: 4px 7px; border-radius: 6px; white-space: nowrap; }
.cursor { position: absolute; top: 0; bottom: 0; width: 1px; pointer-events: none; }
</style>
