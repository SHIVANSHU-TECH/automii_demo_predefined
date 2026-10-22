const { STATUSES } = require("./jobStore");
const { runClaudeJob } = require("./claudeWorker");
const { notify, MESSAGES } = require("./progressNotifier");
const {
  sendDemoVideo,
  userFacingVideoError,
  validateVideoUrl,
} = require("./videoDelivery");
const { logger } = require("../utils/logger");

/**
 * Single-process dispatcher: global concurrency 1 for all Claude/Flow work.
 */
class JobQueue {
  /**
   * @param {{ store: import('./jobStore').JobStore, config: object, getApi: () => any }} opts
   */
  constructor({ store, config, getApi }) {
    this.store = store;
    this.config = config;
    this.getApi = getApi;
    this._timer = null;
    this._running = false;
    this._busy = false;
    this._shuttingDown = false;
    this.dryRun = process.env.CLAUDE_DRY_RUN === "1" || process.env.CLAUDE_DRY_RUN === "true";
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._shuttingDown = false;
    this.store.recoverAfterRestart();
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.error("Dispatcher tick error", err));
    }, this.config.dispatcherPollMs);
    logger.info("Job dispatcher started", {
      pollMs: this.config.dispatcherPollMs,
      dryRun: this.dryRun,
    });
  }

  async stop() {
    this._shuttingDown = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Wait briefly for in-flight tick to finish without claiming new work
    const start = Date.now();
    while (this._busy && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this._running = false;
    logger.info("Job dispatcher stopped");
  }

  async tick() {
    if (this._busy || this._shuttingDown) return;
    if (this.config.botMode !== "live") return;

    const job = this.store.claimNextJob();
    if (!job) return;

    this._busy = true;
    try {
      if (job.status === STATUSES.GENERATING_SCRIPT) {
        await this._runScript(job);
      } else if (job.status === STATUSES.GENERATING_VIDEO) {
        await this._runVideo(job);
      }
    } catch (err) {
      logger.error("Job processing crashed", {
        jobId: job.id,
        message: err.message,
      });
      try {
        // If we were in video generation, prefer reconciliation over blind fail/retry
        if (job.status === STATUSES.GENERATING_VIDEO) {
          this.store.transition(job.id, STATUSES.NEEDS_RECONCILIATION, {
            error: err.message,
          });
          await notify(this.getApi(), job.chatId, MESSAGES.reconciliation);
        } else {
          this.store.transition(job.id, STATUSES.FAILED, { error: err.message });
          await notify(this.getApi(), job.chatId, MESSAGES.failed(err.message));
        }
      } catch (e2) {
        logger.error("Failed to record job crash", e2.message);
      }
    } finally {
      this._busy = false;
    }
  }

  async _runScript(job) {
    const api = this.getApi();
    await notify(api, job.chatId, MESSAGES.scriptStarted);

    const result = await runClaudeJob({
      config: this.config,
      job,
      phase: "script",
      timeoutMs: this.config.scriptTimeoutMs,
      dryRun: this.dryRun,
    });

    if (result.sessionId) {
      this.store.setClaudeSessionId(job.id, result.sessionId);
    }

    if (!result.ok || !result.payload?.script) {
      this.store.transition(job.id, STATUSES.FAILED, {
        error: result.error || "Script generation failed",
        claudeSessionId: result.sessionId,
        diagnostics: result.payload?.diagnostics || { timedOut: result.timedOut },
      });
      await notify(api, job.chatId, MESSAGES.failed(result.error));
      return;
    }

    const script = String(result.payload.script).trim();
    const title =
      (result.payload.scriptTitle && String(result.payload.scriptTitle).trim()) ||
      "Your Automii script";

    this.store.transition(job.id, STATUSES.AWAITING_APPROVAL, {
      scriptText: script,
      scriptTitle: title,
      claudeSessionId: result.sessionId,
      diagnostics: result.payload.diagnostics || null,
    });

    const fresh = this.store.getJob(job.id);
    await notify(api, job.chatId, "Your script is ready! 🎬");
    await api.sendMessage(job.chatId, [title, "", script].join("\n"));

    const { InlineKeyboard } = require("grammy");
    const keyboard = new InlineKeyboard()
      .text("✅ Yes, generate video", `approve:${fresh.id}:${fresh.approvalToken}`)
      .row()
      .text("❌ No, cancel", `cancel:${fresh.id}:${fresh.approvalToken}`);

    await api.sendMessage(job.chatId, MESSAGES.scriptReady, {
      reply_markup: keyboard,
    });
  }

  async _runVideo(job) {
    const api = this.getApi();

    // Fail closed before any paid provider path when dry-run is on.
    if (this.dryRun) {
      const result = await runClaudeJob({
        config: this.config,
        job,
        phase: "video",
        timeoutMs: this.config.videoTimeoutMs,
        dryRun: true,
      });
      this.store.transition(job.id, STATUSES.FAILED, {
        error: result.error || "Dry-run blocked paid video production",
        diagnostics: { dryRun: true, paidOperationsBlocked: true },
      });
      this.store.recordSpendingEvent({
        jobId: job.id,
        telegramUserId: job.telegramUserId,
        eventType: "video_dry_run_blocked",
        meta: { paidOperationsBlocked: true },
      });
      await notify(
        api,
        job.chatId,
        "Dry-run mode: approval was recorded, but paid video generation is blocked (CLAUDE_DRY_RUN=1). No Flow/HeyGen/ElevenLabs/Cloudinary calls were made.\n\nSet CLAUDE_DRY_RUN=0 only when you are ready to spend credits."
      );
      return;
    }

    await notify(api, job.chatId, MESSAGES.videoStarted);

    this.store.recordSpendingEvent({
      jobId: job.id,
      telegramUserId: job.telegramUserId,
      eventType: "video_production_started",
      meta: {
        compositionPath: job.compositionPath,
        maxFlowCredits: job.maxFlowCredits,
        paidAttempts: job.paidAttempts,
      },
    });

    const result = await runClaudeJob({
      config: this.config,
      job,
      phase: "video",
      timeoutMs: this.config.videoTimeoutMs,
      dryRun: false,
    });

    if (result.needsReconciliation) {
      this.store.transition(job.id, STATUSES.NEEDS_RECONCILIATION, {
        error: result.error || "Worker reported needs_reconciliation",
        diagnostics: result.payload?.diagnostics || null,
        claudeSessionId: result.sessionId,
      });
      await notify(api, job.chatId, MESSAGES.reconciliation);
      return;
    }

    if (result.timedOut) {
      this.store.transition(job.id, STATUSES.NEEDS_RECONCILIATION, {
        error: result.error,
        claudeSessionId: result.sessionId,
      });
      await notify(api, job.chatId, MESSAGES.reconciliation);
      return;
    }

    if (!result.ok) {
      this.store.transition(job.id, STATUSES.FAILED, {
        error: result.error || "Video generation failed",
        diagnostics: result.payload?.diagnostics || null,
        claudeSessionId: result.sessionId,
      });
      await notify(api, job.chatId, MESSAGES.failed(result.error));
      return;
    }

    const url =
      result.payload.cloudinaryUrl ||
      result.payload.fallbackVideoUrl ||
      null;

    if (!url) {
      this.store.transition(job.id, STATUSES.FAILED, {
        error: "Worker succeeded but returned no video URL",
        diagnostics: result.payload.diagnostics || null,
      });
      await notify(api, job.chatId, MESSAGES.failed("No video URL returned."));
      return;
    }

    const validation = validateVideoUrl(url);
    if (!validation.ok) {
      this.store.transition(job.id, STATUSES.FAILED, {
        error: validation.error,
        cloudinaryUrl: result.payload.cloudinaryUrl || null,
        fallbackVideoUrl: result.payload.fallbackVideoUrl || null,
      });
      await notify(api, job.chatId, MESSAGES.failed(validation.error));
      return;
    }

    this.store.transition(job.id, STATUSES.UPLOADING, {
      cloudinaryUrl: result.payload.cloudinaryUrl || null,
      fallbackVideoUrl: result.payload.fallbackVideoUrl || null,
      diagnostics: result.payload.diagnostics || null,
      claudeSessionId: result.sessionId,
    });
    await notify(api, job.chatId, MESSAGES.uploading);

    this.store.transition(job.id, STATUSES.DELIVERING, {});
    await notify(api, job.chatId, MESSAGES.delivering);

    const caption = `Your video is ready! 🎬\n${job.scriptTitle || ""}`.trim();

    try {
      await sendDemoVideo(api, job.chatId, { videoUrl: url, caption });
      this.store.transition(job.id, STATUSES.COMPLETED, {});
      this.store.clearActiveJobIfMatch(job.chatId, job.id);
      this.store.recordSpendingEvent({
        jobId: job.id,
        telegramUserId: job.telegramUserId,
        eventType: "video_delivered",
        meta: { urlHost: safeHost(url) },
      });
      await notify(api, job.chatId, MESSAGES.ready);
      const { InlineKeyboard } = require("grammy");
      await api.sendMessage(job.chatId, "Want to try another idea?", {
        reply_markup: new InlineKeyboard().text("Try another idea", "try_another"),
      });
    } catch (err) {
      logger.error("Telegram delivery failed", err);
      this.store.transition(job.id, STATUSES.FAILED, {
        error: err.message,
      });
      await notify(api, job.chatId, userFacingVideoError(err));
    }
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

module.exports = { JobQueue };
