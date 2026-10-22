// Prefer project .env over leftover shell vars (e.g. BOT_MODE=mock from a prior session).
require("dotenv").config({ override: true });

const http = require("http");
const { Bot } = require("grammy");
const { checkConfig } = require("./checkConfig");
const { loadConfig, ensureRuntimeDirs } = require("./config");
const { JobStore } = require("./services/jobStore");
const { JobQueue } = require("./services/jobQueue");
const { registerStartHandlers } = require("./handlers/start");
const { registerMessageHandlers } = require("./handlers/messages");
const { registerCallbackHandlers } = require("./handlers/callbacks");
const { logger } = require("./utils/logger");

async function main() {
  let appConfig;
  try {
    appConfig = loadConfig();
  } catch (err) {
    logger.error(`Config error: ${err.message}`);
    process.exit(1);
  }

  let demosConfig;
  try {
    demosConfig = checkConfig({
      requireToken: true,
      botMode: appConfig.botMode,
    });
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  ensureRuntimeDirs(appConfig);

  let store = null;
  let queue = null;

  if (appConfig.botMode === "live") {
    store = new JobStore({ dbPath: appConfig.dbPath });
    logger.info("Live mode SQLite ready", { dbPath: appConfig.dbPath });
  }

  const token = process.env.BOT_TOKEN.trim();
  const bot = new Bot(token);
  const demos = demosConfig.demos;
  const ctx = { demos, config: appConfig, store };

  registerStartHandlers(bot, ctx);
  registerMessageHandlers(bot, ctx);
  registerCallbackHandlers(bot, ctx);

  if (appConfig.botMode === "live") {
    queue = new JobQueue({
      store,
      config: appConfig,
      getApi: () => bot.api,
    });
    queue.start();
  }

  bot.catch((err) => {
    const c = err.ctx;
    logger.error("Unhandled bot error", {
      updateType: c?.update ? Object.keys(c.update).join(",") : "unknown",
      message: err.error?.message || err.message,
      description: err.error?.description,
    });
  });

  const shutdown = async (signal) => {
    logger.info(`Shutting down (${signal})…`);
    try {
      if (queue) await queue.stop();
    } catch (err) {
      logger.warn("Queue stop error", err.message);
    }
    try {
      bot.stop();
    } catch {
      /* ignore */
    }
    try {
      if (store) store.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Automii Bot starting (long polling)…", {
    mode: appConfig.botMode,
  });
  logger.info("Open your bot in Telegram to test once the token is configured.");

  // Render web services require a process listening on PORT.
  const port = Number(process.env.PORT);
  if (port) {
    http
      .createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      })
      .listen(port, () => {
        logger.info(`Health check listening on port ${port}`);
      });
  }

  try {
    await startPolling(bot);
  } catch (err) {
    logger.error("Failed to start polling:", err.description || err.message);
    if (isPollingConflict(err)) {
      logger.error(
        "Polling conflict: stop every other copy of this bot, including one running on your computer, then redeploy."
      );
    }
    if (err.error_code === 401) {
      logger.error(
        "Invalid BOT_TOKEN. Regenerate the token in @BotFather and update the Render environment variable."
      );
    }
    if (queue) await queue.stop();
    if (store) store.close();
    process.exit(1);
  }
}

function isPollingConflict(err) {
  return (
    err.error_code === 409 ||
    String(err.message || "").includes("409") ||
    String(err.description || "").includes("Conflict") ||
    String(err.message || "").includes("terminated by other getUpdates")
  );
}

async function startPolling(bot) {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await bot.start({
        onStart: (info) => {
          logger.info(`Bot @${info.username} is online (id=${info.id}).`);
        },
      });
      return;
    } catch (err) {
      if (!isPollingConflict(err) || attempt === attempts) {
        throw err;
      }
      logger.warn(
        `Another copy is still polling. Retry ${attempt}/${attempts} in 8 seconds.`
      );
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
  }
}

main();
