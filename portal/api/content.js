const { head, put } = require("@vercel/blob");

const BLOB_PATH = "automii-content.json";

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

function emptyContent() {
  return { title: "", script: "", videoUrl: "", source: "builtin" };
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function readSaved() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return emptyContent();
  try {
    const blob = await head(BLOB_PATH);
    const response = await fetch(blob.url);
    if (!response.ok) return emptyContent();
    const data = await response.json();
    const script = clean(data.script);
    const videoUrl = clean(data.videoUrl);
    return {
      title: clean(data.title),
      script,
      videoUrl,
      source: script && videoUrl ? "portal" : "builtin",
    };
  } catch (err) {
    if (err && (err.name === "BlobNotFoundError" || err.statusCode === 404)) {
      return emptyContent();
    }
    throw err;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      res.status(200).json(await readSaved());
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Use GET or POST." });
      return;
    }

    const password = process.env.PORTAL_PASSWORD || "";
    if (!password) {
      res.status(503).json({
        error: "Set PORTAL_PASSWORD in the Vercel project before saving.",
      });
      return;
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.status(503).json({
        error: "Connect Vercel Blob storage to this project, then save again.",
      });
      return;
    }

    const body = await readBody(req);
    if (clean(body.password) !== password) {
      res.status(401).json({ error: "Wrong password." });
      return;
    }

    const title = clean(body.title);
    const script = clean(body.script);
    const videoUrl = clean(body.videoUrl);
    const hasScript = script.length > 0;
    const hasVideo = videoUrl.length > 0;

    if (hasScript !== hasVideo) {
      res.status(400).json({
        error: "Add both the script and the video link, or leave both empty to use the built-in demo.",
      });
      return;
    }
    if (hasVideo && !isHttpUrl(videoUrl)) {
      res.status(400).json({ error: "The video link must start with https://." });
      return;
    }

    const saved = { title, script, videoUrl };
    await put(BLOB_PATH, JSON.stringify(saved), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });

    res.status(200).json({
      ...saved,
      source: hasScript && hasVideo ? "portal" : "builtin",
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not save." });
  }
};
