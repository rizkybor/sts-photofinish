<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api, can } from "../lib/api";
import type { Lane, RaceCategory, Session } from "../lib/types";

const emit = defineEmits<{ open: [id: string] }>();
const sessions = ref<Session[]>([]);
const error = ref("");

const LANES_BY_CATEGORY: Record<RaceCategory, number> = { H2H: 2, RX: 4, DRR: 0, SPRINT: 0, SLALOM: 0 };
const bucket = reactive({ divisionId: "", raceId: "", initialId: "" });
const form = reactive({ eventId: "", raceCategory: "H2H" as RaceCategory, heatId: "", label: "", cameraId: "cam-1", lanes: [] as Lane[] });

function resetLanes() {
  form.lanes = Array.from({ length: LANES_BY_CATEGORY[form.raceCategory] }, (_, i) => ({
    lane: String.fromCharCode(65 + i), teamId: "", bib: null, teamName: null, crewExpected: null,
  }));
}
resetLanes();

async function load() {
  try {
    sessions.value = await api<Session[]>("GET", "/api/sessions");
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function create() {
  error.value = "";
  try {
    const s = await api<Session>("POST", "/api/sessions", {
      ...form, heatId: form.heatId || null, lanes: form.lanes.filter((l) => l.teamId),
      bucket: bucket.divisionId && bucket.raceId && bucket.initialId ? { ...bucket } : null,
    });
    emit("open", s._id);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(load);
</script>

<template>
  <section v-if="can('operator')" class="card">
    <h2 style="margin-top: 0">Sesi baru</h2>
    <form class="row" @submit.prevent="create">
      <label>Event ID <input v-model="form.eventId" required /></label>
      <label>Format
        <select v-model="form.raceCategory" @change="resetLanes">
          <option value="H2H">H2H</option><option value="RX">Rafting Cross</option><option value="DRR">DRR</option>
          <option value="SPRINT">Sprint</option><option value="SLALOM">Slalom</option>
        </select>
      </label>
      <label>Division ID <input v-model="bucket.divisionId" /></label>
      <label>Race ID <input v-model="bucket.raceId" /></label>
      <label>Initial ID <input v-model="bucket.initialId" /></label>
      <label>Heat <input v-model="form.heatId" placeholder="opsional" /></label>
      <label>Label <input v-model="form.label" required placeholder="mis. H2H R6 Putra — Heat 3" /></label>
      <label>Kamera <input v-model="form.cameraId" required style="width: 90px" /></label>
      <table v-if="form.lanes.length" style="margin-top: 8px">
        <thead><tr><th>Lintasan</th><th>Team ID</th><th>BIB</th><th>Nama tim</th><th>Jumlah awak</th></tr></thead>
        <tbody>
          <tr v-for="l in form.lanes" :key="l.lane">
            <td>{{ l.lane }}</td>
            <td><input v-model="l.teamId" /></td>
            <td><input v-model="l.bib" style="width: 70px" /></td>
            <td><input v-model="l.teamName" /></td>
            <td><input v-model.number="l.crewExpected" type="number" min="1" max="12" /></td>
          </tr>
        </tbody>
      </table>
      <button class="primary">Buat sesi</button>
    </form>
    <p class="muted">
      Division/Race/Initial ID wajib agar hasil otomatis masuk ke kategori yang benar di sts-timingsystem.
      DRR: tim dipilih saat menandai perahu, tidak perlu lintasan.
    </p>
  </section>

  <section class="card">
    <h2 style="margin-top: 0">Sesi</h2>
    <p v-if="error" class="error">{{ error }}</p>
    <table>
      <thead><tr><th>Label</th><th>Format</th><th>Event</th><th>Status</th><th>Dibuat</th></tr></thead>
      <tbody>
        <tr v-for="s in sessions" :key="s._id" style="cursor: pointer" @click="emit('open', s._id)">
          <td>{{ s.label }}</td>
          <td>{{ s.raceCategory }}</td>
          <td class="mono">{{ s.eventId }}</td>
          <td><span v-if="s.armed" class="badge armed">AKTIF</span> <span class="badge">{{ s.status }}</span></td>
          <td class="muted">{{ new Date(s.createdAt).toLocaleString("id-ID") }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
