<script setup lang="ts">
// Form sesi baru: cukup pilih Event. Format lomba, heat, dan label tidak
// perlu — penerapan hasil sama untuk kategori apa pun; label dibuat otomatis
// ("<Nama Event> · Sesi N"). Keterangan dipakai admin sebagai pembeda sesi.
// Dengan `from` (sesi sebelumnya) Event & kamera tersalin — tinggal Enter.
import { computed, nextTick, reactive, ref, watch } from "vue";
import { api } from "../lib/api";
import { loadSessions } from "../lib/sessions";
import type { EventInfo, Session } from "../lib/types";
import { toast } from "../lib/ui";
import AppIcon from "./ui/AppIcon.vue";
import Modal from "./ui/Modal.vue";

const props = defineProps<{ open: boolean; from?: Session | null }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();

const busy = ref(false);
const armNow = ref(true);
const noteInput = ref<HTMLInputElement | null>(null);
const form = reactive({ eventId: "", cameraId: "cam-1", note: "" });
const isNext = computed(() => !!props.from);

// Daftar Event dari sts-timingsystem (nama dari Id Event). Bila tidak
// tersedia, Id Event diketik manual.
const events = ref<EventInfo[]>([]);
const manualEvent = ref(false);
async function loadEvents() {
  try {
    events.value = await api<EventInfo[]>("GET", "/api/events");
  } catch {
    events.value = [];
  }
  manualEvent.value = !events.value.length || (!!form.eventId && !events.value.some((e) => e.eventId === form.eventId));
  // Satu event saja → langsung terpilih.
  if (!form.eventId && events.value.length === 1) form.eventId = events.value[0]!.eventId;
}

watch(() => props.open, async (open) => {
  if (!open) return;
  armNow.value = true;
  const prev = props.from;
  Object.assign(form, { eventId: prev?.eventId ?? "", cameraId: prev?.cameraId ?? "cam-1", note: "" });
  void loadEvents();
  await nextTick();
  noteInput.value?.focus();
});

async function create() {
  if (!form.eventId.trim()) return toast("warning", "Pilih Event dulu");
  busy.value = true;
  try {
    const s = await api<Session>("POST", "/api/sessions", {
      eventId: form.eventId.trim(), cameraId: form.cameraId, note: form.note.trim() || null,
      eventName: events.value.find((e) => e.eventId === form.eventId)?.eventName ?? null,
    });
    if (armNow.value) await api("POST", `/api/sessions/${s._id}/arm`);
    toast("success", armNow.value ? "Sesi dibuat & AKTIF" : "Sesi dibuat", s.label);
    void loadSessions();
    emit("created", s._id);
  } catch (e) {
    toast("error", "Gagal membuat sesi", (e as Error).message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    :open="open" :width="560" @close="emit('close')"
    :title="isNext ? 'Sesi berikutnya' : 'Sesi photo finish baru'"
    :subtitle="isNext ? `Event & kamera disalin dari ${from!.label}. Tekan Enter untuk membuat.` : 'Cukup pilih Event — berlaku untuk kategori apa pun.'"
  >
    <form id="create-session" @submit.prevent="create">
      <label v-if="!manualEvent" class="field">
        <span class="field-label">Event <button type="button" class="link" @click="manualEvent = true">ketik Id Event</button></span>
        <select v-model="form.eventId" class="input" required>
          <option value="" disabled>Pilih event…</option>
          <option v-for="e in events" :key="e.eventId" :value="e.eventId">{{ e.eventName || e.eventId }}</option>
        </select>
      </label>
      <label v-else class="field">
        <span class="field-label">Id Event <button v-if="events.length" type="button" class="link" @click="manualEvent = false">pilih dari daftar</button></span>
        <input v-model="form.eventId" class="input mono" required placeholder="Id Event sts-timingsystem" />
      </label>

      <label class="field" style="margin-top: 14px">
        <span class="field-label">Keterangan <span class="hint">(opsional)</span></span>
        <input ref="noteInput" v-model="form.note" class="input" maxlength="300" placeholder="mis. R4 Putri · Heat 3 — pembeda sesi" />
      </label>

      <label class="field" style="margin-top: 14px; max-width: 200px">
        <span class="field-label">Kamera</span>
        <input v-model="form.cameraId" class="input mono" required />
      </label>

      <label class="arm-now">
        <input v-model="armNow" type="checkbox" />
        <span><strong>Langsung aktifkan</strong> — sinyal RaceTime2 berikutnya masuk ke sesi ini (sesi aktif sebelumnya dinonaktifkan, hasilnya tetap bisa ditinjau).</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" @click="emit('close')">Batal</button>
      <button class="btn btn-primary" type="submit" form="create-session" :disabled="busy">
        <AppIcon :name="armNow ? 'play' : 'add'" /> {{ armNow ? "Buat & aktifkan" : "Buat sesi" }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.link { all: unset; cursor: pointer; margin-left: 6px; font-size: 0.78rem; font-weight: 600; color: var(--brand); }
.link:hover { text-decoration: underline; }
.arm-now { display: flex; gap: 10px; align-items: flex-start; margin-top: 18px; padding: 12px 14px; border-radius: 12px; background: var(--ok-bg); border: 1px solid var(--ok-line); color: var(--ok-ink); font-size: 0.88rem; cursor: pointer; }
.arm-now input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--ok); }
</style>
