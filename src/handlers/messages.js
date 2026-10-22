const crypto = require("crypto");
const {
  getSession,
  updateSession,
  STATES,
} = require("../services/sessionStore");
const { matchDemo, listSupportedTopics } = require("../services/demoMatcher");
const { isAllowedChat } = require("./start");
const { canAcceptNewIdea } = require("../services/spendingPolicy");
const { notify, MESSAGES } = require("../services/progressNotifier");
const { logger } = require("../utils/logger");

function registerMessageHandlers(bot, { demos, config, store }) {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text || "";
    if (text.startsWith("/")) return;

    if (!isAllowedChat(ctx, config)) {
      await ctx.reply("Automii Stage-1 MVP supports private chats only.");
      return;
    }

    if (config.botMode === "live") {
      await handleLiveIdea(ctx, { config, store });
      return;
    }

    await handleMockIdea(ctx, { demos });
  });
}

async function handleLiveIdea(ctx, { config, store }) {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  const text = (ctx.message.text || "").trim();

  if (!userId) {
    await ctx.reply("Unable to identify Telegram user.");
    return;
  }
  if (!text) {
    await ctx.reply("Please send a non-empty topic idea.");
    return;
  }

  const gate = canAcceptNewIdea(store, config, { telegramUserId: userId });
  if (!gate.ok) {
    await ctx.reply(gate.message);
    return;
  }

  // Idempotency for Telegram redelivery: same chat+user+message id
  const idempotencyKey = `msg:${chatId}:${userId}:${ctx.message.message_id}`;

  const { job, reused } = store.createScriptJob({
    telegramUserId: userId,
    chatId,
    topic: text,
    compositionPath: config.compositionPath,
    maxPaidAttempts: config.spending.maxPaidAttemptsPerJob,
    maxFlowCredits: config.spending.maxFlowCreditsPerJob,
    maxClaudeBudgetUsd: config.spending.maxClaudeBudgetUsdPerJob,
    idempotencyKey,
  });

  logger.info("Live script job", {
    jobId: job.id,
    reused,
    chatId: String(chatId),
  });

  if (!reused) {
    await notify(ctx.api, chatId, MESSAGES.scriptQueued);
  } else {
    await ctx.reply(`Reusing existing job ${job.id} (status: ${job.status}).`);
  }
}

async function handleMockIdea(ctx, { demos }) {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  const text = ctx.message.text || "";

  if (session.state === STATES.SENDING_VIDEO) {
    await ctx.reply("Hang tight — I'm still preparing your video… 🎬");
    return;
  }

  if (session.state === STATES.AWAITING_APPROVAL) {
    await ctx.reply(
      "You already have a script waiting. Use the Yes / No buttons above, or send /cancel to start over."
    );
    return;
  }

  const demo = matchDemo(text, demos);

  if (!demo) {
    logger.info("No demo match", { chatId: String(chatId), text });
    const topics = listSupportedTopics(demos);
    await ctx.reply(
      [
        "I couldn't match that to a supported demo topic.",
        "",
        "Try one of these:",
        topics,
        "",
        "Example: Generate a horror video about a haunted house.",
        "",
        "(Live mode is off — set BOT_MODE=live for real generation.)",
      ].join("\n")
    );
    return;
  }

  const approvalToken = crypto.randomBytes(8).toString("hex");
  updateSession(chatId, {
    state: STATES.AWAITING_APPROVAL,
    demoId: demo.id,
    approvalToken,
    videoSent: false,
  });

  logger.info("Demo selected", {
    chatId: String(chatId),
    demoId: demo.id,
  });

  await ctx.reply("Your script is ready! 🎬");
  await ctx.reply([demo.title, "", demo.script].join("\n"));

  // Mock callbacks still use approve:token (no job id) — handled in callbacks.js
  const prompt = await ctx.reply("Would you like me to generate the video?", {
    reply_markup: new (require("grammy").InlineKeyboard)()
      .text("✅ Yes, generate video", `mock_approve:${approvalToken}`)
      .row()
      .text("❌ No, cancel", `mock_cancel:${approvalToken}`),
  });

  updateSession(chatId, { promptMessageId: prompt.message_id });
}

module.exports = { registerMessageHandlers };
