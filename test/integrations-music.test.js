// test/integrations-music.test.js — Apple Music BPM detector.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createMusicDetector, parseNowPlaying } = require("../src/integrations/music");

test.describe("parseNowPlaying", () => {
  test.it("returns null for empty / non-string", () => {
    assert.strictEqual(parseNowPlaying(""), null);
    assert.strictEqual(parseNowPlaying(null), null);
    assert.strictEqual(parseNowPlaying(42), null);
  });
  test.it("returns null when fewer than 3 tab-separated fields", () => {
    assert.strictEqual(parseNowPlaying("Just a name"), null);
    assert.strictEqual(parseNowPlaying("Name\tArtist"), null);
  });
  test.it("returns null when BPM is 0 (missing metadata)", () => {
    assert.strictEqual(parseNowPlaying("Song\tArtist\t0"), null);
  });
  test.it("parses tab-delimited triplet", () => {
    const parsed = parseNowPlaying("Drumroll\tPretty Lights\t132\n");
    assert.deepStrictEqual(parsed, { name: "Drumroll", artist: "Pretty Lights", bpm: 132 });
  });
});

test.describe("createMusicDetector", () => {
  test.it("non-mac → start is a no-op (no timer, no listener calls)", () => {
    const calls = [];
    const detector = createMusicDetector({
      runFile: async () => { calls.push("runFile"); return { stdout: "" }; },
      log: () => {},
      isMac: false,
    });
    detector.start({});
    assert.strictEqual(calls.length, 0);
  });

  test.it("fires on first poll when BPM exceeds threshold", async () => {
    let stdoutValue = "FastSong\tArtist\t130";
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: stdoutValue }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].name, "FastSong");
    assert.strictEqual(fired[0].bpm, 130);
    detector.stop();
  });

  test.it("does NOT re-fire on the same track if BPM stays above threshold", async () => {
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: "Same\tArt\t130" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    await detector.__test.tick();
    await detector.__test.tick();
    assert.strictEqual(fired.length, 1);
    detector.stop();
  });

  test.it("re-fires when track changes", async () => {
    let stdoutValue = "First\tA\t130";
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: stdoutValue }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    stdoutValue = "Second\tA\t140";
    await detector.__test.tick();
    assert.strictEqual(fired.length, 2);
    detector.stop();
  });

  test.it("never fires when BPM stays below threshold", async () => {
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: "Chill\tArt\t80" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    await detector.__test.tick();
    assert.strictEqual(fired.length, 0);
    detector.stop();
  });

  test.it("stop() clears state so subsequent start() is fresh", async () => {
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: "Same\tA\t130" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    detector.stop();
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    assert.strictEqual(fired.length, 2);
    detector.stop();
  });

  test.it("unsubscribe stops further events for that listener", async () => {
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: "Same\tA\t130" }),
      log: () => {},
      isMac: true,
    });
    const fired = [];
    const off = detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    off();
    detector.stop();
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    assert.strictEqual(fired.length, 1);
    detector.stop();
  });

  test.it("a thrown listener does not stop other listeners from firing", async () => {
    const detector = createMusicDetector({
      runFile: async () => ({ stdout: "X\tY\t130" }),
      log: () => {},
      isMac: true,
    });
    detector.onBpmChange(() => { throw new Error("boom"); });
    const fired = [];
    detector.onBpmChange((e) => fired.push(e));
    detector.start({ bpmThreshold: 120 });
    await detector.__test.tick();
    assert.strictEqual(fired.length, 1);
    detector.stop();
  });
});
