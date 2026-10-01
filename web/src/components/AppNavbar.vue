<script setup lang="ts">
import { auth, can } from "../lib/api";
import { realtime } from "../lib/socket";
import ClockPanel from "./ClockPanel.vue";
import AppIcon from "./ui/AppIcon.vue";
import logo from "../assets/logo-sts-white.png";

export type View = "sessions" | "session" | "standby";
defineProps<{ view: View }>();
const emit = defineEmits<{ navigate: [view: View]; logout: [] }>();

const ROLE_LABEL = { admin: "Admin", judge: "Juri", operator: "Operator", viewer: "Viewer" } as const;
</script>

<template>
  <header class="nav">
    <div class="nav-inner">
      <button class="brand" @click="emit('navigate', 'sessions')">
        <img :src="logo" alt="" />
        <span class="brand-text">
          <strong>STS Photo Finish</strong>
          <small>Sustainable Timing System</small>
        </span>
      </button>

      <nav v-if="auth.user" class="nav-links">
        <button class="nav-link" :class="{ active: view === 'sessions' || view === 'session' }" @click="emit('navigate', 'sessions')">
          <AppIcon name="finish" /><span class="lbl">Sesi Lomba</span>
        </button>
        <button v-if="can('operator')" class="nav-link" :class="{ active: view === 'standby' }" @click="emit('navigate', 'standby')">
          <AppIcon name="camera" /><span class="lbl">Standby Kamera</span>
        </button>
      </nav>

      <div v-if="auth.user" class="nav-right">
        <span class="conn" :class="realtime.connected ? 'on' : 'off'" :title="realtime.connected ? 'Realtime terhubung' : 'Realtime terputus — mencoba lagi'">
          <AppIcon :name="realtime.connected ? 'wifi' : 'wifiOff'" />
        </span>
        <ClockPanel />
        <div class="user">
          <span class="avatar"><AppIcon name="person" /></span>
          <span class="user-text"><strong>{{ auth.user.name }}</strong><small>{{ ROLE_LABEL[auth.user.role] }}</small></span>
        </div>
        <button class="nav-link" title="Keluar" @click="emit('logout')"><AppIcon name="logout" /><span class="hide-sm">Keluar</span></button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.nav { position: sticky; top: 0; z-index: 1000; background: var(--brand); color: #fff; box-shadow: 0 2px 10px rgba(15, 23, 42, 0.18); }
.nav-inner { max-width: 1280px; margin: 0 auto; height: var(--nav-h); padding: 0 16px; display: flex; align-items: center; gap: 18px; }
.brand { all: unset; cursor: pointer; display: flex; align-items: center; gap: 10px; }
.brand img { width: 42px; height: 42px; }
.brand-text { display: flex; flex-direction: column; line-height: 1.1; }
.brand-text strong { font-size: 1.05rem; font-weight: 800; letter-spacing: 0.01em; }
.brand-text small { font-size: 0.72rem; opacity: 0.8; font-style: italic; }
.nav-links { display: flex; gap: 4px; }
.nav-link { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; font-weight: 600; font-size: 0.92rem; color: rgba(255, 255, 255, 0.86); }
.nav-link:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
.nav-link.active { color: #fff; background: linear-gradient(90deg, #13628d, var(--brand-2)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }
.nav-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.conn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 999px; font-size: 18px; }
.conn.on { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
.conn.off { background: rgba(220, 38, 38, 0.3); color: #fecaca; animation: pulse 1.2s infinite; }
.user { display: flex; align-items: center; gap: 8px; padding-left: 12px; border-left: 1px solid rgba(255, 255, 255, 0.2); }
.avatar { width: 32px; height: 32px; border-radius: 999px; display: grid; place-items: center; background: rgba(255, 255, 255, 0.16); font-size: 18px; }
.user-text { display: flex; flex-direction: column; line-height: 1.15; }
.user-text strong { font-size: 0.88rem; }
.user-text small { font-size: 0.72rem; opacity: 0.8; }
@media (max-width: 980px) { .user-text, .brand-text small, .hide-sm { display: none; } .nav-inner { gap: 10px; } }
@media (max-width: 720px) {
  .brand-text, .lbl, .user, .conn { display: none; }
  .nav-inner { gap: 6px; padding: 0 10px; }
  .nav-link { padding: 8px; font-size: 1.1rem; }
  .nav-right { gap: 4px; }
}
</style>
