<script setup lang="ts">
// Bar heat: selalu terlihat di bawah navbar (juga di Standby Kamera). Heat
// aktif, heat berikutnya dalam satu tombol, dan heat yang masih punya finish
// berdekatan belum ditinjau — tanpa kembali ke daftar sesi.
import { computed } from "vue";
import { can } from "../lib/api";
import { armedSession, pendingSessions, sessions } from "../lib/sessions";
import type { SessionSummary } from "../lib/types";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ currentId: string | null }>();
const emit = defineEmits<{ open: [id: string, groupId?: string]; next: [] }>();

/** Chip backlog langsung membuka finish berdekatan pertama yang belum ditinjau. */
function openTodo(s: SessionSummary) {
  const f = [...sessions.feed].reverse().find((x) => x.sessionId === s._id && x.needsReview);
  emit("open", s._id, f?.groupId);
}

const backlog = computed(() => pendingSessions.value.filter((s) => !s.armed).slice(0, 6));
const moreBacklog = computed(() => Math.max(0, pendingSessions.value.filter((s) => !s.armed).length - backlog.value.length));

function workText(s: SessionSummary) {
  const p = s.progress;
  const parts = [`${p.finishes} finish`];
  if (p.close) parts.push(`${p.close} berdekatan`);
  if (p.pending) parts.push(`${p.pending} perlu ditinjau`);
  if (p.recording) parts.push(`${p.recording} merekam`);
  return parts.join(" · ");
}
</script>

<template>
  <div v-if="sessions.loaded" class="heatbar">
    <div class="heatbar-inner">
      <button
        v-if="armedSession && armedSession._id !== currentId" class="live"
        :title="`Buka detail sesi aktif (A) — ${workText(armedSession)}`" @click="emit('open', armedSession._id)"
      >
        <span class="live-dot" />
        <span class="live-tag">AKTIF</span>
        <span class="live-label">{{ armedSession.label }}</span>
        <span class="live-meta">{{ armedSession.progress.finishes }} finish<template v-if="armedSession.progress.pending"> · {{ armedSession.progress.pending }} perlu ditinjau</template></span>
        <kbd>A</kbd>
      </button>
      <span v-else-if="!armedSession" class="idle"><AppIcon name="sensors" /> Tidak ada sesi aktif — sinyal RaceTime2 masuk ke daftar "tanpa sesi"</span>

      <div v-if="backlog.length" class="backlog">
        <span class="backlog-title">Berdekatan belum ditinjau</span>
        <button
          v-for="s in backlog" :key="s._id" class="todo" :class="{ current: s._id === currentId }"
          :title="workText(s)" @click="openTodo(s)"
        >
          <span class="todo-label">{{ s.label }}</span>
          <span class="todo-count">{{ s.progress.pending }}</span>
        </button>
        <span v-if="moreBacklog" class="hint">+{{ moreBacklog }}</span>
      </div>

      <span class="spacer" />
      <button v-if="can('operator')" class="btn btn-sm btn-primary" title="Sesi baru untuk Event yang sama & langsung aktifkan (N)" @click="emit('next')">
        <AppIcon name="skipNext" /> {{ sessions.list.some((s) => s.status === "open") ? "Sesi berikutnya" : "Sesi baru" }} <kbd>N</kbd>
      </button>
    </div>
  </div>
</template>

<style scoped>
.heatbar { position: sticky; top: var(--nav-h); z-index: 900; background: var(--surface); border-bottom: 1px solid var(--border); box-shadow: var(--shadow-sm); }
.heatbar-inner { max-width: 1280px; margin: 0 auto; padding: 8px 16px; display: flex; align-items: center; gap: 12px; min-height: 52px; }
.live { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 9px; padding: 6px 12px; border-radius: 10px; background: var(--brand-soft); border: 1px solid transparent; color: var(--brand-ink); min-width: 0; max-width: 46%; }
.live:hover { border-color: var(--brand-2); }
.live-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--ok); flex: none; }
.live-tag { font-weight: 800; font-size: 0.72rem; letter-spacing: 0.06em; }
.live-label { font-weight: 800; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.live-meta { font-size: 0.8rem; white-space: nowrap; }
.idle { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 0.86rem; }
.backlog { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.backlog-title { font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--warn-ink); white-space: nowrap; }
.todo { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; border-radius: 999px; background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink); font-size: 0.8rem; font-weight: 600; max-width: 200px; }
.todo:hover { border-color: var(--warn); }
.todo.current { box-shadow: inset 0 0 0 2px var(--warn); }
.todo-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.todo-count { flex: none; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--warn); color: #fff; font-weight: 800; font-size: 0.74rem; display: grid; place-items: center; }
.spacer { flex: 1; }
kbd { font: 700 0.7rem var(--mono); padding: 1px 6px; border-radius: 5px; border: 1px solid currentColor; opacity: 0.75; }
.btn kbd { margin-left: 2px; }
@media (max-width: 900px) {
  .heatbar-inner { flex-wrap: wrap; gap: 8px; }
  .live { max-width: 100%; }
  .backlog { order: 3; width: 100%; overflow-x: auto; }
  .live-meta, kbd { display: none; }
}
</style>
