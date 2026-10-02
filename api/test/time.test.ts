import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceToAgentNs, diffDayNs, formatClock, frameToDeviceNs, NS_PER_DAY, NS_PER_MS, NS_PER_SEC, officialClock, parseClock,
} from "../src/time.js";

test("parseClock/formatClock bolak-balik format RaceTime2", () => {
  const ns = parseClock("10:42:13.482");
  assert.equal(ns, ((10n * 60n + 42n) * 60n + 13n) * NS_PER_SEC + 482n * NS_PER_MS);
  assert.equal(formatClock(ns), "10:42:13.482");
  assert.throws(() => parseClock("24:00:00.000"));
  assert.throws(() => parseClock("10:42"));
});

test("waktu resmi dalam milidetik (HH:MM:SS.mmm): truncate vs round di bawah 1 ms", () => {
  assert.equal(officialClock(parseClock("04:52:55.976"), "truncate"), "04:52:55.976");
  const ns = parseClock("10:42:13.487") + 700_000n; // 13,4877 dtk
  assert.equal(officialClock(ns, "truncate"), "10:42:13.487");
  assert.equal(officialClock(ns, "round"), "10:42:13.488");
  assert.equal(officialClock(parseClock("23:59:59.999") + 600_000n, "round"), "00:00:00.000");
});

test("diffDayNs memilih jalur terpendek melewati tengah malam", () => {
  assert.equal(diffDayNs(parseClock("00:00:01"), parseClock("23:59:59")), 2n * NS_PER_SEC);
  assert.equal(diffDayNs(parseClock("23:59:59"), parseClock("00:00:01")), -2n * NS_PER_SEC);
});

test("frame kamera → waktu perangkat dan sebaliknya konsisten", () => {
  const dayStart = 1_790_000_000n * NS_PER_SEC - ((1_790_000_000n * NS_PER_SEC) % NS_PER_DAY);
  const device = parseClock("10:42:13.482");
  const deviceOffsetNs = dayStart + 250n * NS_PER_MS; // host = device + 250 ms (delay serial)
  const agentOffsetNs = -3n * NS_PER_MS; // jam agent 3 ms lebih cepat dari host
  const agentNs = deviceToAgentNs(device, { deviceOffsetNs, agentOffsetNs }, dayStart + device);
  assert.equal(frameToDeviceNs(agentNs, { deviceOffsetNs, agentOffsetNs, calibrationOffsetNs: 0n }), device);
  assert.equal(
    frameToDeviceNs(agentNs, { deviceOffsetNs, agentOffsetNs, calibrationOffsetNs: 7n * NS_PER_MS }),
    device + 7n * NS_PER_MS,
  );
});
