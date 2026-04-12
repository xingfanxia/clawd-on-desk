// soul/client.js — Soul server lifecycle management + API helpers
//
// Responsibilities:
// 1. Discover or spawn the clawd-soul server
// 2. Health polling until ready
// 3. Periodic screen observation via desktopCapturer
// 4. Chat forwarding
// 5. Proactive message polling
// 6. Emotion → animation mapping
// 7. Graceful shutdown

const { desktopCapturer } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { mapToAnimation } = require("./emotion-map");

const { execFileSync } = require("child_process");

const DATA_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".clawd");
const RUNTIME_PATH = path.join(DATA_DIR, "soul-runtime.json");

/** Find the system Node.js binary (not Electron's) */
function findNodeBinary() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    process.env.CLAWD_NODE_PATH, // explicit override
  ];

  // Try `which node` via shell (picks up PATH from .zshrc/.bashrc)
  try {
    const found = execFileSync("/bin/sh", ["-lc", "which node"], {
      timeout: 3000, encoding: "utf8",
    }).trim().split("\n").pop();
    if (found) candidates.push(found);
  } catch {}

  // Common paths
  if (process.platform !== "win32") {
    // asdf
    try {
      const asdfNodes = fs.readdirSync(path.join(home, ".asdf/installs/nodejs"));
      for (const v of asdfNodes.sort().reverse()) {
        candidates.push(path.join(home, ".asdf/installs/nodejs", v, "bin/node"));
      }
    } catch {}
    candidates.push(
      path.join(home, ".asdf/shims/node"),
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
    );
    // nvm
    try {
      const nvmDir = path.join(home, ".nvm/versions/node");
      const versions = fs.readdirSync(nvmDir);
      for (const v of versions.sort().reverse()) {
        candidates.push(path.join(nvmDir, v, "bin/node"));
      }
    } catch {}
  } else {
    // Windows: try `where node`
    try {
      const found = execFileSync("where", ["node"], {
        timeout: 2000, encoding: "utf8",
      }).trim().split("\n")[0];
      if (found) candidates.push(found);
    } catch {}
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  // Last resort: hope node is on PATH
  return "node";
}

// Path to clawd-soul — sibling directory
const SOUL_DIR = path.join(__dirname, "..", "..", "clawd-soul");

module.exports = function initSoulClient(ctx) {

let _soulProcess = null;
let _soulPort = null;
let _healthy = false;
let _observeTimer = null;
let _proactiveTimer = null;
let _lastForegroundApp = "";
let _lastWindowTitle = "";
let _observing = false; // prevent overlapping observations

// ---------------------------------------------------------------------------
// HTTP helpers (tiny, no deps)
// ---------------------------------------------------------------------------

function soulRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    if (!_soulPort) { reject(new Error("Soul not connected")); return; }

    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1",
      port: _soulPort,
      path: urlPath,
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Soul server lifecycle
// ---------------------------------------------------------------------------

/** Try to discover an already-running soul server */
function discoverExisting() {
  try {
    if (fs.existsSync(RUNTIME_PATH)) {
      const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
      if (runtime.port && runtime.pid) {
        // Check if process is actually alive
        try { process.kill(runtime.pid, 0); } catch { return null; }
        return runtime.port;
      }
    }
  } catch {}
  return null;
}

/** Spawn a new clawd-soul server as a child process */
function spawnSoul() {
  const serverPath = path.join(SOUL_DIR, "src", "server.js");
  if (!fs.existsSync(serverPath)) {
    console.warn("Clawd Soul: server.js not found at", serverPath);
    return null;
  }

  console.log("Clawd Soul: spawning soul server...");
  // Use system node (not Electron's binary) because clawd-soul has native
  // modules (better-sqlite3) compiled against system Node's ABI.
  const nodeBin = findNodeBinary();
  console.log("Clawd Soul: using node binary:", nodeBin);

  const child = spawn(nodeBin, [serverPath], {
    cwd: SOUL_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: { ...process.env },
  });

  child.stdout.on("data", (data) => {
    const line = data.toString().trim();
    if (line) console.log("[soul]", line);
  });
  child.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line) console.warn("[soul:err]", line);
  });
  child.on("exit", (code) => {
    console.log("Clawd Soul: process exited with code", code);
    _soulProcess = null;
    _healthy = false;
  });

  _soulProcess = child;
  return child;
}

