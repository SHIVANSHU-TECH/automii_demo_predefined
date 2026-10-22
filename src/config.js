const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");

function envBool(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function envInt(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

function envFloat(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

/**
 * Load and validate Automii Stage-1 configuration.
 * Live mode is fail-closed on spending policy.
 */
function loadConfig() {
  const botMode = (process.env.BOT_MODE || "mock").toLowerCase();
  if (!["mock", "live"].includes(botMode)) {
    throw new Error('BOT_MODE must be "mock" or "live"');
  }

  const runtimeDir = path.resolve(
    process.env.RUNTIME_DIR || path.join(ROOT, "runtime")
  );
  const dbPath = path.resolve(
    process.env.SQLITE_PATH || path.join(runtimeDir, "automii.sqlite")
  );
  const jobsWorkspaceDir = path.resolve(
    process.env.JOBS_WORKSPACE_DIR || path.join(runtimeDir, "jobs")
  );

  const compositionPath = (
    process.env.COMPOSITION_PATH || "STUDIO_COMPOSITE"
  ).toUpperCase();
  if (!["STUDIO_COMPOSITE", "PRESENTER_ONLY"].includes(compositionPath)) {
    throw new Error(
      "COMPOSITION_PATH must be STUDIO_COMPOSITE or PRESENTER_ONLY"
    );
  }

  const config = {
    botMode,
    privateChatsOnly: envBool("PRIVATE_CHATS_ONLY", true),
    botToken: process.env.BOT_TOKEN || "",
    runtimeDir,
    dbPath,
    jobsWorkspaceDir,
    demosPath: path.join(ROOT, "data", "demos.json"),
    contractPath: path.join(ROOT, "prompts", "automii-bot-contract.md"),
    skillName: process.env.CLAUDE_SKILL_NAME || "ai-reel-updated-final",
    elevenLabsVoiceId: (process.env.ELEVENLABS_VOICE_ID || "").trim(),
    heygenLookId: (process.env.HEYGEN_LOOK_ID || "").trim(),
    claudeBin: process.env.CLAUDE_BIN || "claude",
    claudePermissionMode:
      process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions",
    compositionPath,
    // Concurrency: Flow-bound production serialized; Stage-1 also serializes all Claude work.
    globalWorkerConcurrency: 1,
    productionConcurrency: 1,
    maxQueueLength: envInt("MAX_QUEUE_LENGTH", 20),
    maxActiveJobsPerUser: envInt("MAX_ACTIVE_JOBS_PER_USER", 2),
    scriptTimeoutMs: envInt("SCRIPT_TIMEOUT_MS", 20 * 60 * 1000),
    videoTimeoutMs: envInt("VIDEO_TIMEOUT_MS", 90 * 60 * 1000),
    dispatcherPollMs: envInt("DISPATCHER_POLL_MS", 1500),
    spending: {
      enabled: envBool("SPENDING_POLICY_ENABLED", botMode === "live"),
      maxVideoJobsPerUserPerDay: envInt("MAX_VIDEO_JOBS_PER_USER_PER_DAY", 3),
      maxVideoJobsPerDay: envInt("MAX_VIDEO_JOBS_PER_DAY", 10),
      maxPaidAttemptsPerJob: envInt("MAX_PAID_ATTEMPTS_PER_JOB", 1),
      // Claude API USD cap passed to `claude --max-budget-usd` (not Flow credits).
      maxClaudeBudgetUsdPerJob: envFloat("MAX_CLAUDE_BUDGET_USD_PER_JOB", 40),
      maxClaudeBudgetUsdPerDay: envFloat("MAX_CLAUDE_BUDGET_USD_PER_DAY", 120),
      // Operator-configured Flow credit ceiling enforced in the bot-mode prompt.
      maxFlowCreditsPerJob: envInt("MAX_FLOW_CREDITS_PER_JOB", 80),
      currency: "USD",
    },
  };

  if (botMode === "live") {
    validateLiveSpending(config.spending);
    if (!fs.existsSync(config.contractPath)) {
      throw new Error(`Bot contract missing: ${config.contractPath}`);
    }
  }

  return config;
}

function validateLiveSpending(s) {
  if (!s.enabled) {
    throw new Error(
      "Live mode requires SPENDING_POLICY_ENABLED=true (fail-closed)."
    );
  }
  const requiredPositive = [
    ["MAX_VIDEO_JOBS_PER_USER_PER_DAY", s.maxVideoJobsPerUserPerDay],
    ["MAX_VIDEO_JOBS_PER_DAY", s.maxVideoJobsPerDay],
    ["MAX_PAID_ATTEMPTS_PER_JOB", s.maxPaidAttemptsPerJob],
    ["MAX_FLOW_CREDITS_PER_JOB", s.maxFlowCreditsPerJob],
  ];
  for (const [name, value] of requiredPositive) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be an integer >= 1 for live mode`);
    }
  }
  if (!(s.maxClaudeBudgetUsdPerJob > 0) || !(s.maxClaudeBudgetUsdPerDay > 0)) {
    throw new Error(
      "MAX_CLAUDE_BUDGET_USD_PER_JOB and MAX_CLAUDE_BUDGET_USD_PER_DAY must be > 0 in live mode"
    );
  }
}

function ensureRuntimeDirs(config) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  fs.mkdirSync(config.jobsWorkspaceDir, { recursive: true });
  fs.mkdirSync(path.join(config.runtimeDir, "logs"), { recursive: true });
}

module.exports = {
  ROOT,
  loadConfig,
  ensureRuntimeDirs,
  envBool,
  envInt,
  envFloat,
};
