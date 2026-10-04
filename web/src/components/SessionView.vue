<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { api, can } from "../lib/api";
import { category } from "../lib/labels";
import { armedSession, deleteSessionWithConfirm, sessions } from "../lib/sessions";
import { getSocket } from "../lib/socket";
import type { Crossing, Group, SessionDetail } from "../lib/types";
import { attempt, confirmDialog, toast } from "../lib/ui";
import CrossingConfirmModal from "./CrossingConfirmModal.vue";
import GroupCard from "./GroupCard.vue";
import RecIndicator from "./RecIndicator.vue";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ sessionId: string; focusGroup?: string | null; cameFrom?: string }>();
const emit = defineEmits<{ back: []; open: [id: string]; next: [] }>();

const detail = ref<SessionDetail | null>(null);
const confirming = ref<Crossing | null>(null);

const session = computed(() => detail.value?.session);
const allGroups = computed(() => [...(detail.value?.groups ?? [])].reverse());
const impulsesOf = (g: Group) => detail.value!.impulses.filter((i) => i.groupId === g._id);
const captureOf = (g: Group) => detail.value!.captures.find((c) => c.groupId === g._id);
const crossingsOf = (g: Group) => detail.value!.crossings.filter((c) => c.groupId === g._id).sort((a, b) => a.rank - b.rank);

/** Heat lain yang sedang aktif (mis. heat berikutnya sudah dikirim dari timing). */
const otherArmed = computed(() => (armedSession.value && armedSession.value._id !== props.sessionId ? armedSession.value : null));

/** Jumlah perahu = maks(sinyal RaceTime2, pemicu kamera) — sama dengan API. */
function boatsOf(g: Group) {
  const imps = impulsesOf(g);
  const cam = imps.filter((i) => i.source === "camera").length;
  return Math.max(imps.length - cam, cam);
}
const isClose = (g: Group) => boatsOf(g) >= 2;
/** Finish yang perlu ditinjau: berdekatan dan belum lengkap/terkonfirmasi, atau ada tanda belum dikonfirmasi. */
function needsReview(g: Group) {
  if (g.status !== "ready") return false;
  const cs = crossingsOf(g);
  const open = cs.some((c) => c.status !== "confirmed");
  return open || (isClose(g) && cs.length < boatsOf(g));
}
const todoGroups = computed(() => allGroups.value.filter(needsReview));

// DRR/Sprint/Slalom: satu sesi berisi banyak finish satu perahu — tampilkan
// yang berdekatan saja secara bawaan agar tinjauan cepat.
const onlyClose = ref<boolean | null>(null);
const showOnlyClose = computed(() => onlyClose.value ?? (!!session.value && category(session.value.raceCategory).lanes === 0 && allGroups.value.length > 3));
const groups = computed(() => (showOnlyClose.value ? allGroups.value.filter((g) => isClose(g) || needsReview(g) || g._id === props.focusGroup) : allGroups.value));
const hiddenCount = computed(() => allGroups.value.length - groups.value.length);

