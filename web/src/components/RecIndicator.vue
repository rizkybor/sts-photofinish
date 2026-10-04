<script setup lang="ts">
// Tanda kapan kamera BENAR-BENAR merekam finish. `variant="nav"` = lencana
// ringkas di navbar; `variant="banner"` = penjelasan lengkap di halaman.
import { computed } from "vue";
import { lowBattery, recState } from "../lib/cameras";
import AppIcon from "./ui/AppIcon.vue";

const props = withDefaults(defineProps<{ variant?: "nav" | "banner"; cameraId?: string }>(), { variant: "nav" });

const view = computed(() => {
  const st = recState.value;
  switch (st.kind) {
    case "recording":
      return { cls: "rec", label: "REC", short: "REC", title: `Merekam · ${st.cameraId}`,
        detail: `Kamera ${st.cameraId} mengirim gambar (${st.fps.toFixed(0)} fps) dan sesi "${st.sessionLabel}" aktif — setiap sinyal finish direkam.` };
    case "not-recording":
      return { cls: "fail", label: "TIDAK MEREKAM", short: "REC", title: `Sesi aktif, kamera ${st.cameraId} bermasalah`,
        detail: `${st.reason} Sesi "${st.sessionLabel}" aktif, tetapi finish TIDAK akan terekam sampai kamera pulih.` };
    case "standby":
      return { cls: "idle", label: "SIAGA", short: "SIAGA", title: `Kamera hidup · ${st.cameraIds.join(", ")}`,
        detail: "Kamera hidup, tetapi tidak ada sesi yang diaktifkan — sinyal finish tidak direkam. Aktifkan sesi untuk mulai merekam." };
    default:
      return { cls: "off", label: "KAMERA OFF", short: "OFF", title: "Kamera tidak aktif",
        detail: "Tidak ada sesi aktif dan tidak ada kamera yang mengirim gambar." };
  }
});
// Banner di halaman sesi/standby hanya relevan bila menyangkut kamera yang dilihat.
const relevant = computed(() => {
  const st = recState.value;
  // Kondisi normal (merekam/siaga) cukup ditandai lencana REC di navbar.
  if (st.kind !== "not-recording") return false;
  return !props.cameraId || st.cameraId === props.cameraId;
});
</script>

<template>
  <span v-if="variant === 'nav'" class="rec-wrap">
    <span class="rec-nav" :class="view.cls" :title="`${view.label} — ${view.detail}`" role="status"><AppIcon v-if="view.cls === 'fail'" name="warning" /><span v-else class="dot" />{{ view.short }}</span>
    <span v-if="lowBattery" class="rec-nav batt" :title="`Baterai laptop kamera ${lowBattery.cameraId} ${lowBattery.percent}% dan tidak dicas — colokkan charger.`">
      <AppIcon name="warning" /> {{ lowBattery.percent }}%
    </span>
  </span>
  <div v-else-if="relevant" class="rec-banner" :class="view.cls" role="status">
    <span class="rec-mark"><span class="dot" />{{ view.label }}</span>
    <div class="grow">
      <strong>{{ view.title }}</strong>
      <span>{{ view.detail }}</span>
    </div>
    <AppIcon v-if="view.cls === 'fail'" name="warning" size="26" />
  </div>
  <div v-if="variant === 'banner' && lowBattery && (!cameraId || lowBattery.cameraId === cameraId)" class="rec-banner fail" role="alert">
    <span class="rec-mark"><AppIcon name="warning" /> {{ lowBattery.percent }}%</span>
    <div class="grow">
      <strong>Baterai laptop kamera {{ lowBattery.cameraId }} hampir habis</strong>
      <span>Colokkan charger ke laptop agent. Bila laptop mati, kamera dan rekaman ikut mati.</span>
    </div>
  </div>
</template>

<style scoped>
.rec-wrap { display: inline-flex; gap: 6px; align-items: center; }
.rec-nav.batt { background: #fbbf24; color: #451a03; }
.dot { width: 9px; height: 9px; border-radius: 999px; background: currentColor; flex: none; }
.rec .dot, .fail .dot { animation: pulse 1s ease-in-out infinite; }

.rec-nav { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; font: 800 0.74rem/1 var(--mono, monospace); letter-spacing: 0.06em; white-space: nowrap; cursor: help; }
.rec-nav.rec { background: #dc2626; color: #fff; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35); }
.rec-nav.fail { background: #fbbf24; color: #451a03; animation: flash 1s steps(2) infinite; }
.rec-nav.idle { background: rgba(255, 255, 255, 0.14); color: rgba(255, 255, 255, 0.9); }
.rec-nav.off { background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.55); }

.rec-banner { display: flex; align-items: center; gap: 14px; padding: 10px 14px; margin-bottom: 14px; border-radius: 12px; border: 2px solid transparent; }
.rec-banner .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.86rem; }
.rec-banner strong { font-size: 0.98rem; }
.rec-mark { display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 8px; font: 800 0.8rem/1 var(--mono, monospace); letter-spacing: 0.06em; white-space: nowrap; }
.rec-banner.rec { background: var(--bad-bg); border-color: var(--bad); color: var(--bad-ink); }
.rec-banner.rec .rec-mark { background: var(--bad); color: #fff; }
.rec-banner.fail { background: var(--warn-bg); border-color: var(--warn); color: var(--warn-ink); }
.rec-banner.fail .rec-mark { background: var(--warn); color: #fff; }
@keyframes flash { 50% { opacity: 0.55; } }
@media (max-width: 720px) { .rec-nav { padding: 5px 8px; font-size: 0.68rem; } }
</style>
