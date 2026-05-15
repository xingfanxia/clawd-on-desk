// test/integrations-index.test.js — PAWPAL-3 registry lifecycle.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

// Stub all 3 sub-detectors. We'll spy on start/stop calls.
function makeStubDetector(name) {
  const calls = [];
  return {
    start: (cfg) => calls.push(["start", cfg]),
    stop: () => calls.push(["stop"]),
    __spyCalls: calls,
    __name: name,
  };
}

// Patch require cache so createIntegrationsRegistry pulls our stubs.
const Module = require("module");
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

function withStubbedDetectors(stubs, fn) {
  const filenames = {
    music: require.resolve("../src/integrations/music"),
    battery: require.resolve("../src/integrations/battery"),
    "system-events": require.resolve("../src/integrations/system-events"),
  };
  const origCache = {
    music: require.cache[filenames.music],
    battery: require.cache[filenames.battery],
    "system-events": require.cache[filenames["system-events"]],
  };
  require.cache[filenames.music] = {
    id: filenames.music,
    exports: { createMusicDetector: () => stubs.music },
  };
  require.cache[filenames.battery] = {
    id: filenames.battery,
    exports: { createBatteryMonitor: () => stubs.battery },
  };
  require.cache[filenames["system-events"]] = {
    id: filenames["system-events"],
    exports: { createSystemEventsBridge: () => stubs.systemEvents },
  };
  // Bust the index cache so it picks up the patched sub-modules.
  delete require.cache[require.resolve("../src/integrations/index")];
  try {
    return fn();
  } finally {
    require.cache[filenames.music] = origCache.music;
    require.cache[filenames.battery] = origCache.battery;
    require.cache[filenames["system-events"]] = origCache["system-events"];
    delete require.cache[require.resolve("../src/integrations/index")];
  }
}

test("integrations registry: throws on missing ctx", () => {
  const { createIntegrationsRegistry } = require("../src/integrations");
  assert.throws(() => createIntegrationsRegistry(null), /requires a ctx object/);
  assert.throws(() => createIntegrationsRegistry(undefined), /requires a ctx object/);
});

test("integrations registry: master off → no sub-detector starts", () => {
  const stubs = {
    music: makeStubDetector("music"),
    battery: makeStubDetector("battery"),
    systemEvents: makeStubDetector("systemEvents"),
  };
  withStubbedDetectors(stubs, () => {
    const { createIntegrationsRegistry } = require("../src/integrations");
    const reg = createIntegrationsRegistry({
      getPrefs: () => ({ integrations: { enabled: false, music: { enabled: true }, battery: { enabled: true }, systemEvents: { enabled: true } } }),
      log: () => {},
    });
    reg.start();
    assert.strictEqual(stubs.music.__spyCalls.length, 0);
    assert.strictEqual(stubs.battery.__spyCalls.length, 0);
    assert.strictEqual(stubs.systemEvents.__spyCalls.length, 0);
  });
});

test("integrations registry: master on + per-source gates honored", () => {
  const stubs = {
    music: makeStubDetector("music"),
    battery: makeStubDetector("battery"),
    systemEvents: makeStubDetector("systemEvents"),
  };
  withStubbedDetectors(stubs, () => {
    const { createIntegrationsRegistry } = require("../src/integrations");
    const reg = createIntegrationsRegistry({
      getPrefs: () => ({
        integrations: {
          enabled: true,
          music: { enabled: true, bpmThreshold: 140 },
          battery: { enabled: false },
          systemEvents: { enabled: true, screenLock: true },
        },
      }),
      log: () => {},
    });
    reg.start();
    assert.deepStrictEqual(stubs.music.__spyCalls, [["start", { enabled: true, bpmThreshold: 140 }]]);
    assert.strictEqual(stubs.battery.__spyCalls.length, 0);
    assert.deepStrictEqual(stubs.systemEvents.__spyCalls, [["start", { enabled: true, screenLock: true }]]);
  });
});

test("integrations registry: start() is idempotent", () => {
  const stubs = {
    music: makeStubDetector("music"),
    battery: makeStubDetector("battery"),
    systemEvents: makeStubDetector("systemEvents"),
  };
  withStubbedDetectors(stubs, () => {
    const { createIntegrationsRegistry } = require("../src/integrations");
    const reg = createIntegrationsRegistry({
      getPrefs: () => ({ integrations: { enabled: true, music: { enabled: true } } }),
      log: () => {},
    });
    reg.start();
    reg.start();
    reg.start();
    assert.strictEqual(stubs.music.__spyCalls.filter((c) => c[0] === "start").length, 1);
  });
});

test("integrations registry: stop() tears down in reverse order", () => {
  const callOrder = [];
  const stubs = {
    music: { start: () => {}, stop: () => callOrder.push("music") },
    battery: { start: () => {}, stop: () => callOrder.push("battery") },
    systemEvents: { start: () => {}, stop: () => callOrder.push("systemEvents") },
  };
  withStubbedDetectors(stubs, () => {
    const { createIntegrationsRegistry } = require("../src/integrations");
    const reg = createIntegrationsRegistry({
      getPrefs: () => ({
        integrations: {
          enabled: true,
          music: { enabled: true },
          battery: { enabled: true },
          systemEvents: { enabled: true },
        },
      }),
      log: () => {},
    });
    reg.start();
    reg.stop();
    assert.deepStrictEqual(callOrder, ["systemEvents", "battery", "music"]);
  });
});

test("integrations registry: a failing sub-detector start() does not block others", () => {
  const stubs = {
    music: { start: () => { throw new Error("boom"); }, stop: () => {} },
    battery: makeStubDetector("battery"),
    systemEvents: makeStubDetector("systemEvents"),
  };
  let lastError = null;
  withStubbedDetectors(stubs, () => {
    const { createIntegrationsRegistry } = require("../src/integrations");
    const reg = createIntegrationsRegistry({
      getPrefs: () => ({
        integrations: {
          enabled: true,
          music: { enabled: true },
          battery: { enabled: true },
          systemEvents: { enabled: true },
        },
      }),
      log: (level, msg, err) => { if (level === "error") lastError = err; },
    });
    reg.start();
    assert.ok(lastError && lastError.message === "boom");
    assert.strictEqual(stubs.battery.__spyCalls.length, 1);
    assert.strictEqual(stubs.systemEvents.__spyCalls.length, 1);
  });
});

test("integrations registry: reload() = stop + start", () => {
  const stubs = {
    music: makeStubDetector("music"),
    battery: makeStubDetector("battery"),
    systemEvents: makeStubDetector("systemEvents"),
  };
  withStubbedDetectors(stubs, () => {
    const { createIntegrationsRegistry } = require("../src/integrations");
    const reg = createIntegrationsRegistry({
      getPrefs: () => ({ integrations: { enabled: true, music: { enabled: true } } }),
      log: () => {},
    });
    reg.start();
    reg.reload();
    const starts = stubs.music.__spyCalls.filter((c) => c[0] === "start").length;
    const stops = stubs.music.__spyCalls.filter((c) => c[0] === "stop").length;
    assert.strictEqual(starts, 2);
    assert.strictEqual(stops, 1);
  });
});
