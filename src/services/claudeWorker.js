const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { logger } = require("../utils/logger");

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    phase: { type: "string" },
    status: { type: "string" },
    jobId: { type: "string" },
    script: { type: ["string", "null"] },
    scriptTitle: { type: ["string", "null"] },
    cloudinaryUrl: { type: ["string", "null"] },
    fallbackVideoUrl: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    diagnostics: { type: ["object", "null"] },
  },
  required: ["phase", "status", "jobId"],
};

function workspaceFor(config, jobId) {
  return path.join(config.jobsWorkspaceDir, jobId);
}

function ensureWorkspace(config, jobId) {
  const dir = workspaceFor(config, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readContract(config) {
  return fs.readFileSync(config.contractPath, "utf8");
}

function presenterOverrideLines(config) {
  const lines = [];
  if (config?.elevenLabsVoiceId) {
    lines.push(`AUTOMII_ELEVENLABS_VOICE_ID=${config.elevenLabsVoiceId}`);
  }
  if (config?.heygenLookId) {
    lines.push(`AUTOMII_HEYGEN_LOOK_ID=${config.heygenLookId}`);
  }
  if (lines.length) {
    lines.push(
      "When AUTOMII_ELEVENLABS_VOICE_ID or AUTOMII_HEYGEN_LOOK_ID is set, use that voice or avatar instead of the skill default. Do not ask a human to confirm."
    );
  }
  return lines;
}

function buildScriptPrompt({ job, config, workspace }) {
  const topicPath = path.join(workspace, "topic.txt");
  fs.writeFileSync(topicPath, job.topic, "utf8");
  const composition =
    job.compositionPath || config.compositionPath || "STUDIO_COMPOSITE";
  const maxFlow =
    job.maxFlowCredits || config.spending.maxFlowCreditsPerJob;
  return [
    `/${config.skillName}`,
    "",
    "AUTOMII_PHASE=script",
    `AUTOMII_JOB_ID=${job.id}`,
    `AUTOMII_CHAT_ID=${job.chatId}`,
    `AUTOMII_COMPOSITION_PATH=${composition}`,
    `AUTOMII_MAX_FLOW_CREDITS_PER_JOB=${maxFlow}`,
    ...presenterOverrideLines(config),
    "",
    "Read the Automii bot-mode contract appended to the system prompt.",
    `Use skill /${config.skillName} exactly (including Google Flow / Labs V-rolls when composition is STUDIO_COMPOSITE).`,
    "Generate the reel script and planning artifacts only. Do not spend Flow/HeyGen/ElevenLabs generation credits.",
    `Asset plan must fit AUTOMII_MAX_FLOW_CREDITS_PER_JOB=${maxFlow} (estimate ~10 credits per 6s Flow clip).`,
    "Do not silently switch to PRESENTER_ONLY while composition is STUDIO_COMPOSITE.",
    `Topic file (UTF-8): ${topicPath}`,
    `Workspace directory: ${workspace}`,
    "Write automii-result.json into the workspace.",
    "Return the AutomiiResult JSON as your final answer.",
  ].join("\n");
}

function resolveClaudeBudgetUsd(job, config) {
  // Prefer the live operator cap so raising .env applies to jobs already awaiting approval.
  const fromConfig = Number(config?.spending?.maxClaudeBudgetUsdPerJob);
  const fromJob = Number(job?.maxClaudeBudgetUsd);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  if (Number.isFinite(fromJob) && fromJob > 0) return fromJob;
  return 40;
}

function buildVideoPrompt({ job, config, workspace }) {
  const scriptPath = path.join(workspace, "approved-script.txt");
  fs.writeFileSync(scriptPath, job.scriptText || "", "utf8");
  const composition =
    job.compositionPath || config.compositionPath || "STUDIO_COMPOSITE";
  const claudeBudget = resolveClaudeBudgetUsd(job, config);
  return [
    `/${config.skillName}`,
    "",
    "AUTOMII_PHASE=video",
    "AUTOMII_APPROVED=yes",
    `AUTOMII_JOB_ID=${job.id}`,
    `AUTOMII_CHAT_ID=${job.chatId}`,
    `AUTOMII_COMPOSITION_PATH=${composition}`,
    `AUTOMII_MAX_FLOW_CREDITS_PER_JOB=${job.maxFlowCredits}`,
    `AUTOMII_MAX_CLAUDE_BUDGET_USD=${claudeBudget}`,
    ...presenterOverrideLines(config),
    "",
    "Telegram approval for this exact job is Phase 10 approval.",
    `Use skill /${config.skillName} production phases after approval.`,
    "Produce the video using the existing skill workflow (including Google Flow / Labs when composition is STUDIO_COMPOSITE).",
    "HARD RULE: if STUDIO_COMPOSITE, do not deliver HeyGen presenter-only as status ok. Fail with CLAUDE_BUDGET_TOO_LOW or FLOW_CREDIT_CAP_EXCEEDED instead of degrading.",
    "Poll providers yourself until complete. Do not ask a human to say check.",
    `Approved script file: ${scriptPath}`,
    `Workspace directory: ${workspace}`,
    "Prefer a verified Cloudinary HTTPS secure_url for delivery.",
    "Write automii-result.json into the workspace.",
    "Return the AutomiiResult JSON as your final answer.",
  ].join("\n");
}

function isAutomiiResult(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.phase === "string" &&
    typeof obj.status === "string" &&
    (obj.jobId != null || obj.job_id != null)
  );
}

function isClaudeCliWrapper(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    (obj.type === "result" ||
      obj.is_error === true ||
      obj.api_error_status != null ||
      (obj.session_id && obj.total_cost_usd != null && !isAutomiiResult(obj)))
  );
}

