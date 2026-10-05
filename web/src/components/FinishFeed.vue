<script setup lang="ts">
// Feed "Finish terakhir" untuk operator yang standby di kamera: finish satu
// perahu cukup tercatat; finish berdekatan ditandai dan bisa langsung ditinjau.
import { pfAt } from "../lib/clock";
import { fmtGap, fmtTime, prefs, sessions } from "../lib/sessions";
import type { FinishEvent } from "../lib/types";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ overlay?: boolean; limit?: number }>();
const emit = defineEmits<{ review: [f: FinishEvent] }>();

/** Jam Photo Finish (terkalibrasi) — sama dengan jam di navbar; cadangan jam komputer. */
function when(f: FinishEvent) {
  return pfAt(BigInt(Date.parse(f.createdAt)) * 1_000_000n)?.slice(0, 8) ?? fmtTime(f.createdAt);
}

function state(f: FinishEvent) {
  if (f.status !== "ready") return { cls: "rec", text: "Merekam…" };
  if (f.needsReview) return { cls: "todo", text: "Perlu ditinjau" };
  if (f.resolved) return { cls: "done", text: "Sudah ditinjau" };
  return { cls: "ok", text: "Tercatat" };
}
</script>

<template>
  <section class="feed" :class="overlay ? 'ov' : 'card'">
    <div class="feed-head">
      <div class="section-label" style="margin: 0">Finish terakhir</div>
      <label v-if="!overlay" class="sound" title="Bunyi saat ada finish berdekatan"><input v-model="prefs.sound" type="checkbox" /><AppIcon :name="prefs.sound ? 'volume' : 'volumeOff'" /></label>
    </div>
    <ul v-if="sessions.feed.length" class="list">
      <li v-for="f in sessions.feed.slice(0, props.limit ?? 10)" :key="f.groupId" :class="state(f).cls">
        <span class="time mono">{{ when(f) }}</span>
        <span class="what">
          <strong>{{ f.boats > 1 ? `${f.boats} perahu berdekatan` : f.boats === 1 ? "1 perahu" : "Pemicu" }}</strong>
          <span v-if="f.close && f.gapMs !== null" class="gap">selisih {{ fmtGap(f.gapMs) }}</span>
          <span class="where">{{ f.sessionLabel }}</span>
        </span>
        <button v-if="f.close" class="btn btn-sm" :class="f.needsReview ? 'btn-warn' : 'btn-ghost'" @click="emit('review', f)">
          {{ f.needsReview ? "Tinjau" : "Lihat" }}
        </button>
        <span v-else class="tag">{{ state(f).text }}</span>
      </li>
    </ul>
    <p v-else class="hint" style="margin: 8px 0 0">Belum ada finish di sesi terbuka.</p>
    <p v-if="!overlay" class="hint" style="margin: 10px 0 0">Finish satu perahu tidak perlu ditinjau — waktu resmi dari RaceTime2. Tinjau hanya bila <strong>berdekatan</strong>.</p>
  </section>
</template>

<style scoped>
.feed-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.sound { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: var(--muted); font-size: 18px; }
.sound input { display: none; }
.list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.list li { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--surface-3); background: var(--surface-2); }
.list li.todo { background: var(--warn-bg); border-color: var(--warn-line); }
.list li.rec { opacity: 0.75; }
.time { font-size: 0.8rem; color: var(--muted); flex: none; }
.what { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.what strong { font-size: 0.86rem; color: var(--ink); }
.list li.todo .what strong { color: var(--warn-ink); }
.gap { font-size: 0.76rem; color: var(--warn-ink); font-weight: 600; }
.where { font-size: 0.74rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { font-size: 0.74rem; color: var(--muted); white-space: nowrap; }
.list li.done .tag, .list li.ok .tag { color: var(--ok-ink); }
.btn-warn { background: var(--warn); border-color: var(--warn); color: #fff; }
/* Layar penuh: kartu gelap transparan di atas gambar kamera. */
.ov .section-label { color: rgba(255, 255, 255, 0.75); }
.ov .hint { color: rgba(255, 255, 255, 0.7); }
.ov .list li { background: rgba(15, 23, 42, 0.72); backdrop-filter: blur(6px); border-color: transparent; }
.ov .list li.todo { background: rgba(245, 158, 11, 0.35); border-color: var(--warn); }
.ov .time, .ov .where, .ov .tag { color: rgba(255, 255, 255, 0.7); }
.ov .what strong, .ov .list li.todo .what strong { color: #fff; }
.ov .gap { color: #fde68a; }
.ov .list li.done .tag, .ov .list li.ok .tag { color: #6ee7b7; }
</style>
