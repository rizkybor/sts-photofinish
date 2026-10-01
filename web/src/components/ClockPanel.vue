<script setup lang="ts">
// Jam Photo Finish berjalan (di navbar) + panel kalibrasi admin terhadap RaceTime2.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, can } from "../lib/api";
import { applyStatus, clock, nsToMs, pfNow, refreshClock, type ClockStatus } from "../lib/clock";
import { getSocket } from "../lib/socket";
import { toast } from "../lib/ui";
import AppIcon from "./ui/AppIcon.vue";

const now = ref<string | null>(null);
const open = ref(false);
const setTime = ref("");
const customTrim = ref<number | null>(null);
const reason = ref("");
const busy = ref(false);
const root = ref<HTMLElement | null>(null);

const s = computed(() => clock.status);
const diffMs = computed(() => nsToMs(s.value?.diffVsRaceTimeNs));
const trimMs = computed(() => nsToMs(s.value?.trimNs) ?? 0);
const autoFresh = computed(() => !!s.value?.auto && s.value.auto.ageMs < 30_000);
const source = computed(() => s.value?.source ?? "host-local");

const SOURCE = {
  manual: { short: "Manual", long: "Dikunci admin", cls: "status-success" },
  racetime: { short: "RaceTime2", long: "Mengikuti heartbeat RaceTime2", cls: "status-neutral" },
  "host-local": { short: "Belum kalibrasi", long: "Jam laptop — belum disamakan dengan RaceTime2", cls: "status-upcoming" },
} as const;

