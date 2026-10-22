const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(__dirname, "..", "runtime", "automii.sqlite"), {
  readonly: true,
});
console.log(
  JSON.stringify(
    db
      .prepare(
        "SELECT id,status,substr(topic,1,40) topic,updated_at FROM jobs ORDER BY created_at DESC LIMIT 5",
      )
      .all(),
    null,
    2,
  ),
);
db.close();
