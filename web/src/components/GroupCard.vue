<script setup lang="ts">
// Satu kelompok finish: impuls RaceTime2, gambar slit-scan, urutan perahu.
import { computed, ref } from "vue";
import { api, can } from "../lib/api";
import { GROUP_STATUS, TIME_SOURCE } from "../lib/labels";
import type { Capture, Crossing, Group, Impulse, Session } from "../lib/types";
import { attempt, confirmDialog, toast } from "../lib/ui";
import SlitScanViewer from "./SlitScanViewer.vue";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ group: Group; index: number; session: Session; impulses: Impulse[]; capture?: Capture; crossings: Crossing[] }>();
const emit = defineEmits<{ changed: []; confirm: [crossing: Crossing] }>();

const mode = ref<"mark" | "calibrate">("mark");
const lane = ref("");
const teamId = ref("");
const zoom = ref<number | null>(null); // null = pas selebar panel
const scale = ref(1);
const hover = ref<{ column: number; label: string } | null>(null);

const usesLanes = computed(() => props.session.lanes.length > 0);
const nextRank = computed(() => props.crossings.reduce((m, c) => Math.max(m, c.rank), 0) + 1);
const usedLanes = computed(() => new Set(props.crossings.map((c) => c.lane)));
const editable = computed(() => props.session.status === "open" && can("operator"));
const st = computed(() => GROUP_STATUS[props.group.status]);

async function onMark(column: number) {
  if (!props.capture) return;
  if (mode.value === "calibrate") {
    const first = props.impulses[0];
    if (!first) return;
    const res = await attempt(() => api<{ calibrationOffsetMs: number }>("POST", `/api/sessions/${props.session._id}/calibrate`, {
      captureId: props.capture!._id, column, impulseId: first._id,
    }));
    if (res) {
      mode.value = "mark";
      emit("changed");
      toast("success", "Kamera terkalibrasi", `Offset ${res.calibrationOffsetMs} ms terhadap photocell`);
    }
    return;
  }
  const ok = await attempt(() => api("POST", "/api/crossings", {
    captureId: props.capture!._id, column, rank: nextRank.value,
    lane: lane.value || null, teamId: lane.value ? null : teamId.value || null,
  }));
  if (ok) {
    lane.value = "";
    teamId.value = "";
    emit("changed");
  }
}

async function remove(c: Crossing) {
  if (!(await confirmDialog({ title: "Hapus tanda?", text: `Tanda urutan ${c.rank}${c.lane ? ` (lintasan ${c.lane})` : ""} akan dihapus. Urutan lain dihitung ulang.`, okText: "Hapus", danger: true }))) return;
  if (await attempt(() => api("DELETE", `/api/crossings/${c._id}`), "Tanda dihapus")) emit("changed");
}

const fmt = (d: string) => new Date(d).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
</script>

