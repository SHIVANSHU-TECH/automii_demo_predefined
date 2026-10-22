PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_token TEXT,
  approved_at TEXT,
  approved_by_user_id TEXT,
  script_title TEXT,
  script_text TEXT,
  cloudinary_url TEXT,
  fallback_video_url TEXT,
  claude_session_id TEXT,
  composition_path TEXT,
  paid_attempts INTEGER NOT NULL DEFAULT 0,
  max_paid_attempts INTEGER NOT NULL DEFAULT 1,
  max_flow_credits INTEGER,
  max_claude_budget_usd REAL,
  error TEXT,
  diagnostics_json TEXT,
  progress_message TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  queued_script_at TEXT,
  generating_script_at TEXT,
  awaiting_approval_at TEXT,
  queued_video_at TEXT,
  generating_video_at TEXT,
  uploading_at TEXT,
  delivering_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  needs_reconciliation_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_id TEXT PRIMARY KEY,
  telegram_user_id TEXT,
  active_job_id TEXT,
  mode TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS spending_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  amount REAL,
  unit TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_spend_day ON spending_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_spend_user_day ON spending_events(telegram_user_id, event_type, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  chat_id TEXT,
  telegram_user_id TEXT,
  event TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
