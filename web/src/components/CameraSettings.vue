<script setup lang="ts">
// Pengaturan kamera: pilih kamera dari hasil pindai (jenisnya — laptop /
// iPhone / eksternal — dikenali otomatis), fps, garis finish (klik di gambar live), photocell virtual, dan
// foto frame. Diterapkan agent saat berjalan; gagal → agent kembali ke
// pengaturan lama dan perubahan tidak disimpan.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { api } from "../lib/api";
import { tiltFromVerticalDeg, tiltLevel, type Line } from "../lib/geometry";
import { getSocket } from "../lib/socket";
import { toast } from "../lib/ui";
import TriggerLog from "./TriggerLog.vue";
import AppIcon from "./ui/AppIcon.vue";

const emit = defineEmits<{ back: [] }>();

type SourceType = "laptop" | "iphone" | "external" | "ip" | "video";
interface Config {
  sourceType: SourceType; source: string; fps: number; width: number | null; height: number | null;
  finishLine: Line | null;
  trigger: { enabled: boolean; threshold: number; minRun: number };
  frames: { enabled: boolean; fps: number; width: number };
  objectFilter?: ObjectFilterConfig;
}
interface ObjectFilterConfig { enabled: boolean; classes: string[]; model: string; conf: number }
interface ObjectFilterStatus {
  enabled: boolean; ready?: boolean; error?: string | null; classes?: string[]; model?: string; modelClasses?: string[];
  passed?: number; rejected?: number; lastLabel?: string | null; lastRejected?: string | null; lastMs?: number | null;
}
interface Status {
  cameraId: string; connected?: boolean; host?: string; running?: boolean; width?: number; height?: number; measuredFps?: number;
  finishLine?: Line | null; lastError?: string | null; settings?: Config; lastFrameAgeMs?: number | null; notice?: string | null; retrying?: boolean;
  objectFilter?: ObjectFilterStatus; detector?: { available: boolean; models: string[] };
}
interface CameraRow { cameraId: string; connected: boolean; status: Status | null; saved: { config: Config; revision: number; updatedAt: string } | null }
type DeviceKind = "laptop" | "iphone" | "external";
interface CameraMode { width: number; height: number; maxFps: number }
interface ScannedCamera { index: number; width: number; height: number; inUse: boolean; thumb?: string | null; name?: string; kind?: DeviceKind; modes?: CameraMode[] }
interface ScanResult { cameras: ScannedCamera[]; deviceNames: string[]; videos: string[] }

/** Jenis kamera dikenali agent dari sistem; menentukan batas fps & petunjuk. */
const KIND_META: Record<DeviceKind, { label: string; hint: string }> = {
  laptop: { label: "Kamera laptop", hint: "Kamera bawaan laptop (FaceTime HD). Cocok untuk uji coba, 24–30 fps." },
  iphone: { label: "iPhone", hint: "Continuity Camera: Apple ID sama dengan Mac, Wi-Fi + Bluetooth nyala, iPhone landscape, diam di tripod, layar terkunci." },
  external: { label: "Kamera eksternal", hint: "Kamera USB/industri. Untuk lomba gunakan 120–240 fps agar akurat 1/100 detik." },
};
/** Kamera IP & video uji tidak ditawarkan di web (masih bisa lewat PF_CAMERA_SOURCE di .env agent). */
const LEGACY_SOURCE: Partial<Record<SourceType, string>> = { ip: "Kamera IP", video: "Video uji" };
const SENSITIVITY = {
  rendah: { label: "Rendah", threshold: 45, minRun: 0.1, hint: "Sedikit pemicu palsu — untuk air beriak / banyak bayangan" },
  sedang: { label: "Sedang", threshold: 30, minRun: 0.06, hint: "Seimbang (bawaan)" },
  tinggi: { label: "Tinggi", threshold: 20, minRun: 0.04, hint: "Perahu kecil/jauh tetap terdeteksi, lebih mudah terpicu" },
} as const;
const FPS_OPTIONS = [24, 25, 30, 50, 60, 120, 240];
/** Tanpa data mode dari agent (agent lama / bukan macOS): batas umum per jenis kamera. */
const FALLBACK_MAX_FPS: Partial<Record<SourceType, number>> = { laptop: 30, iphone: 30 };
const RES_OPTIONS = [
  { label: "Otomatis (bawaan kamera)", w: null, h: null },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
];

const cameras = ref<CameraRow[]>([]);
const cameraId = ref<string | null>(null);
const loading = ref(true);
const busy = ref<"apply" | "scan" | null>(null);
const scanResult = ref<ScanResult | null>(null);
const form = reactive<Config>({
  sourceType: "laptop", source: "0", fps: 30, width: null, height: null, finishLine: null,
  trigger: { enabled: true, threshold: 30, minRun: 0.06 }, frames: { enabled: true, fps: 30, width: 1280 },
  objectFilter: { enabled: false, classes: ["boat"], model: "yolo11s.pt", conf: 0.35 },
});