function extractResultPayload(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;

  // Prefer workspace-style / printed wrapper from --output-format json
  try {
    const outer = JSON.parse(trimmed);
    if (outer && typeof outer === "object") {
      if (isClaudeCliWrapper(outer)) {
        if (outer.result) {
          if (typeof outer.result === "string") {
            try {
              const inner = JSON.parse(outer.result);
              if (isAutomiiResult(inner)) {
                return {
                  payload: inner,
                  sessionId: outer.session_id,
                  outer,
                };
              }
            } catch {
              const m = outer.result.match(/\{[\s\S]*\}/);
              if (m) {
                try {
                  const inner = JSON.parse(m[0]);
                  if (isAutomiiResult(inner)) {
                    return {
                      payload: inner,
                      sessionId: outer.session_id,
                      outer,
                    };
                  }
                } catch {
                  /* ignore */
                }
              }
            }
            // CLI error text (e.g. session limit) — not an Automii result
            return {
              payload: null,
              sessionId: outer.session_id,
              outer,
              cliError:
                outer.is_error || outer.api_error_status
                  ? String(outer.result || `Claude CLI error ${outer.api_error_status || ""}`).trim()
                  : null,
            };
          }
          if (typeof outer.result === "object" && isAutomiiResult(outer.result)) {
            return {
              payload: outer.result,
              sessionId: outer.session_id,
              outer,
            };
          }
        }
        return {
          payload: null,
          sessionId: outer.session_id,
          outer,
          cliError: outer.is_error
            ? String(outer.result || "Claude CLI reported is_error").trim()
            : null,
        };
      }
      if (isAutomiiResult(outer)) {
        return { payload: outer, sessionId: outer.session_id, outer };
      }
    }
  } catch {
    /* fall through */
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (isAutomiiResult(parsed)) {
        return { payload: parsed, sessionId: null, outer: null };
      }
      // Do not treat Claude CLI envelopes as Automii payloads
      if (isClaudeCliWrapper(parsed)) {
        return {
          payload: null,
          sessionId: parsed.session_id || null,
          outer: parsed,
          cliError: parsed.is_error
            ? String(parsed.result || "Claude CLI error").trim()
            : null,
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readWorkspaceResult(workspace) {
  const p = path.join(workspace, "automii-result.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    logger.warn("Failed to parse automii-result.json", err.message);
    return null;
  }
}

/**
 * Recursively find files by basename under a root (depth-limited).
 */
function findFilesByName(root, fileName, maxDepth = 6, acc = [], depth = 0) {
  if (!root || !fs.existsSync(root) || depth > maxDepth) return acc;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      findFilesByName(full, fileName, maxDepth, acc, depth + 1);
    } else if (ent.isFile() && ent.name === fileName) {
      acc.push(full);
    }
  }
  return acc;
}

function parseCloudinaryFromVideoLinks(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    // Prefer explicit Cloudinary line
    if (/cloudinary/i.test(line)) {
      const m = line.match(/https:\/\/res\.cloudinary\.com\/[^\s\]]+/i);
      if (m) return m[0].replace(/[),.;]+$/, "");
    }
  }
  // Any cloudinary HTTPS URL in the file
  const any = text.match(/https:\/\/res\.cloudinary\.com\/[^\s\]"'<>]+/i);
  return any ? any[0].replace(/[),.;]+$/, "") : null;
}

