// Uji interop: klien photofinishCore.js milik sts-timingsystem ↔ API ini.
// Dilewati otomatis bila repo sts-timingsystem tidak ada di sebelah repo ini.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { io as connect } from "socket.io-client";
import { buildApp } from "../src/app.js";
import { hashPassword, issueToken } from "../src/auth.js";
import { sha256Hex } from "../src/canonical.js";
import { loadConfig } from "../src/config.js";
import { connectDb, type Database } from "../src/db.js";
import { nowEpochNs } from "../src/time.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TIMING_APP = process.env.PF_TIMING_APP_DIR ?? path.resolve(here, "../../../sts-timingsystem/app");
const CORE = path.join(TIMING_APP, "src/services/photofinishCore.js");
const skip = !existsSync(CORE) && "sts-timingsystem tidak ditemukan";

const SECRET = "t".repeat(40);
let mongo: MongoMemoryServer, database: Database, app: Awaited<ReturnType<typeof buildApp>>, base = "", capturesDir = "";
let cfg: ReturnType<typeof loadConfig>;

async function http(method: string, url: string, token?: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const until = async (cond: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); }
};

before(async () => {
  if (skip) return;
  mongo = await MongoMemoryServer.create();
  capturesDir = await mkdtemp(path.join(tmpdir(), "pf-interop-"));
  cfg = loadConfig({ NODE_ENV: "test", PF_MONGO_URL: mongo.getUri(), PF_MONGO_DB: "pf_interop", PF_JWT_SECRET: SECRET, PF_HMAC_SECRET: SECRET, PF_FILE_URL_SECRET: SECRET, PF_CAPTURES_DIR: capturesDir, PF_GROUP_QUIET_MS: "200", PF_LOGIN_RATE_MAX: "1000" });
  database = await connectDb(cfg);
  app = await buildApp(cfg, database);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  for (const [username, role] of [["op", "operator"], ["juri", "judge"], ["adm", "admin"]] as const) {
    await database.col.users.insertOne({ _id: new ObjectId(), username, name: username, role, passwordHash: await hashPassword("rahasia-panjang"), disabled: false, createdAt: new Date() });
  }
});

after(async () => {
  await app?.close();
  await database?.client.close();
  await mongo?.stop();
  if (capturesDir) await rm(capturesDir, { recursive: true, force: true });
});

