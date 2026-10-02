<script setup lang="ts">
// Konfirmasi juri untuk satu perahu: tim, jumlah awak, posisi perahu, lintasan kedua.
import { computed, reactive, watch } from "vue";
import { api } from "../lib/api";
import { TIME_SOURCE } from "../lib/labels";
import type { Crossing, Session } from "../lib/types";
import { toast } from "../lib/ui";
import AppIcon from "./ui/AppIcon.vue";
import Modal from "./ui/Modal.vue";

const props = defineProps<{ crossing: Crossing | null; session: Session }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const form = reactive({ teamId: "", crewInBoat: 0, crewExpected: 4, upright: true, secondCrossing: false, manualTime: "", reason: "", busy: false });
const laneOf = (c: Crossing) => props.session.lanes.find((l) => l.lane === c.lane || l.teamId === c.teamId);

watch(() => props.crossing, (c) => {
  if (!c) return;
  const expected = c.crewExpected ?? laneOf(c)?.crewExpected ?? 4;
  Object.assign(form, {
    teamId: c.teamId ?? laneOf(c)?.teamId ?? "", crewInBoat: c.crewInBoat ?? expected, crewExpected: expected,
    upright: c.upright ?? true, secondCrossing: c.secondCrossing, manualTime: "", reason: "", busy: false,
  });
}, { immediate: true });

const isCorrection = computed(() => (props.crossing?.revision ?? 0) > 0);
const needsManual = computed(() => props.crossing?.timeSource !== "impulse" && !props.crossing?.officialTime);
const isRx = computed(() => props.session.raceCategory === "RX");
const penalty = computed(() => {
  const issues: string[] = [];
  if (form.crewInBoat < form.crewExpected) issues.push(`awak ${form.crewInBoat}/${form.crewExpected}`);
  if (!form.upright) issues.push("perahu terbalik");
  return issues;
});
const valid = computed(() => !!form.teamId && (!needsManual.value || !!form.manualTime) && (!isCorrection.value || !!form.reason.trim()));

async function submit() {
  const c = props.crossing;
  if (!c || !valid.value) return;
  form.busy = true;
  try {
    await api("POST", `/api/crossings/${c._id}/confirm`, {
      teamId: form.teamId, lane: c.lane, crewInBoat: form.crewInBoat, crewExpected: form.crewExpected,
      upright: form.upright, secondCrossing: form.secondCrossing,
      ...(form.manualTime ? { manualTime: form.manualTime } : {}),
      ...(form.reason ? { reason: form.reason } : {}),
    });
    toast("success", isCorrection.value ? "Hasil dikoreksi" : "Hasil dikonfirmasi", "Dikirim ke sts-timingsystem.");
    emit("saved");
    emit("close");
  } catch (e) {
    toast("error", "Gagal menyimpan", (e as Error).message);
  } finally {
    form.busy = false;
  }
}
</script>

