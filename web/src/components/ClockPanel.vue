<script setup lang="ts">
// Jam Photo Finish berjalan + kalibrasi manual oleh admin terhadap RaceTime2.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, can } from "../lib/api";
import { applyStatus, clock, nsToMs, pfNow, refreshClock, type ClockStatus } from "../lib/clock";
import { getSocket } from "../lib/socket";

const now = ref<string | null>(null);
const open = ref(false);
const setTime = ref("");
const customTrim = ref<number | null>(null);
const reason = ref("");
const error = ref("");
const busy = ref(false);

const s = computed(() => clock.status);
const diffMs = computed(() => nsToMs(s.value?.diffVsRaceTimeNs));
const trimMs = computed(() => nsToMs(s.value?.trimNs) ?? 0);
const autoFresh = computed(() => !!s.value?.auto && s.value.auto.ageMs < 30_000);
const SOURCE_SHORT = { manual: "manual", racetime: "RaceTime2", "host-local": "jam laptop" } as const;
const SOURCE_LONG = {
  manual: "Manual — dikunci admin",
  racetime: "Otomatis — heartbeat RaceTime2",
  "host-local": "Jam laptop (BELUM dikalibrasi ke RaceTime2)",
} as const;
const diffClass = computed(() => (diffMs.value === null ? "" : Math.abs(diffMs.value) <= 5 ? "ok" : "warn"));

async function act(body: Record<string, unknown>) {
  busy.value = true;
  error.value = "";
  try {
    applyStatus(await api<ClockStatus>("POST", "/api/clock/settings", { ...body, ...(reason.value ? { reason: reason.value } : {}) }));
    await refreshClock();
  } catch (e) {
    error.value = (e as Error).message;
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
const onUpdated = (st: ClockStatus) => {
  applyStatus(st);
};
onMounted(() => {
  refreshClock().catch(() => undefined);
  poll = window.setInterval(() => refreshClock().catch(() => undefined), 5000);
  getSocket().on("clock:updated", onUpdated);
  tick();
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  clearInterval(poll);
  getSocket().off("clock:updated", onUpdated);
});
</script>

<template>
  <div class="clock">
    <button class="clock-face" :title="can('admin') ? 'Pengaturan jam' : 'Jam Photo Finish'" @click="open = !open">
      <span class="mono">{{ now ?? "--:--:--.---" }}</span>
      <span class="badge" :class="{ warn: s?.source === 'host-local' }">{{ SOURCE_SHORT[s?.source ?? "host-local"] }}</span>
      <span v-if="diffMs !== null" class="badge" :class="diffClass">Δ {{ diffMs >= 0 ? "+" : "" }}{{ diffMs.toFixed(1) }} ms</span>
    </button>

    <div v-if="open" class="card clock-panel">
      <h3 style="margin-top: 0">Jam Photo Finish</h3>
      <p class="muted">
        Basis waktu = jam RaceTime2. Waktu ini tercetak di setiap rekaman beserta revisi pengaturannya.
        Rekaman lama tidak berubah bila jam dikalibrasi ulang.
      </p>
      <table>
        <tbody>
          <tr><th>Sumber jam</th><td>{{ SOURCE_LONG[s?.source ?? "host-local"] }} · rev {{ s?.revision ?? 0 }}</td></tr>
          <tr>
            <th>Heartbeat RaceTime2</th>
            <td>
              <template v-if="s?.auto">{{ autoFresh ? "terhubung" : "terputus" }} · {{ (s.auto.ageMs / 1000).toFixed(0) }} dtk lalu · {{ s.auto.samples }} sampel</template>
              <template v-else>belum pernah diterima</template>
            </td>
          </tr>
          <tr><th>Selisih vs RaceTime2</th><td class="mono">{{ diffMs === null ? "—" : `${diffMs >= 0 ? "+" : ""}${diffMs.toFixed(3)} ms` }}</td></tr>
          <tr><th>Trim</th><td class="mono">{{ trimMs >= 0 ? "+" : "" }}{{ trimMs.toFixed(3) }} ms</td></tr>
          <tr><th>Sinkron browser</th><td class="muted">RTT {{ (clock.rttUs / 1000).toFixed(1) }} ms (tampilan saja)</td></tr>
        </tbody>
      </table>

      <template v-if="can('admin')">
        <h4>Kalibrasi (admin)</h4>
        <div class="row">
          <button class="primary" :disabled="busy || !autoFresh" @click="act({ action: 'freeze-from-racetime' })">Kunci dari RaceTime2 (presisi)</button>
          <button :disabled="busy || s?.mode === 'auto'" @click="act({ action: 'use-auto' })">Ikuti otomatis</button>
        </div>
        <p class="muted">"Kunci dari RaceTime2" memakai offset heartbeat yang sudah difilter, sehingga jam PF tetap berjalan tepat walau laptop timing terputus.</p>

        <div class="row">
          <label>Set ke waktu <input v-model="setTime" class="mono" placeholder="HH:MM:SS.mmm" style="width: 130px" /></label>
          <button :disabled="busy || !setTime" @click="act({ action: 'set-time', deviceTime: setTime })">Set</button>
          <span class="muted">presisi ± reaksi, rapikan dengan trim</span>
        </div>

        <div class="row" style="margin-top: 8px">
          <span>Trim</span>
          <button v-for="d in [-100, -10, -1]" :key="d" :disabled="busy" @click="act({ action: 'trim', deltaMs: d })">{{ d }} ms</button>
          <button v-for="d in [1, 10, 100]" :key="d" :disabled="busy" @click="act({ action: 'trim', deltaMs: d })">+{{ d }} ms</button>
          <input v-model.number="customTrim" type="number" step="0.1" placeholder="ms" style="width: 80px" />
          <button :disabled="busy || !customTrim" @click="act({ action: 'trim', deltaMs: customTrim })">Terapkan</button>
          <button :disabled="busy || trimMs === 0" @click="act({ action: 'reset-trim' })">Reset</button>
        </div>
        <p><label>Alasan (masuk audit log) <input v-model="reason" style="width: 260px" /></label></p>
        <p v-if="error" class="error">{{ error }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.clock { position: relative; }
.clock-face { display: inline-flex; gap: 8px; align-items: center; font-size: 18px; }
.clock-panel { position: absolute; right: 0; top: calc(100% + 6px); width: min(560px, calc(100vw - 32px)); z-index: 10; font-size: 14px; }
.clock-panel th { width: 170px; text-transform: none; font-size: 13px; }
</style>
