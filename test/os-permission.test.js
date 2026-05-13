"use strict";

// PAWPAL-2 Task 3 — os-permission.js unit tests.
//
// We verify:
//   1. Linux + Windows always return "granted" (no OS gate to query).
//   2. macOS path uses the injected subprocess stub — granted (success), denied
//      (osascript "not authorized" stderr), and unknown-then-granted lifecycle.
//   3. promptGrant resolves immediately to "granted" on non-macOS.
//   4. Kind whitelist rejects garbage (XSS-style payloads, prototype keys,
//      arbitrary strings) before any URL construction or shell.openExternal
//      call happens.
//   5. SYSTEM_SETTINGS_URLS only contains x-apple.systempreferences: URLs
//      pointing at the security pane.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");

const {
  createOsPermission,
  KINDS,
  SYSTEM_SETTINGS_URLS,
  __test,
} = require("../src/os-permission");

// Tiny stub builders. The subprocess stub mimics the node:child_process callback
// shape: cb(err, stdout, stderr). Never spawns a real process.
function makeRunStub(handler) {
  return function stubRun(_cmd, _args, _opts, cb) {
    handler(cb);
  };
}

function makeShellStub() {
  const calls = [];
  return {
    calls,
    openExternal: async (url) => { calls.push(url); },
  };
}

describe("os-permission: cross-platform isGranted", () => {
  it("returns 'granted' synchronously on Linux", () => {
    const osPerm = createOsPermission({ platform: "linux" });
    assert.strictEqual(osPerm.isGranted("accessibility"), "granted");
    assert.strictEqual(osPerm.isGranted("inputMonitoring"), "granted");
  });

  it("returns 'granted' synchronously on Windows", () => {
    const osPerm = createOsPermission({ platform: "win32" });
    assert.strictEqual(osPerm.isGranted("accessibility"), "granted");
    assert.strictEqual(osPerm.isGranted("inputMonitoring"), "granted");
  });

  it("starts as 'unknown' on macOS until refresh runs", () => {
    const osPerm = createOsPermission({
      platform: "darwin",
      execFile: makeRunStub(() => {}), // never invoke cb — keep cache pristine
    });
    assert.strictEqual(osPerm.isGranted("accessibility"), "unknown");
    assert.strictEqual(osPerm.isGranted("inputMonitoring"), "unknown");
  });
});

describe("os-permission: cross-platform promptGrant", () => {
  it("resolves to 'granted' on Linux without touching shell", async () => {
    const shell = makeShellStub();
    const osPerm = createOsPermission({ platform: "linux", shell });
    const result = await osPerm.promptGrant("accessibility");
    assert.strictEqual(result, "granted");
    assert.deepStrictEqual(shell.calls, []);
  });

  it("resolves to 'granted' on Windows without touching shell", async () => {
    const shell = makeShellStub();
    const osPerm = createOsPermission({ platform: "win32", shell });
    const result = await osPerm.promptGrant("inputMonitoring");
    assert.strictEqual(result, "granted");
    assert.deepStrictEqual(shell.calls, []);
  });
});

describe("os-permission: macOS Accessibility osascript probe", () => {
  it("resolves 'granted' when osascript returns the frontmost app name", async () => {
    const run = makeRunStub((cb) => cb(null, "Finder\n", ""));
    const osPerm = createOsPermission({ platform: "darwin", execFile: run });
    const result = await osPerm.refresh("accessibility");
    assert.strictEqual(result, "granted");
    assert.strictEqual(osPerm.isGranted("accessibility"), "granted");
  });

  it("resolves 'denied' when osascript errors with 'not authorized'", async () => {
    const err = new Error("osascript: not authorized to send Apple events");
    const run = makeRunStub((cb) =>
      cb(err, "", "execution error: System Events got an error: clawd is not allowed assistive access. (-1719)\n"),
    );
    const osPerm = createOsPermission({ platform: "darwin", execFile: run });
    const result = await osPerm.refresh("accessibility");
    assert.strictEqual(result, "denied");
    assert.strictEqual(osPerm.isGranted("accessibility"), "denied");
  });

  it("resolves 'denied' on osascript timeout (covers the silent-failure case)", async () => {
    const err = Object.assign(new Error("Command timed out"), { killed: true, code: null, signal: "SIGTERM" });
    const run = makeRunStub((cb) => cb(err, "", ""));
    const osPerm = createOsPermission({ platform: "darwin", execFile: run });
    const result = await osPerm.refresh("accessibility");
    assert.strictEqual(result, "denied");
  });

  it("inputMonitoring stays 'unknown' on macOS in v1 (Task 5 will fill in)", async () => {
    const run = makeRunStub((cb) => cb(null, "", ""));
    const osPerm = createOsPermission({ platform: "darwin", execFile: run });
    const result = await osPerm.refresh("inputMonitoring");
    assert.strictEqual(result, "unknown");
  });

  it("transitions 'unknown' → 'granted' → 'denied' and notifies subscribers", async () => {
    let nextResult = { err: null, stdout: "Cursor\n", stderr: "" };
    const run = makeRunStub((cb) => cb(nextResult.err, nextResult.stdout, nextResult.stderr));
    const osPerm = createOsPermission({ platform: "darwin", execFile: run });

    const seen = [];
    const unsubscribe = osPerm.subscribe("accessibility", (state) => seen.push(state));

    // Initial unknown — cache is "unknown" before any refresh resolves.
    assert.strictEqual(osPerm.isGranted("accessibility"), "unknown");

    // First refresh: granted.
    await osPerm.refresh("accessibility");
    assert.strictEqual(osPerm.isGranted("accessibility"), "granted");

    // Second refresh: denied.
    const deniedErr = new Error("not authorized");
    nextResult = { err: deniedErr, stdout: "", stderr: "not authorized" };
    await osPerm.refresh("accessibility");
    assert.strictEqual(osPerm.isGranted("accessibility"), "denied");

    // Subscriber should have observed at least the granted and denied
    // transitions (plus possibly the initial-refresh granted on subscribe).
    assert.ok(seen.includes("granted"), `expected 'granted' in transitions, got ${JSON.stringify(seen)}`);
    assert.ok(seen.includes("denied"), `expected 'denied' in transitions, got ${JSON.stringify(seen)}`);

    unsubscribe();
    osPerm.dispose();
  });
});

