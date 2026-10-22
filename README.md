# Automii Bot (`@Automii_bot`)

Telegram bot with two modes:

| `BOT_MODE` | Behavior |
|------------|----------|
| `mock` (default) | Predefined scripts/videos from `data/demos.json` — no Claude/Flow spend |
| `live` | Stage-1 MVP: Claude Code + `ai-reel-final-version` + Google Flow MCP + Cloudinary → Telegram delivery |

---

## Stage 1 (live) — architecture

```
Telegram user
  → grammY bot (private chats)
  → SQLite jobs (runtime/automii.sqlite)
  → JobQueue (global concurrency = 1)
  → claudeWorker (spawn claude -p … /ai-reel-final-version)
  → existing Google Flow / HeyGen / ElevenLabs / Cloudinary MCP tools
  → videoDelivery.js (HTTPS MP4 → Telegram)
```

- Script phase and video phase are separate jobs/states.
- Telegram **Yes** is Phase-10 approval for that exact `jobId`, within spending limits.
- Interrupted `generating_video` / `uploading` / `delivering` jobs become `needs_reconciliation` (never auto-regenerated).
- Google Flow remains single-profile / sequential (concurrency 1).

Bot-mode contract (does **not** rewrite the skill): `prompts/automii-bot-contract.md`.

---

## Prerequisites

- Node.js **18+** (validated on 22.x)
- Telegram bot token
- **Live only:** Claude Code CLI on `PATH` (`claude`), user MCP `google-flow` + Cloudinary/HeyGen/ElevenLabs connected, skill `ai-reel-final-version` available

---

## Install

```bash
cd automii-telegram-demo
npm install
copy .env.example .env
```

---

## Mock mode (safe default)

```env
BOT_MODE=mock
BOT_TOKEN=...
```

```bash
npm run check-config
npm start
```

See original demo topics in `data/demos.json` (e.g. haunted house).

---

## Live mode

### Required `.env` (fail-closed)

```env
BOT_MODE=live
BOT_TOKEN=...
SPENDING_POLICY_ENABLED=true
MAX_VIDEO_JOBS_PER_USER_PER_DAY=3
MAX_VIDEO_JOBS_PER_DAY=10
MAX_PAID_ATTEMPTS_PER_JOB=1
MAX_CLAUDE_BUDGET_USD_PER_JOB=5
MAX_CLAUDE_BUDGET_USD_PER_DAY=25
MAX_FLOW_CREDITS_PER_JOB=40
COMPOSITION_PATH=STUDIO_COMPOSITE
CLAUDE_SKILL_NAME=ai-reel-final-version
PRIVATE_CHATS_ONLY=true
```

**Spending honesty**

- Job-count caps are enforced in SQLite before queueing paid video work.
- `MAX_CLAUDE_BUDGET_USD_PER_JOB` is passed to `claude --max-budget-usd` (Claude API only).
- `MAX_FLOW_CREDITS_PER_JOB` is enforced in the bot-mode prompt against Flow’s live credit quote — **not** a Google billing API.
- HeyGen/ElevenLabs account balances are **not** programmatically capped by this bot.

### Dry-run worker (no Claude / no credits)

```env
BOT_MODE=live
CLAUDE_DRY_RUN=1
# …same spending vars…
```

### Run

```bash
npm run check-config
npm start
```

One process runs polling + the dispatcher. Keep the machine awake; Chrome Flow profile must stay available for video jobs.

### Commands

- `/start` `/help` `/cancel` `/status`

---

## Tests

```bash
npm test
```

Automated tests mock Claude/Flow/Telegram externals (dry-run / SQLite only). They do **not** spend credits or message real users.

---

## Manual smoke-test (before first live video)

Do **not** approve a real video until each step passes.

1. `claude -v` works.
2. `claude mcp list` shows `google-flow` + Cloudinary + HeyGen + ElevenLabs connected.
3. `claude -p --permission-mode dontAsk --permission-prompts none "Reply OK"` succeeds.
4. Confirm skill: ask Claude (interactive) that `ai-reel-final-version` is available.
5. Start bot with `BOT_MODE=live` + `CLAUDE_DRY_RUN=1` → send a topic in a **private** chat → receive dry-run script → tap No.
6. Set `CLAUDE_DRY_RUN=0`, restart, send a cheap/test topic, approve **only** if you accept Flow/HeyGen/ElevenLabs spend within your configured caps.
7. Confirm the delivered Telegram video URL is a real Cloudinary (or disclosed fallback) HTTPS MP4.

---

## Project structure (Stage 1)

```
automii-telegram-demo/
  prompts/automii-bot-contract.md
  runtime/                 # gitignored SQLite + job workspaces
  src/
    bot.js
    config.js
    checkConfig.js
    db/schema.sql
    handlers/
    services/
      jobStore.js
      jobQueue.js
      claudeWorker.js
      spendingPolicy.js
      progressNotifier.js
      videoDelivery.js     # reused
      demoMatcher.js       # mock mode
      sessionStore.js      # mock in-memory
  data/demos.json
  test/
```

---

## Known Stage-1 limitations

- Private chats only (default).
- Global Claude/Flow worker concurrency = 1.
- Skill Phase-10 interactive waits are replaced by Telegram approval via prompt contract — monitor first live runs.
- No Redis / multi-machine workers / extra Flow browser profiles.
- `needs_reconciliation` jobs require operator review (no auto replay of paid work).
