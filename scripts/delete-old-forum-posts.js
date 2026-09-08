#!/usr/bin/env node
'use strict';
/**
 * Delete Punchy forum posts created before a cutoff date.
 *
 * ⚠️ DELETION IS PERMANENT. Discord has no undelete for forum posts. Run the
 * backup step first — it writes every post's full message history to disk so the
 * content survives even though the posts don't.
 *
 * Usage, in order:
 *   node scripts/delete-old-forum-posts.js                  # dry run: list only
 *   node scripts/delete-old-forum-posts.js --backup         # save content to ./forum-backup/
 *   node scripts/delete-old-forum-posts.js --confirm        # actually delete
 *
 * Token: read from .env.mcp (gitignored) or the DISCORD_TOKEN env var. The bot
 * needs Manage Threads in both forums.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ENV_FILE = path.join(REPO, '.env.mcp');
const BACKUP_DIR = path.join(REPO, 'forum-backup');

const token = process.env.DISCORD_TOKEN
    || (fs.existsSync(ENV_FILE)
        ? (fs.readFileSync(ENV_FILE, 'utf8').match(/^DISCORD_TOKEN=(.+)$/m) || [])[1]?.trim()
        : null);
if (!token) {
    console.error('No token. Set DISCORD_TOKEN, or put it in .env.mcp as DISCORD_TOKEN=...');
    process.exit(1);
}

const CONFIRM = process.argv.includes('--confirm');
const BACKUP = process.argv.includes('--backup');

const GUILD_ID = '1433991244966658072';
const CUTOFF = Date.UTC(2026, 7, 12); // 2026-08-12T00:00:00Z — edit to change the window

const FORUMS = {
    '1433994315402838127': 'bug-report',
    '1541938344324243586': 'wiki-questions',
};

// NEVER delete these. Add any post you want kept, by ID.
const PROTECTED = new Set([
    '1518649055075369051', // bug-report: "[All performance-related posts should be centralized here]"
]);

const snowflakeMs = (id) => Number(BigInt(id) >> 22n) + 1420070400000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, endpoint) {
    const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
        method,
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'PunchyForumCleanup (1.0)' },
    });
    if (res.status === 429) {
        const retry = (await res.json()).retry_after || 1;
        console.log(`   rate limited — waiting ${retry}s`);
        await sleep((retry + 0.5) * 1000);
        return api(method, endpoint);
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

/** Every post in a forum: active plus the archived backlog. */
async function allPosts(forumId) {
    const out = new Map();
    const active = await api('GET', `/guilds/${GUILD_ID}/threads/active`);
    if (active.ok) {
        for (const t of active.data.threads || []) if (t.parent_id === forumId) out.set(t.id, t);
    }
    let before = null;
    for (let page = 0; page < 60; page++) {
        const q = before ? `?before=${encodeURIComponent(before)}&limit=100` : '?limit=100';
        const r = await api('GET', `/channels/${forumId}/threads/archived/public${q}`);
        if (!r.ok) break;
        const threads = r.data.threads || [];
        for (const t of threads) out.set(t.id, t);
        if (!r.data.has_more || !threads.length) break;
        before = threads[threads.length - 1].thread_metadata?.archive_timestamp;
        if (!before) break;
    }
    return [...out.values()];
}

async function backupPost(post, forumName) {
    const dir = path.join(BACKUP_DIR, forumName);
    fs.mkdirSync(dir, { recursive: true });
    const messages = [];
    let before = null;
    for (let page = 0; page < 20; page++) {
        const q = before ? `?before=${before}&limit=100` : '?limit=100';
        const r = await api('GET', `/channels/${post.id}/messages${q}`);
        if (!r.ok) break;
        const batch = r.data || [];
        messages.push(...batch);
        if (batch.length < 100) break;
        before = batch[batch.length - 1].id;
        await sleep(250);
    }
    const created = new Date(snowflakeMs(post.id)).toISOString();
    fs.writeFileSync(
        path.join(dir, `${post.id}.json`),
        JSON.stringify({ id: post.id, name: post.name, created, forum: forumName, messages }, null, 2)
    );
    return messages.length;
}

(async () => {
    const mode = CONFIRM ? 'DELETING' : BACKUP ? 'BACKING UP' : 'DRY RUN';
    console.log(`=== ${mode} ===`);
    console.log(`cutoff: ${new Date(CUTOFF).toISOString()}`);
    if (CONFIRM) console.log('⚠️  PERMANENT. Ctrl-C now if you have not run --backup.\n');
    else console.log('');

    const totals = { targeted: 0, deleted: 0, failed: 0, protectedCount: 0, backedUp: 0, messages: 0 };

    for (const [forumId, name] of Object.entries(FORUMS)) {
        const posts = (await allPosts(forumId))
            .filter(p => snowflakeMs(p.id) < CUTOFF)
            .sort((a, b) => snowflakeMs(a.id) - snowflakeMs(b.id));

        console.log(`#${name}: ${posts.length} posts before cutoff`);

        for (const p of posts) {
            const when = new Date(snowflakeMs(p.id)).toISOString().slice(0, 10);
            const title = (p.name || '').slice(0, 60);

            if (PROTECTED.has(p.id)) {
                console.log(`   KEEP (protected)  ${when}  ${title}`);
                totals.protectedCount++;
                continue;
            }
            totals.targeted++;

            if (BACKUP) {
                const n = await backupPost(p, name);
                totals.backedUp++; totals.messages += n;
                console.log(`   saved ${String(n).padStart(3)} msgs  ${when}  ${title}`);
                await sleep(300);
                continue;
            }
            if (!CONFIRM) {
                console.log(`   would delete      ${when}  ${title}`);
                continue;
            }

            const r = await api('DELETE', `/channels/${p.id}`);
            if (r.ok) { totals.deleted++; console.log(`   deleted           ${when}  ${title}`); }
            else { totals.failed++; console.log(`   FAILED            ${when}  ${title}  (${r.status} ${r.data?.message || ''})`); }
            await sleep(450); // stay well under the rate limit
        }
        console.log('');
    }

    console.log('=== SUMMARY ===');
    console.log(`  targeted:  ${totals.targeted}`);
    console.log(`  protected: ${totals.protectedCount}  (kept)`);
    if (BACKUP)  console.log(`  backed up: ${totals.backedUp} posts, ${totals.messages} messages -> ${BACKUP_DIR}`);
    if (CONFIRM) console.log(`  deleted:   ${totals.deleted}\n  failed:    ${totals.failed}`);
    if (!CONFIRM && !BACKUP) console.log('\nNothing changed. Run --backup, then --confirm.');
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
