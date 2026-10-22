const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  extractResultPayload,
  runClaudeJob,
  ensureWorkspace,
  parseCloudinaryFromVideoLinks,
  mergeWithArtifacts,
} = require("../src/services/claudeWorker");

describe("claudeWorker parsing and dry-run", () => {
  it("parses --output-format json wrapper", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "11111111-1111-1111-1111-111111111111",
      result: JSON.stringify({
        phase: "script",
        status: "ok",
        jobId: "job_abc",
        script: "Hook line",
        scriptTitle: "Title",
        cloudinaryUrl: null,
      }),
    });
    const parsed = extractResultPayload(stdout);
    assert.equal(parsed.payload.jobId, "job_abc");
    assert.equal(parsed.payload.script, "Hook line");
    assert.equal(parsed.sessionId, "11111111-1111-1111-1111-111111111111");
  });

  it("dry-run returns script without spawning Claude", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-claude-"));
    const config = {
      jobsWorkspaceDir: dir,
      contractPath: path.join(
        __dirname,
        "../prompts/automii-bot-contract.md"
      ),
      skillName: "ai-reel-final-version",
      compositionPath: "STUDIO_COMPOSITE",
      spending: { maxClaudeBudgetUsdPerJob: 5 },
      claudeBin: "claude",
      claudePermissionMode: "bypassPermissions",
    };
    const job = {
      id: "job_dryrun1",
      chatId: "1",
      topic: "Dry run topic about AI",
      scriptText: null,
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
    };
    ensureWorkspace(config, job.id);
    const result = await runClaudeJob({
      config,
      job,
      phase: "script",
      timeoutMs: 5000,
      dryRun: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.payload.phase, "script");
    assert.match(result.payload.script, /DRY RUN/);
    assert.ok(result.sessionId);
  });

  it("dry-run video phase fails closed without provider calls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-claude-v-"));
    const config = {
      jobsWorkspaceDir: dir,
      contractPath: path.join(
        __dirname,
        "../prompts/automii-bot-contract.md"
      ),
      skillName: "ai-reel-final-version",
      compositionPath: "STUDIO_COMPOSITE",
      spending: { maxClaudeBudgetUsdPerJob: 5 },
      claudeBin: "claude",
      claudePermissionMode: "bypassPermissions",
    };
    const job = {
      id: "job_dryrun_video",
      chatId: "1",
      topic: "topic",
      scriptText: "approved script",
      scriptTitle: "t",
      maxFlowCredits: 40,
      maxClaudeBudgetUsd: 5,
    };
    const result = await runClaudeJob({
      config,
      job,
      phase: "video",
      timeoutMs: 5000,
      dryRun: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.payload.cloudinaryUrl, null);
    assert.match(result.error, /CLAUDE_DRY_RUN/);
  });

  it("validateVideoUrl rejects non-http", () => {
    const { validateVideoUrl } = require("../src/services/videoDelivery");
    assert.equal(validateVideoUrl("not-a-url").ok, false);
    assert.equal(
      validateVideoUrl("https://res.cloudinary.com/demo/video/upload/dog.mp4")
        .ok,
      true
    );
  });

  it("parses Cloudinary URL from video_links.txt text", () => {
    const text = [
      "Cloudinary (permanent): https://res.cloudinary.com/demo/video/upload/v1/final.mp4",
      "HeyGen temporary: https://example.com/temp.mp4",
    ].join("\n");
    assert.equal(
      parseCloudinaryFromVideoLinks(text),
      "https://res.cloudinary.com/demo/video/upload/v1/final.mp4"
    );
  });

  it("recovers script from script.txt when JSON missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-art-"));
    fs.writeFileSync(path.join(dir, "script.txt"), "Hook\nValue\nCTA", "utf8");
    const job = { id: "job_art1", compositionPath: "STUDIO_COMPOSITE" };
    const merged = mergeWithArtifacts(null, dir, job, "script", {}, 0);
    assert.equal(merged.status, "ok");
    assert.match(merged.script, /Hook/);
    assert.equal(merged.jobId, "job_art1");
  });

  it("marks reconciliation when video links exist but JSON missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-artv-"));
    fs.writeFileSync(
      path.join(dir, "video_links.txt"),
      "Cloudinary (permanent): https://res.cloudinary.com/demo/video/upload/v1/x.mp4\n",
      "utf8"
    );
    const job = { id: "job_art2", compositionPath: "STUDIO_COMPOSITE" };
    const merged = mergeWithArtifacts(null, dir, job, "video", {}, 0);
    assert.equal(merged.status, "needs_reconciliation");
    assert.match(merged.cloudinaryUrl, /cloudinary/);
  });

  it("does not adopt unrelated Flow video_links as success", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-scope-"));
    const job = { id: "job_scoped99", compositionPath: "STUDIO_COMPOSITE" };
    // Simulate Claude session-limit CLI failure with no job workspace artifacts
    const merged = mergeWithArtifacts(
      null,
      dir,
      job,
      "video",
      {},
      0,
      "You've hit your session limit · resets 3:30pm"
    );
    assert.equal(merged.status, "failed");
    assert.match(merged.error, /session limit/i);
    assert.equal(merged.cloudinaryUrl, null);
  });

  it("extractResultPayload ignores Claude CLI error envelopes", () => {
    const { extractResultPayload } = require("../src/services/claudeWorker");
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 429,
      session_id: "sess-1",
      result: "You've hit your session limit · resets 3:30pm",
      total_cost_usd: 0,
    });
    const extracted = extractResultPayload(stdout);
    assert.equal(extracted.payload, null);
    assert.match(extracted.cliError, /session limit/i);
    assert.equal(extracted.sessionId, "sess-1");
  });
});
