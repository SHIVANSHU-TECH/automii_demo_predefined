/**
 * One-shot: re-deliver a completed video URL for a job that failed on Telegram size.
 * Usage: node scripts/redeliver-job.js <jobId>
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Api } = require("grammy");
const Database = require("better-sqlite3");
const path = require("path");
const { sendDemoVideo } = require("../src/services/videoDelivery");

async function main() {
  const jobId = process.argv[2] || "job_0699549a1a2af796";
  const dbPath = path.join(__dirname, "..", "runtime", "automii.sqlite");
  const db = new Database(dbPath);
  const job = db
    .prepare(
      "SELECT id, chat_id, status, cloudinary_url, fallback_video_url, script_title FROM jobs WHERE id = ?"
    )
    .get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const url = job.cloudinary_url || job.fallback_video_url;
  if (!url) {
    throw new Error(`No video URL on job ${jobId}`);
  }
  if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN missing");
  }

  const api = new Api(process.env.BOT_TOKEN);
  const caption = `Your video is ready! 🎬\n${job.script_title || ""}`.trim();
  const result = await sendDemoVideo(api, job.chat_id, { videoUrl: url, caption });
  console.log("delivery_method=" + result.method);

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE jobs SET status = 'completed', error = NULL, updated_at = ? WHERE id = ?"
  ).run(now, jobId);
  db.prepare(
    "UPDATE chat_sessions SET active_job_id = NULL WHERE active_job_id = ?"
  ).run(jobId);
  console.log("job_marked_completed");

  await api.sendMessage(job.chat_id, "Want to try another idea?", {
    reply_markup: {
      inline_keyboard: [[{ text: "Try another idea", callback_data: "try_another" }]],
    },
  });
  console.log("followup_sent");
  db.close();
}

main().catch((err) => {
  console.error("FAIL", err.message);
  process.exit(1);
});
