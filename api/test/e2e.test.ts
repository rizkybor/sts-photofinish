// Uji end-to-end satu heat H2H: timing → API → agent → juri → timing.
// Memakai MongoDB in-memory (unduh binary mongod sekali saat pertama jalan).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  PF_GROUP_QUIET_MS: "200", PF_LOGIN_RATE_MAX: "1000", PF_TIMING_DB: "timing_e2e",
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
async function fakeAgent(agentToken: string, opts: { frames?: number; corruptFrame?: boolean; remote?: boolean } = {}) {
  const s = await socket(agentToken);
  // remote = agent di lokasi, API di VPS: file diunggah lewat HTTP, bukan ditulis ke disk API.
  const save = async (rel: string, data: Buffer | string) => {
    if (!opts.remote) return writeFile(path.join(capturesDir, rel), data);
    const res = await fetch(`${base}/api/capture-files/${rel}`, {
      method: "PUT", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/octet-stream" }, body: Buffer.from(data),
    });
    assert.equal(res.status, 201, await res.text());
  };
  const requests: ExtractReq[] = [];
  const rejected: string[] = [];
  s.on("agent:extract", async (req: ExtractReq) => {
    requests.push(req);
    const from = BigInt(req.fromHostNs), to = BigInt(req.toHostNs);
    const columns: string[] = [];
    for (let t = from; t <= to; t += 4_166_667n) columns.push(t.toString());
    const dir = path.join(capturesDir, req.sessionId, req.groupId);
    if (!opts.remote) await mkdir(dir, { recursive: true });
    const png = Buffer.from("fake-png");
    const json = JSON.stringify({ cameraId: req.cameraId, columns });
    await save(`${req.sessionId}/${req.groupId}/cam-1-slit.png`, png);
    await save(`${req.sessionId}/${req.groupId}/cam-1-columns.json`, json);
    let frameFields = {};
    if (opts.frames) {
      // Frame utuh pada kolom 0, 10, 20, … (jam agent sama dengan kolom)
      if (!opts.remote) await mkdir(path.join(dir, "cam-1-frames"), { recursive: true });
      const entries = [];
      for (let i = 1; i <= opts.frames; i++) {
        const jpeg = Buffer.from(`frame-${i}`);
        const rel = `${req.sessionId}/${req.groupId}/cam-1-frames/${String(i).padStart(5, "0")}.jpg`;
        await save(rel, jpeg);
        entries.push({ file: rel, agentNs: columns[(i - 1) * 10]!, sha256: sha256Hex(jpeg) });
      }
      if (opts.corruptFrame) await writeFile(path.join(capturesDir, entries[0]!.file), "dirusak");
      const index = JSON.stringify({ cameraId: "cam-1", scale: 0.5, finishLine: { x1: 160, y1: 0, x2: 160, y2: 359 }, frames: entries });
      await save(`${req.sessionId}/${req.groupId}/cam-1-frames.json`, index);
      frameFields = { framesFile: `${req.sessionId}/${req.groupId}/cam-1-frames.json`, framesSha256: sha256Hex(index), frameCount: opts.frames };
    }
    const res = await http("POST", "/api/captures", agentToken, {
      groupId: req.groupId, cameraId: req.cameraId, file: `${req.sessionId}/${req.groupId}/cam-1-slit.png`,
      columnsFile: `${req.sessionId}/${req.groupId}/cam-1-columns.json`, sha256: sha256Hex(png), columnsSha256: sha256Hex(json),
      fps: 240, width: columns.length, height: 100, fromAgentNs: columns[0], toAgentNs: columns.at(-1), agentOffsetNs: "0", agentRttNs: "500000",
      ...frameFields,
    });
    if (opts.corruptFrame) {
      assert.equal(res.status, 400);
      assert.match(res.data.error, /Frame rusak/);
      rejected.push(req.groupId);
      return;
    }
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });
  return { socket: s, requests, rejected };
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

test("heat H2H: urutan dari kamera, waktu dari sinyal, hasil terkirim ke timing", async () => {
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

  // --- Timing system: offset jam perangkat lalu dua sinyal finish 300 ms
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
  // Kirim ulang (reconnect) tidak boleh menggandakan sinyal.
  await emit("timing:impulse", { type: "timing:impulse", bootId, seq: 2, channel: "FINISH", deviceTime: t2, hostNs: now.toString() });
  assert.equal(await database.col.impulses.countDocuments({ bootId }), 2);

  // --- Kedua sinyal masuk SATU kelompok finish, lalu agent mengirim capture
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

  // Progres untuk bar perpindahan heat: rekaman siap tanpa tanda = perlu ditinjau.
  const progressOf = async () => (await http("GET", "/api/sessions", op)).data.find((s: any) => s._id === session._id).progress;
  assert.deepEqual(await progressOf(), { finishes: 1, recording: 0, close: 1, pending: 1, confirmed: 0 });

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
  assert.deepEqual(cB.warnings, [], "kamera & sinyal selisih < 500 ms → tanpa peringatan");
  assert.equal((await progressOf()).pending, 1, "finish berdekatan belum dikonfirmasi");
  const feed = (await http("GET", "/api/finishes", op)).data;
  assert.equal(feed[0].boats, 2);
  assert.equal(feed[0].gapMs, 300);
  assert.equal(feed[0].close, true);

  // --- Hanya juri yang boleh konfirmasi
  const confirmBody = { teamId: "team-b", lane: "B", crewInBoat: 6, crewExpected: 6, upright: true };
  assert.equal((await http("POST", `/api/crossings/${cB._id}/confirm`, op, confirmBody)).status, 403);
  assert.equal((await http("POST", `/api/crossings/${cB._id}/confirm`, juri, confirmBody)).status, 200);
  await http("POST", `/api/crossings/${cA._id}/confirm`, juri, { teamId: "team-a", lane: "A", crewInBoat: 5, crewExpected: 6, upright: true });

  await until(() => verified.length === 2);
  assert.deepEqual(await progressOf(), { finishes: 1, recording: 0, close: 1, pending: 0, confirmed: 2 });
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

test("frame RaceTime2 tanpa payload: waktu sinyal dari jam PF; sesi cukup terhubung ke Event", async () => {
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

  // Event di database sts-timingsystem (hanya dibaca untuk nama Event).
  const eventId = new ObjectId();
  await database.client.db("timing_e2e").collection("eventsCollection").insertOne({ _id: eventId, eventName: "Kejurnas Arung Jeram 2026", categoriesDivision: [{ name: "R6" }] });
  const events = (await http("GET", "/api/events", op)).data;
  assert.deepEqual(events.map((e: any) => [e.eventId, e.eventName]), [[eventId.toHexString(), "Kejurnas Arung Jeram 2026"]]);
  assert.ok(!("categoriesDivision" in events[0]), "kategori event tidak dibaca");

  const { data: session } = await http("POST", "/api/sessions", op, { eventId: eventId.toHexString(), raceCategory: "RX", label: "RX heat 1", lanes: [{ lane: "1", teamId: "team-1", bib: "1" }] });
  assert.equal(session.eventName, "Kejurnas Arung Jeram 2026", "nama Event dicari dari Id Event");
  assert.equal(session.bucket, undefined);

  // Sesi manual cukup Event: tanpa format, heat, dan label (label dibuat otomatis)
  const { data: simple } = await http("POST", "/api/sessions", op, { eventId: eventId.toHexString(), note: "R4 Putri" });
  assert.equal(simple.raceCategory, null);
  assert.equal(simple.heatId, null);
  assert.match(simple.label, /^Kejurnas Arung Jeram 2026 · Sesi \d+$/);
  assert.equal(simple.note, "R4 Putri");
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
  assert.equal(verified[0].eventId, eventId.toHexString());
  assert.equal(verified[0].eventName, "Kejurnas Arung Jeram 2026");
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

test("keterangan sesi: pembeda sesi dari admin/operator; timing tidak bisa membuat sesi", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const op = await login("op");
  const { data: s } = await http("POST", "/api/sessions", op, { eventId: "EVT-N" });
  assert.match(s.label, /^Event EVT-N · Sesi 1$/, "tanpa database timing: label memakai Id Event");
  assert.equal((await http("PUT", `/api/sessions/${s._id}/note`, op, { note: "  R4 Putra  " })).data.note, "R4 Putra");
  assert.equal((await database.col.sessions.findOne({ _id: new ObjectId(s._id) }))!.note, "R4 Putra");
  assert.equal((await http("PUT", `/api/sessions/${s._id}/note`, await login("lihat"), { note: "x" })).status, 403);

  // Fitur "Kirim heat" dihapus: pesan timing:session tidak lagi ditangani.
  const timing = await socket(issueToken({ sub: "device:timing:h", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  const res = await timing.timeout(800).emitWithAck("timing:session", signPayload({ type: "timing:session", eventId: "EVT-N", raceCategory: "H2H", heatId: null, label: "x", lanes: [] }, SECRET)).catch(() => null);
  assert.equal(res, null, "tidak ada handler → tidak ada jawaban");
  assert.equal(await database.col.sessions.countDocuments({ eventId: "EVT-N" }), 1);
  timing.close();
});

test("photocell virtual: pemicu kamera memicu rekaman, waktu perahu dari kolom gambar", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const op = await login("op");
  const agentToken = issueToken({ sub: "device:agent:t", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");
  const agent = await fakeAgent(agentToken);
  const boot = randomUUID();
  const trig = (seq: number, agentNs: bigint) =>
    agent.socket.emitWithAck("agent:trigger", { cameraId: "cam-1", bootId: boot, seq, agentNs: agentNs.toString(), agentOffsetNs: "0" });

  // Tanpa sesi aktif → diabaikan (orang lalu-lalang di luar heat)
  await http("POST", "/api/sessions", op, { eventId: "EVT-T0", raceCategory: "H2H", label: "tidak aktif" });
  for (const s of await database.col.sessions.find({ armed: true }).toArray()) await http("POST", `/api/sessions/${s._id}/disarm`, op);
  const ignored = await trig(1, nowEpochNs());
  assert.equal(ignored.ok, true);
  assert.equal(ignored.accepted, false);

  const { data: session } = await http("POST", "/api/sessions", op, {
    eventId: "EVT-T", raceCategory: "H2H", label: "photocell virtual",
    lanes: [{ lane: "A", teamId: "a", bib: "1" }, { lane: "B", teamId: "b", bib: "2" }],
  });
  await http("POST", `/api/sessions/${session._id}/arm`, op);

  // sts-timingsystem mendengarkan → baris "Photo Finish" + Buffer-Timer-Finish
  const timing = await socket(issueToken({ sub: "device:timing:pt", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  const notes: any[] = [];
  timing.on("photofinish:trigger", (m: any) => notes.push(m));

  // Dua perahu berdempetan → detektor memicu sekali, rekaman mencakup keduanya
  const t0 = nowEpochNs();
  const res = await trig(2, t0);
  assert.equal(res.accepted, true);
  await trig(2, t0); // kirim ulang → idempoten
  const imps = await database.col.impulses.find({ sessionId: new ObjectId(session._id) }).toArray();
  assert.equal(imps.length, 1);
  assert.equal(imps[0]!.source, "camera");
  await until(() => notes.length === 1);
  assert.ok(verifyPayload(notes[0], SECRET), "notifikasi pemicu bertanda tangan HMAC");
  assert.equal(notes[0].time, imps[0]!.deviceTime);
  assert.match(notes[0].time, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(notes[0].sessionId, session._id);
  timing.close();

  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(session._id) })) === 1);
  const cap = (await http("GET", `/api/sessions/${session._id}`, op)).data.captures[0];
  const a = (await http("POST", "/api/crossings", op, { captureId: cap._id, column: 60, rank: 1, lane: "A" })).data;
  const b = (await http("POST", "/api/crossings", op, { captureId: cap._id, column: 61, rank: 2, lane: "B" })).data;
  // Pemicu kamera bukan waktu resmi → keduanya memakai waktu kolom gambar, selisih 1 frame
  assert.equal(a.timeSource ?? (await database.col.crossings.findOne({ _id: new ObjectId(a._id) }))!.timeSource, "camera");
  const [ca, cb] = await Promise.all([a, b].map((x) => database.col.crossings.findOne({ _id: new ObjectId(x._id) })));
  assert.equal(ca!.timeSource, "camera");
  assert.equal(cb!.timeSource, "camera");
  assert.equal(BigInt(cb!.timeNs!) - BigInt(ca!.timeNs!), 4_166_667n);
  assert.ok(!ca!.warnings.some((w) => w.includes("Sinyal")), "pemicu kamera tidak dihitung sebagai sinyal berlebih");
  agent.socket.close();
});

test("satu kamera satu agent: agent kedua dengan cameraId sama ditolak", async () => {
  const token = issueToken({ sub: "device:agent:dup", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");
  const first = connect(base, { auth: { token, cameraId: "cam-dup" }, transports: ["websocket"], reconnection: false });
  sockets.push(first);
  await new Promise<void>((r) => first.once("connect", () => r()));
  const second = connect(base, { auth: { token, cameraId: "cam-dup" }, transports: ["websocket"], reconnection: false });
  sockets.push(second);
  const rejected = await new Promise<{ error: string }>((r) => second.once("agent:rejected", r));
  assert.match(rejected.error, /cam-dup.*sudah dipakai/);
  await until(() => !second.connected);
  assert.equal(first.connected, true, "agent pertama tetap jalan");
  const other = connect(base, { auth: { token, cameraId: "cam-lain" }, transports: ["websocket"], reconnection: false });
  sockets.push(other);
  await new Promise<void>((r) => other.once("connect", () => r()));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(other.connected, true, "kamera lain boleh");
  first.close(); other.close();
});

test("production: API menyajikan web app hasil build bila PF_WEB_DIR ada", async () => {
  const webDir = await mkdtemp(path.join(tmpdir(), "pf-web-"));
  await mkdir(path.join(webDir, "assets"));
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>STS Photo Finish</title>");
  await writeFile(path.join(webDir, "assets", "app.js"), "console.log(1)");
  const c = loadConfig({
    NODE_ENV: "test", PF_MONGO_URL: mongo.getUri(), PF_MONGO_DB: "pf_e2e_web", PF_JWT_SECRET: SECRET, PF_HMAC_SECRET: SECRET,
    PF_FILE_URL_SECRET: SECRET, PF_CAPTURES_DIR: capturesDir, PF_WEB_DIR: webDir,
  });
  const webApp = await buildApp(c, database);
  await webApp.listen({ host: "127.0.0.1", port: 0 });
  const addr = webApp.server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    assert.match(await (await fetch(url + "/")).text(), /STS Photo Finish/);
    assert.equal((await fetch(url + "/assets/app.js")).headers.get("content-type")?.startsWith("text/javascript") || (await fetch(url + "/assets/app.js")).headers.get("content-type")?.includes("javascript"), true);
    assert.match(await (await fetch(url + "/?standby")).text(), /STS Photo Finish/);
    assert.match(await (await fetch(url + "/sesi/apa-saja")).text(), /STS Photo Finish/, "rute aplikasi → index.html");
    const api404 = await fetch(url + "/api/tidak-ada");
    assert.equal(api404.status, 404);
    assert.match(await api404.text(), /Tidak ditemukan/);
    assert.equal((await fetch(url + "/health")).status, 200);
  } finally {
    await webApp.close();
    await rm(webDir, { recursive: true, force: true });
  }
});

test("hapus tangkapan: file & tanda dihapus, sinyal RaceTime2 kembali tanpa sesi, hasil terkonfirmasi dilindungi", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, juri, lihat] = [await login("op"), await login("juri"), await login("lihat")];
  const agent = await fakeAgent(issueToken({ sub: "device:agent:del", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h"));
  const timing = await socket(issueToken({ sub: "device:timing:del", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  timing.on("photofinish:verified", (_m: unknown, ack: (r: unknown) => void) => ack({ ok: true }));

  const { data: session } = await http("POST", "/api/sessions", op, { eventId: "EVT-DEL", raceCategory: "SPRINT", label: "hapus", lanes: [{ lane: "1", teamId: "t1" }] });
  await http("POST", `/api/sessions/${session._id}/arm`, op);
  const bootId = randomUUID();
  const send = (seq: number) => timing.emitWithAck("timing:impulse", signPayload({ type: "timing:impulse", bootId, seq, channel: "FINISH", hostNs: nowEpochNs().toString() }, SECRET));
  const capturesOf = () => database.col.captures.find({ sessionId: new ObjectId(session._id) }).toArray();

  // Tangkapan 1: belum dikonfirmasi → boleh dihapus
  const imp1 = (await send(1)).impulseId;
  await until(async () => (await capturesOf()).length === 1);
  const cap1 = (await capturesOf())[0]!;
  await http("POST", "/api/crossings", op, { captureId: cap1._id.toHexString(), column: 3, rank: 1, lane: "1" });

  assert.equal((await http("DELETE", `/api/groups/${cap1.groupId}`, lihat)).status, 403, "viewer tidak boleh menghapus");
  const del = await http("DELETE", `/api/groups/${cap1.groupId}`, op);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.racetimeImpulsesReturned, 1);
  assert.equal(await database.col.groups.countDocuments({ _id: cap1.groupId }), 0);
  assert.equal(await database.col.crossings.countDocuments({ groupId: cap1.groupId }), 0);
  assert.equal((await capturesOf()).length, 0);
  const back = (await database.col.impulses.findOne({ _id: new ObjectId(imp1) }))!;
  assert.equal(back.sessionId, null, "sinyal RaceTime2 kembali ke daftar tanpa sesi");
  await assert.rejects(readFile(path.join(capturesDir, cap1.file)), "file gambar terhapus dari disk");
  assert.ok(await database.col.audit.findOne({ action: "group.delete", entityId: cap1.groupId.toHexString() }));

  // Tangkapan 2: sudah dikonfirmasi juri → ditolak
  await send(2);
  await until(async () => (await capturesOf()).length === 1);
  const cap2 = (await capturesOf())[0]!;
  const { data: c } = await http("POST", "/api/crossings", op, { captureId: cap2._id.toHexString(), column: 3, rank: 1, lane: "1" });
  await http("POST", `/api/crossings/${c._id}/confirm`, juri, { teamId: "t1", crewInBoat: 4, crewExpected: 4, upright: true });
  const blocked = await http("DELETE", `/api/groups/${cap2.groupId}`, op);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /dikonfirmasi juri/);
  agent.socket.close();
  timing.close();
});

test("hapus sesi aktif/tidak aktif: tangkapan & file terhapus, sinyal kembali tanpa sesi, hasil juri dilindungi", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, juri, lihat] = [await login("op"), await login("juri"), await login("lihat")];
  const agent = await fakeAgent(issueToken({ sub: "device:agent:sdel", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h"));
  const timing = await socket(issueToken({ sub: "device:timing:sdel", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  timing.on("photofinish:verified", (_m: unknown, ack: (r: unknown) => void) => ack({ ok: true }));
  const bootId = randomUUID();
  const send = (seq: number) => timing.emitWithAck("timing:impulse", signPayload({ type: "timing:impulse", bootId, seq, channel: "FINISH", hostNs: nowEpochNs().toString() }, SECRET));

  // Sesi AKTIF dengan satu tangkapan → bisa dihapus
  const { data: active } = await http("POST", "/api/sessions", op, { eventId: "EVT-SDEL" });
  await http("POST", `/api/sessions/${active._id}/arm`, op);
  const imp = (await send(1)).impulseId;
  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(active._id) })) === 1);
  const cap = (await database.col.captures.findOne({ sessionId: new ObjectId(active._id) }))!;

  assert.equal((await http("DELETE", `/api/sessions/${active._id}`, lihat)).status, 403, "viewer tidak boleh menghapus");
  const del = await http("DELETE", `/api/sessions/${active._id}`, op);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.wasArmed, true);
  assert.equal(await database.col.sessions.countDocuments({ _id: new ObjectId(active._id) }), 0);
  assert.equal(await database.col.groups.countDocuments({ sessionId: new ObjectId(active._id) }), 0);
  assert.equal(await database.col.captures.countDocuments({ sessionId: new ObjectId(active._id) }), 0);
  assert.equal(await database.col.sessions.countDocuments({ armed: true }), 0, "tidak ada sesi aktif lagi");
  assert.equal((await database.col.impulses.findOne({ _id: new ObjectId(imp) }))!.sessionId, null, "sinyal RaceTime2 kembali tanpa sesi");
  await assert.rejects(readFile(path.join(capturesDir, cap.file)), "file rekaman terhapus");
  assert.ok(await database.col.audit.findOne({ action: "session.delete", entityId: active._id }));

  // Sesi TIDAK AKTIF tanpa tangkapan → bisa dihapus
  const { data: idle } = await http("POST", "/api/sessions", op, { eventId: "EVT-SDEL" });
  assert.equal((await http("DELETE", `/api/sessions/${idle._id}`, op)).data.wasArmed, false);

  // Ada hasil dikonfirmasi juri → ditolak
  const { data: kept } = await http("POST", "/api/sessions", op, { eventId: "EVT-SDEL", lanes: [{ lane: "1", teamId: "t1" }] });
  await http("POST", `/api/sessions/${kept._id}/arm`, op);
  await send(2);
  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(kept._id) })) === 1);
  const cap2 = (await database.col.captures.findOne({ sessionId: new ObjectId(kept._id) }))!;
  const { data: c } = await http("POST", "/api/crossings", op, { captureId: cap2._id.toHexString(), column: 3, rank: 1, lane: "1" });
  await http("POST", `/api/crossings/${c._id}/confirm`, juri, { teamId: "t1", crewInBoat: 4, crewExpected: 4, upright: true });
  const blocked = await http("DELETE", `/api/sessions/${kept._id}`, op);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /dikonfirmasi juri/);
  assert.equal(await database.col.sessions.countDocuments({ _id: new ObjectId(kept._id) }), 1);
  agent.socket.close();
  timing.close();
});

test("frame utuh: dipetakan ke kolom slit-scan, diverifikasi hash, ikut terhapus", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const op = await login("op");
  const token = issueToken({ sub: "device:agent:fr", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");
  const agent = await fakeAgent(token, { frames: 5 });
  const timing = await socket(issueToken({ sub: "device:timing:fr", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  const { data: session } = await http("POST", "/api/sessions", op, { eventId: "EVT-FR", raceCategory: "SPRINT", label: "frame" });
  await http("POST", `/api/sessions/${session._id}/arm`, op);
  await timing.emitWithAck("timing:impulse", signPayload({ type: "timing:impulse", bootId: randomUUID(), seq: 1, channel: "FINISH", hostNs: nowEpochNs().toString() }, SECRET));
  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(session._id) })) === 1);
  const cap = (await database.col.captures.findOne({ sessionId: new ObjectId(session._id) }))!;
  assert.equal(cap.frameCount, 5);

  const { data } = await http("GET", `/api/captures/${cap._id}/frames`, op);
  assert.deepEqual(data.frames.map((f: any) => f.column), [0, 10, 20, 30, 40]);
  assert.deepEqual(data.finishLine, { x1: 160, y1: 0, x2: 160, y2: 359 });
  assert.equal(await (await fetch(base + data.frames[2].url)).text(), "frame-3");

  // Hapus tangkapan → folder frame ikut hilang
  await http("DELETE", `/api/groups/${cap.groupId}`, op);
  await assert.rejects(readFile(path.join(capturesDir, cap.framesFile!.replace(/\.json$/, ""), "00001.jpg")));
  agent.socket.close();

  // Frame dirusak setelah hash dihitung → rekaman ditolak
  const bad = await fakeAgent(issueToken({ sub: "device:agent:fr2", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h"), { frames: 2, corruptFrame: true });
  await http("POST", `/api/sessions/${session._id}/arm`, op);
  await timing.emitWithAck("timing:impulse", signPayload({ type: "timing:impulse", bootId: randomUUID(), seq: 1, channel: "FINISH", hostNs: nowEpochNs().toString() }, SECRET));
  await until(() => bad.rejected.length === 1);
  assert.equal(await database.col.captures.countDocuments({ sessionId: new ObjectId(session._id) }), 0);
  bad.socket.close();
  timing.close();
});

test("mode VPS: agent jarak jauh mengunggah rekaman lewat HTTP, path & peran dibatasi", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, juri] = [await login("op"), await login("juri")];
  const token = issueToken({ sub: "device:agent:vps", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");
  const put = (rel: string, tok: string, body = "x") => fetch(`${base}/api/capture-files/${rel}`, {
    method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream" }, body,
  });
  const ok = "0123456789abcdef01234567/0123456789abcdef01234567";
  assert.equal((await put(`${ok}/cam-1-slit.png`, juri)).status, 403, "hanya agent yang boleh mengunggah");
  assert.equal((await put("..%2F..%2Fetc%2Fpasswd", token)).status, 400, "path traversal (ter-encode) ditolak API");
  assert.notEqual((await put("../../etc/passwd", token)).status, 201, "path traversal biasa tidak pernah tersimpan");
  assert.equal((await put(`${ok}/cam-1-slit.png.sh`, token)).status, 400);
  assert.equal((await put(`${ok}%2F..%2Fx%2Fcam-1-slit.png`, token)).status, 400);
  const res = await put(`${ok}/cam-1-slit.png`, token, "isi-png");
  assert.equal(res.status, 201);
  assert.equal((await res.json()).sha256, sha256Hex("isi-png"));
  assert.equal(await readFile(path.join(capturesDir, ok, "cam-1-slit.png"), "utf8"), "isi-png");

  // Alur lengkap: rekaman + 3 foto frame diunggah, lalu terdaftar & bisa dibuka
  const agent = await fakeAgent(token, { frames: 3, remote: true });
  const timing = await socket(issueToken({ sub: "device:timing:vps", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h"));
  const { data: session } = await http("POST", "/api/sessions", op, { eventId: "EVT-VPS", raceCategory: "SPRINT", label: "vps" });
  await http("POST", `/api/sessions/${session._id}/arm`, op);
  await timing.emitWithAck("timing:impulse", signPayload({ type: "timing:impulse", bootId: randomUUID(), seq: 1, channel: "FINISH", hostNs: nowEpochNs().toString() }, SECRET));
  await until(async () => (await database.col.captures.countDocuments({ sessionId: new ObjectId(session._id) })) === 1);
  const cap = (await database.col.captures.findOne({ sessionId: new ObjectId(session._id) }))!;
  assert.equal(cap.frameCount, 3);
  const { data } = await http("GET", `/api/captures/${cap._id}/frames`, op);
  assert.equal(await (await fetch(base + data.frames[1].url)).text(), "frame-2");
  agent.socket.close();
  timing.close();
});

test("pengaturan kamera: tertunda saat offline, diterapkan & disimpan, gagal tidak disimpan, pindai, reset", async () => {
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, lihat] = [await login("op"), await login("lihat")];
  const cfg = {
    sourceType: "iphone", source: "0", fps: 30, width: null, height: null,
    finishLine: { x1: 960, y1: 0, x2: 960, y2: 1079 },
    trigger: { enabled: true, threshold: 30, minRun: 0.06 }, frames: { enabled: true, fps: 30, width: 1280 },
  };
  assert.equal((await http("GET", "/api/cameras", lihat)).status, 403, "viewer tidak boleh mengatur kamera");

  // 1) Agent offline → disimpan sebagai tertunda
  const pending = await http("PUT", "/api/cameras/cam-set/config", op, cfg);
  assert.equal(pending.data.pending, true);

  // 2) Agent terhubung → menerima pengaturan tersimpan
  const token = issueToken({ sub: "device:agent:set", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");
  const agent = connect(base, { auth: { token, cameraId: "cam-set" }, transports: ["websocket"], reconnection: false });
  sockets.push(agent);
  const received: any[] = [];
  let failNext = false;
  agent.on("agent:config", (msg: any, ack: (r: unknown) => void) => {
    received.push(msg.config);
    if (failNext) return ack({ ok: false, error: "Kamera tidak bisa dibuka: 7" });
    ack({ ok: true, status: { running: true, width: 1920, height: 1080, settings: msg.config } });
  });
  agent.on("agent:scan", (_m: unknown, ack: (r: unknown) => void) =>
    ack({ ok: true, cameras: [{ index: 0, width: 1920, height: 1080, inUse: true }, { index: 1, width: 1280, height: 720, inUse: false }], deviceNames: ["FaceTime HD Camera", "iPhone"], videos: [] }));
  await new Promise<void>((r) => agent.once("connect", () => r()));
  await until(() => received.length === 1);
  assert.equal(received[0].sourceType, "iphone", "pengaturan tertunda diterapkan saat agent terhubung");
  agent.emit("agent:status", { running: true, width: 1920, height: 1080, measuredFps: 29.9 });

  // 3) Online: berhasil → disimpan (revisi naik)
  const ok = await http("PUT", "/api/cameras/cam-set/config", op, { ...cfg, sourceType: "laptop", source: "1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.applied, true);
  let list = (await http("GET", "/api/cameras", op)).data.find((c: any) => c.cameraId === "cam-set");
  assert.equal(list.connected, true);
  assert.equal(list.saved.revision, 2);
  assert.equal(list.saved.config.sourceType, "laptop");
  assert.equal(list.status.measuredFps, 29.9);

  // 4) Agent gagal membuka kamera → 422, pengaturan TIDAK disimpan
  failNext = true;
  const bad = await http("PUT", "/api/cameras/cam-set/config", op, { ...cfg, sourceType: "external", source: "7" });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /tidak bisa dibuka/);
  list = (await http("GET", "/api/cameras", op)).data.find((c: any) => c.cameraId === "cam-set");
  assert.equal(list.saved.revision, 2, "pengaturan gagal tidak menimpa yang tersimpan");
  failNext = false;

  // 5) Validasi & pindai
  assert.equal((await http("PUT", "/api/cameras/cam-set/config", op, { ...cfg, fps: 0 })).status, 400);
  const scan = await http("POST", "/api/cameras/cam-set/scan", op);
  assert.equal(scan.data.cameras.length, 2);
  assert.equal((await http("POST", "/api/cameras/cam-lain/scan", op)).status, 409, "agent tidak terhubung");

  // 6) Kembali ke .env → agent menerima config null, simpanan dihapus
  const reset = await http("DELETE", "/api/cameras/cam-set/config", op);
  assert.equal(reset.data.reset, true);
  await until(() => received.at(-1) === null);
  assert.equal(await database.col.cameraConfigs.countDocuments({ _id: "cam-set" }), 0);
  assert.ok(await database.col.audit.findOne({ action: "camera.config", entityId: "cam-set" }));
  agent.close();
});
