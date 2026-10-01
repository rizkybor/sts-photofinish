// Pemakaian: npm run user:create -w api -- <username> <role> "<Nama Lengkap>"
// Password dibaca dari prompt (tidak lewat argumen agar tidak tersimpan di history shell).
import { createInterface } from "node:readline/promises";
import { ObjectId } from "mongodb";
import { hashPassword } from "../auth.js";
import { loadConfig } from "../config.js";
import { connectDb } from "../db.js";

const ROLES = ["admin", "judge", "operator", "viewer"] as const;
const [username, role, name] = process.argv.slice(2);
if (!username || !role || !ROLES.includes(role as (typeof ROLES)[number])) {
  console.error(`Pemakaian: user:create <username> <${ROLES.join("|")}> "<Nama>"`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Password (min 10 karakter): ");
rl.close();
if (password.length < 10) {
  console.error("Password terlalu pendek.");
  process.exit(1);
}

const cfg = loadConfig();
const { client, col } = await connectDb(cfg);
try {
  await col.users.insertOne({
    _id: new ObjectId(), username, name: name ?? username, role: role as (typeof ROLES)[number],
    passwordHash: await hashPassword(password), disabled: false, createdAt: new Date(),
  });
  console.log(`Pengguna "${username}" (${role}) dibuat.`);
} finally {
  await client.close();
}
