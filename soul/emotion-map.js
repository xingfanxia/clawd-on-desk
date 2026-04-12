// soul/emotion-map.js — Map soul API responses to clawd-on-desk animations
//
// The soul server returns { mood: { energy, interest, affection }, action, commentary }.
// This module picks the right pet state + SVG based on the emotional context.
//
// Design: we reuse existing states (no new state machine entries needed).
// The state machine's priority system and auto-return timers handle transitions.

// ── Animation sets for soul-driven states ──
const SOUL_ANIMATIONS = {
  // Pet is excited about what it sees — high energy + interest
  excited: {
    state: "attention",   // uses clawd-happy.svg, 4s auto-return
    svg: null,            // let state machine pick default
    duration: 4000,
  },

  // Pet has a calm observation to share
  commentary: {
    state: "notification", // uses clawd-notification.svg, 2.5s auto-return
    svg: null,
    duration: 2500,
  },

  // Pet is thinking (waiting for AI response)
  thinking: {
    state: "thinking",     // uses clawd-working-thinking.svg
    svg: null,
    duration: 0,           // lasts until response arrives
  },

  // Pet received a chat reply — happy response
  chatReply: {
    state: "attention",    // happy animation
    svg: null,
    duration: 4000,
  },

  // Pet has a proactive message (unprompted)
  proactive: {
    state: "notification",
    svg: null,
    duration: 2500,
  },

  // Pet is writing in its diary
  diary: {
    state: "idle",
    svg: "clawd-idle-reading.svg",
    duration: 8000,
  },

  // AI error — pet looks confused
  error: {
    state: "error",
    svg: null,
    duration: 5000,
  },

  // Sleepy/low energy observation
  sleepy: {
    state: "idle",
    svg: "clawd-idle-look.svg",
    duration: 3000,
  },
};

/**
 * Choose the right animation based on soul response context.
 *
 * @param {string} context - 'observe' | 'chat' | 'proactive' | 'diary' | 'error'
 * @param {Object} mood - { energy: 0-1, interest: 0-1, affection: 0-1 }
 * @param {string} action - 'speech-bubble' | 'silent' | 'none'
 * @returns {{ state: string, svg: string|null, duration: number } | null}
 */
function mapToAnimation(context, mood, action) {
  // Silent observations = no animation change
  if (action === "silent" || action === "none" || action === "throttled") {
    return null;
  }

  // Error context
  if (context === "error") {
    return SOUL_ANIMATIONS.error;
  }

  // Diary writing
  if (context === "diary") {
    return SOUL_ANIMATIONS.diary;
  }

  // Proactive message
  if (context === "proactive") {
    return SOUL_ANIMATIONS.proactive;
  }

  // Chat reply — always happy
  if (context === "chat") {
    return SOUL_ANIMATIONS.chatReply;
  }

  // Observation — mood-driven animation selection
  if (context === "observe") {
    // High energy + high interest = excited
    if (mood && mood.energy > 0.65 && mood.interest > 0.65) {
      return SOUL_ANIMATIONS.excited;
    }

    // Low energy = sleepy reaction
    if (mood && mood.energy < 0.3) {
      return SOUL_ANIMATIONS.sleepy;
    }

    // Default observation commentary
    return SOUL_ANIMATIONS.commentary;
  }

  // Thinking (waiting for AI)
  if (context === "thinking") {
    return SOUL_ANIMATIONS.thinking;
  }

  return SOUL_ANIMATIONS.commentary;
}

module.exports = { mapToAnimation, SOUL_ANIMATIONS };