describe("os-permission: kind whitelist", () => {
  it("isGranted returns 'denied' for hostile string (XSS payload)", () => {
    const osPerm = createOsPermission({ platform: "darwin" });
    const hostile = "<script>alert('xss')</script>";
    assert.strictEqual(osPerm.isGranted(hostile), "denied");
  });

  it("isGranted returns 'denied' for prototype-pollution keys", () => {
    const osPerm = createOsPermission({ platform: "darwin" });
    assert.strictEqual(osPerm.isGranted("__proto__"), "denied");
    assert.strictEqual(osPerm.isGranted("constructor"), "denied");
    assert.strictEqual(osPerm.isGranted("toString"), "denied");
  });

  it("isGranted returns 'denied' for non-string kinds", () => {
    const osPerm = createOsPermission({ platform: "darwin" });
    assert.strictEqual(osPerm.isGranted(null), "denied");
    assert.strictEqual(osPerm.isGranted(undefined), "denied");
    assert.strictEqual(osPerm.isGranted(42), "denied");
    assert.strictEqual(osPerm.isGranted({}), "denied");
  });

  it("refresh throws on invalid kind (loud-fail, not silent denial)", async () => {
    const osPerm = createOsPermission({ platform: "darwin" });
    await assert.rejects(() => osPerm.refresh("<script>alert('xss')</script>"), /invalid kind/);
    await assert.rejects(() => osPerm.refresh("microphone"), /invalid kind/);
  });

  it("promptGrant returns 'denied' for hostile kind WITHOUT opening shell", async () => {
    const shell = makeShellStub();
    const osPerm = createOsPermission({ platform: "darwin", shell });
    const hostile = "<script>alert('xss')</script>";
    const result = await osPerm.promptGrant(hostile);
    assert.strictEqual(result, "denied");
    assert.deepStrictEqual(shell.calls, [], "shell.openExternal must not be called for invalid kinds");
  });

  it("subscribe throws on invalid kind", () => {
    const osPerm = createOsPermission({ platform: "darwin" });
    assert.throws(() => osPerm.subscribe("microphone", () => {}), /invalid kind/);
  });

  it("openSystemSettings returns false for hostile kind WITHOUT opening shell", async () => {
    const shell = makeShellStub();
    const osPerm = createOsPermission({ platform: "darwin", shell });
    const opened = await osPerm.openSystemSettings("__proto__");
    assert.strictEqual(opened, false);
    assert.deepStrictEqual(shell.calls, []);
  });
});

describe("os-permission: SYSTEM_SETTINGS_URLS whitelist", () => {
  it("only exposes the two expected kinds", () => {
    assert.deepStrictEqual(Object.keys(SYSTEM_SETTINGS_URLS).sort(), ["accessibility", "inputMonitoring"]);
  });

  it("every URL is an x-apple.systempreferences security pane", () => {
    for (const kind of KINDS) {
      const url = SYSTEM_SETTINGS_URLS[kind];
      assert.match(
        url,
        /^x-apple\.systempreferences:com\.apple\.preference\.security\?/,
        `URL for ${kind} should target the security pane (got ${url})`,
      );
    }
  });

  it("Accessibility URL targets Privacy_Accessibility", () => {
    assert.ok(SYSTEM_SETTINGS_URLS.accessibility.endsWith("Privacy_Accessibility"));
  });

  it("Input Monitoring URL targets Privacy_ListenEvent", () => {
    assert.ok(SYSTEM_SETTINGS_URLS.inputMonitoring.endsWith("Privacy_ListenEvent"));
  });
});