test("klien timing (photofinishCore.js): antre offline, frame bare, terima & verifikasi hasil", { skip }, async () => {
  const req = createRequire(CORE);
  const core = req(CORE);
  const timingIo = createRequire(path.join(TIMING_APP, "package.json"))("socket.io-client").io;
  const login = async (u: string) => (await http("POST", "/api/auth/login", undefined, { username: u, password: "rahasia-panjang" })).data.token as string;
  const [op, juri, adm] = [await login("op"), await login("juri"), await login("adm")];

  // Fake agent
  const agentToken = issueToken({ sub: "device:agent:i", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");
  const agent = connect(base, { auth: { token: agentToken }, transports: ["websocket"] });
  agent.on("agent:extract", async (r: any) => {
    const cols: string[] = [];
    for (let t = BigInt(r.fromHostNs); t <= BigInt(r.toHostNs); t += 4_166_667n) cols.push(t.toString());
    const dir = path.join(capturesDir, r.sessionId, r.groupId);
    await mkdir(dir, { recursive: true });
    const png = Buffer.from("png"), json = JSON.stringify({ columns: cols });
    await writeFile(path.join(dir, "cam-1-slit.png"), png);
    await writeFile(path.join(dir, "cam-1-columns.json"), json);
    await http("POST", "/api/captures", agentToken, { groupId: r.groupId, cameraId: r.cameraId, file: `${r.sessionId}/${r.groupId}/cam-1-slit.png`, columnsFile: `${r.sessionId}/${r.groupId}/cam-1-columns.json`, sha256: sha256Hex(png), columnsSha256: sha256Hex(json), fps: 240, width: cols.length, height: 10, fromAgentNs: cols[0], toAgentNs: cols.at(-1), agentOffsetNs: "0", agentRttNs: "1" });
  });
  await new Promise<void>((r) => agent.once("connect", () => r()));

  // Admin set jam PF, operator buka sesi H2H (cukup terhubung ke Event)
  await http("POST", "/api/clock/settings", adm, { action: "set-time", deviceTime: "10:00:00.000" });
  const { data: session } = await http("POST", "/api/sessions", op, { eventId: "E1", raceCategory: "H2H", label: "H2H", lanes: [{ lane: "A", teamId: "T-A", bib: "7" }] });
  await http("POST", `/api/sessions/${session._id}/arm`, op);

  // Klien timing — sinyal dikirim SEBELUM terhubung → harus antre di outbox
  const saved: Record<string, unknown> = {};
  const received: any[] = [];
  const statuses: any[] = [];
  const triggers: any[] = [];
  const timingToken = issueToken({ sub: "device:timing:i", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h");
  const client = core.createPhotofinishClient({
    apiUrl: base, deviceToken: timingToken, hmacSecret: SECRET, io: timingIo,
    storage: { load: (n: string) => saved[n] ?? null, save: (n: string, d: unknown) => { saved[n] = JSON.parse(JSON.stringify(d)); } },
    now: () => nowEpochNs().toString(),
    onVerified: (m: any) => received.push(m),
    onStatus: (s: any) => statuses.push(s),
    onTrigger: (m: any) => triggers.push(m),
  });

  // Frame bare RaceTime2 (formatted kosong), 20 byte di 1200 baud
  const latency = core.serialLatencyNs(20, 1200);
  assert.equal(latency, "166666666");
  const hostNs = (nowEpochNs() - BigInt(latency)).toString();
  client.sendImpulse({ channel: "FINISH", deviceTime: "", hostNs, serialLatencyNs: latency });
  assert.equal(client.status().outbox, 1);
  assert.equal((saved.outbox as unknown[]).length, 1, "outbox tersimpan ke disk");

  client.start();
  await until(() => client.status().connected && client.status().outbox === 0);
  const imp = await database.col.impulses.findOne({ sessionId: new ObjectId(session._id) });
  assert.ok(imp, "sinyal dari klien timing tersimpan");
  assert.equal(imp!.timeBasis, "pf-clock");
  assert.equal(imp!.serialLatencyNs, latency);
  assert.equal(imp!.hostNs, hostNs);

  // Juri menandai & konfirmasi → klien timing menerima hasil bertanda tangan
  await until(async () => (await database.col.captures.countDocuments()) === 1);
  const cap = (await http("GET", `/api/sessions/${session._id}`, op)).data.captures[0];
  const { data: crossing } = await http("POST", "/api/crossings", op, { captureId: cap._id, column: 5, rank: 1, lane: "A" });
  await http("POST", `/api/crossings/${crossing._id}/confirm`, juri, { teamId: "T-A", crewInBoat: 6, crewExpected: 6, upright: true });
  await until(() => received.length === 1);
  assert.equal(received[0].finishTime, imp!.deviceTime);
  assert.equal(received[0].eventId, "E1");
  assert.equal(received[0].bib, "7");
  assert.ok(core.verify(SECRET, received[0]));
  assert.equal(client.pending().length, 1);
  await until(async () => (await database.col.crossings.findOne({ _id: new ObjectId(crossing._id) }))!.deliveredRevision === 1);

  // View menerapkan → pending hilang
  client.markApplied(crossing._id, 1);
  assert.equal(client.pending().length, 0);
  assert.deepEqual(saved.pending, {});

  // Sesi berikutnya dibuat admin di Photo Finish (cukup Event, tanpa format)
  const { data: next } = await http("POST", "/api/sessions", op, { eventId: "E1", note: "R4 Putra" });
  await http("POST", `/api/sessions/${next._id}/arm`, op);
  assert.equal((await database.col.sessions.findOne({ _id: new ObjectId(session._id) }))!.armed, false, "hanya satu sesi aktif");
  assert.equal(typeof client.armHeat, "undefined", "fitur Kirim heat sudah dihapus dari klien timing");

  // Perahu lewat garis di kamera → timing menerima baris "Photo Finish" + waktu
  const res = await agent.emitWithAck("agent:trigger", { cameraId: "cam-1", bootId: crypto.randomUUID(), seq: 1, agentNs: nowEpochNs().toString(), agentOffsetNs: "0" });
  assert.equal(res.accepted, true);
  await until(() => triggers.length === 1);
  assert.equal(triggers[0].raceCategory, null);
  assert.match(triggers[0].time, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(triggers[0].eventId, "E1");

  client.stop();
  agent.close();
});

test("klien timing tersambung ulang sendiri setelah API ditutup lalu hidup lagi (Ctrl+C dev:local)", { skip }, async () => {
  const core = createRequire(CORE)(CORE);
  const timingIo = createRequire(path.join(TIMING_APP, "package.json"))("socket.io-client").io;
  const start = async (port = 0) => {
    const a = await buildApp(cfg, database);
    await a.listen({ host: "127.0.0.1", port });
    const addr = a.server.address();
    return { a, port: typeof addr === "object" && addr ? addr.port : 0 };
  };
  let { a: api1, port } = await start();
  const token = issueToken({ sub: "device:timing:r", name: "timing", role: "device", deviceKind: "timing" }, SECRET, "1h");
  const client = core.createPhotofinishClient({
    apiUrl: `http://127.0.0.1:${port}`, deviceToken: token, hmacSecret: SECRET, io: timingIo,
    storage: { load: () => null, save: () => {} }, now: () => nowEpochNs().toString(),
  });
  client.start();
  await until(() => client.status().connected);

  await api1.close(); // shutdown rapi → io.close() → "io server disconnect"
  await until(() => !client.status().connected);
  const { a: api2 } = await start(port);
  try {
    await until(() => client.status().connected, 15000);
  } finally {
    client.stop();
    await api2.close();
  }
});