function parseHeygenFallback(text) {
  if (!text) return null;
  const temp = text.match(/https:\/\/[^\s\]]+\.mp4[^\s\]]*/i);
  if (temp) return temp[0].replace(/[),.;]+$/, "");
  const page = text.match(/https:\/\/app\.heygen\.com\/videos\/[A-Za-z0-9_-]+/i);
  return page ? page[0] : null;
}

/**
 * Recover script / Cloudinary URL from skill artifacts when Automii JSON is missing
 * or incomplete.
 *
 * SAFETY: only the Automii job workspace, plus Flow download paths that contain
 * this exact job id. Never pick an unrelated reel's video_links.txt / script.txt
 * from the global Flow downloads tree (that caused wrong-topic deliveries).
 */
function recoverSkillArtifacts(workspace, job, phase, config = {}) {
  const jobId = String(job.id || "");
  const workspaceNorm = path.resolve(workspace);

  function underWorkspace(p) {
    const resolved = path.resolve(p);
    return (
      resolved === workspaceNorm ||
      resolved.startsWith(workspaceNorm + path.sep)
    );
  }

  function belongsToJob(p) {
    if (underWorkspace(p)) return true;
    if (!jobId) return false;
    // Allow Flow reel folders that embed the Automii job id in the path
    return path.resolve(p).toLowerCase().includes(jobId.toLowerCase());
  }

  let script = null;
  let cloudinaryUrl = null;
  let fallbackVideoUrl = null;
  let scriptPath = null;
  let linksPath = null;

  // 1) Workspace only (contract writes copies here)
  const wsScript = path.join(workspace, "script.txt");
  if (fs.existsSync(wsScript)) {
    scriptPath = wsScript;
    script = fs.readFileSync(wsScript, "utf8").trim();
  }
  const wsLinks = path.join(workspace, "video_links.txt");
  if (fs.existsSync(wsLinks)) {
    linksPath = wsLinks;
    const text = fs.readFileSync(wsLinks, "utf8");
    cloudinaryUrl = parseCloudinaryFromVideoLinks(text);
    fallbackVideoUrl = parseHeygenFallback(text);
  }

  // Nested files still inside the job workspace
  if (!script || !cloudinaryUrl) {
    const nestedScripts = findFilesByName(workspace, "script.txt").filter(
      underWorkspace
    );
    const nestedLinks = findFilesByName(workspace, "video_links.txt").filter(
      underWorkspace
    );
    if (!script && nestedScripts[0]) {
      scriptPath = nestedScripts[0];
      script = fs.readFileSync(nestedScripts[0], "utf8").trim();
    }
    if (!cloudinaryUrl && nestedLinks[0]) {
      linksPath = nestedLinks[0];
      const text = fs.readFileSync(nestedLinks[0], "utf8");
      cloudinaryUrl = parseCloudinaryFromVideoLinks(text);
      fallbackVideoUrl = parseHeygenFallback(text);
    }
  }

  // 2) Optional Flow roots — only paths that contain this job id
  if (!script || !cloudinaryUrl) {
    const flowRoots = [];
    const flowDownloads =
      process.env.FLOW_DOWNLOAD_DIR ||
      path.join(
        require("os").homedir(),
        ".google-flow-creator-fresh",
        "downloads"
      );
    if (fs.existsSync(flowDownloads)) flowRoots.push(flowDownloads);
    const legacyFlow = path.join(
      require("os").homedir(),
      ".google-flow-creator",
      "downloads"
    );
    if (fs.existsSync(legacyFlow)) flowRoots.push(legacyFlow);

    for (const root of flowRoots) {
      if (!script) {
        const hit = findFilesByName(root, "script.txt").find(belongsToJob);
        if (hit) {
          scriptPath = hit;
          script = fs.readFileSync(hit, "utf8").trim();
        }
      }
      if (!cloudinaryUrl) {
        const hit = findFilesByName(root, "video_links.txt").find(belongsToJob);
        if (hit) {
          linksPath = hit;
          const text = fs.readFileSync(hit, "utf8");
          cloudinaryUrl = parseCloudinaryFromVideoLinks(text);
          fallbackVideoUrl = parseHeygenFallback(text);
        }
      }
    }
  }

  // Reject Cloudinary URLs that clearly belong to another reel when job id is in URL for ours
  if (
    cloudinaryUrl &&
    jobId &&
    /job_[a-f0-9]+/i.test(cloudinaryUrl) &&
    !cloudinaryUrl.toLowerCase().includes(jobId.toLowerCase())
  ) {
    cloudinaryUrl = null;
    fallbackVideoUrl = null;
    linksPath = null;
  }

  return {
    script: script || null,
    cloudinaryUrl: cloudinaryUrl || null,
    fallbackVideoUrl: fallbackVideoUrl || null,
    diagnostics: {
      recoveredFromArtifacts: Boolean(scriptPath || linksPath),
      scriptPath,
      linksPath,
      phase,
      jobId: job.id,
      compositionPath: config.compositionPath || job.compositionPath,
      scopedToJobWorkspace: true,
    },
  };
}

