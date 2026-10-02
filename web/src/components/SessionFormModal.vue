<script setup lang="ts">
// Form sesi baru. Dengan `from` (sesi sebelumnya) form terisi otomatis untuk
// heat berikutnya — operator cukup cek tim lalu Enter, cocok untuk jeda < 2 menit.
import { computed, nextTick, reactive, ref, watch } from "vue";
import { api } from "../lib/api";
import { CATEGORY } from "../lib/labels";
import { loadSessions, nextHeat } from "../lib/sessions";
import type { Lane, RaceCategory, Session } from "../lib/types";
import { toast } from "../lib/ui";
import AppIcon from "./ui/AppIcon.vue";
import Modal from "./ui/Modal.vue";

const props = defineProps<{ open: boolean; from?: Session | null }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();

const busy = ref(false);
const armNow = ref(true);
const labelInput = ref<HTMLInputElement | null>(null);
const bucket = reactive({ divisionId: "", raceId: "", initialId: "" });
const form = reactive({ eventId: "", raceCategory: "H2H" as RaceCategory, heatId: "", label: "", cameraId: "cam-1", lanes: [] as Lane[] });

const isNext = computed(() => !!props.from);
const unit = computed(() => CATEGORY[form.raceCategory].unit);

function emptyLanes() {
  const n = CATEGORY[form.raceCategory].lanes;
  form.lanes = Array.from({ length: n }, (_, i) => ({
    lane: n === 4 ? String(i + 1) : String.fromCharCode(65 + i),
    teamId: "", bib: null, teamName: null, crewExpected: null,
  }));
}

/** Label lama yang memuat nomor heat ikut dinaikkan; selain itu tambahkan "Heat N". */
function nextLabel(prev: Session, heat: string) {
  if (prev.heatId && prev.label.includes(prev.heatId)) return prev.label.replace(prev.heatId, heat);
  const bumped = nextHeat(prev.label);
  return bumped !== prev.label ? bumped : heat ? `${prev.label} — ${CATEGORY[prev.raceCategory].unit} ${heat}` : prev.label;
}

watch(() => props.open, async (open) => {
  if (!open) return;
  const prev = props.from;
  armNow.value = true;
  if (prev) {
    const heat = nextHeat(prev.heatId);
    Object.assign(form, { eventId: prev.eventId, raceCategory: prev.raceCategory, heatId: heat, label: nextLabel(prev, heat), cameraId: prev.cameraId });
    Object.assign(bucket, prev.bucket ?? { divisionId: "", raceId: "", initialId: "" });
    // Tim berganti tiap heat; jumlah awak biasanya sama.
    emptyLanes();
    form.lanes.forEach((l, i) => (l.crewExpected = prev.lanes[i]?.crewExpected ?? null));
  } else {
    Object.assign(form, { eventId: "", raceCategory: "H2H", heatId: "", label: "", cameraId: "cam-1" });
    Object.assign(bucket, { divisionId: "", raceId: "", initialId: "" });
    emptyLanes();
  }
  await nextTick();
  labelInput.value?.focus();
  labelInput.value?.select();
});

const bucketComplete = computed(() => !!(bucket.divisionId && bucket.raceId && bucket.initialId));

async function create() {
  busy.value = true;
  try {
    const s = await api<Session>("POST", "/api/sessions", {
      ...form, heatId: form.heatId || null, lanes: form.lanes.filter((l) => l.teamId),
      bucket: bucketComplete.value ? { ...bucket } : null,
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
    :open="open" :width="720" @close="emit('close')"
    :title="isNext ? `${unit} berikutnya` : 'Sesi photo finish baru'"
    :subtitle="isNext ? `Disalin dari ${from!.label}. Periksa label & tim, lalu tekan Enter.` : 'Isi sesuai heat di sts-timingsystem agar hasil masuk ke kategori yang benar.'"
  >
    <form id="create-session" @submit.prevent="create">
      <div class="section-label">Heat</div>
      <div class="grid-2">
        <label class="field"><span class="field-label">Label sesi</span><input ref="labelInput" v-model="form.label" class="input" required :placeholder="form.raceCategory === 'H2H' ? 'H2H R6 Putra — Heat 3' : form.raceCategory === 'RX' ? 'RX R4 Putri — Heat 2' : form.raceCategory === 'SLALOM' ? 'Slalom R4 Putra — Run 1' : form.raceCategory === 'SPRINT' ? 'Sprint R6 Putra — Run 1' : 'DRR R6 Putra'" /></label>
        <label class="field">
          <span class="field-label">Format lomba</span>
          <select v-model="form.raceCategory" class="input" @change="emptyLanes">
            <option v-for="(c, key) in CATEGORY" :key="key" :value="key">{{ c.label }}</option>
          </select>
          <span class="field-help">{{ CATEGORY[form.raceCategory].hint }}</span>
        </label>
        <label class="field"><span class="field-label">Event ID</span><input v-model="form.eventId" class="input mono" required /></label>
        <div class="grid-2" style="gap: 10px">
          <label class="field"><span class="field-label">{{ unit }}</span><input v-model="form.heatId" class="input" placeholder="opsional" /></label>
          <label class="field"><span class="field-label">Kamera</span><input v-model="form.cameraId" class="input mono" required /></label>
        </div>
      </div>

      <details class="bucket" :open="!isNext || !bucketComplete">
        <summary class="section-label">
          Kategori sts-timingsystem
          <span v-if="bucketComplete" class="hint mono">{{ bucket.divisionId }} · {{ bucket.raceId }} · {{ bucket.initialId }}</span>
        </summary>
        <div class="grid-3">
          <label class="field"><span class="field-label">Division ID</span><input v-model="bucket.divisionId" class="input mono" /></label>
          <label class="field"><span class="field-label">Race ID</span><input v-model="bucket.raceId" class="input mono" /></label>
          <label class="field"><span class="field-label">Initial ID</span><input v-model="bucket.initialId" class="input mono" /></label>
        </div>
      </details>
      <div v-if="!bucketComplete" class="alert alert-warn"><AppIcon name="warning" />Tanpa ketiga ID ini, hasil tidak diterapkan otomatis di timing system (aturan Event + Division + Race + Initial).</div>

      <template v-if="form.lanes.length">
        <div class="section-label" style="margin-top: 20px">Lintasan <span class="hint">— boleh dikosongkan, tim bisa dipilih saat konfirmasi</span></div>
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
.bucket { margin-top: 20px; }
.bucket summary { cursor: pointer; display: flex; gap: 10px; align-items: baseline; list-style: revert; }
.arm-now { display: flex; gap: 10px; align-items: flex-start; margin-top: 18px; padding: 12px 14px; border-radius: 12px; background: var(--ok-bg); border: 1px solid var(--ok-line); color: var(--ok-ink); font-size: 0.88rem; cursor: pointer; }
.arm-now input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--ok); }
</style>
