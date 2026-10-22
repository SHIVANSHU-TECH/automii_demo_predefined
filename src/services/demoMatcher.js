const fs = require("fs");
const path = require("path");
const { logger } = require("../utils/logger");

const DEFAULT_DEMOS_PATH = path.join(__dirname, "../../data/demos.json");

/**
 * Load and validate demos from JSON.
 * @param {string} [filePath]
 * @returns {{ demos: Array<object> }}
 */
function loadDemos(filePath = DEFAULT_DEMOS_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Demo configuration not found at: ${filePath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read demo configuration: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Demo configuration is not valid JSON: ${err.message}`);
  }

  if (!parsed || !Array.isArray(parsed.demos) || parsed.demos.length === 0) {
    throw new Error("Demo configuration must include a non-empty \"demos\" array.");
  }

  const ids = new Set();
  const defaultVideoUrl = process.env.DEFAULT_VIDEO_URL || "";

  for (const demo of parsed.demos) {
    validateDemo(demo, defaultVideoUrl);
    if (ids.has(demo.id)) {
      throw new Error(`Duplicate demo id: ${demo.id}`);
    }
    ids.add(demo.id);

    if (!demo.videoUrl && defaultVideoUrl) {
      demo.videoUrl = defaultVideoUrl;
    }
  }

  logger.info(`Loaded ${parsed.demos.length} demo(s) from ${filePath}`);
  return parsed;
}

function validateDemo(demo, defaultVideoUrl) {
  if (!demo || typeof demo !== "object") {
    throw new Error("Each demo must be an object.");
  }
  const required = ["id", "title", "keywords", "aliases", "script"];
  for (const field of required) {
    if (demo[field] === undefined || demo[field] === null || demo[field] === "") {
      throw new Error(`Demo is missing required field "${field}"${demo.id ? ` (id=${demo.id})` : ""}.`);
    }
  }
  if (!Array.isArray(demo.keywords) || demo.keywords.length === 0) {
    throw new Error(`Demo "${demo.id}" must have a non-empty keywords array.`);
  }
  if (!Array.isArray(demo.aliases)) {
    throw new Error(`Demo "${demo.id}" aliases must be an array.`);
  }
  if (!demo.videoUrl && !defaultVideoUrl) {
    throw new Error(
      `Demo "${demo.id}" has no videoUrl and DEFAULT_VIDEO_URL is not set.`
    );
  }
  if (demo.videoUrl) {
    assertHttpUrl(demo.videoUrl, demo.id);
  }
}

function assertHttpUrl(url, demoId) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Demo "${demoId}" videoUrl is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Demo "${demoId}" videoUrl must be http(s).`);
  }
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match user text to a demo using aliases (preferred) then keywords.
 * Returns null if nothing clearly matches — never picks a random demo.
 *
 * @param {string} userText
 * @param {Array<object>} demos
 * @returns {object|null}
 */
function matchDemo(userText, demos) {
  const text = normalize(userText);
  if (!text || !Array.isArray(demos) || demos.length === 0) {
    return null;
  }

  // 1) Alias phrase match (substring)
  let bestAlias = null;
  let bestAliasLen = 0;
  for (const demo of demos) {
    for (const alias of demo.aliases || []) {
      const a = normalize(alias);
      if (a && text.includes(a) && a.length > bestAliasLen) {
        bestAlias = demo;
        bestAliasLen = a.length;
      }
    }
  }
  if (bestAlias) {
    return bestAlias;
  }

  // 2) Keyword scoring — require a clear winner (no ties)
  let best = null;
  let bestScore = 0;
  let tie = false;

  for (const demo of demos) {
    let score = 0;
    for (const keyword of demo.keywords || []) {
      const k = normalize(keyword);
      if (!k) continue;
      if (
        text === k ||
        text.includes(` ${k} `) ||
        text.startsWith(`${k} `) ||
        text.endsWith(` ${k}`) ||
        text.includes(k)
      ) {
        score += k.length >= 4 ? 2 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = demo;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }

  // Need a clear winner with score >= 2 (one long keyword or two short ones)
  if (!tie && best && bestScore >= 2) {
    return best;
  }

  return null;
}

function findDemoById(demoId, demos) {
  return (demos || []).find((d) => d.id === demoId) || null;
}

function listSupportedTopics(demos) {
  return (demos || []).map((d) => `• ${d.title}`).join("\n");
}

module.exports = {
  loadDemos,
  matchDemo,
  findDemoById,
  listSupportedTopics,
  normalize,
  DEFAULT_DEMOS_PATH,
};
