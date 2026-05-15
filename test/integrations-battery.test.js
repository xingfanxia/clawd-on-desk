// test/integrations-battery.test.js — pmset battery monitor.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createBatteryMonitor, parseBatteryOutput } = require("../src/integrations/battery");

test.describe("parseBatteryOutput", () => {
  test.it("parses 'Battery Power' source + percentage", () => {
    const out = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=12345)\t18%; discharging; 1:32 remaining present: true`;
    const r = parseBatteryOutput(out);
    assert.deepStrictEqual(r, { onBattery: true, pct: 18 });
  });
  test.it("parses 'AC Power' source", () => {
    const out = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=...)\t100%; charged; 0:00`;
    const r = parseBatteryOutput(out);
    assert.deepStrictEqual(r, { onBattery: false, pct: 100 });
  });
  test.it("returns null for empty / malformed", () => {
    assert.strictEqual(parseBatteryOutput(""), null);
    assert.strictEqual(parseBatteryOutput("garbage"), null);
    assert.strictEqual(parseBatteryOutput(null), null);
  });
});

test.describe("createBatteryMonitor", () => {
  test.it("non-mac → start is a no-op", async () => {
    const calls = [];
    const monitor = createBatteryMonitor({
      runFile: async () => { calls.push("runFile"); return { stdout: "" }; },
      log: () => {},
      isMac: false,
    });
    monitor.start({});
    assert.strictEqual(calls.length, 0);
  });

  test.it("fires on first poll when below threshold + on battery", async () => {
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: "Now drawing from 'Battery Power'\n -InternalBattery-0 18%; discharging" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].pct, 18);
    monitor.stop();
  });

  test.it("does NOT fire on AC power even below threshold", async () => {
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: "Now drawing from 'AC Power'\n -InternalBattery-0 10%; charging" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 0);
    monitor.stop();
  });

  test.it("does NOT re-fire repeatedly while staying below threshold", async () => {
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: "Now drawing from 'Battery Power'\n 15%; discharging" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    await monitor.__test.tick();
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1);
    monitor.stop();
  });

  test.it("re-arms after going on AC, fires again on next discharge", async () => {
    let stdoutValue = "Now drawing from 'Battery Power'\n 15%; discharging";
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: stdoutValue }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1);
    stdoutValue = "Now drawing from 'AC Power'\n 60%; charging";
    await monitor.__test.tick();
    stdoutValue = "Now drawing from 'Battery Power'\n 18%; discharging";
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 2);
    monitor.stop();
  });

  test.it("hysteresis: re-arms after pct rises >= threshold+5", async () => {
    let stdoutValue = "Now drawing from 'Battery Power'\n 18%; discharging";
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: stdoutValue }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1);
    // Bumped power (still on battery via some quick recharge edge case); pct=26
    // > threshold+5 should re-arm the latch.
    stdoutValue = "Now drawing from 'Battery Power'\n 26%; discharging";
    await monitor.__test.tick();
    stdoutValue = "Now drawing from 'Battery Power'\n 18%; discharging";
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 2);
    monitor.stop();
  });

  test.it("stop({ keepLatch: true }) preserves firedSinceEnteringLow (review fix)", async () => {
    // Regression for review Issue 2: settings-driven reload caused
    // battery latch to reset, re-firing the nudge for a user already
    // at low battery.
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: "Now drawing from 'Battery Power'\n 15%; discharging" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1);

    // Simulate registry.reload() — stop({ keepLatch: true }) + start().
    monitor.stop({ keepLatch: true });
    assert.strictEqual(monitor.__test.getFiredSinceEnteringLow(), true,
      "latch preserved after stop({ keepLatch: true })");
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1, "no re-fire after reload at same low battery");

    monitor.stop();
  });

  test.it("stop() (no args) resets latch — full teardown path", async () => {
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: "Now drawing from 'Battery Power'\n 15%; discharging" }),
      log: () => {},
      isMac: true,
    });
    monitor.start({ lowThresholdPct: 20 });
    await monitor.__test.tick();
    monitor.stop();
    assert.strictEqual(monitor.__test.getFiredSinceEnteringLow(), false,
      "latch reset by plain stop()");
    assert.strictEqual(monitor.__test.getLastOnBattery(), null,
      "lastOnBattery reset by plain stop()");
  });

  test.it("invalid threshold falls back to default (20%)", async () => {
    const monitor = createBatteryMonitor({
      runFile: async () => ({ stdout: "Now drawing from 'Battery Power'\n 19%; discharging" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    monitor.onBatteryLow((e) => fired.push(e));
    monitor.start({ lowThresholdPct: "twenty" });
    assert.strictEqual(monitor.__test.getLowThresholdPct(), 20);
    await monitor.__test.tick();
    assert.strictEqual(fired.length, 1);
    monitor.stop();
  });
});
