<script setup lang="ts">
import { ref } from "vue";
import { api, setAuth } from "../lib/api";
import type { User } from "../lib/types";
import AppIcon from "./ui/AppIcon.vue";
import logo from "../assets/logo-sts-blue.png";

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
  <main class="login">
    <form class="login-card" @submit.prevent="submit">
      <img :src="logo" alt="" class="login-logo" />
      <h1 class="page-title" style="text-align: center">STS Photo Finish</h1>
      <p class="page-subtitle" style="text-align: center; margin-bottom: 22px">Masuk untuk mengelola sesi photo finish lomba</p>

      <label class="field">
        <span class="field-label">Username</span>
        <span class="input-group"><AppIcon name="person" /><input v-model="username" class="input" autocomplete="username" required autofocus /></span>
      </label>
      <label class="field" style="margin-top: 14px">
        <span class="field-label">Password</span>
        <span class="input-group"><AppIcon name="lock" /><input v-model="password" class="input" type="password" autocomplete="current-password" required /></span>
      </label>

      <div v-if="error" class="alert alert-danger" style="margin-top: 14px"><AppIcon name="error" /> {{ error }}</div>
      <button class="btn btn-primary btn-lg btn-block" style="margin-top: 20px" :disabled="busy">{{ busy ? "Memeriksa…" : "Masuk" }}</button>
      <p class="hint" style="text-align: center; margin: 16px 0 0">Akun dibuat oleh admin. Sesi login berakhir otomatis setelah 8 jam.</p>
    </form>
  </main>
</template>

<style scoped>
.login { flex: 1 0 auto; display: grid; place-items: center; padding: 40px 16px; background: radial-gradient(1200px 500px at 50% -10%, #d7ebf6 0%, transparent 60%), var(--page); }
.login-card { width: 100%; max-width: 420px; background: #fff; border: 1px solid var(--border); border-radius: 22px; box-shadow: var(--shadow); padding: 32px 28px; }
.login-logo { display: block; width: 72px; height: 72px; margin: 0 auto 14px; }
</style>
