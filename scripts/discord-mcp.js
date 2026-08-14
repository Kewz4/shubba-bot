#!/usr/bin/env node
/**
 * Launcher for SaseQ/discord-mcp in STDIO mode.
 *
 * Why a wrapper instead of putting env directly in .mcp.json:
 * .mcp.json is committed, so the Discord token must not live there. This reads
 * the token from .env.mcp (gitignored via the existing `.env.*` rule) and hands
 * it to the JAR as an environment variable, so the secret never enters git and
 * never gets printed.
 *
 * STDIO transport means stdout is the MCP protocol channel — anything else
 * written there corrupts the session. So: all diagnostics go to stderr, and the
 * JAR's file logging is redirected out of the repo.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(REPO_ROOT, '.env.mcp');
const JAR = path.join(os.homedir(), '.mcp', 'discord-mcp-1.0.0.jar');
const LOG_FILE = path.join(os.homedir(), '.mcp', 'logs', 'discord-mcp.log');

function die(msg) {
  process.stderr.write(`[discord-mcp] ${msg}\n`);
  process.exit(1);
}

/** Minimal .env parser: KEY=VALUE, ignores blanks/#comments, strips wrapping quotes. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
      (val.startsWith("'") && val.endsWith("'") && val.length > 1)
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

if (!fs.existsSync(JAR)) {
  die(`JAR not found at ${JAR}\nRe-download it from https://github.com/SaseQ/discord-mcp/releases`);
}

const fileEnv = loadEnvFile(ENV_FILE);
// Real environment wins, so you can override without editing the file.
const token = process.env.DISCORD_TOKEN || fileEnv.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID || fileEnv.DISCORD_GUILD_ID;

if (!token || token.startsWith('PASTE_')) {
  die(
    `No Discord token found.\n` +
      `Put it in ${ENV_FILE} as:\n` +
      `  DISCORD_TOKEN=your_token_here\n` +
      `That file is gitignored.`
  );
}

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const child = spawn(
  'java',
  [
    '-jar',
    JAR,
    // Keep Spring's file log out of the repo (default is ./target/logs/...).
    `--logging.file.name=${LOG_FILE}`,
  ],
  {
    // stdin/stdout are the MCP channel and must pass through untouched.
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      DISCORD_TOKEN: token,
      ...(guildId ? { DISCORD_GUILD_ID: guildId } : {}),
    },
  }
);

child.on('error', (err) => die(`Failed to start java: ${err.message}`));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
