<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, can } from "../lib/api";
import { CATEGORY } from "../lib/labels";
import { getSocket } from "../lib/socket";
import type { Crossing, Group, SessionDetail } from "../lib/types";
import { attempt, confirmDialog, toast } from "../lib/ui";
import CrossingConfirmModal from "./CrossingConfirmModal.vue";
import GroupCard from "./GroupCard.vue";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ back: [] }>();

const detail = ref<SessionDetail | null>(null);
const confirming = ref<Crossing | null>(null);

const session = computed(() => detail.value?.session);
const groups = computed(() => [...(detail.value?.groups ?? [])].reverse());
const impulsesOf = (g: Group) => detail.value!.impulses.filter((i) => i.groupId === g._id);
const captureOf = (g: Group) => detail.value!.captures.find((c) => c.groupId === g._id);
const crossingsOf = (g: Group) => detail.value!.crossings.filter((c) => c.groupId === g._id).sort((a, b) => a.rank - b.rank);

const stats = computed(() => {
  const d = detail.value;
  if (!d) return null;
  const confirmed = d.crossings.filter((c) => c.status === "confirmed").length;
  const cal = d.session.calibratedAt ? `${(Number(d.session.calibrationOffsetNs) / 1e6).toFixed(1)} ms` : "Belum";
  return { impulses: d.impulses.length, groups: d.groups.length, confirmed, crossings: d.crossings.length, cal };
});

async function load() {
  try {
    detail.value = await api<SessionDetail>("GET", `/api/sessions/${props.sessionId}`);
  } catch (e) {
    toast("error", "Gagal memuat sesi", (e as Error).message);
  }
}

async function setArmed(armed: boolean) {
  if (await attempt(() => api("POST", `/api/sessions/${props.sessionId}/${armed ? "arm" : "disarm"}`), armed ? "Sesi aktif — impuls RaceTime2 masuk ke sesi ini" : "Sesi dinonaktifkan")) load();
}

async function closeSession() {
  const ok = await confirmDialog({
    title: "Tutup sesi?", danger: true, okText: "Tutup sesi",
    text: "Sesi yang ditutup tidak menerima impuls dan hasilnya tidak bisa diubah lagi. Pastikan semua hasil sudah dikonfirmasi juri.",
  });
  if (ok && (await attempt(() => api("POST", `/api/sessions/${props.sessionId}/close`), "Sesi ditutup"))) load();
}

const socket = getSocket();
const join = () => socket.emit("session:join", props.sessionId);
const EVENTS = ["impulse:new", "group:updated", "capture:ready", "crossing:updated", "session:armed"];
onMounted(() => {
  load();
  join();
  socket.on("connect", join);
  for (const e of EVENTS) socket.on(e, load);
});
onUnmounted(() => {
  socket.off("connect", join);
  for (const e of EVENTS) socket.off(e, load);
});
</script>

<template>
  <template v-if="session && stats">
    <div class="crumbs"><button @click="emit('back')">Sesi Lomba</button><AppIcon name="chevron" /><span>{{ session.label }}</span></div>
    <div class="page-head">
      <div class="grow">
        <h1 class="page-title">{{ session.label }}</h1>
        <div class="row" style="margin-top: 8px">
          <span class="chip chip-brand">{{ CATEGORY[session.raceCategory].label }}</span>
          <span v-if="session.heatId" class="chip">Heat {{ session.heatId }}</span>
          <span class="chip mono">Event {{ session.eventId }}</span>
          <span class="chip"><AppIcon name="camera" /> {{ session.cameraId }}</span>
          <span v-if="session.armed" class="status-pill status-live"><span class="dot" />AKTIF — menerima impuls</span>
          <span v-else-if="session.status === 'open'" class="status-pill status-neutral"><span class="dot" />Terbuka</span>
          <span v-else class="status-pill status-muted"><span class="dot" />Ditutup</span>
        </div>
      </div>
      <div v-if="can('operator') && session.status === 'open'" class="row">
        <button v-if="!session.armed" class="btn btn-success" @click="setArmed(true)"><AppIcon name="play" /> Aktifkan</button>
        <button v-else class="btn" @click="setArmed(false)"><AppIcon name="stop" /> Nonaktifkan</button>
        <button class="btn btn-danger" @click="closeSession"><AppIcon name="lock" /> Tutup sesi</button>
      </div>
    </div>

    <div v-if="!session.bucket" class="alert alert-warn" style="margin: 0 0 16px">
      <AppIcon name="warning" /><span>Sesi belum ditautkan ke Division / Race / Initial — hasil <strong>tidak</strong> diterapkan otomatis di sts-timingsystem.</span>
    </div>

    <div class="stat-strip">
      <div class="stat-card"><span class="stat-card__icon"><AppIcon name="sensors" /></span><div><div class="stat-card__value">{{ stats.impulses }}</div><div class="stat-card__label">Impuls masuk</div></div></div>
      <div class="stat-card stat-card--neutral"><span class="stat-card__icon"><AppIcon name="finish" /></span><div><div class="stat-card__value">{{ stats.groups }}</div><div class="stat-card__label">Kelompok finish</div></div></div>
      <div class="stat-card stat-card--success"><span class="stat-card__icon"><AppIcon name="verified" /></span><div><div class="stat-card__value">{{ stats.confirmed }}<span class="hint" style="font-size: 0.9rem"> / {{ stats.crossings }}</span></div><div class="stat-card__label">Hasil dikonfirmasi</div></div></div>
      <div class="stat-card" :class="session.calibratedAt ? 'stat-card--success' : 'stat-card--warning'"><span class="stat-card__icon"><AppIcon name="target" /></span><div><div class="stat-card__value">{{ stats.cal }}</div><div class="stat-card__label">Kalibrasi kamera</div></div></div>
    </div>

    <section v-if="session.lanes.length" class="card" style="padding: 14px 20px">
      <div class="row">
        <span class="section-label" style="margin: 0">Lintasan</span>
        <span v-for="l in session.lanes" :key="l.lane" class="lane"><span class="lane-id">{{ l.lane }}</span>{{ l.teamName ?? l.teamId }}<span v-if="l.bib" class="hint">#{{ l.bib }}</span></span>
        <span class="spacer" />
        <span v-if="session.bucket" class="hint mono">{{ session.bucket.divisionId }} · {{ session.bucket.raceId }} · {{ session.bucket.initialId }}</span>
      </div>
    </section>

    <div v-if="!groups.length" class="card empty">
      <AppIcon name="sensors" />
      <strong>Belum ada impuls finish</strong>
      <span>{{ session.armed ? "Sesi aktif. Impuls dari RaceTime2 akan muncul di sini secara langsung." : "Aktifkan sesi agar impuls RaceTime2 masuk ke sesi ini." }}</span>
    </div>

    <GroupCard
      v-for="(g, i) in groups" :key="g._id" :group="g" :index="groups.length - i" :session="session"
      :impulses="impulsesOf(g)" :capture="captureOf(g)" :crossings="crossingsOf(g)"
      @changed="load" @confirm="confirming = $event"
    />

    <CrossingConfirmModal :crossing="confirming" :session="session" @close="confirming = null" @saved="load" />
  </template>
  <div v-else class="empty"><AppIcon name="pending" />Memuat sesi…</div>
</template>

<style scoped>
.lane { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--ink); }
.lane-id { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--brand-soft); color: var(--brand); font-weight: 800; }
</style>
