const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  JobStore,
  STATUSES,
} = require("../src/services/jobStore");

describe("JobStore isolation and transitions", () => {
  let dir;
  let store;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-jobs-"));
    store = new JobStore({ dbPath: path.join(dir, "t.sqlite") });
  });

  after(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  });

  it("creates isolated jobs for two users", () => {
    const a = store.createScriptJob({
      telegramUserId: "111",
      chatId: "c111",
      topic: "AI tools for creators",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "msg:c111:111:1",
    });
    const b = store.createScriptJob({
      telegramUserId: "222",
      chatId: "c222",
      topic: "Horror short about a lighthouse",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "msg:c222:222:1",
    });
    assert.notEqual(a.job.id, b.job.id);
    assert.equal(a.job.telegramUserId, "111");
    assert.equal(b.job.telegramUserId, "222");
    assert.equal(a.job.status, STATUSES.QUEUED_SCRIPT);
  });

  it("reuses idempotency key", () => {
    const first = store.createScriptJob({
      telegramUserId: "111",
      chatId: "c111",
      topic: "repeat",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "msg:c111:111:99",
    });
    const second = store.createScriptJob({
      telegramUserId: "111",
      chatId: "c111",
      topic: "repeat",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "msg:c111:111:99",
    });
    assert.equal(second.reused, true);
    assert.equal(second.job.id, first.job.id);
  });

  it("rejects cross-user approval", () => {
    const { job } = store.createScriptJob({
      telegramUserId: "10",
      chatId: "c10",
      topic: "topic",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "msg:c10:10:1",
    });
    store.transition(job.id, STATUSES.GENERATING_SCRIPT, {});
    store.transition(job.id, STATUSES.AWAITING_APPROVAL, {
      scriptText: "hello",
      scriptTitle: "t",
    });
    const fresh = store.getJob(job.id);
    const bad = store.approveVideo({
      jobId: fresh.id,
      token: fresh.approvalToken,
      telegramUserId: "999",
      chatId: "c10",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "wrong_user");
  });

  it("prevents duplicate approval", () => {
    const { job } = store.createScriptJob({
      telegramUserId: "20",
      chatId: "c20",
      topic: "topic2",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "msg:c20:20:1",
    });
    store.transition(job.id, STATUSES.GENERATING_SCRIPT, {});
    store.transition(job.id, STATUSES.AWAITING_APPROVAL, {
      scriptText: "script",
      scriptTitle: "title",
    });
    const fresh = store.getJob(job.id);
    const first = store.approveVideo({
      jobId: fresh.id,
      token: fresh.approvalToken,
      telegramUserId: "20",
      chatId: "c20",
    });
    assert.equal(first.ok, true);
    const second = store.approveVideo({
      jobId: fresh.id,
      token: fresh.approvalToken,
      telegramUserId: "20",
      chatId: "c20",
    });
    assert.equal(second.ok, false);
  });

  it("serializes claimNextJob to one in-flight worker", () => {
    const s = new JobStore({
      dbPath: path.join(dir, "claim.sqlite"),
    });
    const j1 = s.createScriptJob({
      telegramUserId: "1",
      chatId: "1",
      topic: "a",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "a1",
    }).job;
    s.createScriptJob({
      telegramUserId: "2",
      chatId: "2",
      topic: "b",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "b1",
    });

    const claimed = s.claimNextJob();
    assert.ok(claimed);
    assert.equal(claimed.status, STATUSES.GENERATING_SCRIPT);
    assert.equal(claimed.id, j1.id);
    const second = s.claimNextJob();
    assert.equal(second, null);
    s.close();
  });

  it("marks interrupted video jobs as needs_reconciliation on recovery", () => {
    const s = new JobStore({
      dbPath: path.join(dir, "recover.sqlite"),
    });
    const { job } = s.createScriptJob({
      telegramUserId: "3",
      chatId: "3",
      topic: "c",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "c1",
    });
    s.transition(job.id, STATUSES.GENERATING_SCRIPT, {});
    s.transition(job.id, STATUSES.AWAITING_APPROVAL, {
      scriptText: "s",
      scriptTitle: "t",
    });
    const fresh = s.getJob(job.id);
    s.approveVideo({
      jobId: fresh.id,
      token: fresh.approvalToken,
      telegramUserId: "3",
      chatId: "3",
    });
    const claimed = s.claimNextJob();
    assert.equal(claimed.status, STATUSES.GENERATING_VIDEO);
    const result = s.recoverAfterRestart();
    assert.equal(result.needsReconciliation, 1);
    assert.equal(
      s.getJob(job.id).status,
      STATUSES.NEEDS_RECONCILIATION
    );
    s.close();
  });

  it("does not auto-regenerate after reconciliation", () => {
    const s = new JobStore({
      dbPath: path.join(dir, "noregen.sqlite"),
    });
    // Seed a needs_reconciliation job directly
    const { job } = s.createScriptJob({
      telegramUserId: "4",
      chatId: "4",
      topic: "d",
      compositionPath: "STUDIO_COMPOSITE",
      maxPaidAttempts: 1,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
      idempotencyKey: "d1",
    });
    s.transition(job.id, STATUSES.GENERATING_SCRIPT, {});
    s.transition(job.id, STATUSES.AWAITING_APPROVAL, {
      scriptText: "s",
      scriptTitle: "t",
    });
    const fresh = s.getJob(job.id);
    s.approveVideo({
      jobId: fresh.id,
      token: fresh.approvalToken,
      telegramUserId: "4",
      chatId: "4",
    });
    s.claimNextJob();
    s.recoverAfterRestart();
    assert.equal(s.claimNextJob(), null);
    s.close();
  });
});