/** Poll GET /health until the server responds */
function waitForHealth(port, attempts = 25, intervalMs = 200) {
  return new Promise((resolve) => {
    let remaining = attempts;
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (data.ok) { resolve(true); return; }
          } catch {}
          retry();
        });
      });
      req.on("error", () => retry());
      req.on("timeout", () => { req.destroy(); retry(); });
    };

    const retry = () => {
      remaining--;
      if (remaining <= 0) { resolve(false); return; }
      setTimeout(check, intervalMs);
    };

    check();
  });
}

/** Initialize soul connection: discover or spawn, then health check */
async function init() {
  // Try existing server first
  const existingPort = discoverExisting();
  if (existingPort) {
    console.log("Clawd Soul: found existing server on port", existingPort);
    _soulPort = existingPort;
    const ok = await waitForHealth(existingPort, 5, 200);
    if (ok) {
      _healthy = true;
      console.log("Clawd Soul: connected to existing server");
      startLoops();
      return true;
    }
  }

  // Spawn new server
  spawnSoul();
  if (!_soulProcess) return false;

  // Wait for it to write runtime.json, then read port
  const portFound = await new Promise((resolve) => {
    let checks = 0;
    const poll = setInterval(() => {
      checks++;
      if (checks > 25) { clearInterval(poll); resolve(false); return; }
      try {
        if (fs.existsSync(RUNTIME_PATH)) {
          const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
          if (runtime.port) {
            _soulPort = runtime.port;
            clearInterval(poll);
            resolve(true);
          }
        }
      } catch {}
    }, 200);
  });

  if (!portFound) {
    console.warn("Clawd Soul: server did not start in time");
    return false;
  }

  const ok = await waitForHealth(_soulPort, 10, 300);
  if (ok) {
    _healthy = true;
    console.log("Clawd Soul: server started on port", _soulPort);
    startLoops();
    return true;
  }

  console.warn("Clawd Soul: server started but health check failed");
  return false;
}

// ---------------------------------------------------------------------------
// Screen capture via desktopCapturer
// ---------------------------------------------------------------------------

