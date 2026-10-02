<script setup lang="ts">
// Satu kelompok finish: sinyal RaceTime2, gambar slit-scan, urutan perahu.
import { computed, ref } from "vue";
import { api, can } from "../lib/api";
import { GROUP_STATUS, TIME_SOURCE } from "../lib/labels";
import type { Capture, Crossing, Group, Impulse, Session } from "../lib/types";
import { attempt, confirmDialog, toast } from "../lib/ui";
import FrameViewer from "./FrameViewer.vue";
import SlitScanViewer from "./SlitScanViewer.vue";
import AppIcon from "./ui/AppIcon.vue";

const props = defineProps<{ group: Group; index: number; session: Session; impulses: Impulse[]; capture?: Capture; crossings: Crossing[] }>();
const emit = defineEmits<{ changed: []; confirm: [crossing: Crossing] }>();

const mode = ref<"mark" | "calibrate">("mark");
const lane = ref("");
const teamId = ref("");
const zoom = ref<number | null>(null); // null = pas selebar panel
const scale = ref(1);
const smooth = ref(true);
const focusColumn = ref<number | null>(null); // kolom yang fotonya ditampilkan
const pfTimes = ref<string[] | null>(null);
const frameViewer = ref<InstanceType<typeof FrameViewer> | null>(null);
function onHover(info: { column: number; label: string } | null) {
  hover.value = info;
  if (info) focusColumn.value = info.column; // tetap di posisi terakhir saat kursor keluar
}
const hover = ref<{ column: number; label: string } | null>(null);

const usesLanes = computed(() => props.session.lanes.length > 0);
const rtImpulses = computed(() => props.impulses.filter((i) => i.source !== "camera"));
const nextRank = computed(() => props.crossings.reduce((m, c) => Math.max(m, c.rank), 0) + 1);
const usedLanes = computed(() => new Set(props.crossings.map((c) => c.lane)));
const editable = computed(() => props.session.status === "open" && can("operator"));
const st = computed(() => GROUP_STATUS[props.group.status]);

