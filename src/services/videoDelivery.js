const fs = require("fs");
const os = require("os");
const path = require("path");
const { InputFile } = require("grammy");
const { logger } = require("../utils/logger");

/** Telegram Bot API upload limit is 50 MB; keep a small safety margin. */
const TELEGRAM_UPLOAD_MAX_BYTES = 49 * 1024 * 1024;

/**
 * Validate that a video URL looks usable before asking Telegram to fetch it.
 * @param {string} videoUrl
 * @returns {{ ok: boolean, error?: string }}
 */
function validateVideoUrl(videoUrl) {
  if (!videoUrl || typeof videoUrl !== "string") {
    return { ok: false, error: "Video URL is missing." };
  }

  let parsed;
  try {
    parsed = new URL(videoUrl);
  } catch {
    return { ok: false, error: "Video URL is not a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Video URL must use http or https." };
  }

  const pathname = parsed.pathname.toLowerCase();
  const looksLikeMp4 =
    pathname.endsWith(".mp4") ||
    pathname.includes("/video/upload/") ||
    videoUrl.toLowerCase().includes(".mp4");

  if (!looksLikeMp4) {
    logger.warn("Video URL does not clearly look like an MP4:", videoUrl);
  }

  return { ok: true };
}

/**
 * Optionally HEAD-check the URL (best-effort; does not fail hard on network blocks).
 * @param {string} videoUrl
 * @returns {Promise<{ reachable: boolean, status?: number, contentType?: string, contentLength?: number, note?: string }>}
 */