// ---------------------------------------------------------------- filter objek
/** Jenis objek yang bisa dipilih (nama kelas model COCO). Sengaja dibatasi tiga. */
const OBJECT_PRESETS: Array<{ cls: string; label: string }> = [
  { cls: "boat", label: "Perahu" }, { cls: "motorcycle", label: "Motor" }, { cls: "person", label: "Orang" },
];
const PRESET_CLASSES = new Set(OBJECT_PRESETS.map((o) => o.cls));
const BUILTIN_MODEL_LABEL: Record<string, string> = { "yolo11n.pt": "bawaan · cepat", "yolo11s.pt": "bawaan · lebih akurat" };
const of = computed(() => form.objectFilter!);
const filterStatus = computed(() => status.value?.objectFilter ?? null);
const detector = computed(() => status.value?.detector ?? null);
function toggleClass(c: string) {
  const list = of.value.classes;
  const i = list.indexOf(c);
  if (i >= 0) list.splice(i, 1);
  else if (list.length < 10) list.push(c);
}
const lineMode = ref<"auto" | "manual">("auto");
const pickPoints = ref<Array<{ x: number; y: number }>>([]);
const result = ref<{ kind: "success" | "error" | "info"; text: string } | null>(null);

const current = computed(() => cameras.value.find((c) => c.cameraId === cameraId.value) ?? null);
const status = computed(() => current.value?.status ?? null);
const kindMeta = computed(() => (form.sourceType in KIND_META ? KIND_META[form.sourceType as DeviceKind] : null));
const sensitivity = computed(() =>
  (Object.keys(SENSITIVITY) as Array<keyof typeof SENSITIVITY>).find(
    (k) => SENSITIVITY[k].threshold === form.trigger.threshold && SENSITIVITY[k].minRun === form.trigger.minRun) ?? null);
/** Kamera yang sedang berjalan di agent (sumber gambar Live). */
const runningSource = computed(() => status.value?.settings?.source ?? null);
/**
 * Kamera lain dipilih tetapi belum diterapkan — agent hanya membuka satu kamera,
 * jadi Live tetap menampilkan kamera lama sampai Terapkan.
 */
const pendingCamera = computed(() => {
  if (runningSource.value === null || form.source === runningSource.value) return null;
  return scanResult.value?.cameras.find((c) => String(c.index) === form.source) ?? { index: Number(form.source), width: 0, height: 0, inUse: false, thumb: null };
});
/** Mode asli kamera terpilih (resolusi & fps maks.), dibaca agent dari sistem. */
const selectedModes = computed(() => scanResult.value?.cameras.find((c) => String(c.index) === form.source)?.modes ?? []);
/** fps tertinggi yang bisa dicapai kamera pada resolusi terpilih (Otomatis = mode tercepat). */
const maxFps = computed(() => {
  const modes = selectedModes.value;
  if (!modes.length) return FALLBACK_MAX_FPS[form.sourceType] ?? null;
  const at = form.width && form.height ? modes.find((m) => m.width === form.width && m.height === form.height) : null;
  return at?.maxFps ?? Math.max(...modes.map((m) => m.maxFps));
});
const fpsOptions = computed(() => {
  const max = maxFps.value;
  const base = FPS_OPTIONS.filter((f) => max === null || f <= max);
  return withCurrent(base.length ? base : [max ?? 30], form.fps);
});
/** Resolusi yang didukung kamera (≥ 640 px), tiap pilihan menyebut fps maksimalnya. */
const resOptions = computed(() => {
  const modes = selectedModes.value.filter((m) => m.width >= 640);
  const list = modes.length
    ? modes.map((m) => ({ label: `${m.width} × ${m.height} · maks ${m.maxFps} fps`, w: m.width as number | null, h: m.height as number | null }))
    : RES_OPTIONS.slice(1);
  const opts = [RES_OPTIONS[0]!, ...list];
  if (form.width && form.height && !opts.some((o) => o.w === form.width && o.h === form.height)) {
    opts.push({ label: `${form.width} × ${form.height} (tidak didukung kamera ini)`, w: form.width, h: form.height });
  }
  return opts;
});
/** fps/resolusi di luar kemampuan kamera (mis. setelah ganti kamera) → turunkan ke yang didukung. */
watch([maxFps, selectedModes], ([max, modes]) => {
  if (modes.length && form.width && form.height && !modes.some((m) => m.width === form.width && m.height === form.height)) {
    form.width = null;
    form.height = null;
  }
  // Hanya dengan data pasti dari sistem — perkiraan tidak boleh menurunkan pengaturan tersimpan.
  if (modes.length && max !== null && form.fps > max) form.fps = FPS_OPTIONS.filter((f) => f <= max).pop() ?? max;
});
/** fps nyata jauh di bawah yang diminta → perangkat keras kamera membatasi. */
const fpsShortfall = computed(() => {
  const want = status.value?.settings?.fps, got = status.value?.measuredFps;
  if (!want || !got || !status.value?.running) return null;
  return got < want * 0.8 ? { want, got: Math.round(got) } : null;
});
/**
 * Foto frame tidak bisa lebih cepat dari kamera, dan tidak diperbesar melebihi
 * lebar gambar kamera — jangan tawarkan nilai yang diam-diam diabaikan agent.
 */
function withCurrent(opts: number[], v: number) {
  return opts.includes(v) ? opts : [...opts, v].sort((a, b) => a - b);
}
const framesFpsOptions = computed(() => withCurrent([15, 30, 60].filter((f) => f <= form.fps), form.frames.fps));
const cameraWidth = computed(() =>
  scanResult.value?.cameras.find((c) => String(c.index) === form.source)?.width || (runningSource.value === form.source ? status.value?.width : 0) || 0);
