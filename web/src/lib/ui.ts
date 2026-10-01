// Toast & dialog konfirmasi — satu instance global, dipakai semua halaman.
import { reactive } from "vue";

export type ToastKind = "success" | "error" | "warning" | "info";
export interface Toast { id: number; kind: ToastKind; title: string; text?: string }

export const toasts = reactive<Toast[]>([]);
let nextId = 1;

export function toast(kind: ToastKind, title: string, text?: string, ms = kind === "error" ? 7000 : 4000) {
  const id = nextId++;
  toasts.push({ id, kind, title, text });
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

export interface ConfirmOptions { title: string; text: string; okText?: string; cancelText?: string; danger?: boolean }
export const confirmState = reactive<{ open: boolean; opts: ConfirmOptions | null; resolve: ((v: boolean) => void) | null }>({
  open: false, opts: null, resolve: null,
});

/** Dialog konfirmasi berbasis Promise — untuk aksi yang tidak bisa dibatalkan. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => Object.assign(confirmState, { open: true, opts, resolve }));
}

export function closeConfirm(result: boolean) {
  confirmState.resolve?.(result);
  Object.assign(confirmState, { open: false, opts: null, resolve: null });
}

/** Jalankan aksi API dengan toast sukses/gagal yang konsisten. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (success) toast("success", success);
    return r;
  } catch (e) {
    toast("error", "Gagal", (e as Error).message);
    return undefined;
  }
}
