const Database = require("better-sqlite3");
const path = require("path");
const jobId = process.argv[2] || "job_0699549a1a2af796";
const db = new Database(path.join(__dirname, "..", "runtime", "automii.sqlite"));
db.prepare(
  "UPDATE chat_sessions SET active_job_id = NULL WHERE active_job_id = ?"
).run(jobId);
const j = db.prepare("SELECT id, status, error FROM jobs WHERE id = ?").get(jobId);
console.log(JSON.stringify(j));
db.close();
