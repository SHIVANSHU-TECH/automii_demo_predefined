const {
  getSession,
  updateSession,
  clearApproval,
  resetSession,
  STATES,
} = require("../services/sessionStore");
const { findDemoById } = require("../services/demoMatcher");
const {
  sendDemoVideo,
  userFacingVideoError,
} = require("../services/videoDelivery");
const { tryAnotherKeyboard, isAllowedChat } = require("./start");
const { evaluateVideoApproval } = require("../services/spendingPolicy");
const { notify, MESSAGES } = require("../services/progressNotifier");
const { logger } = require("../utils/logger");

function registerCallbackHandlers(bot, { demos, config, store }) {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat?.id;
    const userId = ctx.from?.id;

    if (chatId == null) {
      await ctx.answerCallbackQuery({ text: "Unable to identify chat." });
      return;
    }

    if (!isAllowedChat(ctx, config)) {
      await ctx.answerCallbackQuery({ text: "Private chats only." });
      return;
    }

    try {
      if (data === "try_another") {
        await handleTryAnother(ctx, chatId, config, store, userId);
        return;
      }

      if (data.startsWith("approve:")) {
        await handleLiveApprove(ctx, chatId, userId, data, config, store);
        return;
      }

      if (data.startsWith("cancel:")) {
        await handleLiveCancel(ctx, chatId, userId, data, store);
        return;
      }

      if (data.startsWith("mock_approve:")) {
        await handleMockApprove(
          ctx,
          chatId,
          data.slice("mock_approve:".length),
          demos
        );
        return;
      }

      if (data.startsWith("mock_cancel:")) {
        await handleMockCancel(
          ctx,
          chatId,
          data.slice("mock_cancel:".length)
        );
        return;
      }

      await ctx.answerCallbackQuery({ text: "Unknown action." });
      logger.warn("Unexpected callback data", { data, chatId: String(chatId) });
    } catch (err) {
      logger.error("Callback handler error:", err);
      try {
        await ctx.answerCallbackQuery({ text: "Something went wrong." });
      } catch {
        /* ignore */
      }
    }
  });
}

async function handleTryAnother(ctx, chatId, config, store, userId) {
  await ctx.answerCallbackQuery();
  resetSession(chatId);
  if (config.botMode === "live" && store) {
    store.clearSession(chatId, userId, "live");
  }
  await ctx.reply(
    "Great! Send me a new idea to generate your script and then a video."
  );
}

function parseJobCallback(data, prefix) {
  // approve:job_xxx:token  or cancel:job_xxx:token
  const rest = data.slice(prefix.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  return {
    jobId: rest.slice(0, idx),
    token: rest.slice(idx + 1),
  };
}

async function handleLiveApprove(ctx, chatId, userId, data, config, store) {
  if (config.botMode !== "live" || !store) {
    await ctx.answerCallbackQuery({ text: "Live mode is off." });
    return;
  }
  if (!userId) {
    await ctx.answerCallbackQuery({ text: "Unable to identify user." });
    return;
  }

  const parsed = parseJobCallback(data, "approve:");
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "Invalid approval payload." });
    return;
  }

  const policy = evaluateVideoApproval(store, config, {
    telegramUserId: userId,
  });
  if (!policy.ok) {
    await ctx.answerCallbackQuery({ text: "Limit reached." });
    await ctx.reply(policy.message);
    return;
  }

  const result = store.approveVideo({
    jobId: parsed.jobId,
    token: parsed.token,
    telegramUserId: userId,
    chatId,
  });

  if (!result.ok) {
    const text =
      result.reason === "bad_token" || result.reason === "wrong_user"
        ? "This request is no longer active."
        : result.reason === "paid_attempts_exhausted"
          ? "Paid attempts exhausted for this job."
          : result.reason === "wrong_status"
            ? "Already handled."
            : "Unable to approve.";
    await ctx.answerCallbackQuery({ text });
    await safeEditButtons(ctx);
    return;
  }

  store.recordSpendingEvent({
    jobId: parsed.jobId,
    telegramUserId: userId,
    eventType: "video_approved",
    meta: policy.limits,
  });

  await ctx.answerCallbackQuery({ text: "Queued for video…" });
  await safeEditButtons(ctx, "Approved — queued for video generation…");
  await notify(ctx.api, chatId, MESSAGES.videoQueued);
}

async function handleLiveCancel(ctx, chatId, userId, data, store) {
  const parsed = parseJobCallback(data, "cancel:");
  if (!parsed || !store) {
    await ctx.answerCallbackQuery({ text: "Invalid cancel payload." });
    return;
  }

  const result = store.cancelJob({
    jobId: parsed.jobId,
    token: parsed.token,
    telegramUserId: userId,
    chatId,
  });

  if (!result.ok) {
    await ctx.answerCallbackQuery({
      text: "This request is no longer active.",
    });
    await safeEditButtons(ctx);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Cancelled." });
  await safeEditButtons(ctx);
  await ctx.reply(MESSAGES.cancelled);
}

async function handleMockCancel(ctx, chatId, token) {
  const session = getSession(chatId);

  if (
    session.state !== STATES.AWAITING_APPROVAL ||
    !session.approvalToken ||
    session.approvalToken !== token
  ) {
    await ctx.answerCallbackQuery({
      text: "This request is no longer active.",
    });
    await safeEditButtons(ctx);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Cancelled." });
  clearApproval(chatId);
  await safeEditButtons(ctx);
  await ctx.reply("No problem! Send me another idea whenever you're ready.");
}

async function handleMockApprove(ctx, chatId, token, demos) {
  const session = getSession(chatId);

  if (
    !session.approvalToken ||
    session.approvalToken !== token ||
    !session.demoId
  ) {
    await ctx.answerCallbackQuery({
      text: "This request is no longer active.",
    });
    await safeEditButtons(ctx);
    return;
  }

  if (session.videoSent || session.state === STATES.SENDING_VIDEO) {
    await ctx.answerCallbackQuery({
      text: "Video already requested — please wait.",
    });
    return;
  }

  if (session.state !== STATES.AWAITING_APPROVAL) {
    await ctx.answerCallbackQuery({
      text: "This request is no longer active.",
    });
    return;
  }

  const demo = findDemoById(session.demoId, demos);
  if (!demo) {
    await ctx.answerCallbackQuery({ text: "Demo not found." });
    clearApproval(chatId);
    await ctx.reply(
      "Sorry — that demo is no longer available. Send /start and try another idea."
    );
    return;
  }

  updateSession(chatId, {
    state: STATES.SENDING_VIDEO,
    videoSent: true,
  });

  await ctx.answerCallbackQuery({ text: "Generating…" });
  await safeEditButtons(ctx, "Generating video…");
  await ctx.reply("Preparing your video... 🎬");

  const caption =
    demo.videoCaption || `Your video is ready! 🎬\n${demo.title}`;

  try {
    await sendDemoVideo(ctx.api, chatId, {
      videoUrl: demo.videoUrl,
      caption,
    });

    clearApproval(chatId);
    await ctx.reply("Want to try another idea?", {
      reply_markup: tryAnotherKeyboard(),
    });
  } catch (err) {
    logger.error("Video delivery failed for chat", String(chatId), err);
    clearApproval(chatId);
    await ctx.reply(userFacingVideoError(err));
  }
}

async function safeEditButtons(ctx, label) {
  try {
    if (label) {
      await ctx.editMessageText(label);
    } else if (ctx.callbackQuery.message?.reply_markup) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    }
  } catch (err) {
    logger.debug("Could not update inline buttons:", err.message);
  }
}

module.exports = { registerCallbackHandlers };
