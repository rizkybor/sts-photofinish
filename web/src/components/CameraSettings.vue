<script setup lang="ts">
// Pengaturan kamera: pilih sumber (laptop / iPhone / eksternal / kamera IP /
// video uji), fps, garis finish (klik di gambar live), photocell virtual, dan
// foto frame. Diterapkan agent saat berjalan; gagal → agent kembali ke
// pengaturan lama dan perubahan tidak disimpan.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { api } from "../lib/api";
import { tiltFromVerticalDeg, tiltLevel, type Line } from "../lib/geometry";
import { getSocket } from "../lib/socket";
import { confirmDialog, toast } from "../lib/ui";
import AppIcon, { type IconName } from "./ui/AppIcon.vue";

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
  cameraId: string; connected?: boolean; running?: boolean; width?: number; height?: number; measuredFps?: number;
  finishLine?: Line | null; lastError?: string | null; settings?: Config; lastFrameAgeMs?: number | null; notice?: string | null; retrying?: boolean;
  objectFilter?: ObjectFilterStatus; detector?: { available: boolean; models: string[] };
}
interface CameraRow { cameraId: string; connected: boolean; status: Status | null; saved: { config: Config; revision: number; updatedAt: string } | null }
interface ScanResult { cameras: Array<{ index: number; width: number; height: number; inUse: boolean }>; deviceNames: string[]; videos: string[] }

const SOURCES: Array<{ type: SourceType; label: string; icon: IconName; hint: string }> = [
  { type: "laptop", label: "Kamera laptop", icon: "laptop", hint: "Kamera bawaan laptop (FaceTime HD). Cocok untuk uji coba, 24–30 fps." },
  { type: "iphone", label: "iPhone", icon: "iphone", hint: "Continuity Camera: Apple ID sama dengan Mac, Wi-Fi + Bluetooth nyala, iPhone landscape, diam di tripod, layar terkunci." },
  { type: "external", label: "Kamera eksternal", icon: "usb", hint: "Kamera USB/industri. Untuk lomba gunakan 120–240 fps agar akurat 1/100 detik." },
  { type: "ip", label: "Kamera IP / HP", icon: "ipcam", hint: "Aplikasi kamera IP di HP atau kamera jaringan — isi alamat stream http:// (MJPEG) atau rtsp://." },
  { type: "video", label: "Video uji", icon: "movie", hint: "Memutar file dari data/test-video/ seolah kamera live. Untuk uji tanpa kamera." },
];
const SENSITIVITY = {
  rendah: { label: "Rendah", threshold: 45, minRun: 0.1, hint: "Sedikit pemicu palsu — untuk air beriak / banyak bayangan" },
  sedang: { label: "Sedang", threshold: 30, minRun: 0.06, hint: "Seimbang (bawaan)" },
  tinggi: { label: "Tinggi", threshold: 20, minRun: 0.04, hint: "Perahu kecil/jauh tetap terdeteksi, lebih mudah terpicu" },
} as const;
const FPS_OPTIONS = [24, 30, 60, 120, 240];
const RES_OPTIONS = [
  { label: "Otomatis (bawaan kamera)", w: null, h: null },
  { label: "1280 × 720", w: 1280, h: 720 },
  { label: "1920 × 1080", w: 1920, h: 1080 },
];

const cameras = ref<CameraRow[]>([]);
const cameraId = ref<string | null>(null);
const loading = ref(true);
const busy = ref<"apply" | "scan" | "reset" | null>(null);
const scanResult = ref<ScanResult | null>(null);
const form = reactive<Config>({
  sourceType: "laptop", source: "0", fps: 30, width: null, height: null, finishLine: null,
  trigger: { enabled: true, threshold: 30, minRun: 0.06 }, frames: { enabled: true, fps: 30, width: 1280 },
  objectFilter: { enabled: false, classes: ["boat"], model: "yolo11n.pt", conf: 0.35 },
});

