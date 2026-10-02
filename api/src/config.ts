import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PF_HOST: z.string().default("0.0.0.0"),
  PF_PORT: z.coerce.number().int().positive().default(4100),
  /** true bila API di belakang reverse proxy (Nginx di VPS) — IP asli dari X-Forwarded-For untuk batas login. */
  PF_TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  PF_MONGO_URL: z.string().default("mongodb://127.0.0.1:27017"),
  PF_MONGO_DB: z.string().default("sts_photofinish"),
  // Secret wajib panjang — tidak ada nilai default agar tidak pernah jalan
  // dengan secret contoh (pelajaran dari default "dev-secret" di racehub).
  PF_JWT_SECRET: z.string().min(32, "PF_JWT_SECRET minimal 32 karakter"),
  PF_HMAC_SECRET: z.string().min(32, "PF_HMAC_SECRET minimal 32 karakter"),
  PF_FILE_URL_SECRET: z.string().min(32, "PF_FILE_URL_SECRET minimal 32 karakter"),
  PF_CORS_ORIGINS: z.string().default("http://localhost:5173"),
  PF_CAPTURES_DIR: z.string().default(path.join(repoRoot, "data/captures")),
  /** Web app hasil `npm run build -w web`; disajikan API bila foldernya ada (mode production). */
  PF_WEB_DIR: z.string().default(path.join(repoRoot, "web/dist")),
  PF_USER_TOKEN_TTL: z.string().default("8h"),
  /** Batas percobaan login per IP per 5 menit (anti tebak password). */
  PF_LOGIN_RATE_MAX: z.coerce.number().int().positive().default(10),
  PF_DEVICE_TOKEN_TTL: z.string().default("30d"),
  // Aturan FAJI: akurasi 1/100 detik. Cara pembulatan dikonfirmasi ke Chief Judge.
  PF_OFFICIAL_ROUNDING: z.enum(["truncate", "round"]).default("truncate"),
  // Kelompok finish: sinyal dengan jarak <= GROUP_GAP digabung; ekstraksi
  // dikirim ke agent setelah GROUP_QUIET tanpa sinyal baru.
  PF_GROUP_GAP_MS: z.coerce.number().int().positive().default(3000),
  PF_GROUP_QUIET_MS: z.coerce.number().int().positive().default(2000),
  PF_CAPTURE_PRE_MS: z.coerce.number().int().nonnegative().default(1500),
  PF_CAPTURE_POST_MS: z.coerce.number().int().nonnegative().default(3000),
});

export type Config = z.infer<typeof Env> & { corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Konfigurasi .env tidak valid:\n${issues.join("\n")}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    corsOrigins: cfg.PF_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