describe("os-permission: promptGrant on macOS — open + re-probe lifecycle", () => {
  it("opens the deep-link via shell.openExternal then re-probes the gate", async () => {
    let probedAfterOpen = false;
    const shell = makeShellStub();
    const run = makeRunStub((cb) => {
      // Once openExternal has been called, subsequent probes report 'granted'.
      if (shell.calls.length > 0) probedAfterOpen = true;
      const stdout = probedAfterOpen ? "Finder\n" : "";
      cb(null, stdout, "");
    });

    // Foreground tracker that fires onForeground immediately so we don't
    // wait the full PROMPT_REPOLL_DELAY_MS in the test.
    const foregroundTracker = {
      isForeground: () => true,
      onForeground: (cb) => {
        // Fire synchronously on next tick so promptGrant proceeds.
        setImmediate(cb);
        return () => {};
      },
      onBackground: () => () => {},
    };
    const osPerm = createOsPermission({ platform: "darwin", shell, execFile: run, foregroundTracker });

    const result = await osPerm.promptGrant("accessibility");
    assert.strictEqual(shell.calls.length, 1, "should open System Settings exactly once");
    assert.strictEqual(shell.calls[0], SYSTEM_SETTINGS_URLS.accessibility);
    assert.strictEqual(result, "granted");
    osPerm.dispose();
  });

  it("falls back to 'denied' when re-probe still shows the gate as denied", async () => {
    const shell = makeShellStub();
    const run = makeRunStub((cb) => {
      // Always denied — user opened settings but didn't grant.
      cb(new Error("not authorized"), "", "not authorized");
    });
    const foregroundTracker = {
      isForeground: () => true,
      onForeground: (cb) => {
        setImmediate(cb);
        return () => {};
      },
      onBackground: () => () => {},
    };
    const osPerm = createOsPermission({ platform: "darwin", shell, execFile: run, foregroundTracker });

    const result = await osPerm.promptGrant("accessibility");
    assert.strictEqual(result, "denied");
    osPerm.dispose();
  });
});

describe("os-permission: subscribe lifecycle", () => {
  let osPerm;
  beforeEach(() => {
    if (osPerm) {
      osPerm.dispose();
      osPerm = null;
    }
  });

  it("unsubscribe stops polling and removes the callback", async () => {
    let calls = 0;
    const run = makeRunStub((cb) => {
      calls += 1;
      cb(null, "Finder\n", "");
    });
    osPerm = createOsPermission({ platform: "darwin", execFile: run });
    const seen = [];
    const unsubscribe = osPerm.subscribe("accessibility", (s) => seen.push(s));

    // Wait long enough for the initial refresh to resolve.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(calls >= 1, "initial refresh should have called the subprocess stub");
    unsubscribe();

    const callsAfterUnsub = calls;
    // No new calls should fire from the polling interval after unsubscribe.
    // (We don't wait 5s — just confirm the count is stable across a few microtasks.)
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls, callsAfterUnsub);
  });

  it("subscribe throws on non-function callback", () => {
    osPerm = createOsPermission({ platform: "darwin" });
    assert.throws(() => osPerm.subscribe("accessibility", null), /must be a function/);
    assert.throws(() => osPerm.subscribe("accessibility", "callback"), /must be a function/);
  });
});

describe("os-permission: __test exports", () => {
  it("exposes probeAccessibilityMac and constants for direct unit testing", () => {
    assert.strictEqual(typeof __test.probeAccessibilityMac, "function");
    assert.strictEqual(typeof __test.isKindAllowed, "function");
    assert.strictEqual(typeof __test.OSASCRIPT_TIMEOUT_MS, "number");
    assert.strictEqual(__test.POLL_INTERVAL_MS, 5000);
  });

  it("isKindAllowed accepts only the two whitelisted kinds", () => {
    assert.strictEqual(__test.isKindAllowed("accessibility"), true);
    assert.strictEqual(__test.isKindAllowed("inputMonitoring"), true);
    assert.strictEqual(__test.isKindAllowed("Accessibility"), false);
    assert.strictEqual(__test.isKindAllowed(""), false);
    assert.strictEqual(__test.isKindAllowed(null), false);
  });

  it("probeAccessibilityMac resolves 'granted' on success and 'denied' on error", async () => {
    const grantedResult = await __test.probeAccessibilityMac(
      makeRunStub((cb) => cb(null, "Cursor\n", "")),
    );
    assert.strictEqual(grantedResult, "granted");

    const deniedResult = await __test.probeAccessibilityMac(
      makeRunStub((cb) => cb(new Error("not authorized"), "", "not authorized")),
    );
    assert.strictEqual(deniedResult, "denied");
  });
});
