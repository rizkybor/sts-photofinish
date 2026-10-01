<script setup lang="ts">
import { ref } from "vue";
import { auth, setAuth } from "./lib/api";
import { closeSocket } from "./lib/socket";
import ClockPanel from "./components/ClockPanel.vue";
import LoginView from "./components/LoginView.vue";
import SessionList from "./components/SessionList.vue";
import SessionView from "./components/SessionView.vue";

const sessionId = ref<string | null>(new URLSearchParams(location.search).get("session"));

function open(id: string | null) {
  sessionId.value = id;
  history.replaceState(null, "", id ? `?session=${id}` : location.pathname);
}

function logout() {
  closeSocket();
  setAuth(null, null);
}
</script>

<template>
  <header class="top">
    <h1>STS Photo Finish</h1>
    <template v-if="auth.user">
      <ClockPanel />
      <span class="muted">{{ auth.user.name }} · {{ auth.user.role }}</span>
      <button @click="logout">Keluar</button>
    </template>
  </header>
  <main>
    <LoginView v-if="!auth.user" />
    <SessionView v-else-if="sessionId" :key="sessionId" :session-id="sessionId" @back="open(null)" />
    <SessionList v-else @open="open" />
  </main>
</template>
