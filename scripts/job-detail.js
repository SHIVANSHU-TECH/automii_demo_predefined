const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const id = process.argv[2];
const db = new Database(path.join(__dirname, "..", "runtime", "automii.sqlite"), {
  readonly: true,
});
const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
console.log(
  JSON.stringify(
    {
      id: job?.id,
      status: job?.status,
      topic: job?.topic,
      created_at: job?.created_at,
      updated_at: job?.updated_at,
      generating_video_at: job?.generating_video_at,
      error: job?.error,
      cloudinary_url: job?.cloudinary_url,
    },
    null,
    2,
  ),
);
db.close();
const dir = path.join(__dirname, "..", "runtime", "jobs", id);
if (!fs.existsSync(dir)) {
  console.log("no_workspace");
  process.exit(0);
}
for (const name of fs.readdirSync(dir)) {
  const st = fs.statSync(path.join(dir, name));
  console.log(`${name}\t${st.size}\t${st.mtime.toISOString()}`);
}
const links = path.join(dir, "video_links.txt");
if (fs.existsSync(links)) {
  console.log("--- video_links ---");
  console.log(fs.readFileSync(links, "utf8"));
}
const merged = path.join(dir, "automii-result.merged.json");
const result = path.join(dir, "automii-result.json");
for (const p of [result, merged]) {
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log("---", path.basename(p), "---");
    console.log(
      JSON.stringify(
        {
          phase: j.phase,
          status: j.status,
          error: j.error,
          diagnostics: j.diagnostics,
        },
        null,
        2,
      ).slice(0, 2500),
    );
  }
}
