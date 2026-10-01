// Uji end-to-end satu heat H2H: timing → API → agent → juri → timing.
// Memakai MongoDB in-memory (unduh binary mongod sekali saat pertama jalan).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { io as connect, type Socket } from "socket.io-client";
import { buildApp } from "../src/app.js";
import { hashPassword, issueToken } from "../src/auth.js";
import { sha256Hex, signPayload, verifyPayload } from "../src/canonical.js";
import { loadConfig } from "../src/config.js";
import { connectDb, type Database } from "../src/db.js";
import { formatClock, NS_PER_DAY, NS_PER_MS, nowEpochNs, parseClock } from "../src/time.js";

const SECRET = "s".repeat(40);
let mongo: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let capturesDir: string;
const sockets: Socket[] = [];

const cfg = () => loadConfig({
  NODE_ENV: "test", PF_PORT: "1", PF_MONGO_URL: mongo.getUri(), PF_MONGO_DB: "pf_e2e",
  PF_JWT_SECRET: SECRET, PF_HMAC_SECRET: SECRET, PF_FILE_URL_SECRET: SECRET, PF_CAPTURES_DIR: capturesDir,
  PF_GROUP_QUIET_MS: "200", PF_LOGIN_RATE_MAX: "1000",
});

async function http<T = any>(method: string, url: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

function socket(token?: string): Promise<Socket> {
  const s = connect(base, { auth: token ? { token } : {}, transports: ["websocket"], reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });
}

const until = async (cond: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout menunggu kondisi");
    await new Promise((r) => setTimeout(r, 25));
  }
};

type ExtractReq = { groupId: string; sessionId: string; cameraId: string; fromHostNs: string; toHostNs: string; clock: { deviceOffsetNs: string | null; revision: number; mode: string } };

