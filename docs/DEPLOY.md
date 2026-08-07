# Deploying Shubba

Shubba now loads **all secrets from environment variables** — nothing sensitive
is in the code, so the repo is safe to keep public. This means you **must** set
env vars on the host or the bot exits on startup with a message telling you which
ones are missing.

## 1. Rotate the exposed secrets (do this first)

These were previously hardcoded in the public repo, so treat them as compromised
and regenerate them:

| Secret | Where to rotate |
|---|---|
| Gemini API key | https://aistudio.google.com/apikey → delete old, create new |
| Discord bot token | Developer Portal → your app → Bot → **Reset Token** |
| Trello key/token | https://trello.com/power-ups/admin → regenerate (only if you use Trello sync) |
| Groq key | https://console.groq.com/keys (only if `USE_GROQ=true`) |

> Rotating the Discord token invalidates the old one everywhere — update the env
> var in the same sitting so the bot doesn't go down.

## 2. Set env vars on SparkedHost

Panel → your server → **Startup** tab → **Variables**. At minimum:

```
DISCORD_TOKEN   = <your new bot token>
GEMINI_API_KEY  = <your new gemini key>
```

Everything else is optional — see `.env.example` for the full list with comments.
If your panel doesn't expose arbitrary variables, create a `.env` file next to
`index.js` via the file manager (it's gitignored) — but `index.js` reads
`process.env` directly, so panel variables are preferred. (If you want `.env`
file support, add `require('dotenv').config()` at the top and the `dotenv` dep.)

## 3. Get the code onto the host

**Option A — git (recommended):** on the host, in the bot directory:

```bash
git pull origin claude/discord-bot-faq-command-hcqWd
npm install
npm test        # optional, should print: # pass 18
```

**Option B — file manager:** upload `index.js`, the `lib/` folder, and
`package.json`. The `lib/gemini-chain.js` module is required by `index.js` —
**don't forget the folder** or the bot won't start.

## 4. Restart

Restart from the panel console. On a healthy boot you'll see the dashboard/health
line and Gemini calls logging which model in the chain answered, e.g.
`🤖 standard(thinking:false): gemini-2.5-flash`.

## What changed in the AI layer

- **Multi-model failover.** Support replies now run `gemini-2.5-flash →
  gemini-2.5-flash-lite`; wiki answers the same. Each free model has its own
  daily quota, so when one caps out Shubba rotates to the next instead of going
  down for the rest of the day. A model that isn't enabled on your key (404) is
  dropped automatically; a per-day 429 parks that model until 00:00 UTC.
- **Smarter default.** The support workhorse moved from `flash-lite` (weakest
  tier) up to `flash`, with `flash-lite` as the safety net.
- **Upgrade path with no redeploy.** Set `GEMINI_CHAIN_STANDARD` /
  `GEMINI_CHAIN_WIKI` to put `gemini-3.5-flash` (newer, materially better
  reasoning + multilingual, also free) at the front once you've confirmed it's
  enabled on your key.

The failover logic is covered by `npm test` (18 tests, including daily-429
rotation, 404 drop, transient retry, and 400-abort).
