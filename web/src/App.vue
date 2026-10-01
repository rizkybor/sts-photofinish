<script setup lang="ts">
import { ref } from "vue";
import { auth, can, setAuth } from "./lib/api";
import { closeSocket } from "./lib/socket";
import AppFooter from "./components/AppFooter.vue";
import AppNavbar, { type View } from "./components/AppNavbar.vue";
import CameraStandby from "./components/CameraStandby.vue";
import LoginView from "./components/LoginView.vue";
import SessionList from "./components/SessionList.vue";
import SessionView from "./components/SessionView.vue";
import UiHost from "./components/ui/UiHost.vue";

const params = new URLSearchParams(location.search);
const sessionId = ref<string | null>(params.get("session"));
const view = ref<View>(params.has("standby") ? "standby" : sessionId.value ? "session" : "sessions");

function go(next: View, id: string | null = null) {
  view.value = next;
  sessionId.value = id;
  const qs = next === "standby" ? "?standby" : next === "session" && id ? `?session=${id}` : "";
  history.replaceState(null, "", qs || location.pathname);
  window.scrollTo({ top: 0 });
}

function logout() {
  closeSocket();
  setAuth(null, null);
  go("sessions");
}
</script>

<template>
  <AppNavbar :view="view" @navigate="go" @logout="logout" />
  <LoginView v-if="!auth.user" />
  <main v-else class="page">
    <CameraStandby v-if="view === 'standby' && can('operator')" @back="go('sessions')" />
    <SessionView v-else-if="view === 'session' && sessionId" :key="sessionId" :session-id="sessionId" @back="go('sessions')" />
    <SessionList v-else @open="(id) => go('session', id)" />
  </main>
  <AppFooter />
  <UiHost />
</template>
