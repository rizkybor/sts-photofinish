import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { allows, type Principal, verifyToken } from "./auth.js";
import type { Config } from "./config.js";
import { AgentExtractFailed, AgentTrigger, TimingClock, TimingImpulse } from "./schemas.js";
import type { Bus, Service } from "./service.js";

const ACK_TIMEOUT_MS = 5000;
/** Cuplikan standby JPEG ±100 KB; batas socket dinaikkan secukupnya. */
const MAX_SOCKET_MESSAGE = 1024 * 1024;
/** Koneksi agent tanpa pesan selama ini dianggap mati (agent mengirim status/sinkron jam tiap ±2 dtk). */
const STALE_AGENT_MS = 6000;
const MAX_PREVIEW_JPEG = 900 * 1024;
const CAMERA_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Ack = (res: { ok: boolean; error?: string; [k: string]: unknown }) => void;

/**
 * Berbeda dari sts-racehub: koneksi TANPA token ditolak, dan pesan hanya
 * dikirim ke room yang berhak (bukan io.emit ke semua klien).
 *
 * Room: "staff" (semua pengguna), "session:<id>", "agents", "timing".
 */
export function createRealtime(httpServer: HttpServer, cfg: Config) {
  const io = new Server(httpServer, {
    cors: { origin: cfg.corsOrigins, credentials: true },
    maxHttpBufferSize: MAX_SOCKET_MESSAGE,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token) return next(new Error("Unauthorized"));
    try {
      socket.data.principal = verifyToken(token, cfg.PF_JWT_SECRET);
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  const bus: Bus = {
    toSession: (sessionId, event, data) => void io.to(`session:${sessionId}`).emit(event, data),
    toStaff: (event, data) => void io.to("staff").emit(event, data),
    toAgents: (event, data) => {
      if ((io.sockets.adapter.rooms.get("agents")?.size ?? 0) === 0) return false;
      io.to("agents").emit(event, data);
      return true;
    },
    notifyTiming: (event, data) => void io.to("timing").emit(event, data),
    toTiming: async (event, data) => {
      if ((io.sockets.adapter.rooms.get("timing")?.size ?? 0) === 0) return false;
      try {
        const acks = (await io.to("timing").timeout(ACK_TIMEOUT_MS).emitWithAck(event, data)) as Array<{ ok?: boolean }>;
        return acks.some((a) => a?.ok === true);
      } catch {
        return false; // timeout — dikirim ulang saat timing reconnect
      }
    },
  };

  // ---------------------------------------------------------- cuplikan standby kamera
  // Agent hanya mengirim cuplikan selama room "preview:<cameraId>" berisi
  // penonton — tidak membebani kamera/jaringan saat tidak ada yang melihat.
  const previewRoom = (cameraId: string) => `preview:${cameraId}`;
  const watchers = (cameraId: string) => io.sockets.adapter.rooms.get(previewRoom(cameraId))?.size ?? 0;
  function syncPreview(cameraId: string) {
    io.to("agents").emit("agent:preview", { cameraId, on: watchers(cameraId) > 0 });
  }
  function activePreviewCameras(): string[] {
    return [...io.sockets.adapter.rooms.keys()].filter((r) => r.startsWith("preview:")).map((r) => r.slice("preview:".length));
  }

  // ---------------------------------------------------------- pengaturan kamera
  // cameraId → socket agent + status terakhir yang dilaporkan agent.
  const cameraStatus = new Map<string, Record<string, unknown>>();
  function agentSocket(cameraId: string): Socket | undefined {
    return [...(io.sockets.adapter.rooms.get("agents") ?? [])]
      .map((id) => io.sockets.sockets.get(id))
      .find((s) => s?.data.cameraId === cameraId);
  }
  async function askAgent(cameraId: string, event: string, data: unknown, timeoutMs: number) {
    const s = agentSocket(cameraId);
    if (!s) return { ok: false, offline: true, error: `Agent kamera "${cameraId}" tidak terhubung` };
    try {
      return (await s.timeout(timeoutMs).emitWithAck(event, data)) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "Agent tidak menjawab (timeout) — kamera mungkin sedang dibuka ulang" };
    }
  }
  const cameras = {
    connected: (cameraId: string) => !!agentSocket(cameraId),
    status: (cameraId: string) => cameraStatus.get(cameraId) ?? null,
    ids: () => [...cameraStatus.keys()],
    /** Terapkan pengaturan (null = kembali ke .env). Membuka kamera bisa beberapa detik. */
    applyConfig: (cameraId: string, config: unknown) => askAgent(cameraId, "agent:config", { config }, 25_000),
    scan: (cameraId: string) => askAgent(cameraId, "agent:scan", {}, 30_000),
  };

  function attach(service: Service) {
    io.on("connection", (socket: Socket) => {
      const p = socket.data.principal as Principal;

      if (p.role === "device" && p.deviceKind === "timing") {
        socket.join("timing");
        socket.on("timing:impulse", (raw: unknown, ack?: Ack) => handle(ack, async () => {
          const imp = await service.ingestImpulse(TimingImpulse.parse(raw));
          return { impulseId: imp._id.toHexString() };
        }));
        socket.on("timing:clock", (raw: unknown, ack?: Ack) => handle(ack, () => service.updateClock(TimingClock.parse(raw))));
        // Sinkron jam (gaya NTP) — timing mengonversi kalibrasi Long Range ⇄ Photo Finish.
        socket.on("clock:ping", (_: unknown, ack?: Ack) => ack?.({ ok: true, serverNs: service.serverNowNs().toString() }));
        // Kalibrasi Long Range Start (dari timing) → diterapkan bila lebih baru.
        socket.on("timing:calibration", (raw: unknown, ack?: Ack) => handle(ack, () => service.applyTimingCalibration(raw)));
        // Kalibrasi Photo Finish terkini → timing (Long Range mengikuti bila lebih baru).
        service.calibrationForTiming().then((msg) => socket.emit("pf:calibration", msg)).catch((err) => console.error("[calibration]", err));
        // Panel "Hasil Photo Finish": gambar bukti satu hasil (hanya baca).
        socket.on("timing:result-image", (raw: unknown, ack?: Ack) => handle(ack, () =>
          service.resultImage(String((raw as { crossingId?: unknown } | null)?.crossingId ?? ""))));
        service.redeliverPending().catch((err) => console.error("[redeliver]", err));
        return;
      }

      if (p.role === "device" && p.deviceKind === "agent") {
        // Satu kamera = satu agent. Dua agent dengan cameraId sama membuat
        // cuplikan standby bergantian (berkedip) dan rekaman terkirim ganda.
        const cameraId = socket.handshake.auth?.cameraId;
        const bootId = typeof socket.handshake.auth?.bootId === "string" ? socket.handshake.auth.bootId : null;
        // Setiap pesan dari agent (status, sinkron jam) = tanda koneksi masih hidup.
        socket.data.lastSeen = Date.now();
        socket.use((_packet, next) => { socket.data.lastSeen = Date.now(); next(); });
        let replaced: Socket[] = [];
        if (typeof cameraId === "string" && CAMERA_ID.test(cameraId)) {
          const others = [...(io.sockets.adapter.rooms.get("agents") ?? [])]
            .map((id) => io.sockets.sockets.get(id))
            .filter((s): s is Socket => !!s && s.id !== socket.id && s.data.cameraId === cameraId);
          // Agent yang sama menyambung ulang (internet putus sesaat), atau koneksi lama
          // sudah diam (belum terdeteksi putus di balik proxy) → ambil alih, jangan tolak.
          const live = others.filter((s) => !(bootId && s.data.bootId === bootId) && Date.now() - (s.data.lastSeen ?? 0) < STALE_AGENT_MS);
          if (live.length) {
            socket.emit("agent:rejected", { error: `Kamera "${cameraId}" sudah dipakai agent lain yang sedang berjalan. Hentikan agent lama (Ctrl+C) atau pakai PF_CAMERA_ID berbeda.` });
            setTimeout(() => socket.disconnect(true), 200);
            return;
          }
          replaced = others;
          socket.data.cameraId = cameraId;
          socket.data.bootId = bootId;
        }
        socket.join("agents");
        // Putuskan koneksi lama SETELAH yang baru bergabung — status kamera tidak sempat "terputus".
        for (const old of replaced) old.disconnect(true);
        if (socket.data.cameraId) {
          const camId = socket.data.cameraId as string;
          socket.on("agent:status", (st: unknown) => {
            if (!st || typeof st !== "object") return;
            const status = { ...(st as Record<string, unknown>), cameraId: camId, connected: true, at: Date.now() };
            cameraStatus.set(camId, status);
            io.to("staff").emit("camera:status", status);
          });
          socket.on("disconnect", () => {
            if (agentSocket(camId)) return; // agent lain sudah menggantikan
            const prev = cameraStatus.get(camId) ?? { cameraId: camId };
            cameraStatus.set(camId, { ...prev, connected: false, at: Date.now() });
            io.to("staff").emit("camera:status", cameraStatus.get(camId));
          });
          // Pengaturan tersimpan dari web diterapkan begitu agent terhubung.
          service.getCameraConfig(camId).then((saved) => {
            if (saved) socket.emit("agent:config", { config: saved.config }, () => undefined);
          }).catch((err) => console.error("[camera-config]", err));
        }
        // Ping-pong sinkron jam agent (gaya NTP, agent memilih RTT terkecil).
        socket.on("clock:ping", (_: unknown, ack?: Ack) => ack?.({ ok: true, serverNs: service.serverNowNs().toString() }));
        socket.on("agent:trigger", (raw: unknown, ack?: Ack) => handle(ack, () => service.ingestCameraTrigger(p, AgentTrigger.parse(raw))));
        socket.on("agent:extract-failed", (raw: unknown) => {
          const parsed = AgentExtractFailed.safeParse(raw);
          if (parsed.success) service.markCaptureFailed(parsed.data.groupId, parsed.data.error).catch((err) => console.error("[extract-failed]", err));
        });
        socket.on("agent:preview-frame", (frame: unknown) => {
          const f = frame as { cameraId?: unknown; jpeg?: unknown };
          if (typeof f?.cameraId !== "string" || !CAMERA_ID.test(f.cameraId)) return;
          if (!Buffer.isBuffer(f.jpeg) || f.jpeg.length > MAX_PREVIEW_JPEG) return;
          // volatile: frame lama dibuang bila penonton lambat — selalu tampil yang terbaru.
          io.to(previewRoom(f.cameraId)).volatile.emit("preview:frame", { ...f, receivedAt: Date.now() });
        });
        for (const cameraId of activePreviewCameras()) socket.emit("agent:preview", { cameraId, on: true });
        service.resumePending().catch((err) => console.error("[resume]", err));
        return;
      }

      if (p.role === "device") return void socket.disconnect(true);

      socket.join("staff");
      // Status kamera terakhir langsung dikirim — indikator REC di web tidak
      // perlu menunggu laporan agent berikutnya.
      for (const status of cameraStatus.values()) socket.emit("camera:status", status);

      // Standby kamera: hanya operator ke atas (rekaman atlet = data pribadi).
      socket.on("preview:subscribe", (cameraId: unknown, ack?: Ack) => {
        if (!allows(p.role, "operator")) return ack?.({ ok: false, error: "Akses ditolak" });
        if (typeof cameraId !== "string" || !CAMERA_ID.test(cameraId)) return ack?.({ ok: false, error: "cameraId tidak valid" });
        for (const room of socket.rooms) if (room.startsWith("preview:")) socket.leave(room);
        socket.join(previewRoom(cameraId));
        syncPreview(cameraId);
        ack?.({ ok: true, agents: io.sockets.adapter.rooms.get("agents")?.size ?? 0 });
      });
      socket.on("preview:unsubscribe", (cameraId: unknown) => {
        if (typeof cameraId !== "string" || !CAMERA_ID.test(cameraId)) return;
        socket.leave(previewRoom(cameraId));
        syncPreview(cameraId);
      });
      socket.on("disconnecting", () => {
        const cams = [...socket.rooms].filter((r) => r.startsWith("preview:")).map((r) => r.slice("preview:".length));
        if (cams.length) setImmediate(() => cams.forEach(syncPreview)); // setelah socket benar-benar keluar room
      });
      socket.on("session:join", (sessionId: unknown, ack?: Ack) => {
        if (typeof sessionId !== "string" || !/^[0-9a-f]{24}$/.test(sessionId) || !allows(p.role, "viewer")) {
          return ack?.({ ok: false, error: "sessionId tidak valid" });
        }
        for (const room of socket.rooms) if (room.startsWith("session:")) socket.leave(room);
        socket.join(`session:${sessionId}`);
        ack?.({ ok: true });
      });
    });
  }

  return { io, bus, attach, cameras };
}

async function handle(ack: Ack | undefined, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    ack?.({ ok: true, ...(typeof result === "object" && result ? result : {}) });
  } catch (err) {
    ack?.({ ok: false, error: err instanceof Error ? err.message : "Gagal" });
  }
}
