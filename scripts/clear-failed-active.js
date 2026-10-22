const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(__dirname, "..", "runtime", "automii.sqlite"));
const chatId = process.argv[2] || "871233015";
const row = db
  .prepare("SELECT active_job_id FROM chat_sessions WHERE chat_id = ?")
  .get(chatId);
if (row?.active_job_id) {
  const job = db
    .prepare("SELECT id, status FROM jobs WHERE id = ?")
    .get(row.active_job_id);
  if (!job || job.status === "failed" || job.status === "completed") {
    db.prepare(
      "UPDATE chat_sessions SET active_job_id = NULL, updated_at = ? WHERE chat_id = ?"
    ).run(new Date().toISOString(), chatId);
    console.log("cleared_active", row.active_job_id, job?.status);
  } else {
    console.log("kept_active", row.active_job_id, job.status);
  }
} else {
  console.log("no_active");
}
// Bump budget on awaiting-approval jobs so old rows aren't stuck at $15
const info = db
  .prepare(
    `UPDATE jobs SET max_claude_budget_usd = 40, updated_at = ?
     WHERE status = 'awaiting_approval' AND (max_claude_budget_usd IS NULL OR max_claude_budget_usd < 40)`
  )
  .run(new Date().toISOString());
console.log("budget_bumped_rows", info.changes);
db.close();
