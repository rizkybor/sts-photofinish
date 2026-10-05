<script setup lang="ts">
// Riwayat keputusan Filter objek: pemicu kamera yang diteruskan / diabaikan
// beserta alasannya — operator tahu kenapa sebuah lintasan tidak direkam.
import { computed } from "vue";
import { cameraStatus } from "../lib/cameras";
import { pfAt } from "../lib/clock";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ cameraId: string; limit?: number }>();

/** Nama kelas model (COCO) yang umum terlihat di lokasi lomba. */
const LABEL_ID: Record<string, string> = {
  boat: "perahu", person: "orang", motorcycle: "motor", bicycle: "sepeda", car: "mobil", bird: "burung",
  bench: "bangku", umbrella: "payung", "surfboard": "papan selancar", kite: "layang-layang", dog: "anjing",
};
const translate = (text: string) => text.replace(/\b([a-z][a-z ]*?) (\d\.\d\d)\b/g, (_m, label: string, conf: string) =>
  `${LABEL_ID[label] ?? label} (${Math.round(Number(conf) * 100)}%)`);

const filter = computed(() => cameraStatus(props.cameraId)?.objectFilter ?? null);
const items = computed(() => (filter.value?.recent ?? []).slice(0, props.limit ?? 8));
/**
 * Waktu pemicu dalam jam Photo Finish (terkalibrasi, sama dengan jam di navbar & gambar
 * slit-scan). Waktu pemicu tercatat dengan jam agent → + selisih ke jam server → jam PF.
 */
function fmt(agentNs: number): { text: string; pf: boolean } {
  const offset = cameraStatus(props.cameraId)?.agentOffsetNs;
  const pf = pfAt(BigInt(Math.round(agentNs)) + BigInt(offset ?? "0"));
  if (pf) return { text: pf, pf: true };
  // Jam PF belum dikalibrasi: jam komputer sebagai cadangan, ditandai.
  return { text: new Date(agentNs / 1e6).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), pf: false };
}
</script>

<template>
  <section v-if="filter?.enabled" class="card">
    <div class="section-label">Pemicu kamera (filter objek)</div>
    <p v-if="!items.length" class="muted" style="margin: 0">Belum ada pemicu sejak agent berjalan.</p>
    <ul v-else class="log">
      <li v-for="d in items" :key="d.at" :class="d.ok ? 'ok' : 'skip'">
        <AppIcon :name="d.ok ? 'check' : 'warning'" />
        <div class="grow">
          <div class="head"><strong>{{ d.ok ? "Diteruskan" : "Diabaikan" }}</strong><span class="mono" :title="fmt(d.at).pf ? 'Jam Photo Finish (terkalibrasi)' : 'Jam Photo Finish belum dikalibrasi — jam komputer'">{{ fmt(d.at).text }}<template v-if="!fmt(d.at).pf"> *</template></span></div>
          <span v-if="d.ok">{{ translate(d.seen) }} melintasi garis finish — diteruskan sebagai pemicu finish.</span>
          <span v-else>{{ translate(d.reason ?? `Terlihat: ${d.seen}`) }}</span>
        </div>
      </li>
    </ul>
    <p class="hint" style="margin: 8px 0 0">Pemicu diabaikan tidak membuat rekaman. Sinyal RaceTime2 tetap tercatat dan tetap direkam.</p>
  </section>
</template>

<style scoped>
.log { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.log li { display: flex; gap: 8px; align-items: flex-start; padding: 7px 9px; border-radius: 8px; font-size: 0.82rem; }
.log li.ok { background: var(--ok-bg); color: var(--ok-ink); }
.log li.skip { background: var(--warn-bg); color: var(--warn-ink); }
.log .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.log .head { display: flex; justify-content: space-between; gap: 8px; }
.log .head strong { color: var(--ink); }
.log .mono { font-size: 0.74rem; opacity: 0.8; }
</style>
