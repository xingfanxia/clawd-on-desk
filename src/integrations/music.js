"use strict";

// src/integrations/music.js — Apple Music Now Playing detector (PAWPAL-3).
//
// Polls the foreground Music.app via osascript every MUSIC_POLL_MS and emits
// "music.bpmChange" when the active track's BPM crosses the configured
// threshold (going up; not when it drops). Listeners receive
// `{ name, artist, bpm, at }` so the consumer (nudges.js) can fire a head-
// bob behavior or expose metadata in Settings.
//
// Design:
//   - osascript with hardcoded argv (NO shell). All paths are static — there
//     is no user input flowing into the script, but we still use the runFile
//     api shape to keep symmetry with the PAWPAL-2 detectors.
//   - Pause polling when not foregrounded is NOT wired here — Music.app
//     keeps playing in background and BPM events should fire regardless of
//     pet visibility. The renderer can ignore the event if it wants.
//   - Apple Music sometimes returns BPM as 0 (track missing metadata). We
//     treat 0 as "no signal" and skip the threshold check.
//   - Non-mac → silent no-op.

const MUSIC_POLL_MS = 10_000;

// AppleScript that asks Music.app for the current track's BPM, name, artist.
// Fields are tab-delimited so we can split without quoting edge cases.
// `try ... end try` returns empty string if Music is not running.
const MUSIC_QUERY_SCRIPT = [
  'tell application "Music"',
  '  if it is running then',
  '    try',
  '      set t to current track',
  '      set tName to name of t',
  '      set tArtist to artist of t',
  '      set tBpm to bpm of t',
  '      return (tName & "\\t" & tArtist & "\\t" & tBpm)',
  '    on error',
  '      return ""',
  '    end try',
  '  else',
  '    return ""',
  '  end if',
  'end tell',
].join("\n");

function parseNowPlaying(stdout) {
  if (typeof stdout !== "string") return null;
  const line = stdout.trim();
  if (!line) return null;
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const name = parts[0] || "";
  const artist = parts[1] || "";
  const bpm = Number(parts[2]);
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  return { name, artist, bpm };
}

function createMusicDetector(deps) {
  const runFile = deps && typeof deps.runFile === "function" ? deps.runFile : null;
  const log = deps && typeof deps.log === "function" ? deps.log : () => {};
  const isMac = !!(deps && deps.isMac);

  let timer = null;
  const listeners = new Set();
  let bpmThreshold = 120;
  let lastTrackId = null;
  let lastBpmAboveThreshold = false;

  async function tick() {
    if (!runFile) return;
    try {
      const result = await runFile("osascript", ["-e", MUSIC_QUERY_SCRIPT], { timeout: 5000 });
      const stdout = result && result.stdout;
      const parsed = parseNowPlaying(stdout);
      if (!parsed) {
        lastTrackId = null;
        lastBpmAboveThreshold = false;
        return;
      }
      const trackId = parsed.name + " " + parsed.artist;
      const aboveThreshold = parsed.bpm >= bpmThreshold;
      // Fire only on the LEADING edge of "track crossed into above-threshold"
      // either because the track changed or because we polled across a track
      // boundary. Prevents continuous metronome-rate firing during a single
      // high-BPM song.
      const trackChanged = trackId !== lastTrackId;
      if (aboveThreshold && (trackChanged || !lastBpmAboveThreshold)) {
        const event = { name: parsed.name, artist: parsed.artist, bpm: parsed.bpm, at: Date.now() };
        for (const cb of listeners) {
          try { cb(event); }
          catch (err) { log("error", "music: listener threw", err); }
        }
      }
      lastTrackId = trackId;
      lastBpmAboveThreshold = aboveThreshold;
    } catch (err) {
      // Music.app may not be running, osascript may be missing, etc. Silent
      // by default — log at debug only.
      log("debug", "music: poll failed", err && err.message);
    }
  }

  function start(prefsSub) {
    if (!isMac || timer) return;
    if (prefsSub && Number.isFinite(prefsSub.bpmThreshold) && prefsSub.bpmThreshold > 0) {
      bpmThreshold = prefsSub.bpmThreshold;
    }
    tick();
    timer = setInterval(tick, MUSIC_POLL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    lastTrackId = null;
    lastBpmAboveThreshold = false;
  }

  function onBpmChange(cb) {
    if (typeof cb !== "function") return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return {
    start, stop, onBpmChange,
    __test: {
      tick,
      parseNowPlaying,
      getListenerCount: () => listeners.size,
      getBpmThreshold: () => bpmThreshold,
      getLastTrackId: () => lastTrackId,
      getLastBpmAboveThreshold: () => lastBpmAboveThreshold,
      MUSIC_QUERY_SCRIPT,
      MUSIC_POLL_MS,
    },
  };
}

module.exports = { createMusicDetector, parseNowPlaying };
