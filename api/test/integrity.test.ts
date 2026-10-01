import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAuditHash, findBrokenLink, GENESIS_HASH } from "../src/audit.js";
import { canonicalJson, signPayload, verifyPayload } from "../src/canonical.js";
import { resolveCapturePath, signFileUrl, verifyFileUrl } from "../src/files.js";

const SECRET = "x".repeat(32);

test("canonicalJson tidak bergantung urutan kunci", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2n, c: undefined } }), canonicalJson({ a: { d: "2" }, b: 1 }));
});

test("HMAC: payload asli lolos, payload diubah ditolak", () => {
  const msg = signPayload({ type: "timing:impulse", seq: 7, deviceTime: "10:00:00.123" }, SECRET);
  assert.ok(verifyPayload(msg, SECRET));
  assert.ok(!verifyPayload({ ...msg, deviceTime: "10:00:00.100" }, SECRET));
  assert.ok(!verifyPayload(msg, "y".repeat(32)));
  assert.ok(!verifyPayload({ ...msg, sig: "zz" }, SECRET));
});

test("rantai audit mendeteksi perubahan", () => {
  const entries = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 1; seq <= 3; seq++) {
    const fields = { seq, at: new Date(0), userId: "u", action: "crossing.confirm", entity: "crossing", entityId: `c${seq}`, before: null, after: { t: seq }, reason: null, prevHash };
    const hash = computeAuditHash(fields);
    entries.push({ ...fields, hash });
    prevHash = hash;
  }
  assert.equal(findBrokenLink(entries), null);
  entries[1] = { ...entries[1]!, after: { t: 99 } };
  assert.equal(findBrokenLink(entries), 2);
});

test("URL file bertanda tangan & penolakan path traversal", () => {
  const url = new URL(signFileUrl(SECRET, "s1/g1/slit.png", 1000), "http://x");
  const [exp, sig] = [url.searchParams.get("exp")!, url.searchParams.get("sig")!];
  assert.ok(verifyFileUrl(SECRET, "s1/g1/slit.png", exp, sig, 1000));
  assert.ok(!verifyFileUrl(SECRET, "s1/g1/other.png", exp, sig, 1000));
  assert.ok(!verifyFileUrl(SECRET, "s1/g1/slit.png", exp, sig, 1000 + 3600));
  assert.throws(() => resolveCapturePath("/data/captures", "../secret"));
  assert.throws(() => resolveCapturePath("/data/captures", "/etc/passwd"));
  assert.equal(resolveCapturePath("/data/captures", "a/b.png"), "/data/captures/a/b.png");
});
