// Pemakaian: npm run token:device -w api -- <timing|agent> <nama-perangkat>
// Token dicetak sekali; simpan di .env perangkat terkait (PF_DEVICE_TOKEN).
import { randomUUID } from "node:crypto";
import { issueToken } from "../auth.js";
import { loadConfig } from "../config.js";

const [kind, name] = process.argv.slice(2);
if ((kind !== "timing" && kind !== "agent") || !name) {
  console.error("Pemakaian: token:device <timing|agent> <nama-perangkat>");
  process.exit(1);
}
const cfg = loadConfig();
const token = issueToken({ sub: `device:${kind}:${randomUUID()}`, name, role: "device", deviceKind: kind }, cfg.PF_JWT_SECRET, cfg.PF_DEVICE_TOKEN_TTL);
console.log(token);
