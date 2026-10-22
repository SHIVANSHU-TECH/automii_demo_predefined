const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { logger } = require("../utils/logger");

const STATUSES = Object.freeze({
  QUEUED_SCRIPT: "queued_script",
  GENERATING_SCRIPT: "generating_script",
  AWAITING_APPROVAL: "awaiting_approval",
  QUEUED_VIDEO: "queued_video",
  GENERATING_VIDEO: "generating_video",
  UPLOADING: "uploading",
  DELIVERING: "delivering",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  NEEDS_RECONCILIATION: "needs_reconciliation",
});

const TERMINAL = new Set([
  STATUSES.COMPLETED,
  STATUSES.FAILED,
  STATUSES.CANCELLED,
  STATUSES.NEEDS_RECONCILIATION,
]);

const ACTIVE = new Set([
  STATUSES.QUEUED_SCRIPT,
  STATUSES.GENERATING_SCRIPT,
  STATUSES.AWAITING_APPROVAL,
  STATUSES.QUEUED_VIDEO,
  STATUSES.GENERATING_VIDEO,
  STATUSES.UPLOADING,
  STATUSES.DELIVERING,
]);

/** Allowed transitions: from → Set(to) */
const TRANSITIONS = {
  [STATUSES.QUEUED_SCRIPT]: new Set([
    STATUSES.GENERATING_SCRIPT,
    STATUSES.CANCELLED,
    STATUSES.FAILED,
  ]),
  [STATUSES.GENERATING_SCRIPT]: new Set([
    STATUSES.AWAITING_APPROVAL,
    STATUSES.FAILED,
    STATUSES.NEEDS_RECONCILIATION,
    STATUSES.CANCELLED,
  ]),
  [STATUSES.AWAITING_APPROVAL]: new Set([
    STATUSES.QUEUED_VIDEO,
    STATUSES.CANCELLED,
    STATUSES.FAILED,
  ]),
  [STATUSES.QUEUED_VIDEO]: new Set([
    STATUSES.GENERATING_VIDEO,
    STATUSES.CANCELLED,
    STATUSES.FAILED,
  ]),
  [STATUSES.GENERATING_VIDEO]: new Set([
    STATUSES.UPLOADING,
    STATUSES.DELIVERING,
    STATUSES.FAILED,
    STATUSES.NEEDS_RECONCILIATION,
    STATUSES.CANCELLED,
  ]),
  [STATUSES.UPLOADING]: new Set([
    STATUSES.DELIVERING,
    STATUSES.FAILED,
    STATUSES.NEEDS_RECONCILIATION,
  ]),
  [STATUSES.DELIVERING]: new Set([
    STATUSES.COMPLETED,
    STATUSES.FAILED,
  ]),
};

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  return `job_${crypto.randomBytes(8).toString("hex")}`;
}

function newApprovalToken() {
  return crypto.randomBytes(8).toString("hex");
}

function utcDayStartIso(d = new Date()) {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  ).toISOString();
}

