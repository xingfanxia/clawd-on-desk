"use strict";

// PAWPAL-2 Task 9 — pure predicate for the focus-enter overlay-cancel rule.
//
// Returns true only when the workspace category transitions FROM a non-focus
// state (null / "docs" / "video" / "system" / "unknown" / etc.) INTO a focus
// state ("code" or "creative"). Cross-focus transitions (code → creative or
// vice versa) return false because the user is already in focus mode — re-
// firing popBehavior on every focus-app switch would be noisy and provides
// no UX benefit (no overlay should be running mid-focus).
//
// Extracted to its own module so unit tests can exercise it without booting
// main.js (which pulls in Electron). main.js requires this and calls it from
// the workspace-detector onAppChange subscriber wired in Task 9.

function isFocusCategory(category) {
  return category === "code" || category === "creative";
}

function shouldCancelFocusOverlays(prevCategory, newCategory) {
  return isFocusCategory(newCategory) && !isFocusCategory(prevCategory);
}

module.exports = { shouldCancelFocusOverlays, isFocusCategory };
