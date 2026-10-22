const { matchDemo } = require("./demoMatcher");
const { logger } = require("../utils/logger");

const CACHE_MS = 15 * 1000;
let cache = { at: 0, value: null };

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A portal entry replaces the built-in demos only when both fields are filled.
 * Anything else, including a failed request, keeps the current script and video.
 */
function customDemoFrom(payload) {
  if (!payload || typeof payload !== "object") return null;
  const script = clean(payload.script);
  const videoUrl = clean(payload.videoUrl);
  if (!script || !videoUrl || !isHttpUrl(videoUrl)) return null;
  const title = clean(payload.title) || "Your video";
  return {
    id: "portal-custom",
    title,
    script,
    videoUrl,
    videoCaption: clean(payload.videoCaption) || `Your video is ready! 🎬\n${title}`,
  };
}

async function loadCustomContent(fetchImpl = fetch) {
  const contentUrl = clean(process.env.CONTENT_URL);
  if (!contentUrl) return null;

  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.value;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetchImpl(contentUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Content portal returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    cache = { at: now, value: customDemoFrom(payload) };
    return cache.value;
  } catch (err) {
    logger.warn("Custom content unavailable, using the built-in demo.", err.message);
    cache = { at: now, value: null };
    return null;
  }
}

async function resolveDemo(userText, demos, fetchImpl) {
  const custom = await loadCustomContent(fetchImpl);
  if (custom) return custom;
  return matchDemo(userText, demos);
}

function clearContentCache() {
  cache = { at: 0, value: null };
}

module.exports = {
  resolveDemo,
  customDemoFrom,
  clearContentCache,
  loadCustomContent,
};
