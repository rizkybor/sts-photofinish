import { ObjectId } from "mongodb";
import type { Principal } from "./auth.js";
import type { AuditLog } from "./audit.js";
import { signPayload, verifyPayload } from "./canonical.js";
import type { Config } from "./config.js";
import type { CaptureDoc, ClockSettingsDoc, ClockSnapshot, CrossingDoc, Database, GroupDoc, ImpulseDoc, SessionDoc } from "./db.js";
import { rm, unlink } from "node:fs/promises";
import { fileSha256, readColumns, readFramesIndex, resolveCapturePath, signFileUrl } from "./files.js";
import { findTies, pairByOrder } from "./pairing.js";
import type { z } from "zod";
import { AgentTrigger } from "./schemas.js";
import type { CalibrateBody, CameraConfig, CaptureCreate, ClockSettingsUpdate, CrossingConfirm, CrossingMark, PhotofinishVerified, SessionCreate, TimingClock, TimingImpulse } from "./schemas.js";
import {
  deviceToAgentNs, diffDayNs, formatClock, frameToDeviceNs, NS_PER_MS, NS_PER_SEC, nowEpochNs, officialClock, parseClock, toNs, wrapDay,
} from "./time.js";

/** Kanal keluar — diimplementasikan oleh realtime.ts (Socket.IO). */
export interface Bus {
  toSession(sessionId: string, event: string, data: unknown): void;
  toStaff(event: string, data: unknown): void;
  /** false bila tidak ada agent yang terhubung. */
  toAgents(event: string, data: unknown): boolean;
  /** Resolve true bila timing system meng-ack pesan. */
  toTiming(event: string, data: unknown): Promise<boolean>;
  /** Kirim ke timing system tanpa menunggu ack (notifikasi langsung, boleh hilang). */
  notifyTiming(event: string, data: unknown): void;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const oid = (id: string, what: string) => {
  if (!ObjectId.isValid(id)) throw new HttpError(400, `${what} tidak valid`);
  return new ObjectId(id);
};

export function createService(cfg: Config, { col, client }: Database, audit: AuditLog, bus: Bus) {
  // ---------------------------------------------------------------- event (sts-timingsystem)
  // Sesi cukup terhubung ke Event lewat Id Event. Nama Event dibaca (read-only)
  // dari eventsCollection milik sts-timingsystem di cluster yang sama;
  // categoriesEvent/Division/Race/Initial sengaja TIDAK dibaca.
  const timingEvents = cfg.PF_TIMING_DB ? client.db(cfg.PF_TIMING_DB).collection<{ _id: unknown; eventName?: string; startDateEvent?: unknown; endDateEvent?: unknown; statusEvent?: unknown }>("eventsCollection") : null;
  let eventsCache: { at: number; list: Array<{ eventId: string; eventName: string; startDate: unknown; endDate: unknown; status: unknown }> } | null = null;

  async function listEvents() {
    if (!timingEvents) return [];
    if (eventsCache && eventsCache.list.length && Date.now() - eventsCache.at < 30_000) return eventsCache.list;
    const docs = await timingEvents.find({}, { projection: { eventName: 1, startDateEvent: 1, endDateEvent: 1, statusEvent: 1 } }).sort({ _id: -1 }).limit(200).toArray();
    const list = docs.map((e) => ({ eventId: String(e._id), eventName: String(e.eventName ?? ""), startDate: e.startDateEvent ?? null, endDate: e.endDateEvent ?? null, status: e.statusEvent ?? null }));
    eventsCache = { at: Date.now(), list };
    return list;
  }

  /** Sesi lama (dibuat sebelum ada eventName) tetap tampil dengan nama Event — tanpa menulis DB. */
  async function withEventName<T extends { eventId: string; eventName?: string | null }>(rows: T[]): Promise<T[]> {
    if (rows.every((r) => r.eventName)) return rows;
    const names = new Map((await listEvents().catch(() => [])).map((e) => [e.eventId, e.eventName]));
    return rows.map((r) => (r.eventName ? r : { ...r, eventName: names.get(r.eventId) || null }));
  }

  /** Nama Event dari Id Event; null bila tidak ditemukan / database timing tidak dikonfigurasi. */
  async function eventNameOf(eventId: string): Promise<string | null> {
    try {
      const hit = (await listEvents()).find((e) => e.eventId === eventId);
      if (hit) return hit.eventName || null;
      eventsCache = null; // event baru dibuat — muat ulang sekali
      return (await listEvents()).find((e) => e.eventId === eventId)?.eventName || null;
    } catch {
      return null; // database timing tidak terjangkau — sesi tetap bisa dibuat
    }
  }

  const quietTimers = new Map<string, NodeJS.Timeout>();
  const gapNs = BigInt(cfg.PF_GROUP_GAP_MS) * NS_PER_MS;

  // ---------------------------------------------------------------- jam

  async function currentDeviceOffset(): Promise<string | null> {
    const c = await col.clock.findOne({ _id: "timing" });
    return c?.deviceOffsetNs ?? null;
  }

  async function updateClock(msg: TimingClock) {
    if (!verifyPayload(msg, cfg.PF_HMAC_SECRET)) throw new HttpError(401, "Tanda tangan HMAC tidak valid");
    await col.clock.updateOne(
      { _id: "timing" },
      { $set: { bootId: msg.bootId, deviceOffsetNs: msg.deviceOffsetNs, samples: msg.samples, windowMs: msg.windowMs, hostNs: msg.hostNs, receivedAt: new Date() } },
      { upsert: true },
    );
  }

  // ------------------------------------------------ jam Photo Finish (kalibrasi admin)
  //
  // Jam PF = jam host − effectiveOffset, dalam basis waktu RaceTime2.
  //   auto   : base = offset dari heartbeat RaceTime2 (timing:clock)
  //   manual : base = offset yang dikunci admin — tetap jalan walau timing putus
  //   effectiveOffset = base − trim   (trim positif = jam PF maju)

  async function clockSettings(): Promise<ClockSettingsDoc> {
    return (await col.clockSettings.findOne({ _id: "settings" })) ?? {
      _id: "settings", mode: "auto", manualOffsetNs: null, trimNs: "0", revision: 0, updatedBy: "system", updatedAt: new Date(0),
    };
  }

  /**
   * Fallback saat belum ada acuan RaceTime2: jam lokal laptop (zona waktu
   * host). Offset hanya bermakna modulo 1 hari, jadi cukup selisih zona waktu.
   */
  function hostLocalOffsetNs(): string {
    return (BigInt(new Date().getTimezoneOffset()) * 60n * NS_PER_SEC).toString();
  }

  /** `autoOffset` bisa diisi snapshot sinyal agar satu kelompok konsisten. */
  async function effectiveClock(autoOffset?: string | null): Promise<ClockSnapshot> {
    const s = await clockSettings();
    let base: string | null;
    let source: ClockSnapshot["source"];
    if (s.mode === "manual" && s.manualOffsetNs !== null) {
      [base, source] = [s.manualOffsetNs, "manual"];
    } else {
      const auto = autoOffset ?? (await currentDeviceOffset());
      [base, source] = auto !== null ? [auto, "racetime"] : [hostLocalOffsetNs(), "host-local"];
    }
    return {
      mode: s.mode, source, revision: s.revision, baseOffsetNs: base, trimNs: s.trimNs,
      effectiveOffsetNs: (toNs(base) - toNs(s.trimNs)).toString(),
    };
  }

  async function impulseAutoOffset(group: GroupDoc): Promise<string | null> {
    const imp = await col.impulses.findOne({ _id: { $in: group.impulseIds }, deviceOffsetNs: { $ne: null } }, { sort: { deviceTimeNs: 1 } });
    return imp?.deviceOffsetNs ?? null;
  }

  /** Offset jam yang dipakai rekaman kelompok ini — snapshot saat ekstraksi, agar bukti tidak berubah diam-diam. */
  async function groupDeviceOffset(group: GroupDoc): Promise<string | null> {
    if (group.clock) return group.clock.effectiveOffsetNs;
    return (await effectiveClock(await impulseAutoOffset(group))).effectiveOffsetNs;
  }

  async function clockStatus() {
    const [settings, auto] = await Promise.all([clockSettings(), col.clock.findOne({ _id: "timing" })]);
    const eff = await effectiveClock();
    const serverNs = nowEpochNs();
    return {
      serverNs: serverNs.toString(),
      mode: settings.mode,
      source: eff.source,
      revision: settings.revision,
      manualOffsetNs: settings.manualOffsetNs,
      trimNs: settings.trimNs,
      effectiveOffsetNs: eff.effectiveOffsetNs,
      /** Waktu PF saat ini (basis RaceTime2), atau null bila belum ada acuan. */
      pfTime: eff.effectiveOffsetNs === null ? null : formatClock(serverNs - toNs(eff.effectiveOffsetNs), 3),
      auto: auto ? { deviceOffsetNs: auto.deviceOffsetNs, samples: auto.samples, ageMs: Date.now() - auto.receivedAt.getTime() } : null,
      /** Jam PF − jam RaceTime2 (dari heartbeat). Target admin: mendekati 0. */
      diffVsRaceTimeNs: auto && eff.effectiveOffsetNs !== null ? (toNs(auto.deviceOffsetNs) - toNs(eff.effectiveOffsetNs)).toString() : null,
      updatedBy: settings.updatedBy,
      updatedAt: settings.updatedAt,
    };
  }

  const AUTO_FRESH_MS = 30_000;

  async function updateClockSettings(p: Principal, body: z.infer<typeof ClockSettingsUpdate>) {
    const before = await clockSettings();
    const next = { mode: before.mode, manualOffsetNs: before.manualOffsetNs, trimNs: before.trimNs };

    switch (body.action) {
      case "use-auto": {
        next.mode = "auto";
        break;
      }
      case "freeze-from-racetime": {
        // Cara paling presisi: kunci offset hasil filter heartbeat RaceTime2.
        const auto = await col.clock.findOne({ _id: "timing" });
        if (!auto || Date.now() - auto.receivedAt.getTime() > AUTO_FRESH_MS) {
          throw new HttpError(409, "Heartbeat RaceTime2 belum diterima dalam 30 detik terakhir — sambungkan timing system dulu");
        }
        Object.assign(next, { mode: "manual", manualOffsetNs: auto.deviceOffsetNs });
        break;
      }
      case "set-time": {
        // Presisi terbatas reaksi admin & latensi jaringan — rapikan dengan trim.
        Object.assign(next, { mode: "manual", manualOffsetNs: (nowEpochNs() - parseClock(body.deviceTime)).toString() });
        break;
      }
      case "trim": {
        next.trimNs = (toNs(before.trimNs) + BigInt(Math.round(body.deltaMs * 1000)) * 1000n).toString();
        break;
      }
      case "reset-trim": {
        next.trimNs = "0";
        break;
      }
    }

    const doc: ClockSettingsDoc = { _id: "settings", ...next, revision: before.revision + 1, updatedBy: p.sub, updatedAt: new Date() };
    await col.clockSettings.replaceOne({ _id: "settings" }, doc, { upsert: true });
    await audit.append({
      userId: p.sub, action: `clock.${body.action}`, entity: "clock", entityId: "settings",
      before: { mode: before.mode, manualOffsetNs: before.manualOffsetNs, trimNs: before.trimNs, revision: before.revision },
      after: { ...next, revision: doc.revision }, reason: body.reason ?? null,
    });
    const status = await clockStatus();
    bus.toStaff("clock:updated", status);
    return status;
  }

  // ---------------------------------------------------------------- pengaturan kamera

  async function getCameraConfig(cameraId: string) {
    return col.cameraConfigs.findOne({ _id: cameraId });
  }

  async function listCameraConfigs() {
    return col.cameraConfigs.find().toArray();
  }

  async function saveCameraConfig(p: Principal, cameraId: string, config: CameraConfig, note: string) {
    const before = await col.cameraConfigs.findOne({ _id: cameraId });
    const doc = { _id: cameraId, config, revision: (before?.revision ?? 0) + 1, updatedBy: p.sub, updatedAt: new Date() };
    await col.cameraConfigs.replaceOne({ _id: cameraId }, doc, { upsert: true });
    await audit.append({ userId: p.sub, action: "camera.config", entity: "camera", entityId: cameraId, before: before?.config ?? null, after: config, reason: note });
    return doc;
  }

  async function deleteCameraConfig(p: Principal, cameraId: string) {
    const before = await col.cameraConfigs.findOne({ _id: cameraId });
    await col.cameraConfigs.deleteOne({ _id: cameraId });
    await audit.append({ userId: p.sub, action: "camera.config.reset", entity: "camera", entityId: cameraId, before: before?.config ?? null, after: null, reason: "kembali ke pengaturan .env agent" });
  }

  // ---------------------------------------------------------------- sinyal

  async function ingestImpulse(msg: TimingImpulse): Promise<ImpulseDoc> {
    if (!verifyPayload(msg, cfg.PF_HMAC_SECRET)) throw new HttpError(401, "Tanda tangan HMAC tidak valid");

    const existing = await col.impulses.findOne({ bootId: msg.bootId, seq: msg.seq });
    if (existing) return existing; // dikirim ulang setelah reconnect — idempoten

    const clock = await col.clock.findOne({ _id: "timing" });
    const armed = await col.sessions.findOne({ armed: true, status: "open" });

    // Frame RaceTime2 tanpa payload waktu → waktu = jam PF saat kejadian.
    let deviceTimeNs: bigint;
    let pfClockRevision: number | null = null;
    if (msg.deviceTime) {
      deviceTimeNs = parseClock(msg.deviceTime);
    } else {
      const pf = await effectiveClock();
      deviceTimeNs = wrapDay(toNs(msg.hostNs) - toNs(pf.effectiveOffsetNs!));
      pfClockRevision = pf.revision;
    }

    const doc: ImpulseDoc = {
      _id: new ObjectId(),
      sessionId: armed?._id ?? null,
      groupId: null,
      bootId: msg.bootId,
      seq: msg.seq,
      channel: msg.channel,
      deviceTime: msg.deviceTime ?? formatClock(deviceTimeNs, 3),
      deviceTimeNs: deviceTimeNs.toString(),
      source: "racetime",
      timeBasis: msg.deviceTime ? "device" : "pf-clock",
      pfClockRevision,
      serialLatencyNs: msg.serialLatencyNs ?? null,
      hostNs: msg.hostNs,
      // Relasi RaceTime2↔host hanya terukur bila sinyal membawa waktu perangkat.
      deviceOffsetNs: msg.deviceTime && clock?.bootId === msg.bootId ? clock.deviceOffsetNs : null,
      receivedAt: new Date(),
    };
    try {
      await col.impulses.insertOne(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return (await col.impulses.findOne({ bootId: msg.bootId, seq: msg.seq }))!;
      throw err;
    }

    if (!armed) {
      // Tidak pernah dibuang: operator bisa memindahkannya ke sesi nanti.
      bus.toStaff("impulse:unassigned", serializeImpulse(doc));
      return doc;
    }
    if (doc.channel === "FINISH") await addToGroup(armed, doc);
    return doc;
  }

  /**
   * Pemicu photocell virtual dari agent. Hanya diterima bila ada sesi AKTIF
   * dengan kamera yang sama (tidak membanjiri data saat orang lalu-lalang di
   * luar heat). Masuk ke kelompok finish seperti sinyal biasa sehingga memicu
   * rekaman, tetapi TIDAK dipakai sebagai waktu resmi (lihat repairGroup).
   */
  async function ingestCameraTrigger(p: Principal, data: z.infer<typeof AgentTrigger>) {
    const armed = await col.sessions.findOne({ armed: true, status: "open", cameraId: data.cameraId });
    if (!armed) return { accepted: false };
    const bootId = `camera:${data.cameraId}:${data.bootId}`;
    if (await col.impulses.findOne({ bootId, seq: data.seq })) return { accepted: true };

    const hostNs = toNs(data.agentNs) + toNs(data.agentOffsetNs);
    const pf = await effectiveClock();
    const deviceTimeNs = wrapDay(hostNs - toNs(pf.effectiveOffsetNs!));
    const doc: ImpulseDoc = {
      _id: new ObjectId(), sessionId: armed._id, groupId: null, bootId, seq: data.seq, channel: "FINISH",
      deviceTime: formatClock(deviceTimeNs, 3), deviceTimeNs: deviceTimeNs.toString(), source: "camera",
      timeBasis: "pf-clock", pfClockRevision: pf.revision, serialLatencyNs: null, hostNs: hostNs.toString(),
      deviceOffsetNs: null, receivedAt: new Date(),
    };
    try {
      await col.impulses.insertOne(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { accepted: true };
      throw err;
    }
    await addToGroup(armed, doc);

    // Tampilkan langsung di panel waktu sts-timingsystem: baris "Photo Finish"
    // di tabel Registration Id/Racetime + isi Buffer-Timer-Finish.
    bus.notifyTiming("photofinish:trigger", signPayload({
      type: "photofinish:trigger" as const,
      impulseId: doc._id.toHexString(), sessionId: armed._id.toHexString(), eventId: armed.eventId, eventName: armed.eventName ?? null,
      raceCategory: armed.raceCategory, heatId: armed.heatId, cameraId: data.cameraId, time: doc.deviceTime,
    }, cfg.PF_HMAC_SECRET));
    return { accepted: true, impulseId: doc._id.toHexString() };
  }

  async function assignImpulse(p: Principal, impulseId: string, sessionId: string) {
    const imp = await col.impulses.findOne({ _id: oid(impulseId, "impulseId") });
    if (!imp) throw new HttpError(404, "Sinyal tidak ditemukan");
    if (imp.sessionId) throw new HttpError(409, "Sinyal sudah masuk sesi lain");
    const session = await getOpenSession(sessionId);
    await col.impulses.updateOne({ _id: imp._id }, { $set: { sessionId: session._id } });
    await audit.append({ userId: p.sub, action: "impulse.assign", entity: "impulse", entityId: impulseId, before: { sessionId: null }, after: { sessionId }, reason: null });
    if (imp.channel === "FINISH") await addToGroup(session, { ...imp, sessionId: session._id });
  }

  async function addToGroup(session: SessionDoc, imp: ImpulseDoc) {
    const deviceNs = toNs(imp.deviceTimeNs);
    const open = await col.groups.findOne({ sessionId: session._id, status: "collecting" }, { sort: { createdAt: -1 } });
    let group: GroupDoc;
    if (open && diffDayNs(deviceNs, toNs(open.lastDeviceNs)) <= gapNs && diffDayNs(deviceNs, toNs(open.firstDeviceNs)) >= -gapNs) {
      const last = diffDayNs(deviceNs, toNs(open.lastDeviceNs)) > 0n ? imp.deviceTimeNs : open.lastDeviceNs;
      const first = diffDayNs(deviceNs, toNs(open.firstDeviceNs)) < 0n ? imp.deviceTimeNs : open.firstDeviceNs;
      await col.groups.updateOne({ _id: open._id }, { $push: { impulseIds: imp._id }, $set: { lastDeviceNs: last, firstDeviceNs: first } });
      group = { ...open, impulseIds: [...open.impulseIds, imp._id], lastDeviceNs: last, firstDeviceNs: first };
    } else {
      group = {
        _id: new ObjectId(), sessionId: session._id, impulseIds: [imp._id], firstDeviceNs: imp.deviceTimeNs,
        lastDeviceNs: imp.deviceTimeNs, status: "collecting", warnings: [], createdAt: new Date(), extractRequestedAt: null, clock: null,
      };
      await col.groups.insertOne(group);
    }
    await col.impulses.updateOne({ _id: imp._id }, { $set: { groupId: group._id } });
    bus.toSession(session._id.toHexString(), "impulse:new", serializeImpulse({ ...imp, groupId: group._id }));
    changed(session._id);
    scheduleExtraction(group._id);
  }

  function scheduleExtraction(groupId: ObjectId) {
    const key = groupId.toHexString();
    clearTimeout(quietTimers.get(key));
    quietTimers.set(key, setTimeout(() => {
      quietTimers.delete(key);
      requestExtraction(groupId).catch((err) => console.error("[extract]", err));
    }, cfg.PF_GROUP_QUIET_MS));
  }

  async function requestExtraction(groupId: ObjectId) {
    const group = await col.groups.findOne({ _id: groupId });
    if (!group) return;
    const session = await col.sessions.findOne({ _id: group.sessionId });
    const first = await col.impulses.findOne({ _id: { $in: group.impulseIds } }, { sort: { deviceTimeNs: 1 } });
    if (!session || !first) return;

    // Snapshot jam PF untuk rekaman ini: dicetak di gambar & dipakai menghitung
    // waktu kamera. Kalibrasi ulang nanti tidak mengubah bukti yang sudah ada.
    const autoOffset = await impulseAutoOffset(group);
    const clock = group.clock ?? (await effectiveClock(autoOffset));

    // Posisi sinyal di jam host: pakai relasi RaceTime2↔host yang terukur
    // (auto) bila ada; tanpa itu pakai jam PF; tanpa keduanya pakai waktu
    // terima host (telat ±250 ms di 1200 baud) — jendela ekstraksi cukup lebar.
    const offset = autoOffset ?? clock.effectiveOffsetNs;
    const ref = toNs(first.hostNs);
    const toHost = (deviceNs: string) =>
      offset === null ? null : deviceToAgentNs(toNs(deviceNs), { deviceOffsetNs: toNs(offset), agentOffsetNs: 0n }, ref);
    const firstHost = toHost(group.firstDeviceNs) ?? ref;
    const lastHost = toHost(group.lastDeviceNs) ?? ref + diffDayNs(toNs(group.lastDeviceNs), toNs(group.firstDeviceNs));

    const req = {
      groupId: groupId.toHexString(),
      sessionId: session._id.toHexString(),
      cameraId: session.cameraId,
      fromHostNs: (firstHost - BigInt(cfg.PF_CAPTURE_PRE_MS) * NS_PER_MS).toString(),
      toHostNs: (lastHost + BigInt(cfg.PF_CAPTURE_POST_MS) * NS_PER_MS).toString(),
      // Agent mengubah timestamp tiap kolom ke jam PF dan mencetaknya di gambar.
      clock: {
        deviceOffsetNs: clock.effectiveOffsetNs,
        calibrationOffsetNs: session.calibrationOffsetNs,
        revision: clock.revision,
        mode: clock.mode,
      },
    };
    const sent = bus.toAgents("agent:extract", req);
    const warnings = sent ? [] : ["Capture Agent tidak terhubung — rekaman belum diambil."];
    await col.groups.updateOne({ _id: groupId }, { $set: { status: "extracting", extractRequestedAt: new Date(), warnings, clock } });
    bus.toSession(req.sessionId, "group:updated", { groupId: req.groupId, status: "extracting", warnings });
    bus.toStaff("sessions:changed", { sessionId: req.sessionId });
  }

  /** Dipanggil saat startup & saat agent terhubung: kelompok yang tertunda diekstrak. */
  async function resumePending() {
    const pending = await col.groups.find({ status: { $in: ["collecting", "extracting"] } }).toArray();
    for (const g of pending) {
      if (g.status === "collecting") scheduleExtraction(g._id);
      else if (!(await col.captures.findOne({ groupId: g._id }))) await requestExtraction(g._id);
    }
  }

  // ---------------------------------------------------------------- sesi

  async function getOpenSession(id: string): Promise<SessionDoc> {
    const s = await col.sessions.findOne({ _id: oid(id, "sessionId") });
    if (!s) throw new HttpError(404, "Sesi tidak ditemukan");
    if (s.status !== "open") throw new HttpError(409, "Sesi sudah ditutup");
    return s;
  }

  /** Daftar sesi (bar perpindahan heat) di semua layar staf ikut diperbarui. */
  const changed = (sessionId: ObjectId) => bus.toStaff("sessions:changed", { sessionId: sessionId.toHexString() });

  async function createSession(p: Principal, body: z.infer<typeof SessionCreate>) {
    const eventName = body.eventName || (await eventNameOf(body.eventId));
    // Label otomatis: "<Nama Event> · Sesi N" — operator cukup memilih Event.
    const label = body.label?.trim() || `${eventName ?? `Event ${body.eventId}`} · Sesi ${(await col.sessions.countDocuments({ eventId: body.eventId })) + 1}`;
    const doc: SessionDoc = {
      _id: new ObjectId(), ...body, label, eventName, armed: false, status: "open", calibrationOffsetNs: "0", calibratedAt: null,
      createdBy: p.sub, createdAt: new Date(),
    };
    await col.sessions.insertOne(doc);
    changed(doc._id);
    await audit.append({ userId: p.sub, action: "session.create", entity: "session", entityId: doc._id.toHexString(), before: null, after: doc, reason: null });
    return doc;
  }

  async function armSession(p: Principal, id: string, armed: boolean) {
    const s = await getOpenSession(id);
    // Hanya satu sesi yang menerima sinyal pada satu waktu (satu garis finish).
    if (armed) await col.sessions.updateMany({ armed: true }, { $set: { armed: false } });
    await col.sessions.updateOne({ _id: s._id }, { $set: { armed } });
    await audit.append({ userId: p.sub, action: armed ? "session.arm" : "session.disarm", entity: "session", entityId: id, before: { armed: s.armed }, after: { armed }, reason: null });
    bus.toStaff("session:armed", { sessionId: armed ? id : null });
    changed(s._id);
  }

  /** Keterangan bebas dari admin/operator (mis. "R4 Putri", "heat ulang") — pembeda sesi. */
  async function setSessionNote(p: Principal, id: string, note: string | null) {
    const s = await col.sessions.findOne({ _id: oid(id, "sessionId") });
    if (!s) throw new HttpError(404, "Sesi tidak ditemukan");
    const value = note?.trim() || null;
    await col.sessions.updateOne({ _id: s._id }, { $set: { note: value } });
    await audit.append({ userId: p.sub, action: "session.note", entity: "session", entityId: id, before: { note: s.note ?? null }, after: { note: value }, reason: null });
    changed(s._id);
    return { note: value };
  }

  async function closeSession(p: Principal, id: string) {
    const s = await getOpenSession(id);
    await col.sessions.updateOne({ _id: s._id }, { $set: { status: "closed", armed: false } });
    changed(s._id);
    await audit.append({ userId: p.sub, action: "session.close", entity: "session", entityId: id, before: { status: s.status }, after: { status: "closed" }, reason: null });
  }

  /**
   * Ringkasan satu kejadian finish (kelompok). Operator standby di kamera dan
   * hanya perlu masuk ke detail bila finish BERDEKATAN (≥ 2 perahu dalam satu
   * kelompok) — berlaku sama untuk H2H, RX, DRR, Sprint, Slalom. Finish satu
   * perahu cukup tercatat: waktunya langsung dari RaceTime2.
   * Jumlah perahu = maks(sinyal RaceTime2, pemicu kamera) agar satu perahu yang
   * memicu keduanya tidak dihitung dua.
   */
  async function finishStates(groups: GroupDoc[]) {
    const ids = groups.map((g) => g._id);
    const [imps, crs] = await Promise.all([
      col.impulses.find({ groupId: { $in: ids } }, { projection: { groupId: 1, source: 1, deviceTimeNs: 1 } }).toArray(),
      col.crossings.find({ groupId: { $in: ids } }, { projection: { groupId: 1, status: 1 } }).toArray(),
    ]);
    return new Map(groups.map((g) => {
      const key = g._id.toHexString();
      const mine = imps.filter((i) => String(i.groupId) === key);
      const rt = mine.filter((i) => i.source !== "camera"), cam = mine.filter((i) => i.source === "camera");
      const basis = rt.length >= cam.length ? rt : cam;
      const times = basis.map((i) => BigInt(i.deviceTimeNs));
      const gapMs = times.length > 1 ? Number((times.reduce((m, t) => (t > m ? t : m)) - times.reduce((m, t) => (t < m ? t : m))) / NS_PER_MS) : null;
      const boats = basis.length;
      const cs = crs.filter((c) => String(c.groupId) === key);
      const marked = cs.length, confirmed = cs.filter((c) => c.status === "confirmed").length;
      const close = boats >= 2;
      const needsReview = g.status === "ready" && ((close && (marked < boats || confirmed < marked)) || confirmed < marked);
      return [key, { boats, gapMs, close, marked, confirmed, needsReview, resolved: close && !needsReview && g.status === "ready" }];
    }));
  }

  /**
   * Daftar sesi + progres, untuk perpindahan heat cepat: operator melihat heat
   * mana yang masih punya finish berdekatan belum ditinjau tanpa membuka satu per satu.
   */
  async function sessionList() {
    const sessions = await withEventName(await col.sessions.find().sort({ createdAt: -1 }).limit(100).toArray());
    const groups = await col.groups.find({ sessionId: { $in: sessions.filter((s) => s.status === "open").map((s) => s._id) } }).toArray();
    const states = await finishStates(groups);
    return sessions.map((s) => {
      const mine = groups.filter((g) => g.sessionId.equals(s._id));
      const st = mine.map((g) => states.get(g._id.toHexString())!);
      return {
        ...s,
        progress: {
          finishes: mine.length,
          recording: mine.filter((g) => g.status !== "ready").length,
          close: st.filter((x) => x.close).length,
          pending: st.filter((x) => x.needsReview).length,
          confirmed: st.reduce((n, x) => n + x.confirmed, 0),
        },
      };
    });
  }

  /** Feed "Finish terakhir" di Standby Kamera: kejadian terbaru dari sesi terbuka. */
  async function finishFeed(limit = 20) {
    const open = await col.sessions.find({ status: "open" }, { projection: { label: 1, raceCategory: 1, armed: 1 } }).toArray();
    const groups = await col.groups.find({ sessionId: { $in: open.map((s) => s._id) } }).sort({ createdAt: -1 }).limit(limit).toArray();
    const states = await finishStates(groups);
    return groups.map((g) => {
      const s = open.find((x) => x._id.equals(g.sessionId))!;
      return {
        groupId: g._id.toHexString(), sessionId: s._id.toHexString(), sessionLabel: s.label, raceCategory: s.raceCategory, armed: s.armed,
        status: g.status, createdAt: g.createdAt, ...states.get(g._id.toHexString())!,
      };
    });
  }

  async function sessionDetail(id: string) {
    const _id = oid(id, "sessionId");
    const found = await col.sessions.findOne({ _id });
    if (!found) throw new HttpError(404, "Sesi tidak ditemukan");
    const [session] = await withEventName([found]);
    const [groups, impulses, captures, crossings] = await Promise.all([
      col.groups.find({ sessionId: _id }).sort({ createdAt: 1 }).toArray(),
      col.impulses.find({ sessionId: _id }).sort({ deviceTimeNs: 1 }).toArray(),
      col.captures.find({ sessionId: _id }).toArray(),
      col.crossings.find({ sessionId: _id }).sort({ rank: 1 }).toArray(),
    ]);
    return {
      session,
      groups,
      impulses: impulses.map(serializeImpulse),
      captures: captures.map(serializeCapture),
      crossings,
    };
  }

  // ---------------------------------------------------------------- capture

  function serializeCapture(c: CaptureDoc) {
    return { ...c, url: signFileUrl(cfg.PF_FILE_URL_SECRET, c.file), columnsUrl: signFileUrl(cfg.PF_FILE_URL_SECRET, c.columnsFile) };
  }

  async function addCapture(p: Principal, body: z.infer<typeof CaptureCreate>) {
    const group = await col.groups.findOne({ _id: oid(body.groupId, "groupId") });
    if (!group) throw new HttpError(404, "Kelompok finish tidak ditemukan");

    // Hash dihitung ulang di server: file yang dilaporkan agent harus sama
    // persis dengan yang ada di disk — dasar integritas barang bukti.
    for (const [rel, expected] of [[body.file, body.sha256], [body.columnsFile, body.columnsSha256]] as const) {
      let actual: string;
      try {
        actual = await fileSha256(resolveCapturePath(cfg.PF_CAPTURES_DIR, rel));
      } catch {
        throw new HttpError(400, `File capture tidak ditemukan: ${rel}`);
      }
      if (actual !== expected) throw new HttpError(400, `SHA-256 tidak cocok untuk ${rel}`);
    }

    if (body.framesFile) {
      // Indeks frame + setiap frame diverifikasi — frame utuh juga barang bukti.
      let index;
      try {
        const full = resolveCapturePath(cfg.PF_CAPTURES_DIR, body.framesFile);
        if ((await fileSha256(full)) !== body.framesSha256) throw new HttpError(400, `SHA-256 tidak cocok untuk ${body.framesFile}`);
        index = await readFramesIndex(full);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `Indeks frame tidak bisa dibaca: ${body.framesFile}`);
      }
      for (const f of index.frames) {
        const actual = await fileSha256(resolveCapturePath(cfg.PF_CAPTURES_DIR, f.file)).catch(() => null);
        if (actual !== f.sha256) throw new HttpError(400, `Frame rusak atau hilang: ${f.file}`);
      }
    }

    const { groupId: _g, ...rest } = body;
    const doc: CaptureDoc = { _id: new ObjectId(), sessionId: group.sessionId, groupId: group._id, ...rest, clock: group.clock, createdAt: new Date() };
    await col.captures.insertOne(doc);
    await col.groups.updateOne({ _id: group._id }, { $set: { status: "ready", warnings: [] } });
    await audit.append({ userId: p.sub, action: "capture.create", entity: "capture", entityId: doc._id.toHexString(), before: null, after: { file: doc.file, sha256: doc.sha256, columnsSha256: doc.columnsSha256, clock: doc.clock }, reason: null });
    bus.toSession(group.sessionId.toHexString(), "capture:ready", serializeCapture(doc));
    changed(group.sessionId);
    return doc;
  }

  /**
   * Frame utuh untuk tinjauan frame-demi-frame. Setiap frame dipetakan ke
   * kolom slit-scan terdekat sehingga web bisa menampilkan foto pada detik
   * yang sama dengan kolom yang sedang ditunjuk.
   */
  async function captureFrames(id: string) {
    const capture = await col.captures.findOne({ _id: oid(id, "captureId") });
    if (!capture) throw new HttpError(404, "Capture tidak ditemukan");
    if (!capture.framesFile) return { frames: [], finishLine: null };
    const [index, columns] = await Promise.all([
      readFramesIndex(resolveCapturePath(cfg.PF_CAPTURES_DIR, capture.framesFile)),
      readColumns(resolveCapturePath(cfg.PF_CAPTURES_DIR, capture.columnsFile)),
    ]);
    const colNs = columns.map((c) => toNs(c));
    let j = 0;
    const frames = index.frames.map((f) => {
      const t = toNs(f.agentNs);
      while (j + 1 < colNs.length && colNs[j + 1]! <= t) j++;
      const nearest = j + 1 < colNs.length && colNs[j + 1]! - t < t - colNs[j]! ? j + 1 : j;
      return { url: signFileUrl(cfg.PF_FILE_URL_SECRET, f.file), column: nearest };
    });
    return { frames, finishLine: index.finishLine };
  }

  async function frameAtColumn(captureId: string, column: number) {
    const capture = await col.captures.findOne({ _id: oid(captureId, "captureId") });
    if (!capture) throw new HttpError(404, "Capture tidak ditemukan");
    const columns = await readColumns(resolveCapturePath(cfg.PF_CAPTURES_DIR, capture.columnsFile));
    const frame = columns[column];
    if (frame === undefined) throw new HttpError(400, `Kolom ${column} di luar gambar (lebar ${columns.length})`);
    return { capture, frameAgentNs: frame };
  }

  // ---------------------------------------------------------------- kalibrasi

  async function calibrate(p: Principal, sessionId: string, body: z.infer<typeof CalibrateBody>) {
    const session = await getOpenSession(sessionId);
    const { capture, frameAgentNs } = await frameAtColumn(body.captureId, body.column);
    const imp = await col.impulses.findOne({ _id: oid(body.impulseId, "impulseId") });
    if (!imp) throw new HttpError(404, "Sinyal tidak ditemukan");
    const group = await col.groups.findOne({ _id: capture.groupId });
    const offset = group && (await groupDeviceOffset(group));
    if (!offset) throw new HttpError(409, "Jam perangkat belum tersinkron (timing:clock belum diterima)");

    const raw = frameToDeviceNs(toNs(frameAgentNs), { agentOffsetNs: toNs(capture.agentOffsetNs), deviceOffsetNs: toNs(offset), calibrationOffsetNs: 0n });
    const calibrationOffsetNs = diffDayNs(toNs(imp.deviceTimeNs), raw).toString();
    await col.sessions.updateOne({ _id: session._id }, { $set: { calibrationOffsetNs, calibratedAt: new Date() } });
    await audit.append({ userId: p.sub, action: "session.calibrate", entity: "session", entityId: sessionId, before: { calibrationOffsetNs: session.calibrationOffsetNs }, after: { calibrationOffsetNs, captureId: body.captureId, column: body.column, impulseId: body.impulseId }, reason: null });

    for (const g of await col.groups.find({ sessionId: session._id }).toArray()) await repairGroup(g._id);
    return { calibrationOffsetNs, calibrationOffsetMs: Number(toNs(calibrationOffsetNs) / NS_PER_MS) };
  }

  // ---------------------------------------------------------------- crossing

  async function markCrossing(p: Principal, body: z.infer<typeof CrossingMark>) {
    const { capture, frameAgentNs } = await frameAtColumn(body.captureId, body.column);
    const session = await getOpenSession(capture.sessionId.toHexString());
    const lane = body.lane ? session.lanes.find((l) => l.lane === body.lane) : undefined;
    const doc: CrossingDoc = {
      _id: new ObjectId(), sessionId: capture.sessionId, groupId: capture.groupId, captureId: capture._id, column: body.column,
      rank: body.rank, lane: body.lane, teamId: body.teamId ?? lane?.teamId ?? null, bib: lane?.bib ?? null, frameAgentNs,
      cameraTimeNs: null, impulseId: null, timeSource: null, timeNs: null, finishTime: null, officialTime: null, warnings: [],
      crewInBoat: null, crewExpected: lane?.crewExpected ?? null, upright: null, secondCrossing: false, status: "suggested",
      revision: 0, markedBy: p.sub, confirmedBy: null, confirmedAt: null, deliveredRevision: 0,
    };
    await col.crossings.insertOne(doc);
    await audit.append({ userId: p.sub, action: "crossing.mark", entity: "crossing", entityId: doc._id.toHexString(), before: null, after: { column: doc.column, rank: doc.rank, lane: doc.lane, teamId: doc.teamId }, reason: null });
    await repairGroup(capture.groupId);
    return col.crossings.findOne({ _id: doc._id });
  }

  /**
   * Hapus satu tangkapan (kelompok finish) — mis. pemicu palsu dari orang
   * lewat, atau rekaman uji. Ditolak bila ada hasil yang sudah dikonfirmasi
   * juri (barang bukti). Sinyal RaceTime2 TIDAK hilang: dikembalikan ke
   * daftar "tanpa sesi" agar bisa dipulihkan; pemicu kamera ikut dihapus.
   */
  async function deleteGroup(p: Principal, id: string) {
    const group = await col.groups.findOne({ _id: oid(id, "groupId") });
    if (!group) throw new HttpError(404, "Kelompok finish tidak ditemukan");
    await getOpenSession(group.sessionId.toHexString());

    const crossings = await col.crossings.find({ groupId: group._id }).toArray();
    if (crossings.some((c) => c.revision > 0)) {
      throw new HttpError(409, "Ada hasil yang sudah dikonfirmasi juri di tangkapan ini — tidak bisa dihapus (barang bukti)");
    }
    const [captures, impulses] = await Promise.all([
      col.captures.find({ groupId: group._id }).toArray(),
      col.impulses.find({ _id: { $in: group.impulseIds } }).toArray(),
    ]);

    // Hentikan ekstraksi tertunda untuk kelompok ini.
    const key = group._id.toHexString();
    clearTimeout(quietTimers.get(key));
    quietTimers.delete(key);

    await audit.append({
      userId: p.sub, action: "group.delete", entity: "group", entityId: id,
      before: {
        sessionId: group.sessionId, impulses: impulses.map((i) => ({ id: i._id, source: i.source ?? "racetime", deviceTime: i.deviceTime })),
        captures: captures.map((c) => ({ file: c.file, sha256: c.sha256, columnsSha256: c.columnsSha256, framesSha256: c.framesSha256 ?? null })),
        crossings: crossings.map((c) => ({ rank: c.rank, lane: c.lane, column: c.column })),
      },
      after: null, reason: null,
    });

    const cameraIds = impulses.filter((i) => i.source === "camera").map((i) => i._id);
    const racetimeIds = impulses.filter((i) => i.source !== "camera").map((i) => i._id);
    await Promise.all([
      col.crossings.deleteMany({ groupId: group._id }),
      col.captures.deleteMany({ groupId: group._id }),
      col.impulses.deleteMany({ _id: { $in: cameraIds } }),
      col.impulses.updateMany({ _id: { $in: racetimeIds } }, { $set: { sessionId: null, groupId: null } }),
      col.groups.deleteOne({ _id: group._id }),
    ]);
    for (const c of captures) {
      for (const rel of [c.file, c.columnsFile, c.framesFile].filter((x): x is string => !!x)) {
        await unlink(resolveCapturePath(cfg.PF_CAPTURES_DIR, rel)).catch(() => undefined);
      }
      if (c.framesFile) {
        // folder <cam>-frames/ di samping indeks
        const dir = resolveCapturePath(cfg.PF_CAPTURES_DIR, c.framesFile.replace(/\.json$/, ""));
        await rm(dir, { recursive: true, force: true });
      }
    }
    bus.toSession(group.sessionId.toHexString(), "group:deleted", { groupId: id });
    changed(group.sessionId);
    return { deleted: true, racetimeImpulsesReturned: racetimeIds.length, cameraTriggersDeleted: cameraIds.length };
  }

  async function deleteCrossing(p: Principal, id: string) {
    const c = await col.crossings.findOne({ _id: oid(id, "crossingId") });
    if (!c) throw new HttpError(404, "Crossing tidak ditemukan");
    if (c.status === "confirmed") throw new HttpError(409, "Crossing yang sudah dikonfirmasi tidak bisa dihapus — koreksi dengan alasan");
    await col.crossings.deleteOne({ _id: c._id });
    await audit.append({ userId: p.sub, action: "crossing.delete", entity: "crossing", entityId: id, before: c, after: null, reason: null });
    await repairGroup(c.groupId);
  }

  /** Hitung ulang waktu kamera & pasangan urutan↔sinyal untuk satu kelompok finish. */
  async function repairGroup(groupId: ObjectId) {
    const group = await col.groups.findOne({ _id: groupId });
    if (!group) return;
    const [session, crossings, impulses, captures] = await Promise.all([
      col.sessions.findOne({ _id: group.sessionId }),
      col.crossings.find({ groupId }).toArray(),
      col.impulses.find({ _id: { $in: group.impulseIds } }).toArray(),
      col.captures.find({ groupId }).toArray(),
    ]);
    if (!session) return;
    const offset = await groupDeviceOffset(group);
    const captureById = new Map(captures.map((c) => [c._id.toHexString(), c]));

    const cameraTime = (c: CrossingDoc): bigint | null => {
      const cap = captureById.get(c.captureId.toHexString());
      if (!cap || offset === null) return null;
      return frameToDeviceNs(toNs(c.frameAgentNs), {
        agentOffsetNs: toNs(cap.agentOffsetNs), deviceOffsetNs: toNs(offset), calibrationOffsetNs: toNs(session.calibrationOffsetNs),
      });
    };

    const { results, groupWarnings } = pairByOrder(
      crossings.map((c) => ({ id: c._id.toHexString(), rank: c.rank, cameraTimeNs: cameraTime(c) })),
      // Pemicu kamera hanya memicu rekaman — waktu resmi dari RaceTime2 atau kolom gambar.
      impulses.filter((i) => i.source !== "camera").map((i) => ({ id: i._id.toHexString(), deviceTimeNs: toNs(i.deviceTimeNs) })),
    );

    const official: Array<{ crossingId: string; officialTime: string | null }> = [];
    for (const r of results) {
      const c = crossings.find((x) => x._id.toHexString() === r.crossingId)!;
      const cam = cameraTime(c);
      const computed = {
        cameraTimeNs: cam?.toString() ?? null,
        impulseId: r.impulseId ? new ObjectId(r.impulseId) : null,
        timeSource: r.timeSource,
        timeNs: r.timeNs?.toString() ?? null,
        finishTime: r.timeNs === null ? null : formatClock(r.timeNs, 3),
        officialTime: r.timeNs === null ? null : officialClock(r.timeNs, cfg.PF_OFFICIAL_ROUNDING),
      };
      if (c.status === "confirmed") {
        // Hasil terkonfirmasi tidak pernah diubah diam-diam; beri tanda saja.
        const moved = c.timeSource !== "manual" && (c.timeNs !== computed.timeNs || String(c.impulseId) !== String(computed.impulseId));
        const warnings = moved ? [...r.warnings, "Urutan/kalibrasi berubah setelah konfirmasi — periksa & konfirmasi ulang."] : r.warnings;
        await col.crossings.updateOne({ _id: c._id }, { $set: { cameraTimeNs: computed.cameraTimeNs, warnings, status: moved ? "disputed" : "confirmed" } });
        official.push({ crossingId: r.crossingId, officialTime: c.officialTime });
      } else {
        await col.crossings.updateOne({ _id: c._id }, { $set: { ...computed, warnings: r.warnings } });
        official.push({ crossingId: r.crossingId, officialTime: computed.officialTime });
      }
    }

    const ties = findTies(official);
    const warnings = [
      ...groupWarnings,
      ...ties.map((ids) => `Waktu sama dalam 1/100 (${ids.length} tim) — ${ids.length >= 3 ? "additional run" : "lempar koin"} sesuai aturan FAJI.`),
    ];
    await col.groups.updateOne({ _id: groupId }, { $set: { warnings } });
    bus.toSession(group.sessionId.toHexString(), "group:updated", {
      groupId: groupId.toHexString(), status: group.status, warnings,
      crossings: await col.crossings.find({ groupId }).sort({ rank: 1 }).toArray(),
    });
    changed(group.sessionId);
  }

  async function confirmCrossing(p: Principal, id: string, body: z.infer<typeof CrossingConfirm>) {
    const c = await col.crossings.findOne({ _id: oid(id, "crossingId") });
    if (!c) throw new HttpError(404, "Crossing tidak ditemukan");
    const session = await getOpenSession(c.sessionId.toHexString());
    const isCorrection = c.revision > 0;
    if (isCorrection && !body.reason?.trim()) throw new HttpError(400, "Koreksi hasil wajib menyertakan alasan");

    let { timeNs, timeSource, finishTime, officialTime } = c;
    if (body.manualTime) {
      if (c.timeSource === "impulse") throw new HttpError(400, "Waktu sinyal tersedia — waktu manual tidak diizinkan");
      const ns = parseClock(body.manualTime);
      timeNs = ns.toString();
      timeSource = "manual";
      finishTime = formatClock(ns, 3);
      officialTime = officialClock(ns, cfg.PF_OFFICIAL_ROUNDING);
    }
    if (timeNs === null) throw new HttpError(409, "Belum ada waktu: tunggu sinyal, sinkronkan jam, atau isi waktu manual");

    const lane = session.lanes.find((l) => l.teamId === body.teamId);
    const update = {
      teamId: body.teamId, lane: body.lane ?? lane?.lane ?? c.lane, bib: lane?.bib ?? c.bib,
      crewInBoat: body.crewInBoat, crewExpected: body.crewExpected, upright: body.upright, secondCrossing: body.secondCrossing,
      timeNs, timeSource, finishTime, officialTime,
      status: "confirmed" as const, revision: c.revision + 1, confirmedBy: p.sub, confirmedAt: new Date(),
    };
    await col.crossings.updateOne({ _id: c._id }, { $set: update });
    await audit.append({
      userId: p.sub, action: isCorrection ? "crossing.correct" : "crossing.confirm", entity: "crossing", entityId: id,
      before: isCorrection ? c : null, after: update, reason: body.reason ?? null,
    });
    const saved = (await col.crossings.findOne({ _id: c._id }))!;
    bus.toSession(c.sessionId.toHexString(), "crossing:updated", saved);
    changed(c.sessionId);
    await deliver(saved, session);
    return saved;
  }

  // ---------------------------------------------------------------- kirim ke timing

  async function deliver(c: CrossingDoc, session?: SessionDoc) {
    const s = session ?? (await col.sessions.findOne({ _id: c.sessionId }));
    if (!s || c.status !== "confirmed" || !c.teamId || !c.finishTime || !c.officialTime || !c.timeSource) return false;
    const unsigned: Omit<PhotofinishVerified, "sig"> = {
      type: "photofinish:verified",
      crossingId: c._id.toHexString(), sessionId: s._id.toHexString(), eventId: s.eventId, eventName: s.eventName ?? null, raceCategory: s.raceCategory,
      heatId: s.heatId, teamId: c.teamId, bib: c.bib, rank: c.rank, finishTime: c.finishTime, officialTime: c.officialTime,
      timeSource: c.timeSource,
      penalties: {
        crewIncomplete: c.crewInBoat !== null && c.crewExpected !== null && c.crewInBoat < c.crewExpected,
        capsized: c.upright === false,
        secondCrossing: c.secondCrossing,
      },
      revision: c.revision, verifiedBy: c.confirmedBy ?? "", verifiedAt: (c.confirmedAt ?? new Date()).toISOString(),
    };
    const ok = await bus.toTiming("photofinish:verified", signPayload(unsigned, cfg.PF_HMAC_SECRET));
    if (ok) await col.crossings.updateOne({ _id: c._id, revision: c.revision }, { $max: { deliveredRevision: c.revision } });
    return ok;
  }

  /** Dipanggil saat timing system (re)connect: hasil yang belum ter-ack dikirim ulang. */
  async function redeliverPending() {
    const pending = await col.crossings.find({ status: "confirmed", $expr: { $lt: ["$deliveredRevision", "$revision"] } }).toArray();
    for (const c of pending) await deliver(c);
    return pending.length;
  }

  return {
    updateClock, clockStatus, updateClockSettings, ingestImpulse, ingestCameraTrigger,
    getCameraConfig, listCameraConfigs, saveCameraConfig, deleteCameraConfig, assignImpulse, resumePending, requestExtraction,
    listEvents, createSession, setSessionNote, armSession, closeSession, sessionList, finishFeed, sessionDetail,
    addCapture, captureFrames, calibrate, markCrossing, deleteCrossing, deleteGroup, confirmCrossing, redeliverPending,
    serverNowNs: nowEpochNs,
    /** Hentikan timer kelompok finish saat API dimatikan. */
    shutdown: () => {
      for (const t of quietTimers.values()) clearTimeout(t);
      quietTimers.clear();
    },
  };
}

export type Service = ReturnType<typeof createService>;

function serializeImpulse(i: ImpulseDoc) {
  return { ...i, _id: i._id.toHexString(), sessionId: i.sessionId?.toHexString() ?? null, groupId: i.groupId?.toHexString() ?? null };
}
