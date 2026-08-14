# Deploying Shubba

Shubba loads **every secret from environment variables** — no private credential
is hardcoded in the source, so the repo can stay public. You **must** set env
vars on the host: required ones missing means the bot exits on startup naming
them, and the admin dashboard stays locked until its own two are set.

The one literal left in the source is `CF_API_KEY`, a **public/shared**
CurseForge key (confirmed by the repo owner) kept as a default so download
analytics work with no host configuration. If that ever becomes a key tied to
your own account, delete the literal and make it env-only again.

> **History — read this before assuming you're safe.** Earlier commits on this
> repo's public history *did* contain live credentials in `index.js`: the Gemini
> key and Discord token, the admin dashboard login (`DASHBOARD_USER` /
> `DASHBOARD_PASS`), and a CurseForge API key. Removing them from the current
> file does **not** remove them from git history — anyone can still read them
> with `git log -p`. Rotation below is mandatory, not optional. Until every one
> of these is rotated, treat all of them as public.

## 1. Rotate the exposed secrets (do this first)

These were hardcoded in the public repo at some point, so treat them as
compromised and regenerate them:

| Secret | Where to rotate |
|---|---|
| Gemini API key | https://aistudio.google.com/apikey → delete old, create new |
| Discord bot token | Developer Portal → your app → Bot → **Reset Token** |
| **Dashboard password** (`DASHBOARD_PASS`) | No provider to rotate at — **choose a new one yourself** and set it in the env. The old value `Punchy>HMI` is public forever; never reuse it. Generate a strong one: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`. Change `DASHBOARD_USER` off `ShubbaAdmin` too, since that's equally public. |
| ~~CurseForge API key~~ (`CF_API_KEY`) | **No action needed.** The repo owner confirms this is a public/shared key, not a personal secret, so it ships as a built-in default. Set `CF_API_KEY` only if you want to use your own. |
| Trello key/token | https://trello.com/power-ups/admin → regenerate (only if you use Trello sync) |
| Groq key | https://console.groq.com/keys (only if `USE_GROQ=true`) |

> Rotating the Discord token invalidates the old one everywhere — update the env
> var in the same sitting so the bot doesn't go down.

The dashboard is the urgent one: it's served on a **public IP** (see
`PUBLIC_BASE_URL`) and its `/api/` routes can restart the bot and rewrite its
config, so a publicly-known password there is remote control of the bot for
anyone who finds the port.

## 2. Set env vars on SparkedHost

Panel → your server → **Startup** tab → **Variables**. Required — the bot exits
without these:

```
DISCORD_TOKEN   = <your new bot token>
GEMINI_API_KEY  = <your new gemini key>
```

Required to use the admin dashboard at all — without both, every `/dashboard`,
`/admin` and `/api/` request returns 401 (the bot itself runs fine):

```
DASHBOARD_USER  = <a name that isn't "ShubbaAdmin">
DASHBOARD_PASS  = <a freshly generated strong password>
```

There is **no default and no fallback** for those two by design. If you see
`⚠️ DASHBOARD_USER / DASHBOARD_PASS not set — the admin dashboard is LOCKED` in
the boot log, that's the panel refusing to serve rather than opening up with a
built-in password.

Optional (feature is skipped if unset, with a warning at boot):
`TRELLO_KEY` / `TRELLO_TOKEN`, `GROQ_API_KEY`. (`CF_API_KEY` has a working
built-in default and is not required.) See **`.env.example` in the repo
root** for the complete list of every variable `index.js` reads, with comments
and defaults.

`index.js` loads `dotenv` at the top with `override: true`, so a `.env` file
next to `index.js` works and **wins over panel variables** when both set the
same name. That override exists because the panel carries a stale masked
`GEMINI_API_KEY`. `.env` is gitignored; `.env.example` is committed and must
never hold real values.

## 3. Get the code onto the host

**Option A — git (recommended):** on the host, in the bot directory:

```bash
git pull origin claude/discord-bot-faq-command-hcqWd
npm install
npm test        # optional, should print: # pass 68
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

The failover logic is covered by `npm test` (68 tests total, including daily-429
rotation, 404 drop, transient retry, 400-abort, forum-tag capping, and the
interaction-acknowledgement paths).

> **Note on Option A above:** SparkedHost runs Pterodactyl, whose **Console tab
> is not a shell** — it pipes input to the running bot's stdin, so `git pull`
> typed there does nothing. Use the Startup tab's git/auto-update variables, or
> upload via the File Manager / SFTP instead.
