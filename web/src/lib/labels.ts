import type { RaceCategory } from "./types";

export const CATEGORY: Record<RaceCategory, { label: string; lanes: number }> = {
  H2H: { label: "Head to Head", lanes: 2 },
  RX: { label: "Rafting Cross", lanes: 4 },
  DRR: { label: "Down River Race", lanes: 0 },
  SPRINT: { label: "Sprint", lanes: 0 },
  SLALOM: { label: "Slalom", lanes: 0 },
};

export const TIME_SOURCE = {
  impulse: { label: "Impuls RaceTime2", cls: "status-success" },
  camera: { label: "Waktu kamera", cls: "status-upcoming" },
  manual: { label: "Input manual", cls: "status-neutral" },
} as const;

export const GROUP_STATUS = {
  collecting: { label: "Mengumpulkan impuls", cls: "status-upcoming" },
  extracting: { label: "Merekam", cls: "status-neutral" },
  ready: { label: "Siap ditinjau", cls: "status-success" },
} as const;
