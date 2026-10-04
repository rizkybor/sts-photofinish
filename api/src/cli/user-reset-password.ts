// Pemakaian: npm run user:reset-password -w api -- <username>
// Password baru dibaca dari prompt (tidak lewat argumen agar tidak tersimpan di history shell).
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../auth.js";
import { loadConfig } from "../config.js";
import { connectDb } from "../db.js";

const [username] = process.argv.slice(2);
if (!username) {
  console.error("Pemakaian: user:reset-password <username>");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Password baru (min 10 karakter): ");
rl.close();
if (password.length < 10) {
  console.error("Password terlalu pendek.");
  process.exit(1);
}

const cfg = loadConfig();
const { client, col } = await connectDb(cfg);
try {
  const res = await col.users.updateOne(
    { username },
    { $set: { passwordHash: await hashPassword(password), disabled: false } },
  );
  if (res.matchedCount === 0) {
    console.error(`Pengguna "${username}" tidak ditemukan. Buat dengan user:create.`);
    process.exitCode = 1;
  } else {
    console.log(`Password "${username}" diganti (akun juga diaktifkan).`);
  }
} finally {
  await client.close();
}
