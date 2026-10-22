const { utcDayStartIso } = require("./jobStore");

/**
 * Fail-closed spending / rate gates for live video production.
 *
 * Limitations (documented honestly):
 * - Google Flow does not expose a programmatic monetary wallet API to this bot.
 * - MAX_FLOW_CREDITS_PER_JOB is an operator-configured credit ceiling enforced
 *   in the Claude bot-mode prompt (live quote check), not a Cloud Billing API.
 * - MAX_CLAUDE_BUDGET_USD_* caps Claude Code API spend via `--max-budget-usd`,
 *   not HeyGen / ElevenLabs / Flow account balances.
 * - Job-count caps are the strongest verifiable local controls.
 */
function evaluateVideoApproval(store, config, { telegramUserId }) {
  const spending = config.spending;
  if (!spending.enabled) {
    return {
      ok: false,
      code: "POLICY_DISABLED",
      message:
        "Spending policy is not enabled. Live video generation is blocked (fail-closed).",
    };
  }

  if (
    !Number.isInteger(spending.maxVideoJobsPerUserPerDay) ||
    spending.maxVideoJobsPerUserPerDay < 1 ||
    !Number.isInteger(spending.maxVideoJobsPerDay) ||
    spending.maxVideoJobsPerDay < 1 ||
    !Number.isInteger(spending.maxPaidAttemptsPerJob) ||
    spending.maxPaidAttemptsPerJob < 1 ||
    !Number.isInteger(spending.maxFlowCreditsPerJob) ||
    spending.maxFlowCreditsPerJob < 1 ||
    !(spending.maxClaudeBudgetUsdPerJob > 0)
  ) {
    return {
      ok: false,
      code: "POLICY_INVALID",
      message:
        "Spending limits are missing or invalid. Live video generation is blocked.",
    };
  }

  const dayStart = utcDayStartIso();
  const userCount = store.countVideoJobsSince(telegramUserId, dayStart);
  if (userCount >= spending.maxVideoJobsPerUserPerDay) {
    return {
      ok: false,
      code: "USER_DAILY_CAP",
      message: `You have reached today's video limit (${spending.maxVideoJobsPerUserPerDay}).`,
    };
  }

  const globalCount = store.countGlobalVideoJobsSince(dayStart);
  if (globalCount >= spending.maxVideoJobsPerDay) {
    return {
      ok: false,
      code: "GLOBAL_DAILY_CAP",
      message: `The bot has reached today's global video limit (${spending.maxVideoJobsPerDay}). Try again tomorrow.`,
    };
  }

  return {
    ok: true,
    limits: {
      maxFlowCreditsPerJob: spending.maxFlowCreditsPerJob,
      maxClaudeBudgetUsdPerJob: spending.maxClaudeBudgetUsdPerJob,
      maxPaidAttemptsPerJob: spending.maxPaidAttemptsPerJob,
      userVideosUsedToday: userCount,
      globalVideosUsedToday: globalCount,
      currency: spending.currency,
    },
  };
}

function canAcceptNewIdea(store, config, { telegramUserId }) {
  if (store.countActiveJobsForUser(telegramUserId) >= config.maxActiveJobsPerUser) {
    return {
      ok: false,
      message: `You already have ${config.maxActiveJobsPerUser} active job(s). Wait for one to finish or /cancel.`,
    };
  }
  if (store.countQueuedJobs() >= config.maxQueueLength) {
    return {
      ok: false,
      message: "The queue is full. Please try again in a few minutes.",
    };
  }
  return { ok: true };
}

module.exports = {
  evaluateVideoApproval,
  canAcceptNewIdea,
};