/**
 * Merge JSON payload with on-disk skill artifacts. Prefer explicit JSON fields;
 * fill gaps only from this job's scoped artifacts. Never promote an unrelated
 * Flow reel URL to status ok.
 */
function mergeWithArtifacts(
  payload,
  workspace,
  job,
  phase,
  config,
  exitCode,
  cliError = null
) {
  const artifacts = recoverSkillArtifacts(workspace, job, phase, config);
  const automiiPayload = isAutomiiResult(payload) ? payload : null;
  const base = automiiPayload
    ? { ...automiiPayload }
    : {
        phase,
        status: "failed",
        jobId: job.id,
        script: null,
        scriptTitle: null,
        cloudinaryUrl: null,
        fallbackVideoUrl: null,
        error: null,
        diagnostics: {},
      };

  if (!base.jobId) base.jobId = job.id;
  if (!base.phase) base.phase = phase;

  if (cliError) {
    base.status = "failed";
    base.error = cliError;
    base.diagnostics = {
      ...(base.diagnostics || {}),
      ...(artifacts.diagnostics || {}),
      cliError: true,
    };
    // Do not adopt foreign Cloudinary URLs after a CLI failure
    return base;
  }

  if ((!base.script || !String(base.script).trim()) && artifacts.script) {
    base.script = artifacts.script;
    if (!base.scriptTitle) base.scriptTitle = "Recovered script";
  }
  if (!base.cloudinaryUrl && artifacts.cloudinaryUrl) {
    base.cloudinaryUrl = artifacts.cloudinaryUrl;
  }
  if (!base.fallbackVideoUrl && artifacts.fallbackVideoUrl) {
    base.fallbackVideoUrl = artifacts.fallbackVideoUrl;
  }
  base.diagnostics = {
    ...(base.diagnostics || {}),
    ...(artifacts.diagnostics || {}),
  };

  const hasVideoArtifact = Boolean(
    artifacts.cloudinaryUrl || artifacts.fallbackVideoUrl || artifacts.linksPath
  );

  // Script phase: workspace script.txt alone can satisfy ok
  if (phase === "script") {
    if (base.script && String(base.script).trim()) {
      base.status = "ok";
      base.error = null;
    } else if (!automiiPayload) {
      base.status = "failed";
      base.error =
        "No AutomiiResult JSON and no script.txt artifact could be recovered for this job";
    }
    return base;
  }

  // Video phase
  if (base.cloudinaryUrl || base.fallbackVideoUrl) {
    if (base.status === "needs_reconciliation") return base;
    if (!automiiPayload && hasVideoArtifact) {
      base.status = "needs_reconciliation";
      base.error =
        "Video artifacts found for this job but AutomiiResult JSON was missing/incomplete; manual reconciliation required before Telegram delivery";
      return base;
    }
    if (automiiPayload && base.status !== "failed") {
      base.status = "ok";
      base.error = null;
    }
    return base;
  }

  if (!automiiPayload && exitCode === 0) {
    base.status = "needs_reconciliation";
    base.error =
      "Claude exited 0 but no Automii JSON and no job-scoped video URL; reconcile before retrying paid work";
  } else if (!automiiPayload) {
    base.status = "failed";
    base.error =
      "No AutomiiResult JSON and no job-scoped video_links.txt Cloudinary URL could be recovered";
  }

  return base;
}

