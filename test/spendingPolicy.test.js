const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JobStore, STATUSES } = require("../src/services/jobStore");
const {
  evaluateVideoApproval,
  canAcceptNewIdea,
} = require("../src/services/spendingPolicy");

function baseConfig(overrides = {}) {
  return {
    maxActiveJobsPerUser: 2,
    maxQueueLength: 5,
    spending: {
      enabled: true,
      maxVideoJobsPerUserPerDay: 2,
      maxVideoJobsPerDay: 3,
      maxPaidAttemptsPerJob: 1,
      maxClaudeBudgetUsdPerJob: 5,
      maxClaudeBudgetUsdPerDay: 25,
      maxFlowCreditsPerJob: 40,
      currency: "USD",
      ...overrides.spending,
    },
    ...overrides,
  };
}

describe("spendingPolicy", () => {
  let dir;
  let store;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-spend-"));
    store = new JobStore({ dbPath: path.join(dir, "s.sqlite") });
  });

  after(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  });

  it("fails closed when policy disabled", () => {
    const r = evaluateVideoApproval(store, baseConfig({ spending: { enabled: false } }), {
      telegramUserId: "1",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "POLICY_DISABLED");
  });

  it("fails closed when limits invalid", () => {
    const r = evaluateVideoApproval(
      store,
      baseConfig({
        spending: {
          enabled: true,
          maxVideoJobsPerUserPerDay: 0,
          maxVideoJobsPerDay: 3,
          maxPaidAttemptsPerJob: 1,
          maxClaudeBudgetUsdPerJob: 5,
          maxFlowCreditsPerJob: 40,
        },
      }),
      { telegramUserId: "1" }
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "POLICY_INVALID");
  });

  it("enforces per-user daily video cap", () => {
    const cfg = baseConfig();
    for (let i = 0; i < 2; i++) {
      const { job } = store.createScriptJob({
        telegramUserId: "u1",
        chatId: `cu1-${i}`,
        topic: `t${i}`,
        compositionPath: "STUDIO_COMPOSITE",
        maxPaidAttempts: 1,
        maxFlowCredits: 40,
        maxClaudeBudgetUsd: 5,
        idempotencyKey: `u1-${i}`,
      });
      store.transition(job.id, STATUSES.GENERATING_SCRIPT, {});
      store.transition(job.id, STATUSES.AWAITING_APPROVAL, {
        scriptText: "s",
        scriptTitle: "t",
      });
      const fresh = store.getJob(job.id);
      const ok = store.approveVideo({
        jobId: fresh.id,
        token: fresh.approvalToken,
        telegramUserId: "u1",
        chatId: `cu1-${i}`,
      });
      assert.equal(ok.ok, true);
    }
    const blocked = evaluateVideoApproval(store, cfg, { telegramUserId: "u1" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "USER_DAILY_CAP");
  });

  it("enforces active job and queue limits", () => {
    const s = new JobStore({ dbPath: path.join(dir, "q.sqlite") });
    const cfg = baseConfig({ maxActiveJobsPerUser: 1, maxQueueLength: 1 });
    s.createScriptJob({
      telegramUserId: "qx",
      chatId: "qx",
      topic: "one",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "qx1",
    });
    const active = canAcceptNewIdea(s, cfg, { telegramUserId: "qx" });
    assert.equal(active.ok, false);
    s.close();
  });
});