/** Capture Agent palsu: jam agent = jam host, kolom 240 fps, file PNG palsu. */
async function fakeAgent(agentToken: string) {
  const s = await socket(agentToken);
  const requests: ExtractReq[] = [];
  s.on("agent:extract", async (req: ExtractReq) => {
    requests.push(req);
    const from = BigInt(req.fromHostNs), to = BigInt(req.toHostNs);
    const columns: string[] = [];
    for (let t = from; t <= to; t += 4_166_667n) columns.push(t.toString());
    const dir = path.join(capturesDir, req.sessionId, req.groupId);
    await mkdir(dir, { recursive: true });
    const png = Buffer.from("fake-png");
    const json = JSON.stringify({ cameraId: req.cameraId, columns });
    await writeFile(path.join(dir, "cam-1-slit.png"), png);
    await writeFile(path.join(dir, "cam-1-columns.json"), json);
    const res = await http("POST", "/api/captures", agentToken, {
      groupId: req.groupId, cameraId: req.cameraId, file: `${req.sessionId}/${req.groupId}/cam-1-slit.png`,
      columnsFile: `${req.sessionId}/${req.groupId}/cam-1-columns.json`, sha256: sha256Hex(png), columnsSha256: sha256Hex(json),
      fps: 240, width: columns.length, height: 100, fromAgentNs: columns[0], toAgentNs: columns.at(-1), agentOffsetNs: "0", agentRttNs: "500000",
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });
  return { socket: s, requests };
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  capturesDir = await mkdtemp(path.join(tmpdir(), "pf-captures-"));
  const c = cfg();
  database = await connectDb(c);
  app = await buildApp(c, database);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  for (const [username, role] of [["op", "operator"], ["juri", "judge"], ["adm", "admin"], ["lihat", "viewer"]] as const) {
    await database.col.users.insertOne({
      _id: new ObjectId(), username, name: username, role, passwordHash: await hashPassword("rahasia-panjang"), disabled: false, createdAt: new Date(),
    });
  }
});

after(async () => {
  for (const s of sockets) s.close();
  await app?.close();
  await database?.client.close();
  await mongo?.stop();
  await rm(capturesDir, { recursive: true, force: true });
});

test("socket tanpa token ditolak; login salah ditolak", async () => {
  await assert.rejects(socket(), /Unauthorized/);
  assert.equal((await http("POST", "/api/auth/login", undefined, { username: "op", password: "salah" })).status, 401);
});

test("heat H2H: urutan dari kamera, waktu dari impuls, hasil terkirim ke timing", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, juri, adm] = [await login("op"), await login("juri"), await login("adm")];
  const timingToken = issueToken({ sub: "device:timing:1", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h");
  const agentToken = issueToken({ sub: "device:agent:1", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");

  // Peran dibatasi: operator tidak boleh konfirmasi; perangkat tidak boleh pakai route pengguna.
  assert.equal((await http("GET", "/api/sessions", agentToken)).status, 403);

  // --- Operator membuka sesi H2H & mengaktifkannya
  const { data: session } = await http("POST", "/api/sessions", op, {
    eventId: "EVT-1", raceCategory: "H2H", heatId: "H3", label: "H2H R6 Putra Heat 3",
    lanes: [
      { lane: "A", teamId: "team-a", bib: "11", teamName: "Tim A", crewExpected: 6 },
      { lane: "B", teamId: "team-b", bib: "12", teamName: "Tim B", crewExpected: 6 },
    ],
  });
  assert.equal((await http("POST", `/api/sessions/${session._id}/arm`, op)).status, 200);

  // --- Agent: jam agent = jam host (offset 0), membuat slit-scan palsu 240 fps
  const agent = await fakeAgent(agentToken);

  // --- Timing system: offset jam perangkat lalu dua impuls finish 300 ms
  const timing = await socket(timingToken);
  const verified: any[] = [];
  timing.on("photofinish:verified", (msg: any, ack: (r: unknown) => void) => {
    assert.ok(verifyPayload(msg, SECRET), "hasil dari API harus bertanda tangan HMAC valid");
    verified.push(msg);
    ack({ ok: true });
  });
  const bootId = randomUUID();
  const now = nowEpochNs();
  const dayStart = now - (now % NS_PER_DAY);
  const deviceOffsetNs = dayStart + 250n * NS_PER_MS; // RaceTime2 = jam host − 250 ms
  const deviceNow = (now - deviceOffsetNs) % NS_PER_DAY;
  const fmt = (ns: bigint) => {
    const ms = Number(ns / NS_PER_MS);
    const p = (v: number, n = 2) => String(v).padStart(n, "0");
    return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
  };
  const emit = (event: string, payload: object) => timing.emitWithAck(event, signPayload(payload, SECRET));

  assert.equal((await emit("timing:clock", { type: "timing:clock", bootId, deviceOffsetNs: deviceOffsetNs.toString(), samples: 50, windowMs: 5000, hostNs: now.toString() })).ok, true);

  // Payload yang dimanipulasi setelah ditandatangani harus ditolak.
  const forged = { ...signPayload({ type: "timing:impulse", bootId, seq: 99, channel: "FINISH", deviceTime: fmt(deviceNow), hostNs: now.toString() }, SECRET), deviceTime: "00:00:00.000" };
  assert.equal((await timing.emitWithAck("timing:impulse", forged)).ok, false);

  const t1 = fmt(deviceNow), t2 = fmt(deviceNow + 300n * NS_PER_MS);
  for (const [seq, deviceTime] of [[1, t1], [2, t2]] as const) {
    assert.equal((await emit("timing:impulse", { type: "timing:impulse", bootId, seq, channel: "FINISH", deviceTime, hostNs: now.toString() })).ok, true);
  }
  // Kirim ulang (reconnect) tidak boleh menggandakan impuls.
  await emit("timing:impulse", { type: "timing:impulse", bootId, seq: 2, channel: "FINISH", deviceTime: t2, hostNs: now.toString() });
  assert.equal(await database.col.impulses.countDocuments({ bootId }), 2);

  // --- Kedua impuls masuk SATU kelompok finish, lalu agent mengirim capture
  await until(async () => (await database.col.captures.countDocuments()) === 1);
  const detail = (await http("GET", `/api/sessions/${session._id}`, op)).data;
  assert.equal(detail.groups.length, 1);
  assert.equal(detail.groups[0].impulseIds.length, 2);
  const capture = detail.captures[0];
  assert.match(capture.url, /^\/files\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
  assert.equal((await fetch(base + capture.url)).status, 200);
  assert.equal((await fetch(base + capture.url.replace(/sig=./, "sig=0"))).status, 403);

  // Kolom saat perahu menyentuh garis, dihitung dari jendela capture (jam host).
  const columns: string[] = JSON.parse(await (await fetch(base + capture.columnsUrl)).text()).columns;
  const colAt = (deviceNs: bigint) => {
    const host = dayStart + deviceNs + deviceOffsetNs - dayStart;
    return columns.findIndex((c) => BigInt(c) >= host);
  };
  const colB = colAt(parseClock(t1) + 2n * NS_PER_MS);
  const colA = colAt(parseClock(t2) + 1n * NS_PER_MS);

  // --- Operator menandai urutan: B duluan, lalu A
  const markB = await http("POST", "/api/crossings", op, { captureId: capture._id, column: colB, rank: 1, lane: "B" });
  const markA = await http("POST", "/api/crossings", op, { captureId: capture._id, column: colA, rank: 2, lane: "A" });
  assert.equal(markB.status, 201, JSON.stringify(markB.data));
  const crossings = (await http("GET", `/api/sessions/${session._id}`, op)).data.crossings;
  const [cB, cA] = crossings;
  assert.equal(cB.teamId, "team-b");
  assert.equal(cB.timeSource, "impulse");
  assert.equal(cB.finishTime, t1);
  assert.equal(cA.finishTime, t2);
  assert.deepEqual(cB.warnings, [], "kamera & impuls selisih < 500 ms → tanpa peringatan");

  // --- Hanya juri yang boleh konfirmasi
  const confirmBody = { teamId: "team-b", lane: "B", crewInBoat: 6, crewExpected: 6, upright: true };
  assert.equal((await http("POST", `/api/crossings/${cB._id}/confirm`, op, confirmBody)).status, 403);
  assert.equal((await http("POST", `/api/crossings/${cB._id}/confirm`, juri, confirmBody)).status, 200);
  await http("POST", `/api/crossings/${cA._id}/confirm`, juri, { teamId: "team-a", lane: "A", crewInBoat: 5, crewExpected: 6, upright: true });

  await until(() => verified.length === 2);
  assert.deepEqual(verified.map((v) => [v.teamId, v.rank, v.finishTime]), [["team-b", 1, t1], ["team-a", 2, t2]]);
  assert.equal(verified[1].penalties.crewIncomplete, true);
  await until(async () => (await database.col.crossings.countDocuments({ deliveredRevision: 1 })) === 2);

  // --- Koreksi wajib beralasan; hasil terkonfirmasi tidak bisa dihapus
  assert.equal((await http("POST", `/api/crossings/${cA._id}/confirm`, juri, { teamId: "team-a", crewInBoat: 6, crewExpected: 6, upright: true })).status, 400);
  assert.equal((await http("DELETE", `/api/crossings/${cA._id}`, op)).status, 409);

  // --- Audit utuh, lalu terdeteksi bila diubah langsung di database
  assert.equal((await http("GET", "/api/audit/verify", adm)).data.ok, true);
  await database.col.audit.updateOne({ action: "crossing.confirm" }, { $set: { "after.crewInBoat": 2 } });
  const broken = (await http("GET", "/api/audit/verify", adm)).data;
  assert.equal(broken.ok, false);
  assert.ok(broken.brokenAtSeq > 0);
  void markA;
  agent.socket.close();
  timing.close();
});

test("jam Photo Finish: kalibrasi admin, snapshot per rekaman, bukti lama tidak berubah", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, adm] = [await login("op"), await login("adm")];
  const timingToken = issueToken({ sub: "device:timing:2", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h");
  const agent = await fakeAgent(issueToken({ sub: "device:agent:2", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h"));
  const timing = await socket(timingToken);
  const emit = (event: string, payload: object) => timing.emitWithAck(event, signPayload(payload, SECRET));

  const bootId = randomUUID();
  const now = nowEpochNs();
  const autoOffset = now - (now % NS_PER_DAY) + 250n * NS_PER_MS;
  await emit("timing:clock", { type: "timing:clock", bootId, deviceOffsetNs: autoOffset.toString(), samples: 50, windowMs: 5000, hostNs: now.toString() });

  // Mode auto: jam PF = RaceTime2 → selisih 0.
  let status = (await http("GET", "/api/clock/status", op)).data;
  assert.equal(status.mode, "auto");
  assert.equal(status.diffVsRaceTimeNs, "0");
  assert.match(status.pfTime, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);

  // Hanya admin yang boleh mengkalibrasi.
  assert.equal((await http("POST", "/api/clock/settings", op, { action: "trim", deltaMs: 1 })).status, 403);

  // Kunci dari RaceTime2 lalu trim +10 ms → jam PF 10 ms di depan RaceTime2.
  status = (await http("POST", "/api/clock/settings", adm, { action: "freeze-from-racetime", reason: "sebelum heat 1" })).data;
  assert.equal(status.mode, "manual");
  assert.equal(status.manualOffsetNs, autoOffset.toString());
  status = (await http("POST", "/api/clock/settings", adm, { action: "trim", deltaMs: 10 })).data;
  assert.equal(status.diffVsRaceTimeNs, (10n * NS_PER_MS).toString());
  assert.equal(status.revision, 2);

  // Jam manual tetap jalan walau heartbeat RaceTime2 berubah/putus.
  await emit("timing:clock", { type: "timing:clock", bootId, deviceOffsetNs: (autoOffset + 3n * NS_PER_MS).toString(), samples: 50, windowMs: 5000, hostNs: now.toString() });
  assert.equal((await http("GET", "/api/clock/status", op)).data.effectiveOffsetNs, (autoOffset - 10n * NS_PER_MS).toString());

  // Heat baru: snapshot jam ikut ke agent & tersimpan di capture.
  const { data: session } = await http("POST", "/api/sessions", op, { eventId: "EVT-2", raceCategory: "DRR", label: "DRR final" });
  await http("POST", `/api/sessions/${session._id}/arm`, op);
  const deviceTime = formatClock((now - autoOffset) % NS_PER_DAY, 3);
  await emit("timing:impulse", { type: "timing:impulse", bootId, seq: 1, channel: "FINISH", deviceTime, hostNs: now.toString() });
  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(session._id) })) === 1);

  const req = agent.requests.at(-1)!;
  assert.equal(req.clock.revision, 2);
  assert.equal(req.clock.mode, "manual");
  assert.equal(req.clock.deviceOffsetNs, (autoOffset - 10n * NS_PER_MS).toString());
  const detail = (await http("GET", `/api/sessions/${session._id}`, op)).data;
  assert.equal(detail.captures[0].clock.revision, 2);

  // Waktu kamera memakai jam PF snapshot (+10 ms dari RaceTime2).
  const columns: string[] = JSON.parse(await (await fetch(base + detail.captures[0].columnsUrl)).text()).columns;
  const col = columns.findIndex((c) => BigInt(c) >= now);
  const { data: crossing } = await http("POST", "/api/crossings", op, { captureId: detail.captures[0]._id, column: col, rank: 1, teamId: "team-x" });
  const expected = (BigInt(columns[col]!) - (autoOffset - 10n * NS_PER_MS)) % NS_PER_DAY;
  assert.equal(crossing.cameraTimeNs, expected.toString());

  // Kalibrasi ulang setelahnya tidak mengubah bukti yang sudah terekam.
  await http("POST", "/api/clock/settings", adm, { action: "trim", deltaMs: 50 });
  await http("POST", "/api/crossings", op, { captureId: detail.captures[0]._id, column: col + 1, rank: 2, teamId: "team-y" });
  const again = (await database.col.crossings.findOne({ _id: new ObjectId(crossing._id) }))!;
  assert.equal(again.cameraTimeNs, expected.toString());

  const actions = (await database.col.audit.find({ entity: "clock" }).toArray()).map((a) => a.action);
  assert.deepEqual(actions, ["clock.freeze-from-racetime", "clock.trim", "clock.trim"]);
  agent.socket.close();
  timing.close();
});

test("frame RaceTime2 tanpa payload: waktu impuls dari jam PF, bucket ikut ke timing", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, juri, adm] = [await login("op"), await login("juri"), await login("adm")];
  const timing = await socket(issueToken({ sub: "device:timing:3", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  const agent = await fakeAgent(issueToken({ sub: "device:agent:3", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h"));
  const verified: any[] = [];
  timing.on("photofinish:verified", (msg: any, ack: (r: unknown) => void) => { verified.push(msg); ack({ ok: true }); });

  // Admin menyamakan jam PF dengan tampilan RaceTime2 (set waktu + reset trim).
  await http("POST", "/api/clock/settings", adm, { action: "reset-trim" });
  const status = (await http("POST", "/api/clock/settings", adm, { action: "set-time", deviceTime: "09:00:00.000" })).data;
  assert.equal(status.source, "manual");
  const offset = BigInt(status.effectiveOffsetNs);

  const bucket = { divisionId: "div-r6", raceId: "race-putra", initialId: "init-open" };
  const { data: session } = await http("POST", "/api/sessions", op, { eventId: "EVT-3", bucket, raceCategory: "RX", label: "RX heat 1", lanes: [{ lane: "1", teamId: "team-1", bib: "1" }] });
  assert.deepEqual(session.bucket, bucket);
  await http("POST", "/api/sessions/" + session._id + "/arm", op);

  const hostNs = nowEpochNs();
  const res = await timing.emitWithAck("timing:impulse", signPayload({
    type: "timing:impulse", bootId: randomUUID(), seq: 0, channel: "FINISH", hostNs: hostNs.toString(), serialLatencyNs: "166666667",
  }, SECRET));
  assert.equal(res.ok, true, res.error);
  const imp = (await database.col.impulses.findOne({ _id: new ObjectId(res.impulseId) }))!;
  assert.equal(imp.timeBasis, "pf-clock");
  assert.equal(imp.pfClockRevision, status.revision);
  assert.equal(imp.deviceTimeNs, (((hostNs - offset) % NS_PER_DAY) + NS_PER_DAY) % NS_PER_DAY + "");
  assert.equal(imp.deviceTime, formatClock(BigInt(imp.deviceTimeNs), 3));

  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(session._id) })) === 1);
  const capture = (await http("GET", "/api/sessions/" + session._id, op)).data.captures[0];
  const { data: crossing } = await http("POST", "/api/crossings", op, { captureId: capture._id, column: 10, rank: 1, lane: "1" });
  assert.equal(crossing.finishTime, imp.deviceTime);
  await http("POST", "/api/crossings/" + crossing._id + "/confirm", juri, { teamId: "team-1", crewInBoat: 4, crewExpected: 4, upright: true });
  await until(() => verified.length === 1);
  assert.deepEqual(verified[0].bucket, bucket);
  assert.equal(verified[0].raceCategory, "RX");
  agent.socket.close();
  timing.close();
});

test("standby kamera: cuplikan hanya untuk operator, agent nyala/mati sesuai penonton", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const agent = await socket(issueToken({ sub: "device:agent:p", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h"));
  const toggles: Array<{ cameraId: string; on: boolean }> = [];
  agent.on("agent:preview", (m: { cameraId: string; on: boolean }) => toggles.push(m));

  const viewer = await socket(await login("lihat"));
  assert.equal((await viewer.emitWithAck("preview:subscribe", "cam-1")).ok, false, "viewer tidak boleh melihat kamera");

  const op = await socket(await login("op"));
  const frames: any[] = [];
  op.on("preview:frame", (f: any) => frames.push(f));
  assert.equal((await op.emitWithAck("preview:subscribe", "cam-1")).ok, true);
  await until(() => toggles.some((t) => t.cameraId === "cam-1" && t.on));

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  agent.emit("agent:preview-frame", { cameraId: "cam-1", agentNs: "1", width: 1920, height: 1080, fps: 240, finishLine: { x1: 960, y1: 0, x2: 962, y2: 1079 }, jpeg });
  agent.emit("agent:preview-frame", { cameraId: "cam-1", jpeg: "bukan-gambar" }); // ditolak diam-diam
  await until(() => frames.length === 1);
  assert.equal(frames[0].width, 1920);
  assert.ok(Buffer.from(frames[0].jpeg).equals(jpeg));

  op.close();
  await until(() => toggles.at(-1)?.on === false);
  viewer.close();
  agent.close();
});
