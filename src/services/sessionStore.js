/**
 * In-memory per-chat session store.
 * Sessions reset when the Node process restarts.
 */

const STATES = Object.freeze({
  AWAITING_IDEA: "awaiting_idea",
  AWAITING_APPROVAL: "awaiting_approval",
  SENDING_VIDEO: "sending_video",
});

/** @type {Map<string, object>} */
const sessions = new Map();

function keyFor(chatId) {
  return String(chatId);
}

function createDefaultSession() {
  return {
    state: STATES.AWAITING_IDEA,
    demoId: null,
    approvalToken: null,
    videoSent: false,
    promptMessageId: null,
  };
}

function getSession(chatId) {
  const key = keyFor(chatId);
  if (!sessions.has(key)) {
    sessions.set(key, createDefaultSession());
  }
  return sessions.get(key);
}

function resetSession(chatId) {
  const session = createDefaultSession();
  sessions.set(keyFor(chatId), session);
  return session;
}

function updateSession(chatId, patch) {
  const session = getSession(chatId);
  Object.assign(session, patch);
  return session;
}

function clearApproval(chatId) {
  return updateSession(chatId, {
    state: STATES.AWAITING_IDEA,
    demoId: null,
    approvalToken: null,
    videoSent: false,
    promptMessageId: null,
  });
}

/** Exposed for tests only */
function _clearAllSessions() {
  sessions.clear();
}

/** Exposed for tests only */
function _sessionCount() {
  return sessions.size;
}

module.exports = {
  STATES,
  getSession,
  resetSession,
  updateSession,
  clearApproval,
  _clearAllSessions,
  _sessionCount,
};
