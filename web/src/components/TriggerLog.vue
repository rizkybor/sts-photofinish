<script setup lang="ts">
// Riwayat keputusan Filter objek: pemicu kamera yang diteruskan / diabaikan
// beserta alasannya — operator tahu kenapa sebuah lintasan tidak direkam.
import { computed } from "vue";
import { cameraStatus } from "../lib/cameras";
import { pfAt } from "../lib/clock";
import AppIcon from "./ui/AppIcon.vue";

/** overlay = tampilan layar penuh Standby: gelap transparan, entri baru masuk dari atas. */
const props = defineProps<{ cameraId: string; limit?: number; overlay?: boolean }>();

/** Nama kelas model (COCO) yang umum terlihat di lokasi lomba. */
const LABEL_ID: Record<string, string> = {
  boat: "perahu", person: "orang", motorcycle: "motor", bicycle: "sepeda", car: "mobil", bird: "burung",
  bench: "bangku", umbrella: "payung", "surfboard": "papan selancar", kite: "layang-layang", dog: "anjing",
  bottle: "botol", "potted plant": "pot tanaman", chair: "kursi", truck: "truk", backpack: "ransel", handbag: "tas",
};
const ITEM = /\b([a-z][a-z ]*?) (\d\.\d\d)\b/g;
/**
 * "bottle 0.72, bottle 0.86, person 0.57" → "botol ×2 (72–86%), orang (57%)" — ringkas per jenis,
 * yang paling yakin dulu, supaya daftar panjang tetap terbaca.
 */
function translate(text: string) {
  return text.replace(/(?:\b[a-z][a-z ]*? \d\.\d\d\b(?:, )?)+/g, (list) => {
    const groups = new Map<string, number[]>();
    for (const [, label, conf] of list.matchAll(ITEM)) groups.set(label!, [...(groups.get(label!) ?? []), Math.round(Number(conf) * 100)]);
    const parts = [...groups].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1])).map(([label, confs]) => {
      const name = LABEL_ID[label] ?? label;
      const lo = Math.min(...confs), hi = Math.max(...confs);
      return confs.length > 1 ? `${name} ×${confs.length} (${lo === hi ? `${hi}%` : `${lo}–${hi}%`})` : `${name} (${hi}%)`;
    });
    return parts.join(", ") + (list.endsWith(", ") ? ", " : "");
  });
}

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
  <section v-if="filter?.enabled" :class="overlay ? 'ov' : 'card'">
    <div class="section-label">Pemicu kamera (filter objek)</div>
    <p v-if="!items.length" class="muted" style="margin: 0">Belum ada pemicu sejak agent berjalan.</p>
    <TransitionGroup v-else tag="ul" name="log" class="log">
      <li v-for="d in items" :key="d.at" :class="d.ok ? 'ok' : 'skip'">
        <AppIcon :name="d.ok ? 'check' : 'warning'" />
        <div class="grow">
          <div class="head"><strong>{{ d.ok ? "Diteruskan" : "Diabaikan" }}</strong><span class="mono" :title="fmt(d.at).pf ? 'Jam Photo Finish (terkalibrasi)' : 'Jam Photo Finish belum dikalibrasi — jam komputer'">{{ fmt(d.at).text }}<template v-if="!fmt(d.at).pf"> *</template></span></div>
          <span v-if="d.ok">{{ translate(d.seen) }} melintasi garis finish — diteruskan sebagai pemicu finish.</span>
          <span v-else>{{ translate(d.reason ?? `Terlihat: ${d.seen}`) }}</span>
        </div>
      </li>
    </TransitionGroup>
    <p v-if="!overlay" class="hint" style="margin: 8px 0 0">Pemicu diabaikan tidak membuat rekaman. Sinyal RaceTime2 tetap tercatat dan tetap direkam.</p>
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
.log-enter-from { opacity: 0; transform: translateY(-8px); }
.log-enter-active { transition: opacity 0.3s, transform 0.3s; }
/* Layar penuh: kartu gelap transparan di atas gambar kamera. */
.ov .section-label { color: rgba(255, 255, 255, 0.75); margin-bottom: 6px; }
.ov .muted { color: rgba(255, 255, 255, 0.7); }
.ov .log li { background: rgba(15, 23, 42, 0.72); backdrop-filter: blur(6px); color: rgba(255, 255, 255, 0.9); border-left: 3px solid; }
.ov .log li.ok { border-color: var(--ok); }
.ov .log li.skip { border-color: var(--warn); }
.ov .log .head strong { color: #fff; }
</style>