<template>
  <Modal
    :open="!!crossing"
    :title="isCorrection ? `Koreksi hasil — urutan ${crossing?.rank}` : `Konfirmasi juri — urutan ${crossing?.rank}`"
    :subtitle="crossing?.lane ? `Lintasan ${crossing.lane}` : 'Pilih tim untuk perahu ini'"
    :width="560"
    @close="emit('close')"
  >
    <template v-if="crossing">
      <div class="time-box">
        <div>
          <div class="section-label" style="margin: 0">Waktu resmi</div>
          <div class="mono official">{{ crossing.officialTime ?? "—" }}</div>
          <div class="hint mono">{{ crossing.finishTime ?? "" }}</div>
        </div>
        <span v-if="crossing.timeSource" class="status-pill" :class="TIME_SOURCE[crossing.timeSource].cls"><span class="dot" />{{ TIME_SOURCE[crossing.timeSource].label }}</span>
      </div>

      <div class="grid-2" style="margin-top: 16px">
        <label class="field">
          <span class="field-label">Tim</span>
          <select v-if="session.lanes.length" v-model="form.teamId" class="input">
            <option v-for="l in session.lanes" :key="l.teamId" :value="l.teamId">{{ l.lane }} · {{ l.teamName ?? l.teamId }}{{ l.bib ? ` #${l.bib}` : "" }}</option>
          </select>
          <input v-else v-model="form.teamId" class="input mono" placeholder="Team ID" required />
        </label>
        <div class="field">
          <span class="field-label">Awak di dalam perahu</span>
          <div class="stepper">
            <button type="button" class="btn" :disabled="form.crewInBoat <= 0" aria-label="Kurangi" @click="form.crewInBoat--">−</button>
            <span class="mono">{{ form.crewInBoat }} / {{ form.crewExpected }}</span>
            <button type="button" class="btn" :disabled="form.crewInBoat >= form.crewExpected" aria-label="Tambah" @click="form.crewInBoat++">+</button>
          </div>
        </div>
      </div>

      <div class="toggles">
        <label class="toggle" :class="{ on: form.upright }"><input v-model="form.upright" type="checkbox" /><span><strong>Perahu tegak</strong><small>Tidak terbalik saat melintas garis</small></span></label>
        <label class="toggle" :class="{ warn: form.secondCrossing }"><input v-model="form.secondCrossing" type="checkbox" /><span><strong>Melintas finish 2×</strong><small>Diskualifikasi menurut aturan FAJI</small></span></label>
      </div>

      <div v-if="penalty.length" class="alert alert-warn">
        <AppIcon name="warning" />
        <span>Pelanggaran di garis finish ({{ penalty.join(", ") }}): <strong>{{ isRx ? "eliminasi" : "penalti +50 detik" }}</strong>. Diterapkan operator di sts-timingsystem.</span>
      </div>
      <div v-if="crossing.warnings.length" class="alert alert-info"><AppIcon name="info" /><span>{{ crossing.warnings.join(" ") }}</span></div>

      <label v-if="needsManual" class="field" style="margin-top: 14px">
        <span class="field-label">Waktu manual</span>
        <input v-model="form.manualTime" class="input mono" placeholder="HH:MM:SS.mmm" />
        <span class="field-help">Tidak ada sinyal dan jam kamera belum tersinkron untuk perahu ini.</span>
      </label>
      <label v-if="isCorrection" class="field" style="margin-top: 14px">
        <span class="field-label">Alasan koreksi</span>
        <input v-model="form.reason" class="input" placeholder="Wajib — tercatat di audit log" />
      </label>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Batal</button>
      <button class="btn btn-success" :disabled="!valid || form.busy" @click="submit"><AppIcon name="verified" /> {{ isCorrection ? "Simpan koreksi" : "Konfirmasi hasil" }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.time-box { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--race); color: #fff; border-radius: 14px; padding: 14px 16px; }
.time-box .section-label { color: #b6c2cf; }
.official { font-size: 1.9rem; font-weight: 800; color: #7dd3fc; line-height: 1.15; }
.time-box .hint { color: #94a3b8; }
.stepper { display: flex; align-items: center; gap: 8px; }
.stepper .btn { width: 44px; height: 44px; font-size: 1.2rem; padding: 0; }
.stepper span { flex: 1; text-align: center; font-size: 1.2rem; font-weight: 800; color: var(--ink); }
.toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
.toggle { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border); border-radius: 12px; padding: 12px; cursor: pointer; background: var(--surface-2); }
.toggle input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--brand); }
.toggle span { display: flex; flex-direction: column; font-size: 0.88rem; }
.toggle small { color: var(--muted); }
.toggle.on { border-color: var(--ok-line); background: var(--ok-bg); }
.toggle.warn { border-color: var(--bad-line); background: var(--bad-bg); }
@media (max-width: 560px) { .toggles { grid-template-columns: 1fr; } }
</style>
