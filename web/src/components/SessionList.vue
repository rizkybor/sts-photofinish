<script setup lang="ts">
import { computed, ref } from "vue";
import { can } from "../lib/api";
import { category } from "../lib/labels";
import { armedSession, deleteSessionWithConfirm, sessions } from "../lib/sessions";
import type { SessionSummary } from "../lib/types";
import AppIcon from "./ui/AppIcon.vue";

const emit = defineEmits<{ open: [id: string]; create: [] }>();
const query = ref("");
const filter = ref<"all" | "open" | "closed">("open");

const stats = computed(() => {
  const list = sessions.list;
  return {
    total: list.length, open: list.filter((s) => s.status === "open").length, closed: list.filter((s) => s.status === "closed").length,
    armed: armedSession.value, pending: list.filter((s) => s.status === "open").reduce((n, s) => n + s.progress.pending, 0),
  };
});

/** Heat aktif paling atas, lalu heat yang masih punya pekerjaan, lalu terbaru. */
const rank = (s: SessionSummary) => (s.armed ? 0 : s.status === "open" && s.progress.pending ? 1 : 2);
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return sessions.list
    .filter((s) =>
      (filter.value === "all" || s.status === filter.value) &&
      (!q || [s.label, s.eventId, s.eventName ?? "", s.note ?? "", s.heatId ?? "", category(s.raceCategory).label].some((v) => v.toLowerCase().includes(q))))
    .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
});

const fmtDate = (d: string) => new Date(d).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <div class="page-head">
    <div class="grow">
      <h1 class="page-title">Sesi Photo Finish</h1>
      <p class="page-subtitle">Satu sesi terhubung ke satu Event — berlaku untuk kategori apa pun. Aktifkan sesi agar sinyal RaceTime2 masuk.</p>
    </div>
    <button v-if="can('operator')" class="btn btn-primary" @click="emit('create')"><AppIcon name="add" /> Sesi baru</button>
  </div>

  <div class="stat-strip">
    <div class="stat-card" :class="stats.armed ? 'stat-card--success' : 'stat-card--neutral'">
      <span class="stat-card__icon"><AppIcon name="sensors" /></span>
      <div style="min-width: 0">
        <div class="stat-card__value" style="font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ stats.armed?.label ?? "Tidak ada" }}</div>
        <div class="stat-card__label">Sesi aktif (menerima sinyal)</div>
      </div>
    </div>
    <div class="stat-card" :class="stats.pending ? 'stat-card--warning' : ''"><span class="stat-card__icon"><AppIcon name="finish" /></span><div><div class="stat-card__value">{{ stats.pending }}</div><div class="stat-card__label">Finish berdekatan perlu ditinjau ({{ stats.open }} sesi terbuka)</div></div></div>
    <div class="stat-card stat-card--success"><span class="stat-card__icon"><AppIcon name="doneAll" /></span><div><div class="stat-card__value">{{ stats.closed }}</div><div class="stat-card__label">Ditutup</div></div></div>
    <div class="stat-card stat-card--neutral"><span class="stat-card__icon"><AppIcon name="history" /></span><div><div class="stat-card__value">{{ stats.total }}</div><div class="stat-card__label">Total sesi</div></div></div>
  </div>

  <section class="card" style="padding: 0; overflow: hidden">
    <div class="row" style="padding: 16px 16px 14px">
      <div class="input-group" style="flex: 1; min-width: 220px; max-width: 420px">
        <AppIcon name="search" /><input v-model="query" class="input" placeholder="Cari label, event, keterangan…" />
      </div>
      <div class="spacer" />
      <div class="btn-group" role="tablist">
        <button class="btn btn-sm" :class="{ 'is-active': filter === 'open' }" @click="filter = 'open'">Terbuka</button>
        <button class="btn btn-sm" :class="{ 'is-active': filter === 'closed' }" @click="filter = 'closed'">Ditutup</button>
        <button class="btn btn-sm" :class="{ 'is-active': filter === 'all' }" @click="filter = 'all'">Semua</button>
      </div>
    </div>

    <div class="table-wrap" style="border: 0; border-top: 1px solid var(--border); border-radius: 0">
      <table class="table">
        <thead><tr><th class="num">#</th><th>Sesi</th><th>Event</th><th>Status</th><th>Tinjauan</th><th>Dibuat</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(s, i) in shown" :key="s._id" class="clickable" :class="{ 'row-live': s.armed }" @click="emit('open', s._id)">
            <td class="num">{{ i + 1 }}</td>
            <td><strong style="color: var(--ink)">{{ s.label }}</strong><div v-if="s.note" class="note">{{ s.note }}</div><div class="hint">{{ s.heatId ? `${category(s.raceCategory).unit} ${s.heatId}` : "—" }} · {{ s.cameraId }}</div></td>
            <td>
              <span>{{ s.eventName ?? "—" }}</span>
              <div class="hint mono">{{ s.eventId }}</div>
            </td>
            <td>
              <span v-if="s.armed" class="status-pill status-success"><span class="dot" />Aktif</span>
              <span v-else-if="s.status === 'open'" class="status-pill status-neutral"><span class="dot" />Terbuka</span>
              <span v-else class="status-pill status-muted"><span class="dot" />Ditutup</span>
            </td>
            <td>
              <span v-if="s.progress.pending" class="chip chip-warn">{{ s.progress.pending }} berdekatan perlu ditinjau</span>
              <span v-else-if="s.progress.recording" class="chip">Merekam…</span>
              <span v-else-if="s.progress.finishes" class="chip chip-ok"><AppIcon name="verified" /> {{ s.progress.finishes }} finish<template v-if="s.progress.close"> · {{ s.progress.close }} berdekatan</template></span>
              <span v-else class="hint">—</span>
            </td>
            <td class="tnum">{{ fmtDate(s.createdAt) }}</td>
            <td class="row-actions">
              <button
                v-if="can('operator')" class="btn btn-sm btn-ghost del" :title="`Hapus ${s.label}`"
                @click.stop="deleteSessionWithConfirm(s)"
              ><AppIcon name="del" /></button>
              <AppIcon name="chevron" size="20" />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!sessions.loaded" class="empty"><AppIcon name="pending" />Memuat sesi…</div>
      <div v-else-if="!shown.length" class="empty">
        <AppIcon name="finish" />
        <strong>{{ sessions.list.length ? "Tidak ada sesi yang cocok" : "Belum ada sesi" }}</strong>
        <span>{{ can("operator") ? "Buat sesi untuk heat yang akan dimulai." : "Sesi dibuat oleh operator." }}</span>
      </div>
    </div>
  </section>

</template>

<style scoped>
.chip-warn { background: var(--warn-bg); color: var(--warn-ink); }
.chip-ok { background: var(--ok-bg); color: var(--ok-ink); }
.row-live td { background: var(--brand-soft); }
.row-actions { text-align: right; color: var(--faint); white-space: nowrap; }
.row-actions .del { color: var(--bad-ink); opacity: 0; transition: opacity 0.15s; }
tr:hover .row-actions .del, .row-actions .del:focus-visible { opacity: 1; }
@media (hover: none) { .row-actions .del { opacity: 1; } }
.note { font-size: 0.8rem; color: var(--brand-ink); font-weight: 600; }
</style>
