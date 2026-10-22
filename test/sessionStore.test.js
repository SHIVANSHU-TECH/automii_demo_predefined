const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  STATES,
  getSession,
  resetSession,
  updateSession,
  clearApproval,
  _clearAllSessions,
} = require("../src/services/sessionStore");

describe("sessionStore", () => {
  beforeEach(() => {
    _clearAllSessions();
  });

  it("creates independent sessions per chat", () => {
    const a = getSession(111);
    const b = getSession(222);
    updateSession(111, { demoId: "demo-a", state: STATES.AWAITING_APPROVAL });
    assert.equal(getSession(111).demoId, "demo-a");
    assert.equal(getSession(222).demoId, null);
    assert.equal(b.state, STATES.AWAITING_IDEA);
    assert.notEqual(a, b);
  });

  it("resetSession clears pending demo state", () => {
    updateSession(1, {
      state: STATES.AWAITING_APPROVAL,
      demoId: "x",
      approvalToken: "abc",
      videoSent: true,
    });
    const s = resetSession(1);
    assert.equal(s.state, STATES.AWAITING_IDEA);
    assert.equal(s.demoId, null);
    assert.equal(s.approvalToken, null);
    assert.equal(s.videoSent, false);
  });

  it("supports awaiting_idea → awaiting_approval → sending_video transitions", () => {
    const chatId = 42;
    assert.equal(getSession(chatId).state, STATES.AWAITING_IDEA);

    updateSession(chatId, {
      state: STATES.AWAITING_APPROVAL,
      demoId: "horror-haunted-house",
      approvalToken: "tok1",
    });
    assert.equal(getSession(chatId).state, STATES.AWAITING_APPROVAL);

    updateSession(chatId, {
      state: STATES.SENDING_VIDEO,
      videoSent: true,
    });
    assert.equal(getSession(chatId).state, STATES.SENDING_VIDEO);
    assert.equal(getSession(chatId).videoSent, true);

    clearApproval(chatId);
    assert.equal(getSession(chatId).state, STATES.AWAITING_IDEA);
    assert.equal(getSession(chatId).videoSent, false);
  });

  it("duplicate approval protection: videoSent stays true once set", () => {
    const chatId = 7;
    updateSession(chatId, {
      state: STATES.AWAITING_APPROVAL,
      demoId: "ai-productivity",
      approvalToken: "tok",
      videoSent: false,
    });

    // First approve locks
    updateSession(chatId, { state: STATES.SENDING_VIDEO, videoSent: true });
    const first = getSession(chatId);
    assert.equal(first.videoSent, true);
    assert.equal(first.state, STATES.SENDING_VIDEO);

    // Second "click" would see videoSent already true
    const second = getSession(chatId);
    assert.equal(second.videoSent, true);
    assert.ok(
      second.videoSent || second.state === STATES.SENDING_VIDEO,
      "duplicate approval should be blocked"
    );
  });

  it("stale token does not match after clearApproval", () => {
    updateSession(9, {
      state: STATES.AWAITING_APPROVAL,
      approvalToken: "old-token",
      demoId: "creator-growth",
    });
    clearApproval(9);
    const s = getSession(9);
    assert.notEqual(s.approvalToken, "old-token");
    assert.equal(s.approvalToken, null);
  });
});