class JobStore {
  /**
   * @param {{ dbPath: string }} options
   */
  constructor({ dbPath }) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._migrate();
  }

  _migrate() {
    const schemaPath = path.join(__dirname, "../db/schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    this.db.exec(sql);
    const row = this.db
      .prepare("SELECT id FROM schema_migrations WHERE id = 1")
      .get();
    if (!row) {
      this.db
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (1, ?)")
        .run(nowIso());
      logger.info("SQLite schema applied", { dbPath: this.dbPath });
    }
  }

  close() {
    this.db.close();
  }

  mapJob(row) {
    if (!row) return null;
    return {
      id: row.id,
      telegramUserId: row.telegram_user_id,
      chatId: row.chat_id,
      topic: row.topic,
      status: row.status,
      approvalToken: row.approval_token,
      approvedAt: row.approved_at,
      approvedByUserId: row.approved_by_user_id,
      scriptTitle: row.script_title,
      scriptText: row.script_text,
      cloudinaryUrl: row.cloudinary_url,
      fallbackVideoUrl: row.fallback_video_url,
      claudeSessionId: row.claude_session_id,
      compositionPath: row.composition_path,
      paidAttempts: row.paid_attempts,
      maxPaidAttempts: row.max_paid_attempts,
      maxFlowCredits: row.max_flow_credits,
      maxClaudeBudgetUsd: row.max_claude_budget_usd,
      error: row.error,
      diagnostics: row.diagnostics_json
        ? JSON.parse(row.diagnostics_json)
        : null,
      progressMessage: row.progress_message,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createScriptJob({
    telegramUserId,
    chatId,
    topic,
    compositionPath,
    maxPaidAttempts,
    maxFlowCredits,
    maxClaudeBudgetUsd,
    idempotencyKey,
  }) {
    if (idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
        .get(idempotencyKey);
      if (existing) return { job: this.mapJob(existing), reused: true };
    }

    const id = newJobId();
    const approvalToken = newApprovalToken();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, telegram_user_id, chat_id, topic, status, approval_token,
          composition_path, paid_attempts, max_paid_attempts, max_flow_credits,
          max_claude_budget_usd, idempotency_key, created_at, updated_at, queued_script_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        String(telegramUserId),
        String(chatId),
        topic,
        STATUSES.QUEUED_SCRIPT,
        approvalToken,
        compositionPath,
        maxPaidAttempts,
        maxFlowCredits,
        maxClaudeBudgetUsd,
        idempotencyKey || null,
        ts,
        ts,
        ts
      );

    this.setActiveJob(chatId, telegramUserId, id);
    this.audit({
      jobId: id,
      chatId,
      telegramUserId,
      event: "job_created",
      detail: { topic: topic.slice(0, 200) },
    });
    return { job: this.getJob(id), reused: false };
  }

  getJob(jobId) {
    return this.mapJob(
      this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId)
    );
  }

  setClaudeSessionId(jobId, sessionId) {
    this.db
      .prepare(
        `UPDATE jobs SET claude_session_id = ?, updated_at = ? WHERE id = ?`
      )
      .run(sessionId, nowIso(), jobId);
  }

  /**
   * Transition job status with validation inside a transaction.
   */
  transition(jobId, toStatus, patch = {}) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId);
      if (!row) throw new Error(`Job not found: ${jobId}`);
      const from = row.status;
      const allowed = TRANSITIONS[from];
      if (!allowed || !allowed.has(toStatus)) {
        throw new Error(`Illegal transition ${from} → ${toStatus} for ${jobId}`);
      }
      const ts = nowIso();
      const stampCol = {
        [STATUSES.GENERATING_SCRIPT]: "generating_script_at",
        [STATUSES.AWAITING_APPROVAL]: "awaiting_approval_at",
        [STATUSES.QUEUED_VIDEO]: "queued_video_at",
        [STATUSES.GENERATING_VIDEO]: "generating_video_at",
        [STATUSES.UPLOADING]: "uploading_at",
        [STATUSES.DELIVERING]: "delivering_at",
        [STATUSES.COMPLETED]: "completed_at",
        [STATUSES.FAILED]: "failed_at",
        [STATUSES.CANCELLED]: "cancelled_at",
        [STATUSES.NEEDS_RECONCILIATION]: "needs_reconciliation_at",
      }[toStatus];

      const fields = ["status = ?", "updated_at = ?"];
      const values = [toStatus, ts];
      if (stampCol) {
        fields.push(`${stampCol} = ?`);
        values.push(ts);
      }

      const map = {
        scriptTitle: "script_title",
        scriptText: "script_text",
        cloudinaryUrl: "cloudinary_url",
        fallbackVideoUrl: "fallback_video_url",
        claudeSessionId: "claude_session_id",
        error: "error",
        progressMessage: "progress_message",
        approvedAt: "approved_at",
        approvedByUserId: "approved_by_user_id",
        paidAttempts: "paid_attempts",
      };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] !== undefined) {
          fields.push(`${col} = ?`);
          values.push(patch[k]);
        }
      }
      if (patch.diagnostics !== undefined) {
        fields.push("diagnostics_json = ?");
        values.push(JSON.stringify(patch.diagnostics));
      }

      values.push(jobId);
      this.db
        .prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`)
        .run(...values);

      this.audit({
        jobId,
        chatId: row.chat_id,
        telegramUserId: row.telegram_user_id,
        event: "status_transition",
        detail: { from, to: toStatus },
      });
      return this.getJob(jobId);
    })();
  }

  /**
   * Atomic approve: awaiting_approval → queued_video with ownership checks.
   */
  approveVideo({ jobId, token, telegramUserId, chatId }) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId);
      if (!row) return { ok: false, reason: "not_found" };
      if (String(row.chat_id) !== String(chatId)) {
        return { ok: false, reason: "wrong_chat" };
      }
      if (String(row.telegram_user_id) !== String(telegramUserId)) {
        return { ok: false, reason: "wrong_user" };
      }
      if (row.status !== STATUSES.AWAITING_APPROVAL) {
        return { ok: false, reason: "wrong_status", status: row.status };
      }
      if (!row.approval_token || row.approval_token !== token) {
        return { ok: false, reason: "bad_token" };
      }
      if (row.paid_attempts >= row.max_paid_attempts) {
        return { ok: false, reason: "paid_attempts_exhausted" };
      }

      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE jobs SET
            status = ?,
            approved_at = ?,
            approved_by_user_id = ?,
            queued_video_at = ?,
            paid_attempts = paid_attempts + 1,
            updated_at = ?
          WHERE id = ? AND status = ? AND approval_token = ?`
        )
        .run(
          STATUSES.QUEUED_VIDEO,
          ts,
          String(telegramUserId),
          ts,
          ts,
          jobId,
          STATUSES.AWAITING_APPROVAL,
          token
        );

      const updated = this.getJob(jobId);
      if (!updated || updated.status !== STATUSES.QUEUED_VIDEO) {
        return { ok: false, reason: "race" };
      }
      this.audit({
        jobId,
        chatId,
        telegramUserId,
        event: "video_approved",
        detail: { paidAttempts: updated.paidAttempts },
      });
      return { ok: true, job: updated };
    })();
  }

  cancelJob({ jobId, token, telegramUserId, chatId }) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(jobId);
      if (!row) return { ok: false, reason: "not_found" };
      if (String(row.chat_id) !== String(chatId)) {
        return { ok: false, reason: "wrong_chat" };
      }
      if (String(row.telegram_user_id) !== String(telegramUserId)) {
        return { ok: false, reason: "wrong_user" };
      }
      if (
        row.status !== STATUSES.AWAITING_APPROVAL &&
        row.status !== STATUSES.QUEUED_SCRIPT &&
        row.status !== STATUSES.QUEUED_VIDEO
      ) {
        return { ok: false, reason: "not_cancellable", status: row.status };
      }
      if (
        row.status === STATUSES.AWAITING_APPROVAL &&
        token &&
        row.approval_token !== token
      ) {
        return { ok: false, reason: "bad_token" };
      }
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE jobs SET status = ?, cancelled_at = ?, updated_at = ?, error = ?
           WHERE id = ?`
        )
        .run(STATUSES.CANCELLED, ts, ts, "Cancelled by user", jobId);
      this.clearActiveJobIfMatch(chatId, jobId);
      return { ok: true, job: this.getJob(jobId) };
    })();
  }

  countActiveJobsForUser(telegramUserId) {
    const placeholders = [...ACTIVE].map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE telegram_user_id = ? AND status IN (${placeholders})`
      )
      .get(String(telegramUserId), ...ACTIVE);
    return row.c;
  }

  countQueuedJobs() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE status IN (?, ?)`
      )
      .get(STATUSES.QUEUED_SCRIPT, STATUSES.QUEUED_VIDEO);
    return row.c;
  }

  countVideoJobsSince(telegramUserId, sinceIso) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE telegram_user_id = ?
           AND queued_video_at IS NOT NULL
           AND queued_video_at >= ?`
      )
      .get(String(telegramUserId), sinceIso);
    return row.c;
  }

  countGlobalVideoJobsSince(sinceIso) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE queued_video_at IS NOT NULL AND queued_video_at >= ?`
      )
      .get(sinceIso);
    return row.c;
  }

  /**
   * Claim next work item. Production (video) has exclusive lock vs any in-flight video.
   * Script work is also serialized in Stage 1 (global concurrency 1).
   */
  claimNextJob() {
    return this.db.transaction(() => {
      const inFlight = this.db
        .prepare(
          `SELECT id, status FROM jobs WHERE status IN (?, ?, ?, ?) LIMIT 1`
        )
        .get(
          STATUSES.GENERATING_SCRIPT,
          STATUSES.GENERATING_VIDEO,
          STATUSES.UPLOADING,
          STATUSES.DELIVERING
        );
      if (inFlight) return null;

      const videoQueued = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = ? ORDER BY queued_video_at ASC LIMIT 1`
        )
        .get(STATUSES.QUEUED_VIDEO);
      if (videoQueued) {
        const ts = nowIso();
        this.db
          .prepare(
            `UPDATE jobs SET status = ?, generating_video_at = ?, updated_at = ?
             WHERE id = ? AND status = ?`
          )
          .run(
            STATUSES.GENERATING_VIDEO,
            ts,
            ts,
            videoQueued.id,
            STATUSES.QUEUED_VIDEO
          );
        return this.getJob(videoQueued.id);
      }

      const scriptQueued = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = ? ORDER BY queued_script_at ASC LIMIT 1`
        )
        .get(STATUSES.QUEUED_SCRIPT);
      if (scriptQueued) {
        const ts = nowIso();
        this.db
          .prepare(
            `UPDATE jobs SET status = ?, generating_script_at = ?, updated_at = ?
             WHERE id = ? AND status = ?`
          )
          .run(
            STATUSES.GENERATING_SCRIPT,
            ts,
            ts,
            scriptQueued.id,
            STATUSES.QUEUED_SCRIPT
          );
        return this.getJob(scriptQueued.id);
      }
      return null;
    })();
  }

  /**
   * On startup: mark uncertain paid work for reconciliation; leave queued jobs alone.
   */
  recoverAfterRestart() {
    const ts = nowIso();
    const uncertain = this.db
      .prepare(
        `UPDATE jobs SET status = ?, needs_reconciliation_at = ?, updated_at = ?,
            error = COALESCE(error, ?)
         WHERE status IN (?, ?, ?)`
      )
      .run(
        STATUSES.NEEDS_RECONCILIATION,
        ts,
        ts,
        "Interrupted while paid/production work may have been in progress; manual reconciliation required — will not auto-regenerate.",
        STATUSES.GENERATING_VIDEO,
        STATUSES.UPLOADING,
        STATUSES.DELIVERING
      );

    // Script generation interrupted: fail (no paid Flow yet) so user can retry.
    const scriptInterrupted = this.db
      .prepare(
        `UPDATE jobs SET status = ?, failed_at = ?, updated_at = ?, error = ?
         WHERE status = ?`
      )
      .run(
        STATUSES.FAILED,
        ts,
        ts,
        "Interrupted during script generation; please submit the idea again.",
        STATUSES.GENERATING_SCRIPT
      );

    logger.info("Job recovery on startup", {
      needsReconciliation: uncertain.changes,
      failedScript: scriptInterrupted.changes,
    });
    return {
      needsReconciliation: uncertain.changes,
      failedScript: scriptInterrupted.changes,
    };
  }

  setActiveJob(chatId, telegramUserId, jobId) {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (chat_id, telegram_user_id, active_job_id, mode, updated_at)
         VALUES (?, ?, ?, 'live', ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           telegram_user_id = excluded.telegram_user_id,
           active_job_id = excluded.active_job_id,
           updated_at = excluded.updated_at`
      )
      .run(String(chatId), String(telegramUserId), jobId, ts);
  }

  clearActiveJobIfMatch(chatId, jobId) {
    this.db
      .prepare(
        `UPDATE chat_sessions SET active_job_id = NULL, updated_at = ?
         WHERE chat_id = ? AND active_job_id = ?`
      )
      .run(nowIso(), String(chatId), jobId);
  }

  getSession(chatId) {
    return (
      this.db
        .prepare("SELECT * FROM chat_sessions WHERE chat_id = ?")
        .get(String(chatId)) || null
    );
  }

  clearSession(chatId, telegramUserId, mode = "live") {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (chat_id, telegram_user_id, active_job_id, mode, updated_at)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           telegram_user_id = excluded.telegram_user_id,
           active_job_id = NULL,
           mode = excluded.mode,
           updated_at = excluded.updated_at`
      )
      .run(String(chatId), String(telegramUserId || ""), mode, ts);
  }

  recordSpendingEvent({
    jobId,
    telegramUserId,
    eventType,
    amount = null,
    unit = null,
    meta = null,
  }) {
    this.db
      .prepare(
        `INSERT INTO spending_events
          (job_id, telegram_user_id, event_type, amount, unit, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        jobId,
        String(telegramUserId),
        eventType,
        amount,
        unit,
        meta ? JSON.stringify(meta) : null,
        nowIso()
      );
  }

  audit({ jobId, chatId, telegramUserId, event, detail }) {
    this.db
      .prepare(
        `INSERT INTO audit_log (job_id, chat_id, telegram_user_id, event, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        jobId || null,
        chatId != null ? String(chatId) : null,
        telegramUserId != null ? String(telegramUserId) : null,
        event,
        detail ? JSON.stringify(detail) : null,
        nowIso()
      );
  }
}

module.exports = {
  JobStore,
  STATUSES,
  TERMINAL,
  ACTIVE,
  TRANSITIONS,
  newJobId,
  newApprovalToken,
  utcDayStartIso,
  nowIso,
};