function scrollToGroup(id: string | undefined | null) {
  if (id) document.getElementById(`g-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
const jumpToTodo = () => scrollToGroup(todoGroups.value[0]?._id);

/** Finish yang dibuka dari Standby sudah beres → tawarkan kembali. */
const focusDone = computed(() => {
  const g = allGroups.value.find((x) => x._id === props.focusGroup);
  return !!g && g.status === "ready" && !needsReview(g) && crossingsOf(g).length > 0;
});
const backLabel = computed(() => (props.cameFrom === "standby" ? "Standby Kamera" : "Sesi Lomba"));

const stats = computed(() => {
  const d = detail.value;
  if (!d) return null;
  const confirmed = d.crossings.filter((c) => c.status === "confirmed").length;
  const cal = d.session.calibratedAt ? `${(Number(d.session.calibrationOffsetNs) / 1e6).toFixed(1)} ms` : "Belum";
  return { impulses: d.impulses.length, groups: d.groups.length, confirmed, crossings: d.crossings.length, cal };
});

// ---------------------------------------------------------------- keterangan
const editingNote = ref(false);
const noteDraft = ref("");
const noteInput = ref<HTMLInputElement | null>(null);
async function editNote() {
  noteDraft.value = session.value?.note ?? "";
  editingNote.value = true;
  await nextTick();
  noteInput.value?.focus();
}
async function saveNote() {
  if (await attempt(() => api("PUT", `/api/sessions/${props.sessionId}/note`, { note: noteDraft.value || null }), "Keterangan disimpan")) {
    editingNote.value = false;
    load();
  }
}

let scrolled = false;
async function load() {
  try {
    detail.value = await api<SessionDetail>("GET", `/api/sessions/${props.sessionId}`);
    if (!scrolled && props.focusGroup) {
      scrolled = true;
      await nextTick();
      scrollToGroup(props.focusGroup);
    }
  } catch (e) {
    toast("error", "Gagal memuat sesi", (e as Error).message);
  }
}

async function setArmed(armed: boolean) {
  if (await attempt(() => api("POST", `/api/sessions/${props.sessionId}/${armed ? "arm" : "disarm"}`), armed ? "Sesi aktif — sinyal RaceTime2 masuk ke sesi ini" : "Sesi dinonaktifkan")) load();
}

async function removeSession() {
  if (session.value && (await deleteSessionWithConfirm(session.value))) emit("back");
}

async function closeSession() {
  const pending = sessions.list.find((s) => s._id === props.sessionId)?.progress.pending ?? todoGroups.value.length;
  const ok = await confirmDialog({
    title: "Tutup sesi?", danger: true, okText: pending ? "Tetap tutup" : "Tutup sesi",
    text: pending
      ? `Masih ada ${pending} tinjauan yang belum dikonfirmasi juri. Sesi yang ditutup tidak bisa diubah lagi.`
      : "Sesi yang ditutup tidak menerima sinyal dan hasilnya tidak bisa diubah lagi.",
  });
  if (!ok || !(await attempt(() => api("POST", `/api/sessions/${props.sessionId}/close`), "Sesi ditutup"))) return;
  if (props.cameFrom === "standby") emit("back");
  else if (otherArmed.value) emit("open", otherArmed.value._id);
  else load();
}

const socket = getSocket();
const join = () => socket.emit("session:join", props.sessionId);
const EVENTS = ["impulse:new", "group:updated", "group:deleted", "capture:ready", "crossing:updated", "session:armed"];
watch(() => props.focusGroup, (id) => nextTick(() => scrollToGroup(id)));
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
    <div class="crumbs"><button @click="emit('back')">{{ backLabel }}</button><AppIcon name="chevron" /><span>{{ session.label }}</span></div>
    <div class="page-head">
      <div class="grow">
        <h1 class="page-title">{{ session.label }}</h1>
        <div class="row" style="margin-top: 8px">
          <span v-if="session.raceCategory" class="chip chip-brand">{{ category(session.raceCategory).label }}</span>
          <span v-if="session.heatId" class="chip">{{ category(session.raceCategory).unit }} {{ session.heatId }}</span>
          <span class="chip" :title="`Id Event ${session.eventId}`">{{ session.eventName ?? `Event ${session.eventId}` }}</span>
          <span class="chip"><AppIcon name="camera" /> {{ session.cameraId }}</span>
          <span v-if="session.armed" class="status-pill status-success"><span class="dot" />Aktif — menerima sinyal</span>
          <span v-else-if="session.status === 'open'" class="status-pill status-neutral"><span class="dot" />Terbuka</span>
          <span v-else class="status-pill status-muted"><span class="dot" />Ditutup</span>
        </div>
      </div>
      <div v-if="can('operator') && session.status === 'open'" class="row">
        <button v-if="!session.armed" class="btn btn-success" @click="setArmed(true)"><AppIcon name="play" /> Aktifkan</button>
        <button v-else class="btn" @click="setArmed(false)"><AppIcon name="stop" /> Nonaktifkan</button>
        <button class="btn btn-danger" @click="closeSession"><AppIcon name="lock" /> Tutup sesi</button>
        <button class="btn btn-ghost btn-danger-text" title="Hapus sesi beserta tangkapannya" @click="removeSession"><AppIcon name="del" /> Hapus</button>
      </div>
      <div v-else-if="can('operator')" class="row">
        <button class="btn btn-ghost btn-danger-text" title="Hapus sesi yang sudah ditutup beserta tangkapannya" @click="removeSession"><AppIcon name="del" /> Hapus</button>
      </div>
    </div>

    <RecIndicator v-if="session.armed" variant="banner" :camera-id="session.cameraId" />

    <div v-if="focusDone && cameFrom === 'standby'" class="alert alert-success switch-banner">
      <AppIcon name="check" />
      <span class="grow"><strong>Finish berdekatan selesai ditinjau.</strong><template v-if="todoGroups.length"> Masih ada {{ todoGroups.length }} finish lain di sesi ini.</template></span>
      <button class="btn btn-sm btn-primary" @click="emit('back')"><AppIcon name="arrowBack" /> Kembali ke Standby <kbd>S</kbd></button>
    </div>

    <div v-if="otherArmed" class="alert alert-info switch-banner">
      <AppIcon name="sensors" />
      <span class="grow">Sesi <strong>{{ otherArmed.label }}</strong> sedang aktif ({{ otherArmed.progress.finishes }} finish). Sinyal baru masuk ke sana — sesi ini tetap bisa ditinjau.</span>
      <button class="btn btn-sm btn-primary" @click="emit('open', otherArmed._id)">Buka sesi aktif <kbd>A</kbd></button>
    </div>

    <div v-if="todoGroups.length" class="alert alert-warn switch-banner">
      <AppIcon name="pending" />
      <span class="grow"><strong>{{ todoGroups.length }}</strong> finish belum selesai ditinjau di sesi ini.</span>
      <button class="btn btn-sm" @click="jumpToTodo">Ke tinjauan berikutnya</button>
    </div>

    <section class="card note-card">
      <AppIcon name="edit" />
      <template v-if="editingNote">
        <input ref="noteInput" v-model="noteDraft" class="input" maxlength="300" placeholder="Keterangan sesi, mis. R4 Putri · heat ulang" @keydown.enter="saveNote" @keydown.esc="editingNote = false" />
        <button class="btn btn-sm btn-primary" @click="saveNote">Simpan</button>
        <button class="btn btn-sm" @click="editingNote = false">Batal</button>
      </template>
      <template v-else>
        <span class="grow" :class="{ hint: !session.note }">{{ session.note || "Belum ada keterangan" }}</span>
        <button v-if="can('operator')" class="btn btn-sm btn-ghost" @click="editNote">{{ session.note ? "Ubah" : "Tambah keterangan" }}</button>
      </template>
    </section>

    <div class="stat-strip">
      <div class="stat-card"><span class="stat-card__icon"><AppIcon name="sensors" /></span><div><div class="stat-card__value">{{ stats.impulses }}</div><div class="stat-card__label">Sinyal masuk</div></div></div>
      <div class="stat-card stat-card--neutral"><span class="stat-card__icon"><AppIcon name="finish" /></span><div><div class="stat-card__value">{{ stats.groups }}</div><div class="stat-card__label">Kelompok finish</div></div></div>
      <div class="stat-card stat-card--success"><span class="stat-card__icon"><AppIcon name="verified" /></span><div><div class="stat-card__value">{{ stats.confirmed }}<span class="hint" style="font-size: 0.9rem"> / {{ stats.crossings }}</span></div><div class="stat-card__label">Hasil dikonfirmasi</div></div></div>
      <div class="stat-card" :class="session.calibratedAt ? 'stat-card--success' : 'stat-card--warning'"><span class="stat-card__icon"><AppIcon name="target" /></span><div><div class="stat-card__value">{{ stats.cal }}</div><div class="stat-card__label">Kalibrasi kamera</div></div></div>
    </div>

    <section v-if="session.lanes.length" class="card" style="padding: 14px 20px">
      <div class="row">
        <span class="section-label" style="margin: 0">Lintasan</span>
        <span v-for="l in session.lanes.slice(0, 8)" :key="l.lane" class="lane"><span class="lane-id">{{ l.lane }}</span>{{ l.teamName ?? l.teamId }}<span v-if="l.bib" class="hint">#{{ l.bib }}</span></span>
        <span v-if="session.lanes.length > 8" class="hint">+{{ session.lanes.length - 8 }} tim lain</span>
      </div>
    </section>

    <div v-if="allGroups.length" class="row group-filter">
      <div class="btn-group" role="tablist">
        <button class="btn btn-sm" :class="{ 'is-active': !showOnlyClose }" @click="onlyClose = false">Semua finish ({{ allGroups.length }})</button>
        <button class="btn btn-sm" :class="{ 'is-active': showOnlyClose }" @click="onlyClose = true">Berdekatan & perlu ditinjau</button>
      </div>
      <span v-if="showOnlyClose && hiddenCount" class="hint">{{ hiddenCount }} finish satu perahu disembunyikan — waktunya langsung dari RaceTime2.</span>
    </div>

    <div v-if="allGroups.length && !groups.length" class="card empty">
      <AppIcon name="check" />
      <strong>Tidak ada finish berdekatan</strong>
      <span>Semua finish di sesi ini satu perahu. Pilih "Semua finish" untuk melihat rekamannya.</span>
    </div>

    <div v-if="!allGroups.length" class="card empty">
      <AppIcon name="sensors" />
      <strong>Belum ada sinyal finish</strong>
      <span>{{ session.armed ? "Sesi aktif. Sinyal dari RaceTime2 akan muncul di sini secara langsung." : "Aktifkan sesi agar sinyal RaceTime2 masuk ke sesi ini." }}</span>
    </div>

    <GroupCard
      v-for="g in groups" :id="`g-${g._id}`" :key="g._id" :group="g" :index="allGroups.length - allGroups.indexOf(g)"
      :class="{ focused: g._id === focusGroup }" :session="session"
      :impulses="impulsesOf(g)" :capture="captureOf(g)" :crossings="crossingsOf(g)"
      @changed="load" @confirm="confirming = $event"
    />

    <CrossingConfirmModal :crossing="confirming" :session="session" @close="confirming = null" @saved="load" />
  </template>
  <div v-else class="empty"><AppIcon name="pending" />Memuat sesi…</div>
</template>

<style scoped>
.switch-banner { align-items: center; }
.switch-banner .grow { flex: 1; }
.switch-banner kbd { font: 700 0.7rem var(--mono); padding: 1px 5px; border-radius: 5px; border: 1px solid currentColor; opacity: 0.8; margin-left: 4px; }
[id^="g-"] { scroll-margin-top: calc(var(--nav-h) + 70px); }
.btn-danger-text { color: var(--bad-ink); }
.btn-danger-text:hover { background: var(--bad-bg); }
.note-card { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
.note-card .grow { flex: 1; color: var(--brand-ink); font-weight: 600; }
.note-card .grow.hint { font-weight: 400; color: var(--faint); }
.note-card .input { flex: 1; }
.focused { box-shadow: 0 0 0 3px var(--warn), var(--shadow); }
.group-filter { margin: 0 0 14px; }
.lane { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--ink); }
.lane-id { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--brand-soft); color: var(--brand); font-weight: 800; }
</style>
