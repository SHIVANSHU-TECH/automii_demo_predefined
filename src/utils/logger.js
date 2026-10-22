/**
 * Simple terminal logger. Never logs secrets or full bot tokens.
 */

function stamp() {
  return new Date().toISOString();
}

function sanitize(value) {
  if (typeof value !== "string") return value;
  // Redact anything that looks like a Telegram bot token pattern
  return value.replace(/\d{8,}:[A-Za-z0-9_-]{30,}/g, "[REDACTED_TOKEN]");
}

function formatArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return sanitize(arg.stack || arg.message);
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return sanitize(JSON.stringify(arg));
      } catch {
        return String(arg);
      }
    }
    return sanitize(String(arg));
  });
}

const logger = {
  info(...args) {
    console.log(`[${stamp()}] INFO `, ...formatArgs(args));
  },
  warn(...args) {
    console.warn(`[${stamp()}] WARN `, ...formatArgs(args));
  },
  error(...args) {
    console.error(`[${stamp()}] ERROR`, ...formatArgs(args));
  },
  debug(...args) {
    if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
      console.log(`[${stamp()}] DEBUG`, ...formatArgs(args));
    }
  },
};

module.exports = { logger };
