import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { allows, type Principal, verifyToken } from "./auth.js";
import type { Config } from "./config.js";
import { TimingClock, TimingImpulse } from "./schemas.js";
import type { Bus, Service } from "./service.js";

const ACK_TIMEOUT_MS = 5000;

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
    maxHttpBufferSize: 64 * 1024,
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
        service.redeliverPending().catch((err) => console.error("[redeliver]", err));
        return;
      }

      if (p.role === "device" && p.deviceKind === "agent") {
        socket.join("agents");
        // Ping-pong sinkron jam agent (gaya NTP, agent memilih RTT terkecil).
        socket.on("clock:ping", (_: unknown, ack?: Ack) => ack?.({ ok: true, serverNs: service.serverNowNs().toString() }));
        service.resumePending().catch((err) => console.error("[resume]", err));
        return;
      }

      if (p.role === "device") return void socket.disconnect(true);

      socket.join("staff");
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

  return { io, bus, attach };
}

async function handle(ack: Ack | undefined, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    ack?.({ ok: true, ...(typeof result === "object" && result ? result : {}) });
  } catch (err) {
    ack?.({ ok: false, error: err instanceof Error ? err.message : "Gagal" });
  }
}
