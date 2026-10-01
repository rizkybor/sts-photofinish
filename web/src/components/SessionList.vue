<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, can } from "../lib/api";
import type { Lane, RaceCategory, Session } from "../lib/types";
import { toast } from "../lib/ui";
import { CATEGORY } from "../lib/labels";
import AppIcon from "./ui/AppIcon.vue";
import Modal from "./ui/Modal.vue";

const emit = defineEmits<{ open: [id: string] }>();
const sessions = ref<Session[]>([]);
const loading = ref(true);
const query = ref("");
const filter = ref<"all" | "open" | "closed">("open");

const stats = computed(() => {
  const list = sessions.value;
  const armed = list.find((s) => s.armed);
  return { total: list.length, open: list.filter((s) => s.status === "open").length, closed: list.filter((s) => s.status === "closed").length, armed };
});

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return sessions.value.filter((s) =>
    (filter.value === "all" || s.status === filter.value) &&
    (!q || [s.label, s.eventId, s.heatId ?? "", CATEGORY[s.raceCategory].label].some((v) => v.toLowerCase().includes(q))));
});

async function load() {
  loading.value = true;
  try {
    sessions.value = await api<Session[]>("GET", "/api/sessions");
  } catch (e) {
    toast("error", "Gagal memuat sesi", (e as Error).message);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ---------------------------------------------------------------- sesi baru
const creating = ref(false);
const busy = ref(false);
const bucket = reactive({ divisionId: "", raceId: "", initialId: "" });
const form = reactive({ eventId: "", raceCategory: "H2H" as RaceCategory, heatId: "", label: "", cameraId: "cam-1", lanes: [] as Lane[] });

function resetLanes() {
  form.lanes = Array.from({ length: CATEGORY[form.raceCategory].lanes }, (_, i) => ({
    lane: CATEGORY[form.raceCategory].lanes === 4 ? String(i + 1) : String.fromCharCode(65 + i),
    teamId: "", bib: null, teamName: null, crewExpected: null,
  }));
}
function openCreate() {
  resetLanes();
  creating.value = true;
}

const bucketComplete = computed(() => !!(bucket.divisionId && bucket.raceId && bucket.initialId));

async function create() {
  busy.value = true;
  try {
    const s = await api<Session>("POST", "/api/sessions", {
      ...form, heatId: form.heatId || null, lanes: form.lanes.filter((l) => l.teamId),
      bucket: bucketComplete.value ? { ...bucket } : null,
    });
    toast("success", "Sesi dibuat", s.label);
    creating.value = false;
    emit("open", s._id);
  } catch (e) {
    toast("error", "Gagal membuat sesi", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

const fmtDate = (d: string) => new Date(d).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <div class="page-head">
    <div class="grow">
      <h1 class="page-title">Sesi Photo Finish</h1>
      <p class="page-subtitle">Satu sesi = satu heat / run di garis finish. Aktifkan sesi agar impuls RaceTime2 masuk.</p>
    </div>
    <button v-if="can('operator')" class="btn btn-primary" @click="openCreate"><AppIcon name="add" /> Sesi baru</button>
  </div>

  <div class="stat-strip">
    <div class="stat-card" :class="stats.armed ? 'stat-card--danger' : 'stat-card--neutral'">
      <span class="stat-card__icon"><AppIcon name="sensors" /></span>
      <div style="min-width: 0">
        <div class="stat-card__value" style="font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ stats.armed?.label ?? "Tidak ada" }}</div>
        <div class="stat-card__label">Sesi aktif (menerima impuls)</div>
      </div>
    </div>
    <div class="stat-card"><span class="stat-card__icon"><AppIcon name="finish" /></span><div><div class="stat-card__value">{{ stats.open }}</div><div class="stat-card__label">Terbuka</div></div></div>
    <div class="stat-card stat-card--success"><span class="stat-card__icon"><AppIcon name="doneAll" /></span><div><div class="stat-card__value">{{ stats.closed }}</div><div class="stat-card__label">Ditutup</div></div></div>
    <div class="stat-card stat-card--neutral"><span class="stat-card__icon"><AppIcon name="history" /></span><div><div class="stat-card__value">{{ stats.total }}</div><div class="stat-card__label">Total sesi</div></div></div>
  </div>

  <section class="card" style="padding: 0; overflow: hidden">
    <div class="row" style="padding: 16px 16px 14px">
      <div class="input-group" style="flex: 1; min-width: 220px; max-width: 420px">
        <AppIcon name="search" /><input v-model="query" class="input" placeholder="Cari label, event, heat, format…" />
      </div>
      <div class="spacer" />
      <div class="btn-group" role="tablist">
        <button class="btn btn-sm" :class="{ 'is-active': filter === 'open' }" @click="filter = 'open'">Terbuka</button>
        <button class="btn btn-sm" :class="{ 'is-active': filter === 'closed' }" @click="filter = 'closed'">Ditutup</button>
        <button class="btn btn-sm" :class="{ 'is-active': filter === 'all' }" @click="filter = 'all'">Semua</button>
      </div>
      <button class="btn btn-sm btn-ghost" title="Muat ulang" @click="load"><AppIcon name="refresh" /></button>
    </div>

    <div class="table-wrap" style="border: 0; border-top: 1px solid var(--border); border-radius: 0">
      <table class="table">
        <thead><tr><th class="num">#</th><th>Sesi</th><th>Format</th><th>Event / Kategori</th><th>Status</th><th>Dibuat</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(s, i) in shown" :key="s._id" class="clickable" @click="emit('open', s._id)">
            <td class="num">{{ i + 1 }}</td>
            <td><strong style="color: var(--ink)">{{ s.label }}</strong><div class="hint">{{ s.heatId ? `Heat ${s.heatId}` : "—" }} · {{ s.cameraId }}</div></td>
            <td><span class="chip chip-brand">{{ CATEGORY[s.raceCategory].label }}</span></td>
            <td>
              <span class="mono">{{ s.eventId }}</span>
              <div v-if="s.bucket" class="hint mono">{{ s.bucket.divisionId }} · {{ s.bucket.raceId }} · {{ s.bucket.initialId }}</div>
              <div v-else class="hint" style="color: var(--warn-ink)">Kategori belum ditautkan</div>
            </td>
            <td>
              <span v-if="s.armed" class="status-pill status-live"><span class="dot" />AKTIF</span>
              <span v-else-if="s.status === 'open'" class="status-pill status-neutral"><span class="dot" />Terbuka</span>
              <span v-else class="status-pill status-muted"><span class="dot" />Ditutup</span>
            </td>
            <td class="tnum">{{ fmtDate(s.createdAt) }}</td>
            <td style="text-align: right; color: var(--faint)"><AppIcon name="chevron" size="20" /></td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="empty"><AppIcon name="pending" />Memuat sesi…</div>
      <div v-else-if="!shown.length" class="empty">
        <AppIcon name="finish" />
        <strong>{{ sessions.length ? "Tidak ada sesi yang cocok" : "Belum ada sesi" }}</strong>
        <span>{{ can("operator") ? "Buat sesi untuk heat yang akan dimulai." : "Sesi dibuat oleh operator." }}</span>
      </div>
    </div>
  </section>

  <Modal :open="creating" title="Sesi photo finish baru" subtitle="Isi sesuai heat di sts-timingsystem agar hasil masuk ke kategori yang benar." :width="720" @close="creating = false">
    <form id="create-session" @submit.prevent="create">
      <div class="section-label">Heat</div>
      <div class="grid-2">
        <label class="field"><span class="field-label">Label sesi</span><input v-model="form.label" class="input" required placeholder="H2H R6 Putra — Heat 3" /></label>
        <label class="field">
          <span class="field-label">Format lomba</span>
          <select v-model="form.raceCategory" class="input" @change="resetLanes">
            <option v-for="(c, key) in CATEGORY" :key="key" :value="key">{{ c.label }}</option>
          </select>
        </label>
        <label class="field"><span class="field-label">Event ID</span><input v-model="form.eventId" class="input mono" required /></label>
        <div class="grid-2" style="gap: 10px">
          <label class="field"><span class="field-label">Heat</span><input v-model="form.heatId" class="input" placeholder="opsional" /></label>
          <label class="field"><span class="field-label">Kamera</span><input v-model="form.cameraId" class="input mono" required /></label>
        </div>
      </div>

      <div class="section-label" style="margin-top: 20px">Kategori sts-timingsystem</div>
      <div class="grid-3">
        <label class="field"><span class="field-label">Division ID</span><input v-model="bucket.divisionId" class="input mono" /></label>
        <label class="field"><span class="field-label">Race ID</span><input v-model="bucket.raceId" class="input mono" /></label>
        <label class="field"><span class="field-label">Initial ID</span><input v-model="bucket.initialId" class="input mono" /></label>
      </div>
      <div v-if="!bucketComplete" class="alert alert-warn"><AppIcon name="warning" />Tanpa ketiga ID ini, hasil tidak diterapkan otomatis di timing system (aturan Event + Division + Race + Initial).</div>

      <template v-if="form.lanes.length">
        <div class="section-label" style="margin-top: 20px">Lintasan</div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th class="num">Lin.</th><th>Team ID</th><th>BIB</th><th>Nama tim</th><th>Awak</th></tr></thead>
            <tbody>
              <tr v-for="l in form.lanes" :key="l.lane">
                <td class="num">{{ l.lane }}</td>
                <td><input v-model="l.teamId" class="input input-sm mono" /></td>
                <td><input v-model="l.bib" class="input input-sm mono" style="width: 80px" /></td>
                <td><input v-model="l.teamName" class="input input-sm" /></td>
                <td><input v-model.number="l.crewExpected" class="input input-sm" type="number" min="1" max="12" style="width: 70px" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="hint" style="margin-top: 16px">{{ CATEGORY[form.raceCategory].label }}: tim dipilih saat menandai perahu, tidak perlu lintasan.</p>
    </form>
    <template #footer>
      <button class="btn" @click="creating = false">Batal</button>
      <button class="btn btn-primary" type="submit" form="create-session" :disabled="busy"><AppIcon name="add" /> Buat sesi</button>
    </template>
  </Modal>
</template>