async function onMark(column: number) {
  if (!props.capture) return;
  if (mode.value === "calibrate") {
    // Kalibrasi butuh sinyal photocell RaceTime2 sungguhan, bukan pemicu kamera.
    const first = rtImpulses.value[0];
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

const hasConfirmed = computed(() => props.crossings.some((c) => c.revision > 0));
const deleting = ref(false);

async function removeGroup() {
  const rt = rtImpulses.value.length;
  const ok = await confirmDialog({
    title: `Hapus kelompok finish #${props.index}?`,
    danger: true,
    okText: "Hapus tangkapan",
    text:
      "Gambar rekaman dan tanda urutan di kelompok ini dihapus permanen." +
      (rt ? ` ${rt} sinyal RaceTime2 tidak hilang — dikembalikan ke daftar "tanpa sesi".` : "") +
      " Tindakan ini tercatat di audit log.",
  });
  if (!ok) return;
  deleting.value = true;
  try {
    if (await attempt(() => api("DELETE", `/api/groups/${props.group._id}`), `Kelompok finish #${props.index} dihapus`)) emit("changed");
  } finally {
    deleting.value = false;
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
      <button
        v-if="editable" class="btn btn-sm btn-danger" :disabled="hasConfirmed || deleting"
        :title="hasConfirmed ? 'Ada hasil yang sudah dikonfirmasi juri — tidak bisa dihapus' : 'Hapus tangkapan ini'"
        @click="removeGroup"
      >
        <AppIcon name="del" /> Hapus
      </button>
    </div>

    <div class="impulses">
      <span class="section-label" style="margin: 0">Pemicu</span>
      <span
        v-for="(i, n) in impulses" :key="i._id" class="chip mono" :class="{ 'chip-cam': i.source === 'camera' }"
        :title="i.source === 'camera' ? 'Photocell virtual (kamera) — hanya memicu rekaman, waktu perahu dari gambar' : i.timeBasis === 'pf-clock' ? 'RaceTime2 (frame tanpa waktu — dicap jam Photo Finish)' : 'Waktu dari RaceTime2'"
      >
        <AppIcon :name="i.source === 'camera' ? 'camera' : 'sensors'" />
        <strong>{{ n + 1 }}</strong> {{ i.deviceTime }}
      </span>
    </div>
    <div v-for="w in group.warnings" :key="w" class="alert alert-warn"><AppIcon name="warning" />{{ w }}</div>

    <div v-if="capture" class="race-window" style="margin-top: 12px">
      <div class="race-toolbar">
        <template v-if="editable">
          <div class="btn-group">
            <button class="btn btn-sm" :class="{ 'is-active': mode === 'mark' }" @click="mode = 'mark'"><AppIcon name="touch" /> Tandai urutan</button>
            <button class="btn btn-sm" :class="{ 'is-active': mode === 'calibrate' }" :disabled="!rtImpulses.length" :title="rtImpulses.length ? '' : 'Butuh sinyal RaceTime2'" @click="mode = 'calibrate'"><AppIcon name="target" /> Kalibrasi kamera</button>
          </div>
          <template v-if="mode === 'mark'">
            <span>Urutan <strong class="readout">{{ nextRank }}</strong></span>
            <select v-if="usesLanes && session.lanes.length > 6" v-model="lane" class="input input-sm" aria-label="Tim" style="width: 220px; background: rgba(255,255,255,.08); color: #fff; border-color: rgba(255,255,255,.2)">
              <option value="" style="color: #000">— pilih tim —</option>
              <option v-for="l in session.lanes" :key="l.lane" :value="l.lane" style="color: #000">
                {{ usedLanes.has(l.lane) ? "✓ " : "" }}#{{ l.bib ?? l.lane }} · {{ l.teamName ?? l.teamId }}
              </option>
            </select>
            <div v-else-if="usesLanes" class="btn-group" aria-label="Lintasan">
              <button
                v-for="l in session.lanes" :key="l.lane" class="btn btn-sm" :class="{ 'is-active': lane === l.lane }"
                :title="l.teamName ?? l.teamId" @click="lane = lane === l.lane ? '' : l.lane"
              >
                {{ l.lane }}<AppIcon v-if="usedLanes.has(l.lane)" name="check" />
              </button>
            </div>
            <input v-else v-model="teamId" class="input input-sm mono" placeholder="Team ID" style="width: 130px; background: rgba(255,255,255,.08); color: #fff; border-color: rgba(255,255,255,.2)" />
          </template>
          <span v-else class="hint">Klik haluan perahu kalibrasi (sinyal pertama).</span>
        </template>
        <span class="spacer" />
        <span class="readout">{{ hover ? `kolom ${hover.column} · ${hover.label}` : `${capture.fps} fps · ${(1000 / capture.fps).toFixed(1)} ms/kolom` }}</span>
        <button class="btn btn-sm" :class="{ 'is-active': smooth }" :title="smooth ? 'Tampilan halus — klik untuk piksel tajam per kolom' : 'Piksel tajam — klik untuk tampilan halus'" @click="smooth = !smooth">
          {{ smooth ? "Halus" : "Piksel" }}
        </button>
        <button class="btn btn-sm" :class="{ 'is-active': zoom === null }" title="Pas selebar panel" @click="zoom = null">Pas</button>
        <label class="row" style="gap: 6px">
          <AppIcon name="zoom" />
          <input :value="zoom ?? scale" type="range" min="1" max="8" step="0.5" aria-label="Zoom sumbu waktu" @input="zoom = Number(($event.target as HTMLInputElement).value)" />
          <span class="mono" style="width: 44px">{{ scale.toFixed(1) }}×</span>
        </label>
      </div>
      <div class="review" @mouseenter="frameViewer?.setActive(true)" @mouseleave="frameViewer?.setActive(false)">
        <SlitScanViewer
          :capture="capture" :crossings="crossings" :impulses="impulses" :can-mark="editable" :zoom="zoom" :smooth="smooth"
          :focus-column="capture.frameCount ? focusColumn : null"
          :mark-color="mode === 'calibrate' ? '#fbbf24' : undefined" @mark="onMark" @hover="onHover" @scale="scale = $event" @times="pfTimes = $event"
        />
        <FrameViewer ref="frameViewer" :capture="capture" :column="focusColumn" :pf-times="pfTimes" @focus="focusColumn = $event" />
      </div>
      <p v-if="editable && mode === 'mark'" class="hint" style="margin: 10px 0 0">
        {{ usesLanes ? "Pilih lintasan, lalu klik" : "Isi Team ID, lalu klik" }} ujung haluan perahu sesuai urutan tiba (kiri = lebih dulu).
        Garis putus-putus = saat pemicu (kuning RaceTime2, biru kamera).
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
.review { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 400px); gap: 12px; align-items: start; }
@media (max-width: 1100px) { .review { grid-template-columns: 1fr; } }
.chip-cam { background: #ecfeff; color: #0e7490; }
.rank { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--brand); color: #fff; font-weight: 800; }
</style>
