import type { RaceCategory } from "./types";

/**
 * `unit`: sebutan satu sesi di format itu. H2H/RX berganti sesi tiap heat;
 * format start individu (Sprint/Slalom) dan DRR cukup satu sesi per kategori/run
 * karena perahu finish satu per satu — tidak perlu pindah sesi tiap perahu.
 */
export const CATEGORY: Record<RaceCategory, { label: string; short: string; lanes: number; unit: string; hint: string }> = {
  H2H: { label: "Head to Head", short: "H2H", lanes: 2, unit: "Heat", hint: "Satu sesi per heat (2 perahu)." },
  RX: { label: "Rafting Cross", short: "RX", lanes: 4, unit: "Heat", hint: "Satu sesi per heat (4 perahu)." },
  DRR: { label: "Down River Race", short: "DRR", lanes: 0, unit: "Kategori", hint: "Satu sesi per kategori — semua perahu kategori itu finish di sesi yang sama." },
  SPRINT: { label: "Sprint", short: "Sprint", lanes: 0, unit: "Run", hint: "Satu sesi per run/kategori — perahu start bergantian, finish satu per satu." },
  SLALOM: { label: "Slalom", short: "Slalom", lanes: 0, unit: "Run", hint: "Satu sesi per run (Run 1 / Run 2) — perahu finish satu per satu." },
};

export const TIME_SOURCE = {
  impulse: { label: "Sinyal RaceTime2", cls: "status-success" },
  camera: { label: "Waktu kamera", cls: "status-upcoming" },
  manual: { label: "Input manual", cls: "status-neutral" },
} as const;

export const GROUP_STATUS = {
  collecting: { label: "Mengumpulkan sinyal", cls: "status-upcoming" },
  extracting: { label: "Merekam", cls: "status-neutral" },
  ready: { label: "Siap ditinjau", cls: "status-success" },
} as const;