async function probeVideoUrl(videoUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(videoUrl, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    const contentType = res.headers.get("content-type") || undefined;
    const lengthHeader = res.headers.get("content-length");
    const contentLength = lengthHeader ? Number(lengthHeader) : undefined;
    return {
      reachable: res.ok,
      status: res.status,
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      note: res.ok
        ? undefined
        : `HEAD request returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      reachable: false,
      note: `HEAD probe failed: ${err.message}`,
    };
  }
}

function isUrlFetchFailure(err) {
  const detail = String(err.description || err.message || "").toLowerCase();
  return (
    detail.includes("failed to get http url content") ||
    detail.includes("wrong type of the web page content") ||
    detail.includes("wrong file identifier") ||
    detail.includes("failed to get")
  );
}

/**
 * When the MP4 is too large for Telegram upload, deliver the permanent URL as text.
 * Job still counts as delivered — the video exists; only inline playback failed.
 */
async function sendVideoAsLink(api, chatId, { videoUrl, caption }) {
  const lines = [
    caption || "Your video is ready! 🎬",
    "",
    "The file is larger than Telegram’s ~50 MB bot upload limit, so here’s the direct download link:",
    videoUrl,
  ];
  const message = await api.sendMessage(chatId, lines.join("\n"), {
    link_preview_options: { is_disabled: false },
  });
  logger.info("Video delivered as download link (too large for bot upload):", {
    chatId: String(chatId),
    messageId: message.message_id,
  });
  return { ok: true, message, method: "link" };
}

/**
 * Download a remote MP4 to a temp file, then upload via Telegram InputFile.
 * Used when Telegram cannot fetch the Cloudinary URL itself.
 */
async function sendVideoViaDownload(api, chatId, { videoUrl, caption }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automii-video-"));
  const tmpFile = path.join(tmpDir, "demo.mp4");

  logger.info("Downloading video for Telegram upload fallback…", {
    chatId: String(chatId),
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(videoUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Download failed with HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);
    logger.info(`Downloaded ${sizeMb} MB — uploading to Telegram…`);

    if (buffer.length > TELEGRAM_UPLOAD_MAX_BYTES) {
      const err = new Error(
        `Downloaded video is ${sizeMb} MB; Telegram bot uploads are limited to ~50 MB.`
      );
      err.code = "VIDEO_TOO_LARGE";
      throw err;
    }

    fs.writeFileSync(tmpFile, buffer);

    const message = await api.sendVideo(chatId, new InputFile(tmpFile), {
      caption: caption || "Your video is ready! 🎬",
      supports_streaming: true,
    });

    logger.info("Video uploaded successfully via file fallback:", {
      chatId: String(chatId),
      messageId: message.message_id,
    });
    return { ok: true, message, method: "upload" };
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    } catch (cleanupErr) {
      logger.debug("Temp cleanup failed:", cleanupErr.message);
    }
  }
}

/**
 * Send a video to the chat.
 * Prefer URL or upload; if over Telegram’s ~50 MB bot limit, deliver the permanent link.
 *
 * @param {import("grammy").Api} api
 * @param {number|string} chatId
 * @param {{ videoUrl: string, caption?: string }} options
 */
async function sendDemoVideo(api, chatId, { videoUrl, caption }) {
  const validation = validateVideoUrl(videoUrl);
  if (!validation.ok) {
    const err = new Error(validation.error);
    err.code = "INVALID_VIDEO_URL";
    throw err;
  }

  const probe = await probeVideoUrl(videoUrl);
  if (!probe.reachable) {
    logger.warn("Video URL probe failed (will try download fallback):", {
      videoUrl,
      ...probe,
    });
  } else {
    logger.info("Video URL probe OK:", {
      status: probe.status,
      contentType: probe.contentType,
      contentLength: probe.contentLength,
    });
  }

  const knownTooLarge =
    typeof probe.contentLength === "number" &&
    probe.contentLength > TELEGRAM_UPLOAD_MAX_BYTES;

  // Prefer upload for mid-size files — Telegram often fails fetching ~20–49 MB URLs
  const preferUpload =
    !knownTooLarge &&
    typeof probe.contentLength === "number" &&
    probe.contentLength > 20 * 1024 * 1024;

  if (knownTooLarge) {
    logger.info(
      "Video exceeds Telegram upload limit; trying URL send, then link fallback."
    );
  }

  if (preferUpload) {
    logger.info(
      "Video is large; sending via download+upload to avoid Telegram URL fetch issues."
    );
    try {
      return await sendVideoViaDownload(api, chatId, { videoUrl, caption });
    } catch (uploadErr) {
      if (uploadErr.code === "VIDEO_TOO_LARGE") {
        logger.warn("Downloaded file too large for Telegram; trying URL then link.");
      } else {
        logger.warn("Upload fallback failed, trying URL send:", uploadErr.message);
      }
    }
  }

  try {
    const message = await api.sendVideo(chatId, videoUrl, {
      caption: caption || "Your video is ready! 🎬",
      supports_streaming: true,
    });
    logger.info("Video sent successfully via URL:", {
      chatId: String(chatId),
      messageId: message.message_id,
    });
    return { ok: true, message, method: "url" };
  } catch (err) {
    logger.error("Telegram sendVideo (URL) failed:", {
      chatId: String(chatId),
      videoUrl,
      description: err.description || err.message,
      errorCode: err.error_code,
    });

    if (!knownTooLarge && (isUrlFetchFailure(err) || !preferUpload)) {
      logger.info("Retrying with download+upload fallback…");
      try {
        return await sendVideoViaDownload(api, chatId, { videoUrl, caption });
      } catch (fallbackErr) {
        if (fallbackErr.code === "VIDEO_TOO_LARGE") {
          logger.warn(
            "Upload too large after URL failure; delivering permanent link instead."
          );
          return sendVideoAsLink(api, chatId, { videoUrl, caption });
        }
        logger.error("Download+upload fallback also failed:", fallbackErr.message);
        const wrapped = new Error(
          fallbackErr.message ||
            err.description ||
            err.message ||
            "Telegram rejected the video."
        );
        wrapped.code =
          fallbackErr.code || "TELEGRAM_SEND_VIDEO_FAILED";
        wrapped.cause = fallbackErr;
        throw wrapped;
      }
    }

    // URL fetch failed and file is (or may be) too large to upload — send link.
    logger.warn("Delivering permanent video link after Telegram send failure.");
    try {
      return await sendVideoAsLink(api, chatId, { videoUrl, caption });
    } catch (linkErr) {
      const wrapped = new Error(
        linkErr.message ||
          err.description ||
          err.message ||
          "Telegram rejected the video."
      );
      wrapped.code = "TELEGRAM_SEND_VIDEO_FAILED";
      wrapped.cause = linkErr;
      throw wrapped;
    }
  }
}

/**
 * Friendly user-facing error copy for video delivery failures.
 */
function userFacingVideoError(err) {
  const detail = (err && (err.description || err.message)) || "";
  const lower = detail.toLowerCase();

  if (err.code === "INVALID_VIDEO_URL") {
    return (
      "I couldn't use the configured video URL for this demo. " +
      "Please ask the demo operator to check data/demos.json."
    );
  }

  if (err.code === "VIDEO_TOO_LARGE" || lower.includes("50 mb")) {
    return (
      "This video is larger than Telegram’s ~50 MB bot upload limit.\n" +
      "Ask for the Cloudinary link, or try again after we compress under 50 MB."
    );
  }

  if (
    lower.includes("failed to get http url content") ||
    lower.includes("wrong type of the web page content") ||
    lower.includes("failed to get") ||
    lower.includes("wrong file identifier") ||
    lower.includes("download failed")
  ) {
    return (
      "I couldn't deliver this video to Telegram.\n\n" +
      "Likely causes:\n" +
      "• The Cloudinary URL is not publicly reachable\n" +
      "• The file isn't a Telegram-supported MP4\n" +
      "• The file is too large\n\n" +
      "Please try again, or ask the operator to check the video URL."
    );
  }

  return (
    "Sorry — I couldn't deliver the video just now. " +
    "Please try again in a moment, or send another idea with /start."
  );
}

module.exports = {
  validateVideoUrl,
  probeVideoUrl,
  sendDemoVideo,
  sendVideoAsLink,
  userFacingVideoError,
  TELEGRAM_UPLOAD_MAX_BYTES,
};
