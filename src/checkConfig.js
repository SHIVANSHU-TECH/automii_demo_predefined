/**
 * Startup / CI helper: validates BOT_TOKEN and mode-specific requirements.
 * Usage: npm run check-config
 */
require("dotenv").config({ override: true });

const { loadDemos } = require("./services/demoMatcher");
const { loadConfig } = require("./config");
const { logger } = require("./utils/logger");

function checkConfig({ requireToken = true, botMode } = {}) {
  const skipToken =
    process.env.SKIP_TOKEN_CHECK === "1" ||
    process.env.SKIP_TOKEN_CHECK === "true" ||
    !requireToken;

  if (!skipToken) {
    const token = process.env.BOT_TOKEN;
    if (!token || token === "your_telegram_bot_token_here" || !token.trim()) {
      throw new Error(
        "BOT_TOKEN is missing. Copy .env.example to .env and set your Telegram bot token."
      );
    }
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token.trim())) {
      throw new Error(
        "BOT_TOKEN does not look like a valid Telegram bot token (expected format: 123456:ABC...)."
      );
    }
  }

  let mode = botMode;
  if (!mode) {
    mode = (process.env.BOT_MODE || "mock").toLowerCase();
  }

  // Always validate app config (spending fail-closed in live)
  const appConfig = loadConfig();

  if (mode === "mock" || appConfig.botMode === "mock") {
    const config = loadDemos();
    return config;
  }

  // Live mode: demos optional (kept for optional mock fallback demos file integrity)
  try {
    const config = loadDemos();
    return config;
  } catch (err) {
    logger.warn(
      `demos.json not loaded in live mode (ok): ${err.message}`
    );
    return { demos: [] };
  }
}

if (require.main === module) {
  try {
    const config = checkConfig({ requireToken: true });
    const app = loadConfig();
    logger.info(
      `Config OK — mode=${app.botMode}, demos=${config.demos.length}, skill=${app.skillName}`
    );
    process.exit(0);
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
}

module.exports = { checkConfig };
