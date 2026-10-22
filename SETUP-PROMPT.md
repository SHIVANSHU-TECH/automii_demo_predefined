# Share this zip, then this prompt

Each person unzips `automii-telegram-demo`, opens that folder in Claude, and pastes the prompt below with their own values. Claude Code must already be installed, and Google Flow, HeyGen, ElevenLabs, and Cloudinary must already be connected in their Claude account.

Leave `ELEVENLABS_VOICE_ID` or `HEYGEN_LOOK_ID` as `PASTE_OR_LEAVE_BLANK` if they want the skill's default voice or avatar. `TELEGRAM_BOT_TOKEN` must be the BotFather token (`123456:ABC...`), not only the `@username`.

```text
Set up this unzipped automii-telegram-demo folder on my machine so my own Telegram bot can run it. Do the work in this folder only. Do not change unrelated projects. Never print my secrets back in full, never commit .env, and never put tokens in source code or README.

My values:
TELEGRAM_BOT_TOKEN: PASTE_BOTFATHER_TOKEN_HERE
ELEVENLABS_VOICE_ID: PASTE_OR_LEAVE_BLANK
HEYGEN_LOOK_ID: PASTE_OR_LEAVE_BLANK

Before changing anything, confirm this machine is ready:
1. `node -v` is 18 or newer.
2. `claude -v` works and `claude` is on PATH.
3. The skill named in .env.example (CLAUDE_SKILL_NAME) is installed for this Claude account.
4. `claude mcp list` shows google-flow, HeyGen, ElevenLabs, and Cloudinary connected. If any of these is missing, stop and tell me exactly which one to connect. Do not start live video generation.

Then set up the bot:
1. Copy .env.example to .env if .env does not exist.
2. Set BOT_TOKEN to my TELEGRAM_BOT_TOKEN.
3. Set BOT_MODE=live, CLAUDE_DRY_RUN=1, SPENDING_POLICY_ENABLED=true, PRIVATE_CHATS_ONLY=true, COMPOSITION_PATH=STUDIO_COMPOSITE.
4. Keep the skill name already in .env.example. Keep MAX_CLAUDE_BUDGET_USD_PER_JOB=40 and MAX_FLOW_CREDITS_PER_JOB=80 unless I say otherwise.
5. If ELEVENLABS_VOICE_ID is not blank and is not PASTE_OR_LEAVE_BLANK, set that value in .env as ELEVENLABS_VOICE_ID. If it is blank, leave ELEVENLABS_VOICE_ID empty so the skill default voice is used.
6. If HEYGEN_LOOK_ID is not blank and is not PASTE_OR_LEAVE_BLANK, set that value in .env as HEYGEN_LOOK_ID. If it is blank, leave HEYGEN_LOOK_ID empty so the skill default avatar is used.
7. Run npm install.
8. Run npm run check-config and npm test. Fix only setup errors you introduced.
9. Start one bot process with npm start. If Telegram polling says another instance is already running, stop the extra instance and leave exactly one running.
10. Tell me the bot username from Telegram getMe, the chat link, that dry-run is on, and the exact test: open the bot, send /start, send a topic in a private chat, read the script, and tap No.

Do not set CLAUDE_DRY_RUN=0 and do not generate a paid video unless I reply "go live". Paid runs spend Claude, Google Flow, HeyGen, and ElevenLabs credits.
```