const framesWidthOptions = computed(() => withCurrent([960, 1280, 1920].filter((w) => !cameraWidth.value || w <= cameraWidth.value), form.frames.width));
/** Resolusi diminta tetapi kamera memberi ukuran lain (mis. FaceTime maks. 1280×720). */
const resolutionMismatch = computed(() => {
  const st = status.value, want = st?.settings;
  if (!st?.running || !want?.width || !want.height || !st.width) return null;
  return st.width !== want.width || st.height !== want.height ? { want: `${want.width}×${want.height}`, got: `${st.width}×${st.height}` } : null;
});
watch(() => form.fps, () => {
  if (form.frames.fps > form.fps) form.frames.fps = framesFpsOptions.value.filter((f) => f <= form.fps).pop() ?? 15;
});
watch(cameraWidth, (w) => {
  if (w && form.frames.width > w) form.frames.width = [960, 1280, 1920].filter((x) => x <= w).pop() ?? 960;
});
const lineTilt = computed(() => (form.finishLine ? tiltFromVerticalDeg(form.finishLine) : 0));

// ---------------------------------------------------------------- data
function loadForm(c: CameraRow | null) {
  const cfg = c?.saved?.config ?? c?.status?.settings;
  if (!cfg) return;
  Object.assign(form, { objectFilter: { enabled: false, classes: ["boat"], model: "yolo11s.pt", conf: 0.35 } }, JSON.parse(JSON.stringify(cfg)));
  // Kelas lama di luar pilihan (mis. sepeda, mobil) dibuang — yang tampil = yang diterapkan.
  form.objectFilter!.classes = form.objectFilter!.classes.filter((c) => PRESET_CLASSES.has(c));
  lineMode.value = form.finishLine ? "manual" : "auto";
  pickPoints.value = [];
}

