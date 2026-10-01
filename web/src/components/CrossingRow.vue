<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { api, can } from "../lib/api";
import type { Crossing, Session } from "../lib/types";

const props = defineProps<{ crossing: Crossing; session: Session }>();
const emit = defineEmits<{ changed: [] }>();

const c = () => props.crossing;
const lane = () => props.session.lanes.find((l) => l.lane === c().lane || l.teamId === c().teamId);
const form = reactive({ teamId: "", crewInBoat: 0, crewExpected: 0, upright: true, secondCrossing: false, manualTime: "", reason: "" });
const error = ref("");
const busy = ref(false);

function resetForm() {
  const expected = c().crewExpected ?? lane()?.crewExpected ?? 6;
  Object.assign(form, {
    teamId: c().teamId ?? lane()?.teamId ?? "", crewInBoat: c().crewInBoat ?? expected, crewExpected: expected,
    upright: c().upright ?? true, secondCrossing: c().secondCrossing, manualTime: "", reason: "",
  });
}
watch(() => props.crossing, resetForm, { immediate: true });

const SOURCE_LABEL = { impulse: "impuls RaceTime2", camera: "kamera (tanpa impuls)", manual: "manual" } as const;

async function confirm() {
  busy.value = true;
  error.value = "";
  try {
    await api("POST", `/api/crossings/${c()._id}/confirm`, {
      teamId: form.teamId, lane: c().lane, crewInBoat: form.crewInBoat, crewExpected: form.crewExpected,
      upright: form.upright, secondCrossing: form.secondCrossing,
      ...(form.manualTime ? { manualTime: form.manualTime } : {}),
      ...(form.reason ? { reason: form.reason } : {}),
    });
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function remove() {
  try {
    await api("DELETE", `/api/crossings/${c()._id}`);
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <tr>
    <td><strong>{{ crossing.rank }}</strong></td>
    <td>
      {{ crossing.lane ?? "—" }}<br />
      <span class="muted">{{ lane()?.teamName ?? crossing.teamId ?? "" }} {{ crossing.bib ? `#${crossing.bib}` : "" }}</span>
    </td>
    <td>
      <span class="mono">{{ crossing.officialTime ?? "—" }}</span><br />
      <span class="muted">{{ crossing.timeSource ? SOURCE_LABEL[crossing.timeSource] : "belum ada waktu" }}</span>
    </td>
    <td>
      <span class="badge" :class="{ ok: crossing.status === 'confirmed', warn: crossing.status === 'disputed' }">{{ crossing.status }}</span>
      <div v-if="crossing.status === 'confirmed'" class="muted">
        {{ crossing.deliveredRevision >= crossing.revision ? "terkirim ke timing" : "menunggu timing" }}
      </div>
      <div v-for="w in crossing.warnings" :key="w" class="warn-box">{{ w }}</div>
    </td>
    <td v-if="can('judge')">
      <div class="row">
        <label>Tim <input v-model="form.teamId" style="width: 110px" required /></label>
        <label>Awak <input v-model.number="form.crewInBoat" type="number" min="0" max="12" />/<input v-model.number="form.crewExpected" type="number" min="1" max="12" /></label>
        <label><input v-model="form.upright" type="checkbox" /> tidak terbalik</label>
        <label><input v-model="form.secondCrossing" type="checkbox" /> melintas 2×</label>
        <label v-if="crossing.timeSource !== 'impulse'">Waktu manual <input v-model="form.manualTime" placeholder="HH:MM:SS.mmm" class="mono" style="width: 120px" /></label>
        <label v-if="crossing.revision > 0">Alasan koreksi <input v-model="form.reason" required /></label>
        <button class="primary" :disabled="busy || !form.teamId" @click="confirm">{{ crossing.revision > 0 ? "Koreksi" : "Konfirmasi" }}</button>
        <button v-if="crossing.status !== 'confirmed' && crossing.revision === 0" class="danger" @click="remove">Hapus</button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </td>
  </tr>
</template>
