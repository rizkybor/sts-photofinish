<script setup lang="ts">
import { ref } from "vue";
import { api, setAuth } from "../lib/api";
import type { User } from "../lib/types";

const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    const res = await api<{ token: string; user: User }>("POST", "/api/auth/login", { username: username.value, password: password.value });
    setAuth(res.token, res.user);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
    password.value = "";
  }
}
</script>

<template>
  <form class="card" style="max-width: 360px; margin: 40px auto" @submit.prevent="submit">
    <h2 style="margin-top: 0">Masuk</h2>
    <p><label>Username <input v-model="username" autocomplete="username" required /></label></p>
    <p><label>Password <input v-model="password" type="password" autocomplete="current-password" required /></label></p>
    <p v-if="error" class="error">{{ error }}</p>
    <button class="primary" :disabled="busy">Masuk</button>
  </form>
</template>