async function load(keepForm = false) {
  try {
    cameras.value = await api<CameraRow[]>("GET", "/api/cameras");
    if (!cameraId.value || !cameras.value.some((c) => c.cameraId === cameraId.value)) {
      cameraId.value = cameras.value.find((c) => c.connected)?.cameraId ?? cameras.value[0]?.cameraId ?? null;
    }
    if (!keepForm) loadForm(current.value);
  } catch (e) {
    toast("error", "Gagal memuat kamera", (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function scan(quiet = false) {
  if (!cameraId.value) return;
  busy.value = "scan";
  try {
    scanResult.value = await api<ScanResult>("POST", `/api/cameras/${cameraId.value}/scan`);
    // Jenis tersimpan bisa keliru (mis. "Kamera laptop" padahal nomornya iPhone) — ikuti jenis sebenarnya.
    const sel = scanResult.value.cameras.find((c) => String(c.index) === form.source);
    if (sel?.kind && sel.kind !== form.sourceType) form.sourceType = sel.kind;
    if (!quiet) toast("info", "Pindai selesai", `${scanResult.value.cameras.length} kamera ditemukan`);
  } catch (e) {
    if (!quiet) toast("error", "Pindai gagal", (e as Error).message);
  } finally {
    busy.value = null;
  }
}

/**
 * Nomor perangkat dari sistem (OpenCV) mulai 0 dan tidak bermakna bagi operator —
 * tampilkan sebagai "Kamera 1, 2, …"; kamera dikenali dari gambar kecilnya.
 */
function deviceName(index: string | number) {
  const known = scanResult.value?.cameras.find((c) => String(c.index) === String(index))?.name;
  if (known) return known;
  if (/^\d+$/.test(String(index))) return `Kamera ${Number(index) + 1}`;
  // Sumber lama (file video / alamat stream): cukup nama pendeknya, bukan path lengkap.
  return String(index).split(/[\\/]/).filter(Boolean).pop() ?? String(index);
}
function pickDevice(c: ScannedCamera) {
  if (form.source === String(c.index)) return;
  resetLineForNewCamera();
  form.source = String(c.index);
  // Jenis = label + batas fps. Tidak dikenali → anggap eksternal (semua fps ditawarkan).
  form.sourceType = c.kind ?? "external";
}

function setSensitivity(k: keyof typeof SENSITIVITY) {
  form.trigger.threshold = SENSITIVITY[k].threshold;
  form.trigger.minRun = SENSITIVITY[k].minRun;
}

/** Kamera berganti → koordinat garis lama (resolusi lain) tidak berlaku lagi. */
function resetLineForNewCamera() {
  if (lineMode.value === "manual") {
    lineMode.value = "auto";
    toast("info", "Garis finish kembali ke Otomatis", "Kamera berganti — atur ulang garis di gambar setelah diterapkan bila perlu.");
  }
}

watch(lineMode, (m) => {
  if (m === "auto") form.finishLine = null;
  pickPoints.value = [];
});

async function apply() {
  if (!cameraId.value) return;
  if (!kindMeta.value || !/^\d+$/.test(form.source)) return toast("warning", "Pilih kamera", "Klik Pindai kamera lalu pilih kamera dari gambarnya");
  if (lineMode.value === "manual" && !form.finishLine) return toast("warning", "Garis finish belum ditentukan", "Klik dua titik pada gambar, atau pilih Otomatis");
  if (of.value.enabled && !of.value.classes.length) return toast("warning", "Pilih jenis objek", "Minimal satu, mis. Perahu");
  busy.value = "apply";
  result.value = { kind: "info", text: "Agent sedang membuka kamera dengan pengaturan baru…" };
  try {
    const res = await api<{ applied: boolean; pending?: boolean; message?: string }>("PUT", `/api/cameras/${cameraId.value}/config`, form);
    result.value = res.pending
      ? { kind: "info", text: res.message ?? "Disimpan — diterapkan saat agent terhubung." }
      : { kind: "success", text: "Pengaturan diterapkan & disimpan. Cek gambar live di sebelah kanan." };
    toast("success", res.pending ? "Pengaturan disimpan" : "Pengaturan kamera diterapkan");
    await load(true);
  } catch (e) {
    // Pesan dari agent sudah menyebut apakah kamera lama berhasil dibuka lagi.
    result.value = { kind: "error", text: (e as Error).message };
    toast("error", "Pengaturan gagal diterapkan", "Perubahan tidak disimpan");
    await load(true);
  } finally {
    busy.value = null;
  }
}

// ---------------------------------------------------------------- pratinjau live
interface PreviewFrame { cameraId: string; width: number; height: number; fps: number; finishLine: Line; jpeg: ArrayBuffer }
const preview = ref<{ width: number; height: number; fps: number; finishLine: Line; at: number } | null>(null);
const imgUrl = ref<string | null>(null);
const now = ref(Date.now());
const socket = getSocket();
let decoding = false;

async function onFrame(f: PreviewFrame) {
  if (f.cameraId !== cameraId.value || decoding) return;
  decoding = true;
  const url = URL.createObjectURL(new Blob([f.jpeg], { type: "image/jpeg" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const old = imgUrl.value;
    imgUrl.value = url;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
    preview.value = { width: f.width, height: f.height, fps: f.fps, finishLine: f.finishLine, at: Date.now() };
  } catch {
    URL.revokeObjectURL(url);
  } finally {
    decoding = false;
  }
}
const live = computed(() => !!preview.value && now.value - preview.value.at < 2500);

function subscribe(id: string | null, old?: string | null) {
  if (old) socket.emit("preview:unsubscribe", old);
  preview.value = null;
  if (id) socket.emit("preview:subscribe", id, () => undefined);
}
watch(cameraId, (id, old) => {
  subscribe(id, old);
  loadForm(current.value);
  scanResult.value = null;
});

function pickOnImage(ev: MouseEvent) {
  if (lineMode.value !== "manual" || !preview.value) return;
  // Gambar masih dari kamera lama — garis finish harus diatur di kamera baru.
  if (pendingCamera.value) return toast("info", "Terapkan kamera baru dulu", "Garis finish diatur di gambar kamera yang akan dipakai.");
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const x = Math.round(((ev.clientX - rect.left) / rect.width) * preview.value.width);
  const y = Math.round(((ev.clientY - rect.top) / rect.height) * preview.value.height);
  const pts = pickPoints.value.length >= 2 ? [] : [...pickPoints.value];
  pts.push({ x, y });
  pickPoints.value = pts;
  if (pts.length === 2) {
    // urutkan atas → bawah agar sudut kemiringan konsisten
    const [a, b] = pts[0]!.y <= pts[1]!.y ? [pts[0]!, pts[1]!] : [pts[1]!, pts[0]!];
    form.finishLine = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
}

const onStatus = (st: Status) => {
  const row = cameras.value.find((c) => c.cameraId === st.cameraId);
  if (row) {
    row.status = st;
    row.connected = !!st.connected;
  } else load(true);
};
const resubscribe = () => subscribe(cameraId.value);
let timer: number | undefined;
onMounted(async () => {
  socket.on("preview:frame", onFrame);
  socket.on("camera:status", onStatus);
  socket.on("connect", resubscribe);
  await load();
  subscribe(cameraId.value);
  if (current.value?.connected) void scan(true); // langsung tampilkan kamera yang tersedia beserta gambarnya
  timer = window.setInterval(() => (now.value = Date.now()), 500);
});
onUnmounted(() => {
  if (cameraId.value) socket.emit("preview:unsubscribe", cameraId.value);
  socket.off("preview:frame", onFrame);
  socket.off("camera:status", onStatus);
  socket.off("connect", resubscribe);
  clearInterval(timer);
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value);
});

const shownLine = computed<Line | null>(() => {
  if (lineMode.value === "manual") return form.finishLine;
  if (!preview.value) return null;
  const w = preview.value.width, h = preview.value.height;
  return { x1: w / 2, y1: 0, x2: w / 2, y2: h - 1 };
});
</script>

<template>
  <div class="page-head">
    <div class="grow">
      <h1 class="page-title">Pengaturan Kamera</h1>
      <p class="page-subtitle">Pilih kamera, atur garis finish dan photocell virtual. Diterapkan langsung tanpa restart agent.</p>
    </div>
    <div v-if="cameras.length > 1" class="btn-group">
      <button v-for="c in cameras" :key="c.cameraId" class="btn btn-sm" :class="{ 'is-active': c.cameraId === cameraId }" @click="cameraId = c.cameraId">
        <span class="dot-status" :class="{ on: c.connected }" /> {{ c.cameraId }}
      </button>
    </div>
  </div>

  <div v-if="loading" class="card empty"><AppIcon name="pending" />Memuat kamera…</div>
  <div v-else-if="!cameras.length" class="card empty">
    <AppIcon name="camera" />
    <strong>Belum ada agent kamera</strong>
    <span>Jalankan agent di laptop yang tersambung ke kamera (<span class="mono">npm run dev:local</span> atau <span class="mono">pf-agent</span>), lalu muat ulang halaman ini.</span>
  </div>

  <div v-else class="layout">
    <!-- ======================= kiri: formulir ======================= -->
    <div class="col-form">
      <!-- status -->
      <section class="card status-card">
        <div class="row">
          <span class="status-pill" :class="current?.connected ? 'status-success' : 'status-danger'"><span class="dot" />{{ current?.connected ? "Agent terhubung" : "Agent tidak terhubung" }}</span>
          <span v-if="current?.connected && status?.host" class="host" title="Kamera yang dipindai & dipakai adalah kamera yang tercolok di komputer ini — bukan di perangkat yang membuka halaman ini">
            <AppIcon name="laptop" /> Kamera di komputer <strong>{{ status.host }}</strong>
          </span>
          <span v-if="current?.connected && status?.running === false" class="status-pill status-danger"><span class="dot" />Kamera tidak berjalan</span>
          <span v-else-if="current?.connected && (status?.lastFrameAgeMs ?? 0) > 3000" class="status-pill status-danger"><span class="dot" />Kamera tidak mengirim gambar</span>
        </div>
        <div v-if="status?.notice" class="alert alert-warn"><AppIcon name="warning" /><span>{{ status.notice }}</span></div>
        <div v-if="current?.connected && status?.running === false" class="alert alert-danger">
          <AppIcon name="error" />
          <span><strong>{{ deviceName(status.settings?.source ?? "") }} tidak bisa dibuka — agent terus mencoba setiap 3 detik.</strong> {{ status.lastError }}
            Bila kamera itu memang tidak tersedia (mis. iPhone tidak tersambung), <strong>Pindai kamera</strong> lalu pilih kamera lain dan Terapkan.</span>
        </div>
        <div v-else-if="status?.lastError" class="alert alert-danger"><AppIcon name="error" /><span>Percobaan terakhir gagal: {{ status.lastError }}</span></div>
        <div v-if="current?.connected && status?.running !== false && (status?.lastFrameAgeMs ?? 0) > 3000" class="alert alert-warn">
          <AppIcon name="warning" /><span>Kamera berhenti mengirim gambar — agent mencoba membuka ulang. iPhone: pastikan terkunci, diam, dan dekat Mac. USB: cek kabel. Atau pilih kamera lain lalu Terapkan.</span>
        </div>
      </section>

      <!-- kamera -->
      <section class="card">
        <h2 class="card-title"><AppIcon name="camera" /> Kamera</h2>
        <div v-if="LEGACY_SOURCE[form.sourceType]" class="alert alert-warn" style="margin: 0 0 12px">
          <AppIcon name="warning" />
          <span>Sumber saat ini <strong>{{ LEGACY_SOURCE[form.sourceType] }}</strong> ({{ form.source }}) tidak lagi tersedia di sini. Pilih kamera di bawah lalu Terapkan.</span>
        </div>
        <div class="device-head">
            <span class="field-label">Pilih kamera</span>
            <button class="btn btn-sm" :disabled="busy !== null || !current?.connected" @click="scan()">
              <AppIcon :name="busy === 'scan' ? 'pending' : 'search'" /> {{ busy === "scan" ? "Memindai…" : scanResult ? "Pindai ulang" : "Pindai kamera" }}
            </button>
          </div>
          <p v-if="current?.connected && status?.host" class="hint" style="margin: 0 0 10px">
            Daftar ini berisi kamera yang tercolok di komputer <strong>{{ status.host }}</strong> (tempat agent berjalan), bukan di perangkat yang membuka halaman ini.
            Untuk memakai kamera di komputer lain, jalankan agent di komputer itu.
          </p>
          <div v-if="scanResult?.cameras.length" class="device-grid" role="radiogroup" aria-label="Kamera">
            <button
              v-for="c in scanResult.cameras" :key="c.index" type="button" class="device" :class="{ active: form.source === String(c.index) }"
              role="radio" :aria-checked="form.source === String(c.index)" @click="pickDevice(c)"
            >
              <img v-if="c.thumb" :src="c.thumb" alt="" />
              <span v-else class="no-thumb"><AppIcon name="camera" size="28" /></span>
              <span class="device-name">{{ deviceName(c.index) }}<span v-if="String(c.index) === runningSource" class="chip chip-brand">Live</span><span v-else-if="form.source === String(c.index)" class="chip">dipilih · belum diterapkan</span></span>
              <small>{{ c.kind ? KIND_META[c.kind].label : "Jenis tidak dikenali" }} · {{ c.width }}×{{ c.height }}</small>
            </button>
          </div>
          <p v-else-if="scanResult" class="hint" style="margin: 8px 0 0">Tidak ada kamera ditemukan di komputer agent{{ status?.host ? ` (${status.host})` : "" }}. Cek sambungan kamera lalu Pindai ulang.</p>
          <p v-else class="hint" style="margin: 8px 0 0">
            Dipakai sekarang: <strong>{{ deviceName(form.source) }}</strong>.
            <template v-if="current?.connected">{{ busy === "scan" ? "Mencari kamera lain…" : "Klik Pindai kamera untuk melihat semua kamera beserta gambarnya." }}</template>
            <template v-else>Agent offline — pindai tersedia setelah agent tersambung.</template>
          </p>
          <p v-if="scanResult?.cameras.some((c) => !c.kind)" class="hint" style="margin: 8px 0 0">
            Jenis sebagian kamera tidak dikenali sistem — kenali dari gambarnya.
          </p>
          <p v-if="kindMeta" class="hint" style="margin: 8px 0 0"><AppIcon name="info" /> {{ kindMeta.hint }}</p>

        <div class="grid-2" style="margin-top: 16px">
          <label class="field">
            <span class="field-label">Frame per detik (fps)</span>
            <select v-model.number="form.fps" class="input">
              <option v-for="f in fpsOptions" :key="f" :value="f">{{ f }} fps · {{ (1000 / f).toFixed(1) }} ms/frame</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Resolusi</span>
            <select class="input" :value="`${form.width ?? ''}x${form.height ?? ''}`"
              @change="(e) => { const r = resOptions.find((o) => `${o.w ?? ''}x${o.h ?? ''}` === (e.target as HTMLSelectElement).value); form.width = r?.w ?? null; form.height = r?.h ?? null; }">
              <option v-for="r in resOptions" :key="r.label" :value="`${r.w ?? ''}x${r.h ?? ''}`">{{ r.label }}</option>
            </select>
          </label>
        </div>
        <p v-if="maxFps !== null" class="hint" style="margin: 8px 0 0">
          <AppIcon name="info" /> Kamera ini maksimal <strong>{{ maxFps }} fps</strong>{{ form.width ? ` pada ${form.width}×${form.height}` : "" }}{{ selectedModes.length ? " (menurut sistem)" : " (perkiraan — Pindai kamera untuk data pasti)" }}.
          <template v-if="maxFps < 120">Untuk lomba resmi (akurasi 1/100 detik) perlu kamera ≥ 120 fps.</template>
          <template v-if="form.sourceType === 'iphone'"> iPhone di tempat redup bisa turun ke 24 fps.</template>
        </p>
        <p v-else-if="form.fps < 120" class="hint" style="margin: 8px 0 0">Untuk lomba resmi (akurasi 1/100 detik) gunakan kamera ≥ 120 fps.</p>
        <div v-if="resolutionMismatch" class="alert alert-warn" style="margin: 10px 0 0">
          <AppIcon name="warning" />
          <span>Diminta <strong>{{ resolutionMismatch.want }}</strong>, tetapi kamera memberi <strong>{{ resolutionMismatch.got }}</strong> — kamera ini tidak mendukung resolusi itu.</span>
        </div>
        <div v-if="fpsShortfall" class="alert alert-warn" style="margin: 10px 0 0">
          <AppIcon name="warning" />
          <span>Diminta <strong>{{ fpsShortfall.want }} fps</strong>, tetapi kamera hanya mengirim <strong>±{{ fpsShortfall.got }} fps</strong>.
            Batas ini dari perangkat keras kamera (atau cahaya kurang), bukan pengaturan — pilih fps yang sesuai atau ganti kamera.</span>
        </div>
      </section>

      <!-- garis finish -->
      <section class="card">
        <h2 class="card-title"><AppIcon name="vertical" /> Garis finish</h2>
        <div class="btn-group" style="margin-bottom: 10px">
          <button class="btn btn-sm" :class="{ 'is-active': lineMode === 'auto' }" @click="lineMode = 'auto'">Otomatis (tegak di tengah)</button>
          <button class="btn btn-sm" :class="{ 'is-active': lineMode === 'manual' }" @click="lineMode = 'manual'">Atur di gambar</button>
        </div>
        <p v-if="lineMode === 'auto'" class="muted" style="margin: 0">Garis tegak lurus tepat di tengah gambar. Posisikan kamera agar tiang photocell berada di tengah.</p>
        <template v-else>
          <p class="muted" style="margin: 0 0 8px">
            Klik <strong>titik atas</strong> lalu <strong>titik bawah</strong> garis finish (mis. kedua ujung tiang photocell) pada gambar live.
            <span v-if="pickPoints.length === 1" class="chip chip-brand">1/2 — klik titik kedua</span>
          </p>
          <div v-if="form.finishLine" class="row">
            <span class="chip mono">({{ Math.round(form.finishLine.x1) }}, {{ Math.round(form.finishLine.y1) }}) → ({{ Math.round(form.finishLine.x2) }}, {{ Math.round(form.finishLine.y2) }})</span>
            <span class="status-pill" :class="{ 'status-success': tiltLevel(lineTilt) === 'ok', 'status-upcoming': tiltLevel(lineTilt) === 'warn', 'status-danger': tiltLevel(lineTilt) === 'bad' }">
              <span class="dot" />{{ lineTilt >= 0 ? "+" : "" }}{{ lineTilt.toFixed(2) }}° dari tegak
            </span>
          </div>
        </template>
      </section>

      <!-- photocell & foto frame -->
      <section class="card">
        <h2 class="card-title"><AppIcon name="sensors" /> Photocell virtual</h2>
        <label class="switch-row">
          <span><strong>Picu rekaman otomatis saat perahu menyentuh garis</strong><small>Tanpa klik — perahu berdempetan tetap masuk satu rekaman</small></span>
          <input v-model="form.trigger.enabled" type="checkbox" class="switch" />
        </label>
        <template v-if="form.trigger.enabled">
          <div class="field-label" style="margin: 12px 0 6px">Kepekaan</div>
          <div class="btn-group">
            <button v-for="(v, k) in SENSITIVITY" :key="k" class="btn btn-sm" :class="{ 'is-active': sensitivity === k }" @click="setSensitivity(k)">{{ v.label }}</button>
          </div>
          <p class="hint" style="margin: 6px 0 0">{{ sensitivity ? SENSITIVITY[sensitivity].hint : "Kustom (dari .env agent) — pilih salah satu untuk mengganti" }}</p>
        </template>

        <h2 class="card-title" style="margin-top: 22px"><AppIcon name="target" /> Filter objek</h2>
        <label class="switch-row">
          <span><strong>Teruskan pemicu hanya bila objek ini yang melintas</strong><small>Objek lain (burung, ranting, riak, bayangan, dan jenis yang tidak dipilih) diabaikan otomatis. Waktu finish tetap dari photocell.</small></span>
          <input v-model="of.enabled" type="checkbox" class="switch" :disabled="!form.trigger.enabled" />
        </label>
        <p v-if="!form.trigger.enabled" class="hint" style="margin: 6px 0 0">Aktifkan photocell virtual dulu — filter memeriksa pemicunya.</p>
        <template v-else-if="of.enabled">
          <div v-if="detector && !detector.available" class="alert alert-warn" style="margin-top: 10px">
            <AppIcon name="warning" />
            <span>Paket deteksi belum terpasang di laptop agent. Jalankan <code>cd agent &amp;&amp; .venv/bin/pip install -e ".[detect]"</code> lalu restart agent. Sampai itu, semua pemicu tetap diteruskan.</span>
          </div>
          <div class="field-label" style="margin: 12px 0 6px">Jenis objek</div>
          <div class="chips">
            <button
              v-for="o in OBJECT_PRESETS" :key="o.cls" type="button" class="chip-toggle" :class="{ on: of.classes.includes(o.cls) }"
              @click="toggleClass(o.cls)"
            >{{ o.label }}</button>
          </div>
          <div class="grid-2" style="margin-top: 12px">
            <label class="field"><span class="field-label">Model</span>
              <select v-model="of.model" class="input">
                <option v-for="m in detector?.models ?? ['yolo11n.pt', 'yolo11s.pt']" :key="m" :value="m">{{ m }}{{ BUILTIN_MODEL_LABEL[m] ? ` (${BUILTIN_MODEL_LABEL[m]})` : " (latih ulang)" }}</option>
              </select>
            </label>
            <label class="field"><span class="field-label">Keyakinan minimal: {{ Math.round(of.conf * 100) }}%</span>
              <input v-model.number="of.conf" type="range" min="0.15" max="0.8" step="0.05" />
            </label>
          </div>
          <p class="hint" style="margin: 6px 0 0">Model bawaan mengenal "boat" secara umum; <strong>perahu karet</strong> lebih andal dengan model hasil latih ulang dari foto lomba Anda (taruh di <code>data/models/</code>).</p>
          <div v-if="filterStatus?.enabled" class="filter-stats">
            <span v-if="filterStatus.error" class="status-pill status-danger"><span class="dot" />{{ filterStatus.error }}</span>
            <span v-else-if="!filterStatus.ready" class="status-pill status-upcoming"><span class="dot" />Memuat model…</span>
            <template v-else>
              <span class="chip chip-ok">Lolos {{ filterStatus.passed }}</span>
              <span class="chip">Diabaikan {{ filterStatus.rejected }}</span>
              <span v-if="filterStatus.lastLabel" class="hint">terakhir lolos: <strong>{{ filterStatus.lastLabel }}</strong></span>
              <span v-if="filterStatus.lastMs" class="hint">· {{ filterStatus.lastMs }} ms</span>
            </template>
          </div>
          <TriggerLog v-if="cameraId && filterStatus?.enabled" :camera-id="cameraId" :limit="10" class="trigger-log" />
        </template>

        <h2 class="card-title" style="margin-top: 22px"><AppIcon name="camera" /> Foto frame</h2>
        <label class="switch-row">
          <span><strong>Simpan foto kamera utuh di sekitar finish</strong><small>Untuk tinjauan frame demi frame (proporsi asli, tidak gepeng)</small></span>
          <input v-model="form.frames.enabled" type="checkbox" class="switch" />
        </label>
        <div v-if="form.frames.enabled" class="grid-2" style="margin-top: 10px">
          <label class="field"><span class="field-label">Foto per detik</span>
            <select v-model.number="form.frames.fps" class="input"><option v-for="f in framesFpsOptions" :key="f" :value="f">{{ f }}</option></select>
          </label>
          <label class="field"><span class="field-label">Lebar foto</span>
            <select v-model.number="form.frames.width" class="input"><option v-for="w in framesWidthOptions" :key="w" :value="w">{{ w }} px</option></select>
          </label>
        </div>
      </section>

      <!-- aksi -->
      <section class="card actions">
        <div v-if="result" class="alert" :class="{ 'alert-info': result.kind === 'info', 'alert-danger': result.kind === 'error' }" :style="result.kind === 'success' ? 'background: var(--ok-bg); color: var(--ok-ink); border-color: var(--ok-line)' : ''">
          <AppIcon :name="result.kind === 'success' ? 'check' : result.kind === 'error' ? 'error' : 'pending'" /><span>{{ result.text }}</span>
        </div>
        <div class="row">
          <button class="btn btn-primary btn-lg" :disabled="busy !== null" :title="busy === 'scan' ? 'Tunggu pemindaian selesai' : ''" @click="apply">
            <AppIcon :name="busy === 'apply' ? 'pending' : 'save'" /> {{ busy === "apply" ? "Menerapkan…" : "Terapkan" }}
          </button>
          <button class="btn" :disabled="busy !== null" @click="loadForm(current)"><AppIcon name="restart" /> Batalkan perubahan</button>
        </div>
        <p class="hint" style="margin: 8px 0 0">Bila kamera baru gagal dibuka, agent otomatis kembali ke pengaturan sebelumnya (bila kamera lama masih tersedia). Setiap perubahan tercatat di audit log.</p>
      </section>
    </div>

    <!-- ======================= kanan: gambar live ======================= -->
    <aside class="col-preview">
      <section class="race-window">
        <div class="race-toolbar">
          <span class="status-pill" :class="live ? 'status-live' : 'status-muted'"><span class="dot" />{{ live ? "LIVE" : "Tidak ada gambar" }}</span>
          <span v-if="runningSource !== null" class="readout">{{ deviceName(runningSource) }}</span>
          <span v-if="preview" class="readout">{{ preview.width }}×{{ preview.height }} · {{ preview.fps || "?" }} fps</span>
        </div>
        <div v-if="pendingCamera" class="pending-switch">
          <img v-if="pendingCamera.thumb" :src="pendingCamera.thumb" alt="" />
          <div class="grow">
            <strong>{{ deviceName(pendingCamera.index) }} dipilih — belum diterapkan</strong>
            <span>Live di bawah masih {{ deviceName(runningSource ?? "") }}. Tekan Terapkan untuk beralih.</span>
          </div>
          <button class="btn btn-primary btn-sm" :disabled="busy !== null" @click="apply">{{ busy === "apply" ? "Menerapkan…" : "Terapkan" }}</button>
        </div>
        <div v-if="preview && imgUrl" class="stage" :class="{ picking: lineMode === 'manual' && !pendingCamera, dimmed: pendingCamera }" @click="pickOnImage">
          <img :src="imgUrl" alt="Gambar live kamera" draggable="false" />
          <svg :viewBox="`0 0 ${preview.width} ${preview.height}`" preserveAspectRatio="none">
            <line :x1="preview.width / 2" :x2="preview.width / 2" y1="0" :y2="preview.height" class="center" />
            <line v-if="shownLine" :x1="shownLine.x1" :y1="shownLine.y1" :x2="shownLine.x2" :y2="shownLine.y2" class="finish" />
            <circle v-for="(p, i) in pickPoints" :key="i" :cx="p.x" :cy="p.y" r="9" class="pt" />
          </svg>
        </div>
        <div v-else class="empty" style="color: #b6c2cf">
          <AppIcon name="camera" />
          <span>{{ current?.connected ? "Menunggu gambar dari kamera…" : "Agent tidak terhubung" }}</span>
        </div>
        <p class="hint" style="margin: 10px 0 0">
          Gambar dari pengaturan yang <strong>sedang berjalan</strong>. Garis merah = garis finish {{ lineMode === "manual" ? "baru" : "otomatis" }}; garis putus-putus = tengah gambar.
        </p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip-toggle { all: unset; cursor: pointer; display: inline-flex; align-items: baseline; gap: 5px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border-2); background: var(--surface); font-weight: 600; font-size: 0.86rem; color: var(--text-2); }
.chip-toggle small { font: 500 0.7rem var(--mono); color: var(--faint); }
.chip-toggle.on { background: var(--brand); border-color: var(--brand); color: #fff; }
.chip-toggle.on small { color: rgba(255, 255, 255, 0.75); }
.filter-stats { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.trigger-log { margin-top: 12px; padding: 0; box-shadow: none; border: 0; }
.host { display: inline-flex; align-items: center; gap: 6px; font-size: 0.86rem; color: var(--text-2); }
.chip-ok { background: var(--ok-bg); color: var(--ok-ink); }

.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 0.9fr); gap: 20px; align-items: start; }
.col-preview { position: sticky; top: calc(var(--nav-h) + 16px); }
.card-title { font-size: 1rem; margin-bottom: 12px; }
.status-card { padding: 14px 18px; }
.pending-switch { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; padding: 8px 10px; border-radius: 10px; background: var(--warn-bg); border: 1.5px solid var(--warn); color: var(--warn-ink); font-size: 0.82rem; }
.pending-switch img { width: 88px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; flex: none; }
.pending-switch .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pending-switch strong { color: var(--ink); font-size: 0.88rem; }
.stage.dimmed img { opacity: 0.55; }
.device-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.device-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.device { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 12px; border: 1.5px solid var(--border); background: var(--surface-2); color: var(--text-2); transition: all 0.15s; }
.device:hover { border-color: var(--brand-2); }
.device:focus-visible { box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.25); }
.device.active { border-color: var(--brand); background: var(--brand-soft); box-shadow: 0 0 0 3px rgba(24, 116, 165, 0.12); }
.device img, .no-thumb { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; background: #0f172a; }
.no-thumb { display: grid; place-items: center; color: #64748b; }
.device-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 700; font-size: 0.88rem; color: var(--ink); }
.device small { font-size: 0.76rem; color: var(--muted); }
.switch-row { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.switch-row > span { flex: 1; display: flex; flex-direction: column; font-size: 0.9rem; color: var(--ink); }
.switch-row small { color: var(--muted); font-size: 0.8rem; }
.switch { appearance: none; width: 42px; height: 24px; border-radius: 999px; background: #cbd5e1; position: relative; cursor: pointer; transition: background 0.15s; flex: none; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 999px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); transition: left 0.15s; }
.switch:checked { background: var(--brand); }
.switch:checked::after { left: 21px; }
.actions { position: sticky; bottom: 12px; z-index: 5; border-color: var(--brand-soft); box-shadow: 0 10px 30px rgba(15, 23, 42, 0.15); }
.dot-status { width: 8px; height: 8px; border-radius: 999px; background: var(--bad); display: inline-block; }
.dot-status.on { background: var(--ok); }
.stage { position: relative; line-height: 0; border-radius: 12px; overflow: hidden; background: var(--race-2); }
.stage.picking { cursor: crosshair; }
.stage img { width: 100%; height: auto; display: block; }
.stage svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.finish { stroke: #ff3b30; stroke-width: 3; vector-effect: non-scaling-stroke; }
.center { stroke: rgba(34, 211, 238, 0.7); stroke-width: 1.5; stroke-dasharray: 8 6; vector-effect: non-scaling-stroke; }
.pt { fill: #fbbf24; stroke: #000; stroke-width: 2; vector-effect: non-scaling-stroke; }
@media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .col-preview { position: static; order: -1; } }
</style>
