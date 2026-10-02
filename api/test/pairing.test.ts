import assert from "node:assert/strict";
import { test } from "node:test";
import { findTies, pairByOrder } from "../src/pairing.js";
import { NS_PER_MS, parseClock } from "../src/time.js";

const t = (s: string) => parseClock(s);

test("H2H: urutan ke-n dipasangkan dengan sinyal ke-n (urut waktu)", () => {
  const { results, groupWarnings } = pairByOrder(
    [{ id: "B", rank: 2, cameraTimeNs: t("10:00:00.310") }, { id: "A", rank: 1, cameraTimeNs: t("10:00:00.002") }],
    [{ id: "i2", deviceTimeNs: t("10:00:00.300") }, { id: "i1", deviceTimeNs: t("10:00:00.000") }],
  );
  assert.deepEqual(groupWarnings, []);
  assert.deepEqual(results.map((r) => [r.crossingId, r.impulseId, r.timeSource]), [["A", "i1", "impulse"], ["B", "i2", "impulse"]]);
  assert.ok(results.every((r) => r.warnings.length === 0));
});

test("photocell terhalang: perahu tanpa sinyal memakai waktu kamera", () => {
  const { results } = pairByOrder(
    [{ id: "A", rank: 1, cameraTimeNs: t("10:00:00.000") }, { id: "B", rank: 2, cameraTimeNs: t("10:00:00.040") }],
    [{ id: "i1", deviceTimeNs: t("10:00:00.001") }],
  );
  assert.equal(results[1]!.timeSource, "camera");
  assert.equal(results[1]!.timeNs, t("10:00:00.040"));
  assert.match(results[1]!.warnings[0]!, /waktu kamera/);
});

test("tanpa sinyal dan jam belum sinkron: waktu harus manual", () => {
  const { results } = pairByOrder([{ id: "A", rank: 1, cameraTimeNs: null }], []);
  assert.equal(results[0]!.timeSource, null);
  assert.equal(results[0]!.timeNs, null);
});

test("peringatan: urutan bertentangan dengan gambar, selisih besar, sinyal berlebih", () => {
  const { results, groupWarnings } = pairByOrder(
    [{ id: "A", rank: 1, cameraTimeNs: t("10:00:01.000") }, { id: "B", rank: 2, cameraTimeNs: t("10:00:00.500") }],
    [{ id: "i1", deviceTimeNs: t("10:00:00.000") }, { id: "i2", deviceTimeNs: t("10:00:00.400") }, { id: "i3", deviceTimeNs: t("10:00:00.900") }],
  );
  assert.match(groupWarnings[0]!, /Sinyal \(3\) lebih banyak/);
  assert.match(results[0]!.warnings[0]!, /Selisih waktu sinyal vs kamera -1000 ms/);
  assert.ok(results[1]!.warnings.some((w) => w.includes("lebih dulu")));
  void NS_PER_MS;
});

test("seri dalam 1/100 ditandai, bukan diputuskan", () => {
  assert.deepEqual(
    findTies([
      { crossingId: "A", officialTime: "10:00:00.121" },
      { crossingId: "B", officialTime: "10:00:00.128" }, // beda 7 ms, tetap seri dalam 1/100
      { crossingId: "C", officialTime: "10:00:00.130" },
    ]),
    [["A", "B"]],
  );
});
