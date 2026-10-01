<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, can } from "../lib/api";
import { getSocket } from "../lib/socket";
import type { Group, SessionDetail } from "../lib/types";
import CrossingRow from "./CrossingRow.vue";
import SlitScanViewer from "./SlitScanViewer.vue";

const props = defineProps<{ sessionId: string }>();
defineEmits<{ back: [] }>();

const detail = ref<SessionDetail | null>(null);
const error = ref("");
const calibrating = ref<string | null>(null); // groupId yang sedang dipakai kalibrasi
const markLane = ref<Record<string, string>>({});
const markTeam = ref<Record<string, string>>({});

const session = computed(() => detail.value?.session);
const groups = computed(() => [...(detail.value?.groups ?? [])].reverse());
const usesLanes = computed(() => (session.value?.lanes.length ?? 0) > 0);

const impulsesOf = (g: Group) => detail.value!.impulses.filter((i) => i.groupId === g._id);
const captureOf = (g: Group) => detail.value!.captures.find((c) => c.groupId === g._id);
const crossingsOf = (g: Group) => detail.value!.crossings.filter((c) => c.groupId === g._id).sort((a, b) => a.rank - b.rank);

async function load() {
  try {
    detail.value = await api<SessionDetail>("GET", `/api/sessions/${props.sessionId}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function run(fn: () => Promise<unknown>) {
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function onMark(g: Group, column: number) {
  const capture = captureOf(g)!;
  if (calibrating.value === g._id) {
    const first = impulsesOf(g)[0];
    if (!first) return void (error.value = "Kalibrasi butuh minimal satu impuls di kelompok ini.");
    calibrating.value = null;
    return run(() => api("POST", `/api/sessions/${props.sessionId}/calibrate`, { captureId: capture._id, column, impulseId: first._id }));
  }
  const nextRank = crossingsOf(g).reduce((m, c) => Math.max(m, c.rank), 0) + 1;
  const lane = markLane.value[g._id] || null;
  run(() => api("POST", "/api/crossings", {
    captureId: capture._id, column, rank: nextRank, lane, teamId: lane ? null : markTeam.value[g._id] || null,
  }));
  markLane.value[g._id] = "";
  markTeam.value[g._id] = "";
}

const socket = getSocket();
const join = () => socket.emit("session:join", props.sessionId);
const EVENTS = ["impulse:new", "group:updated", "capture:ready", "crossing:updated", "session:armed"];
onMounted(() => {
  load();
  join();
  socket.on("connect", join); // gabung ulang room setelah reconnect
  for (const e of EVENTS) socket.on(e, load);
});
onUnmounted(() => {
  socket.off("connect", join);
  for (const e of EVENTS) socket.off(e, load);
});
</script>

<template>
  <button @click="$emit('back')">← Daftar sesi</button>
  <p v-if="error" class="error">{{ error }}</p>

  <template v-if="session">
    <section class="card">
      <div class="row">
        <h2 style="margin: 0; flex: 1">
          {{ session.label }} <span class="badge">{{ session.raceCategory }}</span>
          <span v-if="session.armed" class="badge armed">AKTIF — menerima impuls</span>
        </h2>
        <template v-if="can('operator') && session.status === 'open'">
          <button v-if="!session.armed" class="primary" @click="run(() => api('POST', `/api/sessions/${sessionId}/arm`))">Aktifkan</button>
          <button v-else @click="run(() => api('POST', `/api/sessions/${sessionId}/disarm`))">Nonaktifkan</button>
          <button class="danger" @click="run(() => api('POST', `/api/sessions/${sessionId}/close`))">Tutup sesi</button>
        </template>
      </div>
      <p class="muted">
        Event <span class="mono">{{ session.eventId }}</span> · Kamera {{ session.cameraId }} ·
        Kalibrasi kamera (vs photocell): {{ session.calibratedAt ? `${(Number(session.calibrationOffsetNs) / 1e6).toFixed(1)} ms (${new Date(session.calibratedAt).toLocaleTimeString("id-ID")})` : "belum" }}
      </p>
      <p v-if="usesLanes" class="muted">
        Lintasan: <span v-for="l in session.lanes" :key="l.lane" style="margin-right: 12px">{{ l.lane }} = {{ l.teamName ?? l.teamId }}{{ l.bib ? ` #${l.bib}` : "" }}</span>
      </p>
    </section>

    <p v-if="!groups.length" class="muted">Belum ada impuls finish. Aktifkan sesi, lalu impuls dari RaceTime2 akan muncul di sini.</p>

    <section v-for="g in groups" :key="g._id" class="card">
      <div class="row">
        <strong style="flex: 1">Kelompok finish · {{ new Date(g.createdAt).toLocaleTimeString("id-ID") }}</strong>
        <span class="badge" :class="{ ok: g.status === 'ready' }">{{ g.status }}</span>
      </div>
      <p class="muted">
        Impuls RaceTime2:
        <span v-for="(i, n) in impulsesOf(g)" :key="i._id" class="mono" style="margin-right: 10px">{{ n + 1 }}) {{ i.deviceTime }}</span>
      </p>
      <div v-for="w in g.warnings" :key="w" class="warn-box">{{ w }}</div>

      <template v-if="captureOf(g)">
        <div v-if="can('operator')" class="row" style="margin: 8px 0">
          <span class="muted">Klik haluan perahu sesuai urutan tiba →</span>
          <label v-if="usesLanes">Lintasan
            <select v-model="markLane[g._id]">
              <option value="">—</option>
              <option v-for="l in session.lanes" :key="l.lane" :value="l.lane">{{ l.lane }} · {{ l.teamName ?? l.teamId }}</option>
            </select>
          </label>
          <label v-else>Team ID <input v-model="markTeam[g._id]" style="width: 110px" /></label>
          <button :class="{ primary: calibrating === g._id }" @click="calibrating = calibrating === g._id ? null : g._id">
            {{ calibrating === g._id ? "Klik haluan untuk kalibrasi…" : "Kalibrasi kamera" }}
          </button>
        </div>
        <SlitScanViewer :capture="captureOf(g)!" :crossings="crossingsOf(g)" :can-mark="can('operator')" @mark="onMark(g, $event)" />
      </template>
      <p v-else class="muted">Menunggu rekaman dari Capture Agent…</p>

      <table v-if="crossingsOf(g).length" style="margin-top: 10px">
        <thead><tr><th>Urutan</th><th>Lintasan / tim</th><th>Waktu resmi</th><th>Status</th><th v-if="can('judge')">Konfirmasi juri</th></tr></thead>
        <tbody>
          <CrossingRow v-for="c in crossingsOf(g)" :key="c._id" :crossing="c" :session="session" @changed="load" />
        </tbody>
      </table>
    </section>
  </template>
</template>
