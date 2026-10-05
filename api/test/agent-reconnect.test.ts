// Agent kamera menyambung ulang lewat internet (Render/VPS): koneksi lama sering
// belum terdeteksi putus di balik proxy. Agent yang sama — atau koneksi lama yang
// sudah diam — harus diambil alih, sedangkan agent KEDUA yang masih hidup ditolak.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as connect, type Socket } from "socket.io-client";
import { buildApp } from "../src/app.js";
import { issueToken } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { connectDb, type Database } from "../src/db.js";

const SECRET = "s".repeat(40);
let mongo: MongoMemoryServer;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let capturesDir: string;
const sockets: Socket[] = [];
const token = issueToken({ sub: "device:agent:1", name: "agent", role: "device", deviceKind: "agent" }, SECRET, "1h");

before(async () => {
  mongo = await MongoMemoryServer.create();
  capturesDir = await mkdtemp(path.join(tmpdir(), "pf-reconnect-"));
  const cfg = loadConfig({
    NODE_ENV: "test", PF_PORT: "1", PF_MONGO_URL: mongo.getUri(), PF_MONGO_DB: "pf_reconnect",
    PF_JWT_SECRET: SECRET, PF_HMAC_SECRET: SECRET, PF_FILE_URL_SECRET: SECRET, PF_CAPTURES_DIR: capturesDir,
  });
  database = await connectDb(cfg);
  app = await buildApp(cfg, database);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  for (const s of sockets) s.close();
  await app?.close();
  await database?.client.close();
  await mongo?.stop();
  await rm(capturesDir, { recursive: true, force: true });
});

/** Agent palsu; `rejected` terisi bila API menolaknya sebagai agent ganda. */
async function agent(cameraId: string, bootId: string) {
  const s = connect(base, { auth: { token, cameraId, bootId }, transports: ["websocket"], reconnection: false });
  sockets.push(s);
  const state = { socket: s, rejected: null as string | null, disconnected: false };
  s.on("agent:rejected", (d: { error: string }) => (state.rejected = d.error));
  s.on("disconnect", () => (state.disconnected = true));
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", reject);
  });
  await new Promise((r) => setTimeout(r, 400)); // beri waktu API memutuskan terima/tolak
  return state;
}

test("agent kedua yang masih hidup untuk kamera yang sama ditolak", async () => {
  const first = await agent("cam-a", "boot-1");
  const second = await agent("cam-a", "boot-2");
  assert.match(second.rejected ?? "", /sudah dipakai agent lain/);
  assert.equal(first.disconnected, false);
});

test("agent yang sama menyambung ulang mengambil alih koneksi lama", async () => {
  const old = await agent("cam-b", "boot-x");
  const again = await agent("cam-b", "boot-x"); // koneksi lama belum terdeteksi putus
  assert.equal(again.rejected, null);
  assert.equal(old.disconnected, true);
  assert.equal(again.disconnected, false);
});

test("koneksi lama yang sudah diam diambil alih agent baru (mis. setelah restart)", async () => {
  const old = await agent("cam-c", "boot-lama");
  await new Promise((r) => setTimeout(r, 6500)); // tanpa pesan > STALE_AGENT_MS
  const fresh = await agent("cam-c", "boot-baru");
  assert.equal(fresh.rejected, null);
  assert.equal(old.disconnected, true);
});
