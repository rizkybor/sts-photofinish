<script setup lang="ts">
// Host global toast + dialog konfirmasi (dipasang sekali di App.vue).
import { closeConfirm, confirmState, dismissToast, toasts } from "../../lib/ui";
import AppIcon from "./AppIcon.vue";
import Modal from "./Modal.vue";

const ICON = { success: "check", error: "error", warning: "warning", info: "info" } as const;
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.kind">
        <AppIcon :name="ICON[t.kind]" size="22" />
        <div class="toast-body"><strong>{{ t.title }}</strong><span v-if="t.text">{{ t.text }}</span></div>
        <button class="toast-x" aria-label="Tutup" @click="dismissToast(t.id)"><AppIcon name="close" /></button>
      </div>
    </TransitionGroup>
  </div>

  <Modal :open="confirmState.open" :title="confirmState.opts?.title ?? ''" :width="440" @close="closeConfirm(false)">
    <p style="margin: 0; color: var(--text-2)">{{ confirmState.opts?.text }}</p>
    <template #footer>
      <button class="btn" @click="closeConfirm(false)">{{ confirmState.opts?.cancelText ?? "Batal" }}</button>
      <button class="btn" :class="confirmState.opts?.danger ? 'btn-danger' : 'btn-primary'" @click="closeConfirm(true)">
        {{ confirmState.opts?.okText ?? "Ya, lanjutkan" }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 10px; z-index: 3000; width: min(380px, calc(100vw - 32px)); }
.toast { display: flex; gap: 10px; align-items: flex-start; background: #fff; border: 1px solid var(--border); border-left: 5px solid; border-radius: 14px; padding: 12px 12px 12px 14px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.16); }
.toast-body { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 0.88rem; color: var(--text-2); }
.toast-body strong { color: var(--ink); }
.toast-x { all: unset; cursor: pointer; color: var(--faint); }
.toast-success { border-left-color: var(--ok); } .toast-success > .iconify { color: var(--ok); }
.toast-error { border-left-color: var(--bad); } .toast-error > .iconify { color: var(--bad); }
.toast-warning { border-left-color: var(--warn); } .toast-warning > .iconify { color: var(--warn); }
.toast-info { border-left-color: var(--info); } .toast-info > .iconify { color: var(--info); }
.toast-enter-active, .toast-leave-active { transition: all 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
