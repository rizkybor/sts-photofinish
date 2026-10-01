// Audit log append-only berantai hash. Rekaman photo finish bisa menjadi
// barang bukti protes (Peraturan FAJI), jadi setiap perubahan hasil harus
// bisa ditelusuri dan perubahan diam-diam di database harus terdeteksi.

import { canonicalJson, sha256Hex } from "./canonical.js";
import type { AuditDoc, Collections } from "./db.js";

export const GENESIS_HASH = "0".repeat(64);

export type AuditInput = Pick<AuditDoc, "userId" | "action" | "entity" | "entityId" | "before" | "after"> & {
  reason?: string | null;
};

type HashedFields = Omit<AuditDoc, "_id" | "hash">;

export function computeAuditHash(entry: HashedFields): string {
  return sha256Hex(entry.prevHash + canonicalJson(entry));
}

/** Memeriksa rantai; mengembalikan seq pertama yang rusak, atau null bila utuh. */
export function findBrokenLink(entries: Array<Omit<AuditDoc, "_id">>): number | null {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    const { hash, ...fields } = e;
    if (e.seq !== expectedSeq || e.prevHash !== prevHash || computeAuditHash(fields) !== hash) return e.seq;
    prevHash = hash;
    expectedSeq++;
  }
  return null;
}

export function createAuditLog(col: Collections["audit"]) {
  // Satu API per lokasi lomba: penulisan diserialkan di proses ini. Indeks
  // unik pada `seq` menjaga rantai bila ada proses kedua yang tak sengaja jalan.
  let queue: Promise<unknown> = Promise.resolve();

  function append(input: AuditInput): Promise<AuditDoc> {
    const run = async () => {
      const last = await col.find().sort({ seq: -1 }).limit(1).next();
      const fields: HashedFields = {
        seq: (last?.seq ?? 0) + 1,
        at: new Date(),
        userId: input.userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        // Disimpan dalam bentuk kanonik agar hash bisa dihitung ulang persis.
        before: JSON.parse(canonicalJson(input.before)),
        after: JSON.parse(canonicalJson(input.after)),
        reason: input.reason ?? null,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const doc = { ...fields, hash: computeAuditHash(fields) };
      const res = await col.insertOne(doc as AuditDoc);
      return { ...doc, _id: res.insertedId } as AuditDoc;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  async function verify(): Promise<{ ok: boolean; entries: number; brokenAtSeq: number | null }> {
    const entries = await col.find({}, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray();
    const broken = findBrokenLink(entries);
    return { ok: broken === null, entries: entries.length, brokenAtSeq: broken };
  }

  return { append, verify };
}

export type AuditLog = ReturnType<typeof createAuditLog>;
