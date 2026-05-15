// test/integrations-system-events.test.js — Electron powerMonitor bridge.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createSystemEventsBridge } = require("../src/integrations/system-events");

function makePowerMonitorStub() {
  const handlers = new Map();
  return {
    on: (ev, cb) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
    },
    off: (ev, cb) => {
      const arr = handlers.get(ev) || [];
      handlers.set(ev, arr.filter((h) => h !== cb));
    },
    fire: (ev) => {
      const arr = handlers.get(ev) || [];
      for (const cb of arr) cb();
    },
    __handlers: handlers,
  };
}

test("system-events: start subscribes to lock/unlock when screenLock toggle is true", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: true });
  assert.strictEqual(pm.__handlers.get("lock-screen").length, 1);
  assert.strictEqual(pm.__handlers.get("unlock-screen").length, 1);
  assert.strictEqual(pm.__handlers.get("suspend").length, 1);
  assert.strictEqual(pm.__handlers.get("resume").length, 1);
});

test("system-events: no lock subscription when screenLock toggle is false", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: false });
  assert.strictEqual(pm.__handlers.has("lock-screen"), false);
});

test("system-events: lock event fans out to all lock listeners", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: true });
  const events = [];
  bridge.onScreenLock((e) => events.push(e));
  pm.fire("lock-screen");
  pm.fire("suspend");
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].source, "lock-screen");
  assert.strictEqual(events[1].source, "suspend");
});

test("system-events: unlock event paired with lock subscription", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: true });
  const events = [];
  bridge.onScreenUnlock((e) => events.push(e));
  pm.fire("unlock-screen");
  pm.fire("resume");
  assert.strictEqual(events.length, 2);
});

test("system-events: AC change events fire when dockConnect=true", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ dockConnect: true });
  const acEvents = [];
  bridge.onAcChange((e) => acEvents.push(e));
  pm.fire("on-ac");
  pm.fire("on-battery");
  assert.strictEqual(acEvents.length, 2);
  assert.strictEqual(acEvents[0].onAc, true);
  assert.strictEqual(acEvents[1].onAc, false);
});

test("system-events: stop() unsubscribes everything (idempotent)", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: true, dockConnect: true });
  bridge.stop();
  assert.strictEqual(pm.__handlers.get("lock-screen").length, 0);
  assert.strictEqual(pm.__handlers.get("on-ac").length, 0);
  bridge.stop();
});

test("system-events: missing powerMonitor → silent no-op", () => {
  const bridge = createSystemEventsBridge({ powerMonitor: null, log: () => {} });
  // Should not throw.
  bridge.start({ screenLock: true });
  bridge.stop();
});

test("system-events: a throwing listener does not block other listeners", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: true });
  bridge.onScreenLock(() => { throw new Error("boom"); });
  const events = [];
  bridge.onScreenLock((e) => events.push(e));
  pm.fire("lock-screen");
  assert.strictEqual(events.length, 1);
});

test("system-events: start() is idempotent — no double subscriptions", () => {
  const pm = makePowerMonitorStub();
  const bridge = createSystemEventsBridge({ powerMonitor: pm, log: () => {} });
  bridge.start({ screenLock: true });
  bridge.start({ screenLock: true });
  assert.strictEqual(pm.__handlers.get("lock-screen").length, 1);
});
