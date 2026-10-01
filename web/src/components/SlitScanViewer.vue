<script setup lang="ts">
// Gambar slit-scan: sumbu horizontal = waktu (kiri lebih awal). Juri mengklik
// haluan perahu; posisi klik → indeks kolom = frame tempat haluan menyentuh garis.
import { computed, ref, watch } from "vue";
import type { Capture, Crossing } from "../lib/types";

const props = defineProps<{ capture: Capture; crossings: Crossing[]; canMark: boolean }>();
const emit = defineEmits<{ mark: [column: number] }>();

const zoom = ref(2);
// Waktu Photo Finish per kolom, terekam oleh agent saat rekaman dibuat.
const pfTimes = ref<string[] | null>(null);
watch(() => props.capture.columnsUrl, async (url) => {
  try {
    pfTimes.value = ((await (await fetch(url)).json()) as { pfTimes?: string[] | null }).pfTimes ?? null;
  } catch {
    pfTimes.value = null;
  }
}, { immediate: true });
const hover = ref<number | null>(null);
const displayWidth = computed(() => props.capture.width * zoom.value);
const msPerColumn = computed(() => (props.capture.fps > 0 ? 1000 / props.capture.fps : 0));

function columnAt(ev: MouseEvent): number {
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  return Math.min(props.capture.width - 1, Math.max(0, Math.floor((ev.clientX - rect.left) / zoom.value)));
}
</script>

<template>
  <div>
    <div class="row muted" style="margin-bottom: 6px">
      <span>{{ capture.cameraId }} · {{ capture.width }} kolom · {{ capture.fps }} fps (≈{{ msPerColumn.toFixed(1) }} ms/kolom)</span>
      <label>Zoom <input v-model.number="zoom" type="range" min="1" max="8" step="1" /> {{ zoom }}×</label>
      <span v-if="hover !== null" class="mono">
        kolom {{ hover }} · {{ pfTimes?.[hover] ? `jam PF ${pfTimes[hover]}` : `+${(hover * msPerColumn).toFixed(1)} ms` }}
      </span>
    </div>
    <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 6px">
      <div
        :style="{ position: 'relative', width: displayWidth + 'px', cursor: canMark ? 'crosshair' : 'default' }"
        @mousemove="hover = columnAt($event)"
        @mouseleave="hover = null"
        @click="canMark && emit('mark', columnAt($event))"
      >
        <img
          :src="capture.url"
          :width="displayWidth"
          :height="capture.height * zoom"
          style="display: block; image-rendering: pixelated; max-height: 70vh; width: auto"
          :style="{ width: displayWidth + 'px', height: 'auto' }"
          alt="Slit-scan garis finish"
          draggable="false"
        />
        <div
          v-for="c in crossings"
          :key="c._id"
          :style="{ position: 'absolute', top: 0, bottom: 0, left: c.column * zoom + 'px', width: Math.max(1, zoom) + 'px', background: 'var(--mark)' }"
        >
          <span style="position: absolute; top: 2px; left: 4px; background: var(--mark); color: #fff; font-size: 12px; padding: 0 5px; border-radius: 4px">
            {{ c.rank }}{{ c.lane ? ` · ${c.lane}` : "" }}
          </span>
        </div>
        <div v-if="hover !== null" :style="{ position: 'absolute', top: 0, bottom: 0, left: hover * zoom + 'px', width: '1px', background: 'var(--accent)', pointerEvents: 'none' }" />
      </div>
    </div>
  </div>
</template>