<template>
  <section class="card group">
    <div class="card-head">
      <h3 class="card-title"><AppIcon name="finish" /> Kelompok finish #{{ index }} <span class="hint" style="font-weight: 600">· {{ fmt(group.createdAt) }}</span></h3>
      <span class="status-pill" :class="st.cls"><span class="dot" />{{ st.label }}</span>
    </div>

    <div class="impulses">
      <span class="section-label" style="margin: 0">Impuls RaceTime2</span>
      <span v-for="(i, n) in impulses" :key="i._id" class="chip mono" :title="i.timeBasis === 'pf-clock' ? 'Frame tanpa waktu — dicap jam Photo Finish' : 'Waktu dari RaceTime2'">
        <strong>{{ n + 1 }}</strong> {{ i.deviceTime }}<AppIcon v-if="i.timeBasis === 'pf-clock'" name="timer" />
      </span>
    </div>
    <div v-for="w in group.warnings" :key="w" class="alert alert-warn"><AppIcon name="warning" />{{ w }}</div>

    <div v-if="capture" class="race-window" style="margin-top: 12px">
      <div class="race-toolbar">
        <template v-if="editable">
          <div class="btn-group">
            <button class="btn btn-sm" :class="{ 'is-active': mode === 'mark' }" @click="mode = 'mark'"><AppIcon name="touch" /> Tandai urutan</button>
            <button class="btn btn-sm" :class="{ 'is-active': mode === 'calibrate' }" :disabled="!impulses.length" @click="mode = 'calibrate'"><AppIcon name="target" /> Kalibrasi kamera</button>
          </div>
          <template v-if="mode === 'mark'">
            <span>Urutan <strong class="readout">{{ nextRank }}</strong></span>
            <div v-if="usesLanes" class="btn-group" aria-label="Lintasan">
              <button
                v-for="l in session.lanes" :key="l.lane" class="btn btn-sm" :class="{ 'is-active': lane === l.lane }"
                :title="l.teamName ?? l.teamId" @click="lane = lane === l.lane ? '' : l.lane"
              >
                {{ l.lane }}<AppIcon v-if="usedLanes.has(l.lane)" name="check" />
              </button>
            </div>
            <input v-else v-model="teamId" class="input input-sm mono" placeholder="Team ID" style="width: 130px; background: rgba(255,255,255,.08); color: #fff; border-color: rgba(255,255,255,.2)" />
          </template>
          <span v-else class="hint">Klik haluan perahu kalibrasi (impuls pertama).</span>
        </template>
        <span class="spacer" />
        <span class="readout">{{ hover ? `kolom ${hover.column} · ${hover.label}` : `${capture.fps} fps · ${(1000 / capture.fps).toFixed(1)} ms/kolom` }}</span>
        <button class="btn btn-sm" :class="{ 'is-active': zoom === null }" title="Pas selebar panel" @click="zoom = null">Pas</button>
        <label class="row" style="gap: 6px">
          <AppIcon name="zoom" />
          <input :value="zoom ?? scale" type="range" min="1" max="8" step="0.5" aria-label="Zoom sumbu waktu" @input="zoom = Number(($event.target as HTMLInputElement).value)" />
          <span class="mono" style="width: 44px">{{ scale.toFixed(1) }}×</span>
        </label>
      </div>
      <SlitScanViewer
        :capture="capture" :crossings="crossings" :can-mark="editable" :zoom="zoom"
        :mark-color="mode === 'calibrate' ? '#fbbf24' : undefined" @mark="onMark" @hover="hover = $event" @scale="scale = $event"
      />
      <p v-if="editable && mode === 'mark'" class="hint" style="margin: 10px 0 0">
        {{ usesLanes ? "Pilih lintasan, lalu klik" : "Isi Team ID, lalu klik" }} ujung haluan perahu sesuai urutan tiba (kiri = lebih dulu).
      </p>
    </div>
    <div v-else class="race-window empty" style="margin-top: 12px; color: #b6c2cf"><AppIcon name="camera" />Menunggu rekaman dari Capture Agent…</div>

    <div v-if="crossings.length" class="table-wrap" style="margin-top: 16px">
      <table class="table">
        <thead><tr><th class="num">Urutan</th><th>Lintasan / Tim</th><th>Waktu resmi</th><th>Status</th><th style="text-align: right">Aksi</th></tr></thead>
        <tbody>
          <tr v-for="c in crossings" :key="c._id">
            <td class="num"><span class="rank">{{ c.rank }}</span></td>
            <td>
              <strong style="color: var(--ink)">{{ session.lanes.find((l) => l.teamId === c.teamId)?.teamName ?? c.teamId ?? "Belum dipilih" }}</strong>
              <div class="hint">{{ c.lane ? `Lintasan ${c.lane}` : "—" }}{{ c.bib ? ` · BIB ${c.bib}` : "" }}</div>
            </td>
            <td>
              <span class="mono" style="font-size: 1.05rem; font-weight: 800; color: var(--ink)">{{ c.officialTime ?? "—" }}</span>
              <div v-if="c.timeSource"><span class="hint">{{ TIME_SOURCE[c.timeSource].label }}</span></div>
            </td>
            <td>
              <span v-if="c.status === 'confirmed'" class="status-pill status-success"><span class="dot" />Dikonfirmasi</span>
              <span v-else-if="c.status === 'disputed'" class="status-pill status-danger"><span class="dot" />Perlu dicek</span>
              <span v-else class="status-pill status-upcoming"><span class="dot" />Menunggu juri</span>
              <div v-if="c.status === 'confirmed'" class="hint" style="margin-top: 4px">
                <AppIcon :name="c.deliveredRevision >= c.revision ? 'doneAll' : 'pending'" />
                {{ c.deliveredRevision >= c.revision ? "Terkirim ke timing" : "Menunggu timing" }}
              </div>
              <div v-if="c.warnings.length" class="hint" style="color: var(--warn-ink); margin-top: 4px"><AppIcon name="warning" /> {{ c.warnings[0] }}</div>
            </td>
            <td style="text-align: right; white-space: nowrap">
              <button v-if="can('judge') && session.status === 'open'" class="btn btn-sm" :class="c.revision ? '' : 'btn-success'" @click="emit('confirm', c)">
                <AppIcon :name="c.revision ? 'edit' : 'verified'" /> {{ c.revision ? "Koreksi" : "Konfirmasi" }}
              </button>
              <button v-if="editable && c.revision === 0" class="btn btn-sm btn-ghost" title="Hapus tanda" @click="remove(c)"><AppIcon name="del" /></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.impulses { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rank { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--brand); color: #fff; font-weight: 800; }
</style>