// ---------------------------------------------------------------- filter objek
/** Kelas umum model bawaan (COCO). Model hasil latih ulang punya kelasnya sendiri (mis. raft). */
const OBJECT_PRESETS: Array<{ cls: string; label: string }> = [
  { cls: "boat", label: "Perahu" }, { cls: "motorcycle", label: "Motor" }, { cls: "bicycle", label: "Sepeda" },
  { cls: "car", label: "Mobil" }, { cls: "person", label: "Orang" },
];
const BUILTIN_MODEL_LABEL: Record<string, string> = { "yolo11n.pt": "bawaan · cepat", "yolo11s.pt": "bawaan · lebih akurat" };
const customClass = ref("");
const of = computed(() => form.objectFilter!);
const filterStatus = computed(() => status.value?.objectFilter ?? null);
const detector = computed(() => status.value?.detector ?? null);
/** Kelas yang ditawarkan: kelas model (bila sudah dimuat & model kustom) atau preset umum. */
const classOptions = computed(() => {
  const fromModel = filterStatus.value?.model === of.value.model ? filterStatus.value?.modelClasses ?? [] : [];
  const custom = fromModel.length && !BUILTIN_MODEL_LABEL[of.value.model]
    ? fromModel.map((c) => ({ cls: c, label: c }))
    : OBJECT_PRESETS;
  const extra = of.value.classes.filter((c) => !custom.some((o) => o.cls === c)).map((c) => ({ cls: c, label: c }));
  return [...custom, ...extra];
});
function toggleClass(c: string) {
  const list = of.value.classes;
  const i = list.indexOf(c);
  if (i >= 0) list.splice(i, 1);
  else if (list.length < 10) list.push(c);
}
function addCustomClass() {
  const c = customClass.value.trim();
  if (!/^[\w][\w .-]{0,39}$/.test(c)) return toast("warning", "Nama kelas tidak valid", "Huruf/angka, mis. raft atau perahu_karet");
  if (!of.value.classes.includes(c)) of.value.classes.push(c);
  customClass.value = "";
}
const lineMode = ref<"auto" | "manual">("auto");
const pickPoints = ref<Array<{ x: number; y: number }>>([]);
const showAdvanced = ref(false);
const result = ref<{ kind: "success" | "error" | "info"; text: string } | null>(null);

const current = computed(() => cameras.value.find((c) => c.cameraId === cameraId.value) ?? null);
const status = computed(() => current.value?.status ?? null);
const sourceMeta = computed(() => SOURCES.find((s) => s.type === form.sourceType)!);
const usesDevice = computed(() => ["laptop", "iphone", "external"].includes(form.sourceType));
const sensitivity = computed(() =>
  (Object.keys(SENSITIVITY) as Array<keyof typeof SENSITIVITY>).find(
    (k) => SENSITIVITY[k].threshold === form.trigger.threshold && SENSITIVITY[k].minRun === form.trigger.minRun) ?? null);
const lineTilt = computed(() => (form.finishLine ? tiltFromVerticalDeg(form.finishLine) : 0));

