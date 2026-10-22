const Database = require("better-sqlite3");
const path = require("path");
const id = process.argv[2];
const reason = process.argv[3] || "failed";
const db = new Database(path.join(__dirname, "..", "runtime", "automii.sqlite"));
db.prepare(
  "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
).run(reason, new Date().toISOString(), id);
console.log("ok", id);
db.close();
