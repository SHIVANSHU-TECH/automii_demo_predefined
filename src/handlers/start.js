const { InlineKeyboard } = require("grammy");
const {
  resetSession,
  clearApproval,
  STATES,
} = require("../services/sessionStore");
const { listSupportedTopics } = require("../services/demoMatcher");
const { logger } = require("../utils/logger");

function registerStartHandlers(bot, { demos, config, store }) {
  bot.command("start", async (ctx) => {
    if (!isAllowedChat(ctx, config)) {
      await ctx.reply("Automii Stage-1 MVP supports private chats only.");
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    resetSession(chatId);
    if (config.botMode === "live" && store) {
      store.clearSession(chatId, userId, "live");
    }

    logger.info("/start", { chatId: String(chatId), mode: config.botMode });

    if (config.botMode === "live") {
      await ctx.reply(
        [
          "Welcome to Automii (live mode).",
          "",
          "Send me a topic idea. I will generate a real script with Claude Code,",
          "then ask you to approve video generation (Google Flow + Cloudinary).",
          "",
          "Commands: /help  /cancel  /status",
        ].join("\n")
      );
      return;
    }

    await ctx.reply(
      "Welcome! Send me a message to generate your script and then a video."
    );
  });

  bot.command("cancel", async (ctx) => {
    if (!isAllowedChat(ctx, config)) return;
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;

    if (config.botMode === "live" && store) {
      const session = store.getSession(chatId);
      if (session?.active_job_id) {
        const result = store.cancelJob({
          jobId: session.active_job_id,
          telegramUserId: userId,
          chatId,
        });
        if (result.ok) {
          await ctx.reply(
            "Session cleared / job cancelled. Send a new idea when ready."
          );
          return;
        }
      }
      store.clearSession(chatId, userId, "live");
    }

    clearApproval(chatId);
    logger.info("/cancel", { chatId: String(chatId) });
    await ctx.reply(
      "Session cleared. Send me another idea whenever you're ready."
    );
  });

  bot.command("status", async (ctx) => {
    if (!isAllowedChat(ctx, config)) return;
    if (config.botMode !== "live" || !store) {
      await ctx.reply(`Mode: ${config.botMode}. No live job store.`);
      return;
    }
    const session = store.getSession(ctx.chat.id);
    if (!session?.active_job_id) {
      await ctx.reply("No active job. Send a topic to start.");
      return;
    }
    const job = store.getJob(session.active_job_id);
    if (!job) {
      await ctx.reply("No active job found.");
      return;
    }
    await ctx.reply(
      [
        `Job: ${job.id}`,
        `Status: ${job.status}`,
        `Topic: ${job.topic.slice(0, 120)}`,
        job.error ? `Error: ${job.error}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  });

  bot.command("help", async (ctx) => {
    if (config.botMode === "live") {
      await ctx.reply(
        [
          "Automii Bot — live Stage-1 MVP",
          "",
          "1. Send /start",
          "2. Send a topic idea (private chat)",
          "3. Review the generated script",
          "4. Tap Yes to authorize video generation within configured spending limits",
          "",
          "Commands: /start  /cancel  /status  /help",
          "",
          `Skill: ${config.skillName}`,
          `Composition: ${config.compositionPath}`,
          "Production concurrency: 1 (Google Flow serialized)",
        ].join("\n")
      );
      return;
    }

    const topics = listSupportedTopics(demos);
    await ctx.reply(
      [
        "Automii Bot — interactive demo (mock mode)",
        "",
        "Scripts and videos are predefined — no live AI generation.",
        "",
        "Commands:",
        "/start — reset and begin",
        "/cancel — clear pending approval",
        "/help — show this message",
        "",
        "Supported demo topics:",
        topics || "• (none configured)",
        "",
        "Example: Generate a horror video about a haunted house.",
        "",
        "Set BOT_MODE=live in .env for real Claude + Google Flow jobs.",
      ].join("\n")
    );
  });
}

function isAllowedChat(ctx, config) {
  if (!config.privateChatsOnly) return true;
  return ctx.chat?.type === "private";
}

function approvalKeyboard(jobId, approvalToken) {
  return new InlineKeyboard()
    .text("✅ Yes, generate video", `approve:${jobId}:${approvalToken}`)
    .row()
    .text("❌ No, cancel", `cancel:${jobId}:${approvalToken}`);
}

function tryAnotherKeyboard() {
  return new InlineKeyboard().text("Try another idea", "try_another");
}

module.exports = {
  registerStartHandlers,
  approvalKeyboard,
  tryAnotherKeyboard,
  STATES,
  isAllowedChat,
};
