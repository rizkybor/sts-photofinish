import { reactive } from "vue";
import type { User } from "./types";

// Token disimpan di sessionStorage (hilang saat tab ditutup) dan berumur
// pendek (8 jam). Tablet juri di lapangan sering dipinjamkan bergantian.
const KEY = "pf.auth";

export const auth = reactive<{ token: string | null; user: User | null }>(load());

function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as { token: string; user: User };
  } catch { /* abaikan */ }
  return { token: null, user: null };
}

export function setAuth(token: string | null, user: User | null) {
  auth.token = token;
  auth.user = user;
  try {
    if (token) sessionStorage.setItem(KEY, JSON.stringify({ token, user }));
    else sessionStorage.removeItem(KEY);
  } catch { /* abaikan */ }
}

const RANK: Record<string, number> = { viewer: 0, operator: 1, judge: 2, admin: 3 };
export const can = (role: keyof typeof RANK) => !!auth.user && RANK[auth.user.role]! >= RANK[role]!;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && auth.token) setAuth(null, null);
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return data as T;
}
