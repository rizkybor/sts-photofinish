import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * JSON kanonik: kunci objek diurutkan, bigint → string, Date → ISO,
 * ObjectId → hex, nilai undefined dibuang. Dipakai untuk HMAC dan rantai
 * hash audit — dua pihak harus menghasilkan string yang byte-per-byte sama.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const maybeId = value as { toHexString?: () => string };
    if (typeof maybeId.toHexString === "function") return maybeId.toHexString();
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256 atas JSON kanonik payload, tanpa field `sig`. */
export function signPayload<T extends object>(payload: T, secret: string): T & { sig: string } {
  const { sig: _ignored, ...rest } = payload as T & { sig?: string };
  const sig = createHmac("sha256", secret).update(canonicalJson(rest)).digest("hex");
  return { ...(rest as T), sig };
}

export function verifyPayload(payload: object, secret: string): boolean {
  const { sig, ...rest } = payload as { sig?: unknown };
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = createHmac("sha256", secret).update(canonicalJson(rest)).digest();
  return timingSafeEqual(expected, Buffer.from(sig, "hex"));
}