// ---------------------------------------------------------------- data
function loadForm(c: CameraRow | null) {
  const cfg = c?.saved?.config ?? c?.status?.settings;
  if (!cfg) return;
  Object.assign(form, { objectFilter: { enabled: false, classes: ["boat"], model: "yolo11n.pt", conf: 0.35 } }, JSON.parse(JSON.stringify(cfg)));
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

async function scan() {
  if (!cameraId.value) return;
  busy.value = "scan";
  try {
    scanResult.value = await api<ScanResult>("POST", `/api/cameras/${cameraId.value}/scan`);
    toast("info", "Pindai selesai", `${scanResult.value.cameras.length} kamera ditemukan`);
  } catch (e) {
    toast("error", "Pindai gagal", (e as Error).message);
  } finally {
    busy.value = null;
  }
}

function deviceLabel(c: { index: number; width: number; height: number; inUse: boolean }) {
  const guess = c.width >= 1920 ? "kemungkinan iPhone / kamera eksternal" : c.width > 0 ? "kemungkinan kamera laptop" : "";
  return `Kamera ${c.index} — ${c.width}×${c.height}${guess ? ` (${guess})` : ""}${c.inUse ? " · sedang dipakai" : ""}`;
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

function selectSource(t: SourceType) {
  if (form.sourceType === t) return;
  resetLineForNewCamera();
  form.sourceType = t;
  if (t === "ip") form.source = form.source.startsWith("http") || form.source.startsWith("rtsp") ? form.source : "";
  else if (t === "video") form.source = scanResult.value?.videos[0] ?? "";
  else if (!/^\d+$/.test(form.source)) form.source = "0";
  if (t === "external" && form.fps < 60) form.fps = 120;
  if ((t === "laptop" || t === "iphone") && form.fps > 30) form.fps = 30;
}

watch(lineMode, (m) => {
  if (m === "auto") form.finishLine = null;
  pickPoints.value = [];
});

async function apply() {
  if (!cameraId.value) return;
  if (usesDevice.value && !/^\d+$/.test(form.source)) return toast("warning", "Pilih perangkat kamera", "Klik Pindai kamera lalu pilih kamera, atau isi nomor kamera (mis. 0)");
  if (form.sourceType === "ip" && !/^(https?|rtsp):\/\//.test(form.source)) return toast("warning", "Alamat kamera IP belum benar", "Harus diawali http://, https://, atau rtsp://");
  if (form.sourceType === "video" && !form.source.trim()) return toast("warning", "Pilih file video", "Klik Muat daftar lalu pilih video dari data/test-video/");
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

async function resetToEnv() {
  if (!cameraId.value) return;
  const ok = await confirmDialog({
    title: "Kembalikan ke pengaturan .env?", okText: "Kembalikan",
    text: "Pengaturan dari halaman ini dihapus dan agent kembali memakai pengaturan di file .env laptop kamera.",
  });
  if (!ok) return;
  busy.value = "reset";
  try {
    await api("DELETE", `/api/cameras/${cameraId.value}/config`);
    toast("success", "Kembali ke pengaturan .env");
    await load();
  } catch (e) {
    toast("error", "Gagal", (e as Error).message);
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
function makeVertical() {
  if (!form.finishLine) return;
  const x = Math.round((form.finishLine.x1 + form.finishLine.x2) / 2);
  form.finishLine = { x1: x, y1: form.finishLine.y1, x2: x, y2: form.finishLine.y2 };
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
const shortPath = (p: string) => p.split("/").slice(-2).join("/");
</script>

<template>
  <div class="crumbs"><button @click="emit('back')">Sesi Lomba</button><AppIcon name="chevron" /><span>Pengaturan Kamera</span></div>
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
          <span class="chip mono">{{ cameraId }}</span>
          <span v-if="status?.width" class="chip">{{ status.width }}×{{ status.height }}</span>
          <span v-if="status?.measuredFps" class="chip">{{ status.measuredFps }} fps terukur</span>
          <span v-if="current?.connected && status?.running === false" class="status-pill status-danger"><span class="dot" />Kamera tidak berjalan</span>
          <span v-else-if="current?.connected && (status?.lastFrameAgeMs ?? 0) > 3000" class="status-pill status-danger"><span class="dot" />Kamera tidak mengirim gambar</span>
          <span v-if="current?.saved" class="chip chip-brand">Pengaturan web · rev {{ current.saved.revision }}</span>
          <span v-else class="chip">Pengaturan .env</span>
        </div>
        <div v-if="status?.notice" class="alert alert-warn"><AppIcon name="warning" /><span>{{ status.notice }}</span></div>
        <div v-if="current?.connected && status?.running === false" class="alert alert-danger">
          <AppIcon name="error" />
          <span><strong>Kamera {{ status.settings?.source }} tidak bisa dibuka — agent terus mencoba setiap 3 detik.</strong> {{ status.lastError }}
            Bila kamera itu memang tidak tersedia (mis. iPhone tidak tersambung), <strong>Pindai kamera</strong> lalu pilih kamera lain dan Terapkan.</span>
        </div>
        <div v-else-if="status?.lastError" class="alert alert-danger"><AppIcon name="error" /><span>Percobaan terakhir gagal: {{ status.lastError }}</span></div>
        <div v-if="current?.connected && status?.running !== false && (status?.lastFrameAgeMs ?? 0) > 3000" class="alert alert-warn">
          <AppIcon name="warning" /><span>Kamera berhenti mengirim gambar — agent mencoba membuka ulang. iPhone: pastikan terkunci, diam, dan dekat Mac. USB: cek kabel. Atau pilih kamera lain lalu Terapkan.</span>
        </div>
      </section>

      <!-- sumber -->
      <section class="card">
        <h2 class="card-title"><AppIcon name="camera" /> Sumber kamera</h2>
        <div class="source-grid" role="radiogroup" aria-label="Sumber kamera">
          <button
            v-for="s in SOURCES" :key="s.type" type="button" class="source" :class="{ active: form.sourceType === s.type }"
            role="radio" :aria-checked="form.sourceType === s.type" @click="selectSource(s.type)"
          >
            <AppIcon :name="s.icon" size="26" />
            <span>{{ s.label }}</span>
          </button>
        </div>
        <p class="hint" style="margin: 10px 0 14px"><AppIcon name="info" /> {{ sourceMeta.hint }}</p>

        <template v-if="usesDevice">
          <div class="row" style="align-items: flex-end">
            <label class="field" style="flex: 1; min-width: 240px">
              <span class="field-label">Perangkat</span>
              <select v-if="scanResult?.cameras.length" v-model="form.source" class="input" @change="resetLineForNewCamera">
                <option v-for="c in scanResult.cameras" :key="c.index" :value="String(c.index)">{{ deviceLabel(c) }}</option>
              </select>
              <input v-else v-model="form.source" class="input mono" placeholder="Nomor kamera, mis. 0" />
            </label>
            <button class="btn" :disabled="busy !== null || !current?.connected" @click="scan">
              <AppIcon :name="busy === 'scan' ? 'pending' : 'search'" /> {{ busy === "scan" ? "Memindai…" : "Pindai kamera" }}
            </button>
          </div>
          <p v-if="scanResult?.deviceNames.length" class="hint" style="margin: 8px 0 0">
            Terdeteksi sistem: {{ scanResult.deviceNames.join(" · ") }}. Nomor kamera tidak selalu berurutan sama — cek gambar live setelah diterapkan.
          </p>
          <p v-else-if="!scanResult" class="hint" style="margin: 8px 0 0">Klik <strong>Pindai kamera</strong> untuk melihat kamera yang terpasang di laptop agent.</p>
        </template>

        <label v-else-if="form.sourceType === 'ip'" class="field">
          <span class="field-label">Alamat stream</span>
          <input v-model="form.source" class="input mono" placeholder="http://192.168.1.20:8080/video  atau  rtsp://…" />
          <span class="field-help">Gunakan alamat yang ditampilkan aplikasi kamera IP. HP & laptop agent harus di jaringan yang sama.</span>
        </label>

        <template v-else>
          <div class="row" style="align-items: flex-end">
            <label class="field" style="flex: 1; min-width: 240px">
              <span class="field-label">File video</span>
              <select v-if="scanResult?.videos.length" v-model="form.source" class="input">
                <option v-for="v in scanResult.videos" :key="v" :value="v">{{ shortPath(v) }}</option>
              </select>
              <input v-else v-model="form.source" class="input mono" placeholder="…/data/test-video/sungai-h2h.mp4" />
            </label>
            <button class="btn" :disabled="busy !== null || !current?.connected" @click="scan">
              <AppIcon :name="busy === 'scan' ? 'pending' : 'search'" /> {{ busy === "scan" ? "Memuat…" : "Muat daftar" }}
            </button>
          </div>
        </template>

        <div class="grid-2" style="margin-top: 16px">
          <label class="field">
            <span class="field-label">Frame per detik (fps)</span>
            <select v-model.number="form.fps" class="input">
              <option v-for="f in FPS_OPTIONS" :key="f" :value="f">{{ f }} fps · {{ (1000 / f).toFixed(1) }} ms/frame</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Resolusi</span>
            <select class="input" :value="`${form.width ?? ''}x${form.height ?? ''}`"
              @change="(e) => { const r = RES_OPTIONS.find((o) => `${o.w ?? ''}x${o.h ?? ''}` === (e.target as HTMLSelectElement).value); form.width = r?.w ?? null; form.height = r?.h ?? null; }">
              <option v-for="r in RES_OPTIONS" :key="r.label" :value="`${r.w ?? ''}x${r.h ?? ''}`">{{ r.label }}</option>
            </select>
          </label>
        </div>
        <p v-if="form.fps < 120" class="hint" style="margin: 8px 0 0">Untuk lomba resmi (akurasi 1/100 detik) gunakan kamera ≥ 120 fps.</p>
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
            <button class="btn btn-sm" @click="makeVertical">Luruskan</button>
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
          <p class="hint" style="margin: 6px 0 0">{{ sensitivity ? SENSITIVITY[sensitivity].hint : "Kustom" }}</p>
          <button class="btn btn-ghost btn-sm" style="margin-top: 6px" @click="showAdvanced = !showAdvanced"><AppIcon name="tune" /> {{ showAdvanced ? "Sembunyikan" : "Lanjutan" }}</button>
          <div v-if="showAdvanced" class="grid-2" style="margin-top: 8px">
            <label class="field"><span class="field-label">Ambang warna (5–150)</span><input v-model.number="form.trigger.threshold" type="number" min="5" max="150" class="input" /></label>
            <label class="field"><span class="field-label">Panjang benda min. (0,01–0,5)</span><input v-model.number="form.trigger.minRun" type="number" min="0.01" max="0.5" step="0.01" class="input" /></label>
          </div>
        </template>

        <h2 class="card-title" style="margin-top: 22px"><AppIcon name="target" /> Filter objek</h2>
        <label class="switch-row">
          <span><strong>Teruskan pemicu hanya bila objek ini yang melintas</strong><small>Orang lewat, burung, ranting, riak & bayangan diabaikan otomatis. Waktu finish tetap dari photocell.</small></span>
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
              v-for="o in classOptions" :key="o.cls" type="button" class="chip-toggle" :class="{ on: of.classes.includes(o.cls) }"
              :title="o.cls" @click="toggleClass(o.cls)"
            >{{ o.label }}<small v-if="o.label !== o.cls">{{ o.cls }}</small></button>
            <span class="custom-class">
              <input v-model="customClass" class="input input-sm" placeholder="kelas lain, mis. raft" @keydown.enter.prevent="addCustomClass" />
              <button type="button" class="btn btn-sm" @click="addCustomClass"><AppIcon name="add" /></button>
            </span>
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
              <span v-if="filterStatus.lastRejected" class="hint">terakhir diabaikan: {{ filterStatus.lastRejected }}</span>
              <span v-if="filterStatus.lastMs" class="hint">· {{ filterStatus.lastMs }} ms</span>
            </template>
          </div>
        </template>

        <h2 class="card-title" style="margin-top: 22px"><AppIcon name="camera" /> Foto frame</h2>
        <label class="switch-row">
          <span><strong>Simpan foto kamera utuh di sekitar finish</strong><small>Untuk tinjauan frame demi frame (proporsi asli, tidak gepeng)</small></span>
          <input v-model="form.frames.enabled" type="checkbox" class="switch" />
        </label>
        <div v-if="form.frames.enabled" class="grid-2" style="margin-top: 10px">
          <label class="field"><span class="field-label">Foto per detik</span>
            <select v-model.number="form.frames.fps" class="input"><option v-for="f in [15, 30, 60]" :key="f" :value="f">{{ f }}</option></select>
          </label>
          <label class="field"><span class="field-label">Lebar foto</span>
            <select v-model.number="form.frames.width" class="input"><option v-for="w in [960, 1280, 1920]" :key="w" :value="w">{{ w }} px</option></select>
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
          <span class="spacer" />
          <button v-if="current?.saved" class="btn btn-ghost" :disabled="busy !== null" @click="resetToEnv">Kembalikan ke .env</button>
        </div>
        <p class="hint" style="margin: 8px 0 0">Bila kamera baru gagal dibuka, agent otomatis kembali ke pengaturan sebelumnya (bila kamera lama masih tersedia). Setiap perubahan tercatat di audit log.</p>
      </section>
    </div>

    <!-- ======================= kanan: gambar live ======================= -->
    <aside class="col-preview">
      <section class="race-window">
        <div class="race-toolbar">
          <span class="status-pill" :class="live ? 'status-live' : 'status-muted'"><span class="dot" />{{ live ? "LIVE" : "Tidak ada gambar" }}</span>
          <span v-if="preview" class="readout">{{ preview.width }}×{{ preview.height }} · {{ preview.fps || "?" }} fps</span>
        </div>
        <div v-if="preview && imgUrl" class="stage" :class="{ picking: lineMode === 'manual' }" @click="pickOnImage">
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
.custom-class { display: inline-flex; gap: 4px; }
.custom-class .input { width: 170px; }
.filter-stats { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.chip-ok { background: var(--ok-bg); color: var(--ok-ink); }

.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 0.9fr); gap: 20px; align-items: start; }
.col-preview { position: sticky; top: calc(var(--nav-h) + 16px); }
.card-title { font-size: 1rem; margin-bottom: 12px; }
.status-card { padding: 14px 18px; }
.source-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.source { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 8px; border-radius: 14px; border: 1.5px solid var(--border); background: var(--surface-2); color: var(--text-2); font-weight: 700; font-size: 0.85rem; text-align: center; transition: all 0.15s; }
.source:hover { border-color: var(--brand-2); color: var(--brand); }
.source:focus-visible { box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.25); }
.source.active { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); box-shadow: 0 0 0 3px rgba(24, 116, 165, 0.12); }
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
@media (max-width: 640px) { .source-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