const fmtMs = (v: number | null, digits = 1) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)} ms`);
const diffCls = computed(() => (diffMs.value === null ? "status-muted" : Math.abs(diffMs.value) <= 5 ? "status-success" : "status-upcoming"));

async function act(body: Record<string, unknown>, done: string) {
  busy.value = true;
  try {
    applyStatus(await api<ClockStatus>("POST", "/api/clock/settings", { ...body, ...(reason.value ? { reason: reason.value } : {}) }));
    await refreshClock();
    toast("success", done);
  } catch (e) {
    toast("error", "Kalibrasi gagal", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

let raf = 0;
let poll: number | undefined;
const tick = () => {
  now.value = pfNow();
  raf = requestAnimationFrame(tick);
};
const onUpdated = (st: ClockStatus) => applyStatus(st);
const onDocClick = (e: MouseEvent) => {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
};
onMounted(() => {
  refreshClock().catch(() => undefined);
  poll = window.setInterval(() => refreshClock().catch(() => undefined), 5000);
  getSocket().on("clock:updated", onUpdated);
  document.addEventListener("mousedown", onDocClick);
  tick();
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  clearInterval(poll);
  getSocket().off("clock:updated", onUpdated);
  document.removeEventListener("mousedown", onDocClick);
});
</script>

<template>
  <div ref="root" class="clock">
    <button class="clock-face" :class="{ warn: source === 'host-local' }" :aria-expanded="open" title="Jam Photo Finish" @click="open = !open">
      <AppIcon name="timer" size="18" />
      <span class="mono time">{{ now ?? "--:--:--.---" }}</span>
      <span class="src">{{ SOURCE[source].short }}</span>
      <AppIcon name="down" />
    </button>

    <div v-if="open" class="panel">
      <div class="panel-head">
        <div>
          <div class="section-label" style="margin: 0">Jam Photo Finish</div>
          <div class="mono big">{{ now ?? "--:--:--.---" }}</div>
        </div>
        <span class="status-pill" :class="SOURCE[source].cls"><span class="dot" />{{ SOURCE[source].short }}</span>
      </div>
      <p class="hint" style="margin: 0 0 12px">
        Basis waktu = jam RaceTime2. Waktu ini dicetak di setiap rekaman beserta revisinya; rekaman lama tidak berubah bila jam dikalibrasi ulang.
      </p>

      <dl class="facts">
        <div><dt>Sumber</dt><dd>{{ SOURCE[source].long }} · rev {{ s?.revision ?? 0 }}</dd></div>
        <div>
          <dt>Heartbeat RaceTime2</dt>
          <dd>
            <template v-if="s?.auto">{{ autoFresh ? "Terhubung" : "Terputus" }} · {{ (s.auto.ageMs / 1000).toFixed(0) }} dtk lalu</template>
            <template v-else>Tidak tersedia (frame tanpa waktu)</template>
          </dd>
        </div>
        <div><dt>Selisih vs RaceTime2</dt><dd><span class="status-pill" :class="diffCls">{{ fmtMs(diffMs, 3) }}</span></dd></div>
        <div><dt>Trim</dt><dd class="mono">{{ fmtMs(trimMs, 3) }}</dd></div>
      </dl>

      <template v-if="can('admin')">
        <div class="section-label">Kalibrasi admin</div>
        <div class="stack">
          <div class="row">
            <button class="btn btn-primary btn-sm" :disabled="busy || !autoFresh" @click="act({ action: 'freeze-from-racetime' }, 'Jam dikunci dari RaceTime2')">
              <AppIcon name="lock" /> Kunci dari RaceTime2
            </button>
            <button class="btn btn-sm" :disabled="busy || s?.mode === 'auto'" @click="act({ action: 'use-auto' }, 'Jam mengikuti RaceTime2')">Ikuti otomatis</button>
          </div>

          <div class="row">
            <input v-model="setTime" class="input input-sm mono" placeholder="HH:MM:SS.mmm" style="width: 150px" aria-label="Waktu RaceTime2" />
            <button class="btn btn-sm" :disabled="busy || !setTime" @click="act({ action: 'set-time', deviceTime: setTime }, 'Jam diset ke ' + setTime)">
              <AppIcon name="edit" /> Set ke waktu
            </button>
          </div>

          <div class="row">
            <div class="btn-group">
              <button v-for="d in [-100, -10, -1]" :key="d" class="btn btn-sm" :disabled="busy" @click="act({ action: 'trim', deltaMs: d }, `Trim ${d} ms`)">{{ d }}</button>
              <button v-for="d in [1, 10, 100]" :key="d" class="btn btn-sm" :disabled="busy" @click="act({ action: 'trim', deltaMs: d }, `Trim +${d} ms`)">+{{ d }}</button>
            </div>
            <span class="hint">ms</span>
          </div>
          <div class="row">
            <input v-model.number="customTrim" type="number" step="0.1" class="input input-sm" placeholder="Trim (ms)" style="width: 110px" />
            <button class="btn btn-sm" :disabled="busy || !customTrim" @click="act({ action: 'trim', deltaMs: customTrim }, `Trim ${customTrim} ms`)">Terapkan</button>
            <button class="btn btn-sm btn-ghost" :disabled="busy || trimMs === 0" @click="act({ action: 'reset-trim' }, 'Trim direset')">Reset trim</button>
          </div>
          <input v-model="reason" class="input input-sm" placeholder="Alasan perubahan (masuk audit log)" />
        </div>
        <p class="hint" style="margin: 10px 0 0">
          RaceTime2 saat ini tidak mengirim waktu. Gunakan <strong>Set ke waktu</strong> sesuai layar RaceTime2, lalu rapikan dengan <strong>Trim</strong>.
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.clock { position: relative; }
.clock-face { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 10px; background: rgba(0, 0, 0, 0.22); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); color: #fff; }
.clock-face:hover { background: rgba(0, 0, 0, 0.3); }
.clock-face.warn { box-shadow: inset 0 0 0 1px #fbbf24; }
.time { font-size: 1.15rem; font-weight: 700; letter-spacing: 0.02em; color: #e0f2fe; }
.src { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 6px; background: rgba(255, 255, 255, 0.16); }
.clock-face.warn .src { background: #fbbf24; color: #78350f; }
.panel { position: absolute; right: 0; top: calc(100% + 10px); width: min(440px, calc(100vw - 24px)); background: #fff; color: var(--text); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22); padding: 18px; z-index: 1100; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.big { font-size: 1.7rem; font-weight: 800; color: var(--ink); }
.facts { margin: 0 0 16px; display: grid; gap: 8px; }
.facts > div { display: grid; grid-template-columns: 150px 1fr; gap: 8px; align-items: center; font-size: 0.86rem; }
.facts dt { color: var(--muted); font-weight: 600; }
.facts dd { margin: 0; color: var(--text); }
.stack { display: flex; flex-direction: column; gap: 10px; }
@media (max-width: 720px) {
  .src, .clock-face > .iconify:last-child { display: none; }
  .clock-face { padding: 6px 8px; gap: 5px; }
  .time { font-size: 0.92rem; }
  .panel { position: fixed; left: 12px; right: 12px; top: calc(var(--nav-h) + 8px); width: auto; max-height: calc(100vh - var(--nav-h) - 24px); overflow: auto; }
}
</style>
