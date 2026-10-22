const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(
  path.join(__dirname, "..", "runtime", "automii.sqlite"),
  { readonly: true }
);
const rows = db
  .prepare(
    `SELECT id, status, chat_id, substr(topic,1,40) AS topic, error, updated_at, created_at
     FROM jobs ORDER BY created_at DESC LIMIT 10`
  )
  .all();
console.log(JSON.stringify(rows, null, 2));
const sessions = db
  .prepare(
    `SELECT chat_id, active_job_id, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT 10`
  )
  .all();
console.log("sessions", JSON.stringify(sessions, null, 2));
db.close();
