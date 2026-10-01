<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ open: boolean; title: string; subtitle?: string; width?: number }>();
const emit = defineEmits<{ close: [] }>();

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape" && props.open) emit("close");
};
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-backdrop" @mousedown.self="emit('close')">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="title" :style="{ maxWidth: (width ?? 560) + 'px' }">
          <header class="modal-head">
            <div>
              <h3 class="modal-title">{{ title }}</h3>
              <p v-if="subtitle" class="modal-subtitle">{{ subtitle }}</p>
            </div>
            <button class="btn btn-ghost btn-sm" aria-label="Tutup" @click="emit('close')"><AppIcon name="close" size="20" /></button>
          </header>
          <div class="modal-body"><slot /></div>
          <footer v-if="$slots.footer" class="modal-foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(2px); display: grid; place-items: center; padding: 16px; z-index: 2000; }
.modal { width: 100%; background: #fff; border-radius: 18px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.25); max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 12px; border-bottom: 1px solid var(--surface-3); }
.modal-head > div { flex: 1; }
.modal-title { margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--ink); }
.modal-subtitle { margin: 2px 0 0; color: var(--muted); font-size: 0.86rem; }
.modal-body { padding: 18px 20px; overflow: auto; }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--surface-3); background: var(--surface-2); border-radius: 0 0 18px 18px; }
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-active .modal, .modal-leave-active .modal { transition: transform 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .modal { transform: translateY(8px) scale(0.98); }
</style>
