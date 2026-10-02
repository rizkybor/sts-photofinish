<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { auth, can, setAuth } from "./lib/api";
import { armedSession, beep, closeQueue, isTyping, onCloseFinish, sessions } from "./lib/sessions";
import { closeSocket } from "./lib/socket";
import type { FinishEvent, Session } from "./lib/types";
import { toast } from "./lib/ui";
import AppFooter from "./components/AppFooter.vue";
import AppNavbar, { type View } from "./components/AppNavbar.vue";
import CameraSettings from "./components/CameraSettings.vue";
import CameraStandby from "./components/CameraStandby.vue";
import HeatBar from "./components/HeatBar.vue";
import LoginView from "./components/LoginView.vue";
import SessionFormModal from "./components/SessionFormModal.vue";
import SessionList from "./components/SessionList.vue";
import SessionView from "./components/SessionView.vue";
import UiHost from "./components/ui/UiHost.vue";

const params = new URLSearchParams(location.search);
const sessionId = ref<string | null>(params.get("session"));
const focusGroup = ref<string | null>(params.get("finish"));
const view = ref<View>(params.has("standby") ? "standby" : params.has("kamera") ? "camera-settings" : sessionId.value ? "session" : "sessions");
/** Halaman asal saat membuka detail sesi — untuk tombol kembali (Standby saat lomba). */
const cameFrom = ref<View>(params.has("from-standby") ? "standby" : "sessions");

function go(next: View, id: string | null = null, groupId: string | null = null) {
  if (next === "session" && view.value !== "session") cameFrom.value = view.value === "standby" ? "standby" : "sessions";
  view.value = next;
  sessionId.value = id;
  focusGroup.value = groupId;
  const q = new URLSearchParams();
  if (next === "standby") q.set("standby", "");
  if (next === "camera-settings") q.set("kamera", "");
  if (next === "session" && id) {
    q.set("session", id);
    if (groupId) q.set("finish", groupId);
    if (cameFrom.value === "standby") q.set("from-standby", "");
  }
  const qs = q.toString().replace(/=(?=&|$)/g, "");
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  window.scrollTo({ top: 0 });
}
const openSession = (id: string, groupId?: string) => go("session", id, groupId ?? null);
const review = (f: FinishEvent) => openSession(f.sessionId, f.groupId);
const back = () => go(cameFrom.value);

function logout() {
  closeSocket();
  setAuth(null, null);
  go("sessions");
}

const showHeatBar = computed(() => !!auth.user && ["sessions", "session", "standby"].includes(view.value));
const currentId = computed(() => (view.value === "session" ? sessionId.value : null));

// ---------------------------------------------------------------- heat/run berikutnya
const nextOpen = ref(false);
/** Sumber salinan: sesi yang sedang dibuka, lalu sesi aktif, lalu sesi terbaru. */
const nextFrom = ref<Session | null>(null);
function openNext() {
  if (!can("operator")) return;
  nextFrom.value = sessions.list.find((s) => s._id === currentId.value) ?? armedSession.value ?? sessions.list.find((s) => s.status === "open") ?? null;
  nextOpen.value = true;
}
function openNew() {
  nextFrom.value = null;
  nextOpen.value = true;
}
/** Dari Standby: tetap di Standby (kamera tetap terpantau); dari tempat lain: buka sesinya. */
let createdHere: string | null = null;
function onCreated(id: string) {
  createdHere = id;
  nextOpen.value = false;
  if (view.value !== "standby") openSession(id);
}

// ---------------------------------------------------------------- notifikasi
// Heat baru diaktifkan (mis. "Kirim heat" dari sts-timingsystem): cukup kabari.
watch(() => armedSession.value?._id, (id, prev) => {
  if (id && prev !== undefined && id !== prev && id !== createdHere) toast("info", "Sesi aktif berganti", armedSession.value!.label);
});
// Finish berdekatan: bunyi + toast (di Standby sudah ada banner besar).
const off = onCloseFinish((f) => {
  beep();
  if (view.value !== "standby") toast("warning", `Finish berdekatan — ${f.boats} perahu`, `${f.sessionLabel} · tekan T untuk meninjau`, 8000);
});

function onKey(e: KeyboardEvent) {
  if (!auth.user || isTyping(e)) return;
  const k = e.key.toLowerCase();
  const act = (fn: () => void) => { e.preventDefault(); fn(); };
  if (k === "t" && closeQueue.value.length) act(() => review(closeQueue.value[0]!));
  else if (k === "s" && can("operator") && view.value !== "standby") act(() => go("standby"));
  else if (k === "a" && armedSession.value) act(() => openSession(armedSession.value!._id));
  else if (k === "n" && can("operator")) act(openNext);
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  off();
});
</script>

<template>
  <AppNavbar :view="view" @navigate="go" @logout="logout" />
  <HeatBar v-if="showHeatBar" :current-id="currentId" @open="openSession" @next="openNext" />
  <LoginView v-if="!auth.user" />
  <main v-else class="page">
    <CameraStandby v-if="view === 'standby' && can('operator')" @back="go('sessions')" @review="review" />
    <CameraSettings v-else-if="view === 'camera-settings' && can('operator')" @back="go('sessions')" />
    <SessionView
      v-else-if="view === 'session' && sessionId" :key="sessionId" :session-id="sessionId" :focus-group="focusGroup" :came-from="cameFrom"
      @back="back" @open="openSession" @next="openNext"
    />
    <SessionList v-else @open="openSession" @create="openNew" />
  </main>
  <SessionFormModal :open="nextOpen" :from="nextFrom" @close="nextOpen = false" @created="onCreated" />
  <AppFooter />
  <UiHost />
</template>