async function captureScreen() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });

    if (sources.length === 0) return null;

    // Get the primary screen (first source)
    const source = sources[0];
    const image = source.thumbnail;
    if (image.isEmpty()) return null;

    // Convert to JPEG base64
    const jpeg = image.toJPEG(60); // quality 60 for speed
    return jpeg.toString("base64");
  } catch (err) {
    console.warn("Clawd Soul: screen capture failed:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Observation loop
// ---------------------------------------------------------------------------

async function doObservation(trigger = "periodic") {
  if (!_healthy || _observing) return;
  _observing = true;

  try {
    // Capture screen
    const screenshot = await captureScreen();

    // Show thinking animation
    const thinkAnim = mapToAnimation("thinking", null, "speech-bubble");
    if (thinkAnim && ctx.speechBubble) {
      ctx.speechBubble.showTyping();
    }
    if (thinkAnim) {
      ctx.applyState(thinkAnim.state, thinkAnim.svg);
    }

    // Send to soul
    const result = await soulRequest("POST", "/observe", {
      screenshot,
      foregroundApp: _lastForegroundApp,
      windowTitle: _lastWindowTitle,
      trigger,
    });

    if (!result) {
      if (ctx.speechBubble) ctx.speechBubble.hide();
      return;
    }

    // Map response to animation
    if (result.action === "silent" || result.action === "throttled" || !result.commentary) {
      // Hide typing indicator, return to previous state
      if (ctx.speechBubble) ctx.speechBubble.hide();
      const resolved = ctx.resolveDisplayState();
      ctx.applyState(resolved);
      return;
    }

    // Show commentary with emotion-appropriate animation
    const anim = mapToAnimation("observe", result.mood, result.action);
    if (anim) {
      ctx.applyState(anim.state, anim.svg);
    }
    if (ctx.speechBubble) {
      ctx.speechBubble.show(result.commentary, result.duration || 8000);
    }
  } catch (err) {
    console.warn("Clawd Soul: observation failed:", err.message);
    if (ctx.speechBubble) ctx.speechBubble.hide();
  } finally {
    _observing = false;
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function chat(message) {
  if (!_healthy) return null;

  try {
    // Show thinking
    const thinkAnim = mapToAnimation("thinking", null, "speech-bubble");
    if (thinkAnim) ctx.applyState(thinkAnim.state, thinkAnim.svg);
    if (ctx.speechBubble) ctx.speechBubble.showTyping();

    const result = await soulRequest("POST", "/chat", { message });

    if (!result || !result.ok) {
      if (ctx.speechBubble) ctx.speechBubble.hide();
      const errAnim = mapToAnimation("error", null, "error");
      if (errAnim) ctx.applyState(errAnim.state, errAnim.svg);
      return result;
    }

    // Happy response animation
    const anim = mapToAnimation("chat", result.mood, "speech-bubble");
    if (anim) ctx.applyState(anim.state, anim.svg);
    if (ctx.speechBubble) {
      ctx.speechBubble.show(result.reply, 10000);
    }

    return result;
  } catch (err) {
    console.warn("Clawd Soul: chat failed:", err.message);
    if (ctx.speechBubble) ctx.speechBubble.hide();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proactive message polling
// ---------------------------------------------------------------------------

async function pollProactive() {
  if (!_healthy) return;

  try {
    const result = await soulRequest("GET", "/proactive");
    if (result && result.commentary && result.action !== "none") {
      const anim = mapToAnimation("proactive", result.mood, result.action);
      if (anim) ctx.applyState(anim.state, anim.svg);
      if (ctx.speechBubble) {
        ctx.speechBubble.show(result.commentary, result.duration || 8000);
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Foreground app tracking (called from tick.js)
// ---------------------------------------------------------------------------

function updateForegroundApp(appName, windowTitle) {
  const appChanged = appName && appName !== _lastForegroundApp;
  _lastForegroundApp = appName || _lastForegroundApp;
  _lastWindowTitle = windowTitle || _lastWindowTitle;

  // Trigger observation on app switch
  if (appChanged && _healthy) {
    doObservation("app-switch");
  }
}

// ---------------------------------------------------------------------------
// Mood event reporting
// ---------------------------------------------------------------------------

function reportEvent(eventName) {
  if (!_healthy) return;
  soulRequest("POST", "/mood/event", { event: eventName }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

function startLoops() {
  // Periodic observation (every 30s)
  _observeTimer = setInterval(() => {
    // Only observe when not in working/sleeping states (don't interrupt agent work)
    const state = ctx.getCurrentState();
    const skip = ["working", "thinking", "juggling", "sweeping", "carrying",
                  "sleeping", "dozing", "collapsing", "yawning", "waking"];
    if (!skip.includes(state)) {
      doObservation("periodic");
    }
  }, 30000);

  // Proactive message polling (every 60s)
  _proactiveTimer = setInterval(() => {
    const state = ctx.getCurrentState();
    if (state === "idle" || state === "mini-idle") {
      pollProactive();
    }
  }, 60000);

  // Report that the user is here
  reportEvent("user-returned");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown() {
  if (_observeTimer) { clearInterval(_observeTimer); _observeTimer = null; }
  if (_proactiveTimer) { clearInterval(_proactiveTimer); _proactiveTimer = null; }
  _healthy = false;

  if (_soulProcess) {
    console.log("Clawd Soul: shutting down soul server...");
    _soulProcess.kill("SIGTERM");
    _soulProcess = null;
  }
}

return {
  init,
  shutdown,
  chat,
  doObservation,
  reportEvent,
  updateForegroundApp,
  get healthy() { return _healthy; },
  get port() { return _soulPort; },
};

};
