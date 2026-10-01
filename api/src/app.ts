import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { ZodError, z } from "zod";
import { createAuditLog } from "./audit.js";
import { issueToken, makeGuards, verifyPassword } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { openFile, resolveCapturePath, verifyFileUrl } from "./files.js";
import { createRealtime } from "./realtime.js";
import {
  CalibrateBody, CaptureCreate, ClockSettingsUpdate, CrossingConfirm, CrossingMark, LoginBody, SessionCreate, TimingClock, TimingImpulse,
} from "./schemas.js";
import { createService, HttpError } from "./service.js";

export async function buildApp(cfg: Config, database: Database) {
  const app: FastifyInstance = Fastify({
    logger: { level: cfg.NODE_ENV === "production" ? "info" : cfg.NODE_ENV === "test" ? "warn" : "debug", redact: ["req.headers.authorization"] },
    bodyLimit: 256 * 1024,
  });
  await app.register(cors, { origin: cfg.corsOrigins, credentials: true });
  await app.register(rateLimit, { global: false });

  const audit = createAuditLog(database.col.audit);
  const realtime = createRealtime(app.server, cfg);
  const service = createService(cfg, database, audit, realtime.bus);
  realtime.attach(service);
  const guard = makeGuards(cfg.PF_JWT_SECRET);
  const { col } = database;

  // BigInt tidak bisa di-JSON-kan secara bawaan; ObjectId → hex.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof ObjectId ? v.toHexString() : v)),
  );

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Data tidak valid", issues: err.issues });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "Kesalahan server" });
  });

  const IdParam = z.object({ id: z.string() });

  // ------------------------------------------------------------ umum
  app.get("/health", async () => ({ ok: true }));

  app.post("/api/auth/login", {
    config: { rateLimit: { max: cfg.PF_LOGIN_RATE_MAX, timeWindow: "5 minutes" } },
  }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const user = await col.users.findOne({ username: body.username });
    // Pesan sama untuk user tidak ada / password salah — tidak membocorkan username.
    if (!user || user.disabled || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "Username atau password salah" });
    }
    const principal = { sub: user._id.toHexString(), name: user.name, role: user.role };
    return { token: issueToken(principal, cfg.PF_JWT_SECRET, cfg.PF_USER_TOKEN_TTL), user: principal };
  });

  app.get("/api/me", { preHandler: guard.require("viewer") }, async (req) => req.principal);

  // ------------------------------------------------------------ sesi
  app.get("/api/sessions", { preHandler: guard.require("viewer") }, async () =>
    col.sessions.find().sort({ createdAt: -1 }).limit(100).toArray());

  app.post("/api/sessions", { preHandler: guard.require("operator") }, async (req, reply) =>
    reply.code(201).send(await service.createSession(req.principal!, SessionCreate.parse(req.body))));

  app.get("/api/sessions/:id", { preHandler: guard.require("viewer") }, async (req) =>
    service.sessionDetail(IdParam.parse(req.params).id));

  app.post("/api/sessions/:id/arm", { preHandler: guard.require("operator") }, async (req) => {
    await service.armSession(req.principal!, IdParam.parse(req.params).id, true);
    return { ok: true };
  });

  app.post("/api/sessions/:id/disarm", { preHandler: guard.require("operator") }, async (req) => {
    await service.armSession(req.principal!, IdParam.parse(req.params).id, false);
    return { ok: true };
  });

  app.post("/api/sessions/:id/close", { preHandler: guard.require("operator") }, async (req) => {
    await service.closeSession(req.principal!, IdParam.parse(req.params).id);
    return { ok: true };
  });

  app.post("/api/sessions/:id/calibrate", { preHandler: guard.require("operator") }, async (req) =>
    service.calibrate(req.principal!, IdParam.parse(req.params).id, CalibrateBody.parse(req.body)));

  // ------------------------------------------------------------ impuls (HTTP alternatif socket)
  app.get("/api/impulses/unassigned", { preHandler: guard.require("operator") }, async () =>
    col.impulses.find({ sessionId: null }).sort({ receivedAt: -1 }).limit(200).toArray());

  app.post("/api/impulses", { preHandler: guard.require("device", "timing") }, async (req, reply) =>
    reply.code(201).send(await service.ingestImpulse(TimingImpulse.parse(req.body))));

  app.post("/api/impulses/:id/assign", { preHandler: guard.require("operator") }, async (req) => {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(req.body);
    await service.assignImpulse(req.principal!, IdParam.parse(req.params).id, sessionId);
    return { ok: true };
  });

  app.post("/api/timing/clock", { preHandler: guard.require("device", "timing") }, async (req) => {
    await service.updateClock(TimingClock.parse(req.body));
    return { ok: true };
  });

  // ------------------------------------------------------------ jam Photo Finish
  app.get("/api/clock/status", { preHandler: guard.require("viewer") }, async () => service.clockStatus());

  app.post("/api/clock/settings", { preHandler: guard.require("admin") }, async (req) =>
    service.updateClockSettings(req.principal!, ClockSettingsUpdate.parse(req.body)));

  // ------------------------------------------------------------ agent
  app.get("/api/clock", { preHandler: guard.require("device", "agent") }, async () => ({ serverNs: service.serverNowNs().toString() }));

  app.post("/api/captures", { preHandler: guard.require("device", "agent") }, async (req, reply) =>
    reply.code(201).send(await service.addCapture(req.principal!, CaptureCreate.parse(req.body))));

  // ------------------------------------------------------------ crossing (juri)
  app.post("/api/crossings", { preHandler: guard.require("operator") }, async (req, reply) =>
    reply.code(201).send(await service.markCrossing(req.principal!, CrossingMark.parse(req.body))));

  app.delete("/api/crossings/:id", { preHandler: guard.require("operator") }, async (req) => {
    await service.deleteCrossing(req.principal!, IdParam.parse(req.params).id);
    return { ok: true };
  });

  app.post("/api/crossings/:id/confirm", { preHandler: guard.require("judge") }, async (req) =>
    service.confirmCrossing(req.principal!, IdParam.parse(req.params).id, CrossingConfirm.parse(req.body)));

  // ------------------------------------------------------------ audit
  app.get("/api/audit", { preHandler: guard.require("judge") }, async (req) => {
    const { entityId } = z.object({ entityId: z.string().optional() }).parse(req.query);
    return col.audit.find(entityId ? { entityId } : {}).sort({ seq: -1 }).limit(500).toArray();
  });

  app.get("/api/audit/verify", { preHandler: guard.require("admin") }, async () => audit.verify());

  // ------------------------------------------------------------ file bertanda tangan
  app.get("/files/*", async (req, reply) => {
    const rel = decodeURIComponent((req.params as { "*": string })["*"]);
    const { exp, sig } = z.object({ exp: z.string(), sig: z.string() }).parse(req.query);
    if (!verifyFileUrl(cfg.PF_FILE_URL_SECRET, rel, exp, sig)) return reply.code(403).send({ error: "URL kedaluwarsa atau tidak valid" });
    const full = resolveCapturePath(cfg.PF_CAPTURES_DIR, rel);
    const { size, stream } = await openFile(full).catch(() => {
      throw new HttpError(404, "File tidak ditemukan");
    });
    const type = rel.endsWith(".png") ? "image/png" : rel.endsWith(".json") ? "application/json" : rel.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
    return reply.header("content-type", type).header("content-length", size).header("cache-control", "private, max-age=600").send(stream);
  });

  app.addHook("onReady", async () => {
    await service.resumePending();
  });
  app.addHook("onClose", async () => {
    realtime.io.close();
  });

  return app;
}
