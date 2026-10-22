const { logger } = require("../utils/logger");

/**
 * Best-effort Telegram progress messages. Never throws to callers.
 */
async function notify(api, chatId, text) {
  try {
    await api.sendMessage(chatId, text);
  } catch (err) {
    logger.warn("Progress notify failed", {
      chatId: String(chatId),
      message: err.message,
    });
  }
}

const MESSAGES = {
  scriptQueued: "Your script request is queued…",
  scriptStarted: "Your script is being prepared…",
  scriptReady: "Your script is ready. Would you like to generate the video?",
  videoQueued: "Your video request is queued.",
  videoStarted: "Video generation has started. This can take a while.",
  uploading: "Your video is being uploaded…",
  delivering: "Delivering your video…",
  ready: "Your video is ready! 🎬",
  failed: (err) => {
    const detail = String(err || "").trim();
    const lower = detail.toLowerCase();
    if (lower.includes("session limit") || lower.includes("resets ")) {
      return (
        "Claude hit a temporary session limit, so this job did not run.\n" +
        `${detail}\n\n` +
        "Please wait until the reset time, then send a new idea with /start."
      );
    }
    return `Sorry — this job failed.\n${detail || "Please try again with /start."}`;
  },
  cancelled: "Cancelled. Send a new idea whenever you're ready.",
  reconciliation:
    "This job may have started a paid step before interruption. It was marked for manual reconciliation and will not auto-regenerate.",
};

module.exports = {
  notify,
  MESSAGES,
};