/**
 * Spawn Claude Code CLI with argv array (no shell).
 * @returns {Promise<{ ok: boolean, payload?: object, sessionId?: string, error?: string, timedOut?: boolean, exitCode?: number }>}
 */
function runClaudeJob({ config, job, phase, timeoutMs, dryRun = false }) {
  const workspace = ensureWorkspace(config, job.id);
  const contract = readContract(config);
  const prompt =
    phase === "script"
      ? buildScriptPrompt({ job, config, workspace })
      : buildVideoPrompt({ job, config, workspace });

  fs.writeFileSync(path.join(workspace, `${phase}-prompt.txt`), prompt, "utf8");

  if (dryRun) {
    // Hard block: never spawn Claude, never touch Flow/HeyGen/ElevenLabs/Cloudinary MCP.
    if (phase === "video") {
      return Promise.resolve({
        ok: false,
        dryRun: true,
        payload: {
          phase: "video",
          status: "failed",
          jobId: job.id,
          script: job.scriptText,
          scriptTitle: job.scriptTitle,
          cloudinaryUrl: null,
          fallbackVideoUrl: null,
          error:
            "CLAUDE_DRY_RUN=1: paid video production is blocked (no Claude/Flow/HeyGen/ElevenLabs/Cloudinary calls).",
          diagnostics: { dryRun: true, paidOperationsBlocked: true },
        },
        sessionId: job.claudeSessionId || crypto.randomUUID(),
        error:
          "CLAUDE_DRY_RUN=1: paid video production is blocked (no Claude/Flow/HeyGen/ElevenLabs/Cloudinary calls).",
      });
    }
    return Promise.resolve({
      ok: true,
      dryRun: true,
      payload: {
        phase: "script",
        status: "ok",
        jobId: job.id,
        script: `[DRY RUN SCRIPT]\nTopic: ${job.topic}\n(This is not a live generation. No Claude or paid providers were called.)`,
        scriptTitle: "Dry-run script",
        cloudinaryUrl: null,
        error: null,
        diagnostics: { dryRun: true, paidOperationsBlocked: true },
      },
      sessionId: job.claudeSessionId || crypto.randomUUID(),
    });
  }

  const sessionId = job.claudeSessionId || crypto.randomUUID();
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(RESULT_SCHEMA),
    "--permission-mode",
    config.claudePermissionMode,
    "--permission-prompts",
    "none",
    "--append-system-prompt",
    contract,
    "--max-budget-usd",
    String(resolveClaudeBudgetUsd(job, config)),
  ];

  if (phase === "script") {
    args.push("--session-id", sessionId);
  } else if (job.claudeSessionId) {
    args.push("--resume", job.claudeSessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  args.push(prompt);

  logger.info("Spawning Claude worker", {
    jobId: job.id,
    phase,
    claudeBin: config.claudeBin,
    sessionId,
    timeoutMs,
  });

  return new Promise((resolve) => {
    const child = spawn(config.claudeBin, args, {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        // Do not dump secrets into logs; inherit env for Claude auth + MCP.
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxCapture = 5 * 1024 * 1024;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000);
      resolve({
        ok: false,
        timedOut: true,
        sessionId,
        error: `Claude worker timed out after ${timeoutMs}ms`,
        exitCode: null,
      });
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      if (stdout.length < maxCapture) stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf) => {
      if (stderr.length < maxCapture) stderr += buf.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        sessionId,
        error: `Failed to spawn Claude CLI: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      fs.writeFileSync(
        path.join(workspace, `${phase}-stdout.json.txt`),
        stdout.slice(0, 500000),
        "utf8"
      );
      if (stderr) {
        fs.writeFileSync(
          path.join(workspace, `${phase}-stderr.txt`),
          stderr.slice(0, 200000),
          "utf8"
        );
      }

      const fromFile = readWorkspaceResult(workspace);
      const extracted = extractResultPayload(stdout);
      const rawPayload =
        (isAutomiiResult(fromFile) ? fromFile : null) ||
        extracted?.payload ||
        null;
      const resolvedSession =
        extracted?.sessionId || extracted?.outer?.session_id || sessionId;
      const cliError =
        extracted?.cliError ||
        (extracted?.outer?.is_error
          ? String(extracted.outer.result || "Claude CLI error").trim()
          : null);

      const payload = mergeWithArtifacts(
        rawPayload,
        workspace,
        job,
        phase,
        config,
        code,
        cliError
      );

      // Persist merged recovery result for operators
      try {
        fs.writeFileSync(
          path.join(workspace, "automii-result.merged.json"),
          JSON.stringify(payload, null, 2),
          "utf8"
        );
      } catch {
        /* ignore */
      }

      if (String(payload.jobId) !== String(job.id)) {
        resolve({
          ok: false,
          sessionId: resolvedSession,
          exitCode: code,
          error: `Result jobId mismatch (got ${payload.jobId})`,
          payload,
        });
        return;
      }

      if (
        !rawPayload &&
        payload.status === "failed" &&
        !payload.script &&
        !payload.cloudinaryUrl
      ) {
        const preferredError =
          payload.error ||
          cliError ||
          (code === 0
            ? "Claude finished but no AutomiiResult JSON or skill artifacts were found"
            : `Claude exited with code ${code}: ${stderr.slice(0, 500)}`);
        resolve({
          ok: false,
          needsReconciliation: payload.status === "needs_reconciliation",
          sessionId: resolvedSession,
          exitCode: code,
          payload,
          error: preferredError,
        });
        return;
      }

      const status = payload.status;
      resolve({
        ok: status === "ok",
        needsReconciliation: status === "needs_reconciliation",
        sessionId: resolvedSession,
        exitCode: code,
        payload,
        error:
          status === "ok"
            ? null
            : payload.error || cliError || "Worker reported failure",
      });
    });
  });
}

module.exports = {
  runClaudeJob,
  workspaceFor,
  ensureWorkspace,
  extractResultPayload,
  recoverSkillArtifacts,
  mergeWithArtifacts,
  parseCloudinaryFromVideoLinks,
  RESULT_SCHEMA,
};
