#!/usr/bin/env node
'use strict';
/**
 * Mirror the LIVE Punchy server's structure into the STAGING server.
 *
 *   node scripts/staging-sync.js            # dry run: print every write it would make
 *   node scripts/staging-sync.js --apply    # perform them
 *     --prune     also delete staging-only roles/channels (normally KEPT)
 *     --no-mods   mirror live only; skip re-applying scripts/staging-mods.js
 *
 * Structure only: guild settings, roles, channels, permission overwrites, forum
 * tags, emojis, stickers, AutoMod and onboarding. NEVER messages, NEVER members.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * The bot token used here has ADMINISTRATOR on the live server. A single wrong
 * id in a write would change the live server of a 6,000-member community. So
 * every non-GET request passes through assertStagingWrite(), which refuses it
 * unless ALL of these hold:
 *   • the route is /guilds/<STAGING>/… or /channels/<id> where <id> was
 *     verified to belong to staging (listed from staging, or created there);
 *   • no id in the route is a known live guild/channel/role/emoji/sticker id;
 *   • no quoted snowflake in the JSON body is a known live id — which also
 *     catches a forgotten remap before Discord ever sees it.
 * Reads from live are fine; they are the source.
 *
 * Token: DISCORD_TOKEN env, or .env.mcp (gitignored).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LIVE_GUILD = '1433991244966658072';     // Punchy Guys Studios — SOURCE, read-only
const STAGING_GUILD = '1523847700037107742';  // staging — the ONLY write target
const BOT_ID = '1465165237358559386';

const APPLY = process.argv.includes('--apply');
// Staging is where new things get built (the Punchy! Moves section, first).
// Anything staging has that live does not is KEPT unless --prune is given.
const PRUNE = process.argv.includes('--prune');
const REPO = path.resolve(__dirname, '..');
const REPORT = path.join(os.tmpdir(), 'staging-sync-report.json');

const token = process.env.DISCORD_TOKEN
    || ((fs.existsSync(path.join(REPO, '.env.mcp'))
        && fs.readFileSync(path.join(REPO, '.env.mcp'), 'utf8').match(/^DISCORD_TOKEN=(.+)$/m)) || [])[1]?.trim();
// (The token is checked in main(), so tests can require the guard without one.)

if (LIVE_GUILD === STAGING_GUILD) { console.error('LIVE and STAGING ids are identical. Refusing.'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNOWFLAKE = /\d{17,20}/g;
const T = { TEXT: 0, VOICE: 2, CATEGORY: 4, NEWS: 5, STAGE: 13, FORUM: 15, MEDIA: 16 };

// ─── Guarded REST client ────────────────────────────────────────────────────

class GuardedDiscord {
    constructor() {
        this.liveIds = new Set([LIVE_GUILD]);
        this.stagingChannels = new Set();   // channel ids VERIFIED to belong to staging
        this.writes = [];                    // every write attempted, for the report
        this.refused = [];
        this.fakeSeq = 0;
    }

    markLive(ids) { for (const id of ids) if (id) this.liveIds.add(String(id)); }

    markStagingChannel(ch) {
        if (!ch || !ch.id) return;
        // A channel only counts as staging's when Discord itself says so.
        if (ch.guild_id && ch.guild_id !== STAGING_GUILD) {
            throw new Error(`channel ${ch.id} reports guild ${ch.guild_id}, not staging — refusing to treat it as writable`);
        }
        if (this.liveIds.has(ch.id)) throw new Error(`channel ${ch.id} is a LIVE channel id`);
        this.stagingChannels.add(ch.id);
    }

    assertStagingWrite(method, route, body) {
        const fail = (why) => {
            const msg = `REFUSED ${method} ${route}: ${why}`;
            this.refused.push(msg);
            throw new Error(msg);
        };
        for (const id of route.match(SNOWFLAKE) || []) {
            if (this.liveIds.has(id)) fail(`route contains LIVE id ${id}`);
        }
        const m = route.match(/^\/(guilds|channels)\/(\d{17,20})(?:[/?]|$)/);
        if (!m) fail('not a /guilds/<id> or /channels/<id> route');
        if (m[1] === 'guilds' && m[2] !== STAGING_GUILD) fail(`guild ${m[2]} is not staging`);
        if (m[1] === 'channels' && !this.stagingChannels.has(m[2])) fail(`channel ${m[2]} is not a verified staging channel`);
        if (body && typeof body === 'object' && !(body instanceof FormData)) {
            const json = JSON.stringify(body);
            for (const q of json.match(/"(\d{17,20})"/g) || []) {
                const id = q.slice(1, -1);
                if (this.liveIds.has(id)) fail(`body still references LIVE id ${id} — a remap was missed`);
            }
        }
    }

    async req(method, route, body) {
        if (method !== 'GET') {
            this.assertStagingWrite(method, route, body);
            this.writes.push({ method, route, summary: summarize(body) });
            if (!APPLY) {
                // Dry run: pretend it worked, and hand back a stand-in id so later
                // steps can plan against it. Stand-ins are registered as staging.
                // Snowflake-shaped so later writes to it route like a real id and
                // face the same guard. Never sent: this branch only runs dry.
                const fake = (9000000000000000000n + BigInt(++this.fakeSeq)).toString();
                return { id: fake, guild_id: STAGING_GUILD, __dry: true };
            }
        }
        for (let attempt = 0; attempt < 8; attempt++) {
            const init = { method, headers: { Authorization: `Bot ${token}`, 'User-Agent': 'PunchyStagingSync (1.0)' } };
            if (body instanceof FormData) init.body = body;
            else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
            if (method !== 'GET') init.headers['X-Audit-Log-Reason'] = 'staging-sync: mirror live structure';
            const res = await fetch(`https://discord.com/api/v10${route}`, init);
            if (res.status === 429) {
                const j = await res.json().catch(() => ({}));
                await sleep(((j.retry_after || 1) * 1000) + 300);
                continue;
            }
            const text = await res.text();
            const data = text ? safeJson(text) : null;
            if (!res.ok) {
                const err = new Error(`${method} ${route} → ${res.status} ${JSON.stringify(data)?.slice(0, 400)}`);
                err.status = res.status; err.data = data;
                throw err;
            }
            if (method !== 'GET') await sleep(350);   // stay well clear of per-route limits
            return data;
        }
        throw new Error(`${method} ${route}: rate limited 8 times in a row`);
    }

    get(route) { return this.req('GET', route); }
}

function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }
function summarize(body) {
    if (!body) return null;
    if (body instanceof FormData) return '[multipart]';
    const b = { ...body };
    for (const k of ['icon', 'image', 'banner', 'splash']) if (typeof b[k] === 'string' && b[k].length > 80) b[k] = `[${b[k].length} chars]`;
    const s = JSON.stringify(b);
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/**
 * Order a list the way live orders it, while keeping staging-only items where
 * they are relative to their neighbours.
 *
 * `liveOrder` is staging ids in live's order (bottom → top, or any consistent
 * direction). `currentOrder` is staging ids as staging has them now, same
 * direction. Each staging-only item is anchored to the nearest non-staging-only
 * item before it in `currentOrder`, and re-inserted right after that anchor —
 * or at the very start if nothing precedes it.
 */
function mergeOrder(liveOrder, currentOrder, isStagingOnly) {
    const anchored = new Map();   // anchor id (or null) -> staging-only ids, in order
    let anchor = null;
    for (const id of currentOrder) {
        if (isStagingOnly(id)) {
            if (!anchored.has(anchor)) anchored.set(anchor, []);
            anchored.get(anchor).push(id);
        } else if (liveOrder.includes(id)) {
            anchor = id;
        }
    }
    const out = [...(anchored.get(null) || [])];
    for (const id of liveOrder) {
        out.push(id);
        out.push(...(anchored.get(id) || []));
    }
    return out;
}

/** An onboarding option as GET returns it → the shape PUT accepts. */
function reshapeOption(o) {
    const out = { id: o.id, title: o.title, description: o.description, channel_ids: o.channel_ids || [], role_ids: o.role_ids || [] };
    if (o.emoji?.id) { out.emoji_id = o.emoji.id; out.emoji_name = o.emoji.name; out.emoji_animated = !!o.emoji.animated; }
    else if (o.emoji?.name) out.emoji_name = o.emoji.name;
    else if (o.emoji_name || o.emoji_id) { out.emoji_id = o.emoji_id; out.emoji_name = o.emoji_name; out.emoji_animated = o.emoji_animated; }
    return out;
}
function reshapePrompt(p) {
    return { id: p.id, type: p.type, title: p.title, single_select: p.single_select, required: p.required, in_onboarding: p.in_onboarding, options: (p.options || []).map(reshapeOption) };
}

/**
 * Merge live's onboarding (already remapped to staging ids) into staging's,
 * without losing what was built in staging.
 *
 * Live is authoritative for everything it has. On top of that, staging keeps:
 *   • prompts live does not have (e.g. "Which Punchy! mods are you here for?"),
 *   • options live does not have inside a shared prompt (e.g. "Punchy! Moves
 *     Updates" inside the notifications prompt),
 *   • role/channel grants on a shared option that point at staging-only things
 *     (e.g. "Everything" also granting the Moves roles).
 * Prompt and option ids are reused where titles match, so ids stay stable, and
 * staging's prompt ORDER is kept — the Moves question stays first.
 */
function mergeOnboarding(livePrompts, stagingPrompts, isKeptRole, isKeptChannel) {
    const uniq = a => [...new Set(a)];
    const stByTitle = new Map((stagingPrompts || []).map(p => [p.title, p]));
    const merged = new Map();
    for (const lp of livePrompts) {
        const sp = stByTitle.get(lp.title);
        const spOpts = new Map((sp?.options || []).map(o => [o.title, o]));
        const liveOptTitles = new Set(lp.options.map(o => o.title));
        const options = lp.options.map(lo => {
            const so = spOpts.get(lo.title);
            return {
                ...lo,
                id: so?.id || lo.id,
                role_ids: uniq([...lo.role_ids, ...(so?.role_ids || []).filter(isKeptRole)]),
                channel_ids: uniq([...lo.channel_ids, ...(so?.channel_ids || []).filter(isKeptChannel)]),
            };
        });
        for (const so of sp?.options || []) if (!liveOptTitles.has(so.title)) options.push(reshapeOption(so));
        merged.set(lp.title, { ...lp, id: sp?.id || lp.id, options });
    }
    const out = [];
    for (const sp of stagingPrompts || []) out.push(merged.get(sp.title) || reshapePrompt(sp));
    for (const lp of livePrompts) if (!stByTitle.has(lp.title)) out.push(merged.get(lp.title));
    return out;
}

// Onboarding prompts/options need client-generated snowflakes.
let snowSeq = 0n;
function newSnowflake() {
    return (((BigInt(Date.now()) - 1420070400000n) << 22n) + (snowSeq++ & 0xFFFn)).toString();
}

async function downloadAsDataUri(url, mime) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${url} → ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, buf };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    if (!token) { console.error('No DISCORD_TOKEN (env or .env.mcp).'); process.exit(1); }
    const d = new GuardedDiscord();
    const log = [];
    const note = (s) => { log.push(s); console.log(s); };
    const skipped = [];
    const skip = (s) => { skipped.push(s); console.log(`   ⤷ skipped: ${s}`); };

    console.log(`=== staging-sync — ${APPLY ? 'APPLYING' : 'DRY RUN (nothing will change)'} ===`);
    console.log(`source: ${LIVE_GUILD} (read-only)   target: ${STAGING_GUILD}\n`);

    // ── Read both sides ──────────────────────────────────────────────────────
    const L = {
        guild: await d.get(`/guilds/${LIVE_GUILD}`),
        channels: await d.get(`/guilds/${LIVE_GUILD}/channels`),
        roles: await d.get(`/guilds/${LIVE_GUILD}/roles`),
        emojis: await d.get(`/guilds/${LIVE_GUILD}/emojis`),
        stickers: await d.get(`/guilds/${LIVE_GUILD}/stickers`),
        onboarding: await d.get(`/guilds/${LIVE_GUILD}/onboarding`).catch(() => null),
        automod: await d.get(`/guilds/${LIVE_GUILD}/auto-moderation/rules`).catch(() => []),
    };
    // Every live id becomes untouchable before a single write is considered.
    d.markLive(L.channels.map(c => c.id));
    d.markLive(L.roles.map(r => r.id));
    d.markLive(L.emojis.map(e => e.id));
    d.markLive(L.stickers.map(s => s.id));
    d.markLive((L.automod || []).map(a => a.id));

    let S = await readStaging(d);
    const stagingMemberIds = new Set((await d.get(`/guilds/${STAGING_GUILD}/members?limit=1000`)).map(m => m.user.id));

    // Sanity: the two servers must not share a single channel or role id.
    for (const c of S.channels) if (d.liveIds.has(c.id)) throw new Error(`staging channel ${c.id} is also a live id — refusing to run`);
    for (const c of S.channels) d.markStagingChannel(c);

    const botMember = await d.get(`/guilds/${STAGING_GUILD}/members/${BOT_ID}`);
    const roleById = new Map(S.roles.map(r => [r.id, r]));
    const botTop = Math.max(0, ...botMember.roles.map(id => roleById.get(id)?.position ?? 0));
    const manageable = (stagingRole) => stagingRole.position < botTop;
    const botRoleIsTop = S.roles.every(r => r.id === STAGING_GUILD || r.position <= botTop);
    note(`bot's highest staging role is at position ${botTop} of ${S.roles.length - 1}${botRoleIsTop ? ' (top — full role sync possible)' : ' — roles above it cannot be edited'}`);

    // ── 1. Guild settings + Community ────────────────────────────────────────
    // Channel ids get mapped below; settings that reference channels are
    // applied after channels exist, in step 5b.
    note('\n── 1. guild settings');
    const iconUri = L.guild.icon
        ? (await downloadAsDataUri(`https://cdn.discordapp.com/icons/${LIVE_GUILD}/${L.guild.icon}.png?size=1024`, 'image/png')).dataUri
        : null;
    const guildPatch = {
        name: `${L.guild.name} (Staging)`,
        description: L.guild.description,
        preferred_locale: L.guild.preferred_locale,
        default_message_notifications: L.guild.default_message_notifications,
        premium_progress_bar_enabled: L.guild.premium_progress_bar_enabled,
        afk_timeout: L.guild.afk_timeout,
        system_channel_flags: L.guild.system_channel_flags,
    };
    if (iconUri) guildPatch.icon = iconUri;
    await d.req('PATCH', `/guilds/${STAGING_GUILD}`, guildPatch);
    note(`   name → "${guildPatch.name}", icon ${iconUri ? 'copied' : 'none'}, locale/notifications copied`);

    // ── 2. Roles ─────────────────────────────────────────────────────────────
    note('\n── 2. roles');
    const roleMap = new Map([[LIVE_GUILD, STAGING_GUILD]]);   // @everyone
    const liveShubbaRole = L.roles.find(r => r.tags?.bot_id === BOT_ID);
    const stagingShubbaRole = S.roles.find(r => r.tags?.bot_id === BOT_ID);
    if (liveShubbaRole && stagingShubbaRole) roleMap.set(liveShubbaRole.id, stagingShubbaRole.id);

    // @everyone permissions
    const liveEveryone = L.roles.find(r => r.id === LIVE_GUILD);
    const stagingEveryone = S.roles.find(r => r.id === STAGING_GUILD);
    if (liveEveryone.permissions !== stagingEveryone.permissions) {
        await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles/${STAGING_GUILD}`, { permissions: liveEveryone.permissions });
        note('   @everyone permissions → live');
    }

    const liveRoles = L.roles.filter(r => r.id !== LIVE_GUILD).sort((a, b) => b.position - a.position);
    const stagingByName = new Map();
    for (const r of S.roles) if (r.id !== STAGING_GUILD && !r.managed) {
        if (!stagingByName.has(r.name)) stagingByName.set(r.name, []);
        stagingByName.get(r.name).push(r);
    }
    const claimed = new Set();
    const roleIconsOk = (S.guild.features || []).includes('ROLE_ICONS');

    for (const lr of liveRoles) {
        if (lr.managed) {
            if (!roleMap.has(lr.id)) skip(`managed role "${lr.name}" — created by its bot/integration joining, cannot be made by hand`);
            continue;
        }
        const props = {
            name: lr.name,
            permissions: lr.permissions,
            color: lr.color,
            hoist: lr.hoist,
            mentionable: lr.mentionable,
        };
        if (roleIconsOk && lr.unicode_emoji) props.unicode_emoji = lr.unicode_emoji;
        const candidates = (stagingByName.get(lr.name) || []).filter(r => !claimed.has(r.id));
        const existing = candidates[0];
        if (existing) {
            claimed.add(existing.id);
            roleMap.set(lr.id, existing.id);
            const differs = existing.permissions !== props.permissions || existing.color !== props.color
                || existing.hoist !== props.hoist || existing.mentionable !== props.mentionable;
            if (!differs) continue;
            if (!manageable(existing)) { skip(`role "${lr.name}" differs but sits above the bot`); continue; }
            await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles/${existing.id}`, props);
            note(`   updated role "${lr.name}"`);
        } else {
            const created = await d.req('POST', `/guilds/${STAGING_GUILD}/roles`, props);
            roleMap.set(lr.id, created.id);
            note(`   created role "${lr.name}"`);
        }
    }

    // Staging roles with no live counterpart are either leftovers from an older
    // clone or something being BUILT in staging (Punchy! Moves). The sync
    // cannot tell which, so it keeps them unless told to --prune.
    const stagingOnlyRoles = S.roles.filter(sr => sr.id !== STAGING_GUILD && !sr.managed && !claimed.has(sr.id));
    for (const sr of stagingOnlyRoles) {
        if (!PRUNE) { note(`   kept staging-only role "${sr.name}" (use --prune to remove)`); continue; }
        if (!manageable(sr)) { skip(`staging-only role "${sr.name}" sits above the bot — delete it by hand`); continue; }
        await d.req('DELETE', `/guilds/${STAGING_GUILD}/roles/${sr.id}`);
        note(`   pruned staging-only role "${sr.name}"`);
    }
    const keptRoleIds = new Set(PRUNE ? [] : stagingOnlyRoles.map(r => r.id));

    // Order: mirror live, for every role the bot is allowed to move.
    if (APPLY) S = await readStaging(d);
    const orderable = liveRoles
        .filter(lr => roleMap.has(lr.id) && lr.id !== liveShubbaRole?.id)
        .map(lr => ({ id: roleMap.get(lr.id), livePos: lr.position }));
    const stagingPos = new Map(S.roles.map(r => [r.id, r.position]));
    const movable = orderable.filter(o => APPLY ? (stagingPos.get(o.id) ?? 0) < botTop : true);
    if (movable.length) {
        // Assign contiguous positions from the bottom, in live's order, below the
        // bot — with any kept staging-only role re-inserted next to the role it
        // currently sits above, so building something in staging survives a sync.
        const liveOrder = [...movable].sort((a, b) => a.livePos - b.livePos).map(o => o.id);
        const currentOrder = S.roles
            .filter(r => r.id !== STAGING_GUILD && (liveOrder.includes(r.id) || keptRoleIds.has(r.id)))
            .sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
            .map(r => r.id);
        const merged = mergeOrder(liveOrder, currentOrder, id => keptRoleIds.has(id));
        const positions = merged.map((id, i) => ({ id, position: i + 1 }));
        // Positions are plain integers and a bot may only assign ones BELOW its
        // own. Newly created roles all land on position 1, and Discord does not
        // renumber until someone drags a role in the client — so a bot "at the
        // top" can still be numerically too low to fit everything under it. It
        // cannot raise its own role, so say so instead of failing the whole run.
        let liveBotPos = Math.max(0, ...botMember.roles.map(id => S.roles.find(r => r.id === id)?.position ?? 0));
        if (APPLY && positions.length >= liveBotPos) {
            // Any valid reorder makes Discord renumber every role contiguously,
            // which lifts the bot's role above everything it already sits over.
            // Move one role onto the position it already holds — a no-op — and
            // re-read.
            const anchor = S.roles.find(r => r.id !== STAGING_GUILD && !r.managed && r.position > 0 && r.position < liveBotPos);
            if (anchor) {
                await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles`, [{ id: anchor.id, position: anchor.position }]);
                S = await readStaging(d);
                liveBotPos = Math.max(0, ...botMember.roles.map(id => S.roles.find(r => r.id === id)?.position ?? 0));
                note(`   renumbered roles (bot now at ${liveBotPos})`);
            }
        }
        if (APPLY && positions.length >= liveBotPos) {
            skip(`role ORDER — ${positions.length} roles need slots under the bot, whose role is numerically at ${liveBotPos}. `
                + `Drag "Shubba (AI Bot)" to the top once more in Server Settings → Roles (that renumbers every role), then re-run.`);
        } else if (botRoleIsTop || !APPLY) {
            try {
                await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles`, positions);
                note(`   reordered ${positions.length} roles to match live`);
            } catch (e) {
                if (e.status !== 403 && e.data?.code !== 50013) throw e;
                skip(`role ORDER — Discord refused (${e.data?.code}); drag the bot's role to the top and re-run`);
            }
        } else {
            skip(`role ORDER — the bot's role is not at the top, so it cannot place roles above itself`);
        }
    }

    // ── 3. Emojis ────────────────────────────────────────────────────────────
    note('\n── 3. emojis');
    const emojiMap = new Map();
    const stagingEmojiByName = new Map(S.emojis.map(e => [e.name, e]));
    for (const le of L.emojis) {
        const have = stagingEmojiByName.get(le.name);
        if (have) { emojiMap.set(le.id, have.id); continue; }
        const ext = le.animated ? 'gif' : 'png';
        const { dataUri } = await downloadAsDataUri(`https://cdn.discordapp.com/emojis/${le.id}.${ext}`, `image/${ext}`);
        const created = await d.req('POST', `/guilds/${STAGING_GUILD}/emojis`, {
            name: le.name,
            image: dataUri,
            roles: (le.roles || []).map(id => roleMap.get(id)).filter(Boolean),
        });
        emojiMap.set(le.id, created.id);
        note(`   uploaded :${le.name}:`);
    }

    // ── 4. Stickers ──────────────────────────────────────────────────────────
    note('\n── 4. stickers');
    const stagingStickerNames = new Set(S.stickers.map(s => s.name));
    for (const ls of L.stickers) {
        if (stagingStickerNames.has(ls.name)) continue;
        // format_type: 1 PNG, 2 APNG, 3 LOTTIE (partner/verified only), 4 GIF
        if (ls.format_type === 3) { skip(`sticker "${ls.name}" is Lottie — only partnered/verified servers may upload those`); continue; }
        const ext = ls.format_type === 4 ? 'gif' : 'png';
        const mime = ls.format_type === 4 ? 'image/gif' : 'image/png';
        const r = await fetch(`https://media.discordapp.net/stickers/${ls.id}.${ext}`);
        if (!r.ok) { skip(`sticker "${ls.name}" — download failed (${r.status})`); continue; }
        const form = new FormData();
        form.append('name', ls.name);
        form.append('description', ls.description || '');
        form.append('tags', ls.tags || ls.name);
        form.append('file', new Blob([Buffer.from(await r.arrayBuffer())], { type: mime }), `${ls.name}.${ext}`);
        await d.req('POST', `/guilds/${STAGING_GUILD}/stickers`, form);
        note(`   uploaded sticker "${ls.name}"`);
    }

    // ── 5. Channels ──────────────────────────────────────────────────────────
    note('\n── 5. channels');
    const chanMap = new Map();
    const catName = (list, id) => list.find(c => c.id === id)?.name || '';
    const isTextish = t => t === T.TEXT || t === T.NEWS;
    const typeClass = t => isTextish(t) ? 'text' : String(t);

    // Staging's own layout (scripts/staging-mods.js) moves, renames and removes
    // some of live's channels. Honour it, or every sync would undo it: recreate
    // what was removed, move relocated channels back, rename categories back.
    // --no-mods means a pure mirror, so no overrides.
    const LAYOUT = process.argv.includes('--no-mods')
        ? { omit: [], categoryAlias: {}, relocate: {} }
        : require('./staging-mods').LAYOUT;
    const omitted = new Set(LAYOUT.omit);
    const aliasOf = (name) => LAYOUT.categoryAlias[name] || name;

    // Categories first, matched by name (or by the name staging gives them).
    const liveCats = L.channels.filter(c => c.type === T.CATEGORY).sort((a, b) => a.position - b.position);
    const stagingCats = S.channels.filter(c => c.type === T.CATEGORY);
    for (const lc of liveCats) {
        const have = stagingCats.find(c => (c.name === lc.name || c.name === aliasOf(lc.name))
            && !chanMap.has(c.id) && ![...chanMap.values()].includes(c.id));
        if (have) { chanMap.set(lc.id, have.id); continue; }
        if (omitted.has(lc.name)) { note(`   not recreating [${lc.name}] — staging's layout removes it`); continue; }
        const created = await d.req('POST', `/guilds/${STAGING_GUILD}/channels`, { name: lc.name, type: T.CATEGORY });
        d.markStagingChannel(created);
        chanMap.set(lc.id, created.id);
        note(`   created category [${lc.name}]`);
    }

    // Then everything else, matched by (category name, channel name, type class).
    const used = new Set(chanMap.values());
    const liveRest = L.channels.filter(c => c.type !== T.CATEGORY).sort((a, b) => a.position - b.position);
    const pendingCreate = [];
    for (const lc of liveRest) {
        const lcat = catName(L.channels, lc.parent_id);
        const have = S.channels.find(c => c.type !== T.CATEGORY && !used.has(c.id)
            && c.name === lc.name && typeClass(c.type) === typeClass(lc.type)
            && catName(S.channels, c.parent_id) === lcat);
        const loose = have || S.channels.find(c => c.type !== T.CATEGORY && !used.has(c.id)
            && c.name === lc.name && typeClass(c.type) === typeClass(lc.type));
        if (loose) { chanMap.set(lc.id, loose.id); used.add(loose.id); }
        else if (omitted.has(lc.name)) note(`   not recreating #${lc.name} — staging's layout removes it`);
        else pendingCreate.push(lc);
    }

    // Anything in staging that live does not have.
    const extraStaging = S.channels.filter(c => !used.has(c.id));

    // Now that every live channel and role has a staging twin (or is known not
    // to), mentions inside topics can be rewritten to point at staging.
    const remapMentions = (text) => typeof text !== 'string' ? text : text
        .replace(/<#(\d{17,20})>/g, (m, id) => chanMap.has(id) ? `<#${chanMap.get(id)}>` : m)
        .replace(/<@&(\d{17,20})>/g, (m, id) => roleMap.has(id) ? `<@&${roleMap.get(id)}>` : m);

    const mapOverwrites = (lc) => {
        const out = [];
        for (const o of lc.permission_overwrites || []) {
            if (o.type === 0) {
                const id = roleMap.get(o.id);
                if (!id) { skip(`#${lc.name}: overwrite for unmappable role ${L.roles.find(r => r.id === o.id)?.name || o.id}`); continue; }
                out.push({ id, type: 0, allow: o.allow, deny: o.deny });
            } else {
                if (!stagingMemberIds.has(o.id)) { skip(`#${lc.name}: member overwrite for a user not in staging`); continue; }
                out.push({ id: o.id, type: 1, allow: o.allow, deny: o.deny });
            }
        }
        return out;
    };

    const mapEmojiRef = (emoji_id, emoji_name) => ({
        emoji_id: emoji_id ? (emojiMap.get(emoji_id) || null) : null,
        emoji_name: emoji_id && !emojiMap.get(emoji_id) ? null : (emoji_name || null),
    });

    const channelProps = (lc, stagingTwin) => {
        const p = {
            name: lc.name,
            topic: remapMentions(lc.topic ?? null),
            nsfw: !!lc.nsfw,
            permission_overwrites: mapOverwrites(lc),
        };
        if (lc.type !== T.VOICE && lc.type !== T.STAGE) p.rate_limit_per_user = lc.rate_limit_per_user || 0;
        if (lc.default_auto_archive_duration) p.default_auto_archive_duration = lc.default_auto_archive_duration;
        if (lc.type === T.VOICE || lc.type === T.STAGE) {
            p.bitrate = Math.min(lc.bitrate || 64000, 96000);   // unboosted ceiling
            p.user_limit = lc.user_limit || 0;
            delete p.topic;
        }
        if (lc.type === T.FORUM || lc.type === T.MEDIA) {
            const stagingTags = stagingTwin?.available_tags || [];
            p.available_tags = (lc.available_tags || []).map(t => {
                const twin = stagingTags.find(s => s.name === t.name);
                const tag = { name: t.name, moderated: !!t.moderated, ...mapEmojiRef(t.emoji_id, t.emoji_name) };
                if (twin) tag.id = twin.id;
                return tag;
            });
            p.default_reaction_emoji = lc.default_reaction_emoji
                ? mapEmojiRef(lc.default_reaction_emoji.emoji_id, lc.default_reaction_emoji.emoji_name)
                : null;
            if (p.default_reaction_emoji && !p.default_reaction_emoji.emoji_id && !p.default_reaction_emoji.emoji_name) p.default_reaction_emoji = null;
            if (lc.default_sort_order != null) p.default_sort_order = lc.default_sort_order;
            if (lc.default_forum_layout != null) p.default_forum_layout = lc.default_forum_layout;
            if (lc.default_thread_rate_limit_per_user != null) p.default_thread_rate_limit_per_user = lc.default_thread_rate_limit_per_user;
            // AND vs OR when a member filters the forum by several tags. Not in
            // Discord's public docs, but returned and writable — and live's
            // #bug-report uses match_all, which an independent check caught us
            // dropping.
            if (lc.default_tag_setting) p.default_tag_setting = lc.default_tag_setting;
            p.flags = lc.flags || 0;   // REQUIRE_TAG lives here
        }
        return p;
    };

    // Community must be on BEFORE announcement channels can exist. It needs a
    // rules channel and an updates channel, which have to be staging ids.
    const liveRules = L.guild.rules_channel_id, liveUpdates = L.guild.public_updates_channel_id;
    const needsCommunity = !(S.guild.features || []).includes('COMMUNITY');
    if (needsCommunity) {
        const rulesId = chanMap.get(liveRules);
        const updatesId = chanMap.get(liveUpdates);
        if (!rulesId || !updatesId) {
            skip('COMMUNITY — live rules/updates channel has no staging twin yet');
        } else {
            await d.req('PATCH', `/guilds/${STAGING_GUILD}`, {
                features: [...new Set([...(S.guild.features || []), 'COMMUNITY'])],
                verification_level: Math.max(1, L.guild.verification_level),
                explicit_content_filter: 2,
                rules_channel_id: rulesId,
                public_updates_channel_id: updatesId,
            });
            note('   enabled COMMUNITY (needed for announcement channels and onboarding) — NOT discoverable');
        }
    }

    for (const lc of pendingCreate) {
        const parent = lc.parent_id ? chanMap.get(lc.parent_id) : null;
        const body = { ...channelProps(lc, null), type: lc.type, parent_id: parent || null };
        // REQUIRE_TAG is checked against the forum's current tags (none, on
        // create) and rejected with 40066 — set it once the tags exist.
        const flags = body.flags;
        delete body.flags;
        const created = await d.req('POST', `/guilds/${STAGING_GUILD}/channels`, body);
        d.markStagingChannel(created);
        chanMap.set(lc.id, created.id);
        if (flags) await d.req('PATCH', `/channels/${created.id}`, { flags });
        note(`   created ${lc.type === T.NEWS ? 'announcement' : lc.type === T.FORUM ? 'forum' : 'channel'} #${lc.name}`);
    }

    // Update every matched channel to live's properties.
    for (const lc of [...liveCats, ...liveRest]) {
        const sid = chanMap.get(lc.id);
        if (!sid || pendingCreate.includes(lc)) continue;
        const twin = S.channels.find(c => c.id === sid);
        const body = lc.type === T.CATEGORY
            ? { name: aliasOf(lc.name), permission_overwrites: mapOverwrites(lc) }
            : channelProps(lc, twin);
        if (twin && isTextish(lc.type) && twin.type !== lc.type) body.type = lc.type;   // text ↔ announcement
        await d.req('PATCH', `/channels/${sid}`, body);
    }
    note(`   updated ${[...liveCats, ...liveRest].filter(lc => chanMap.has(lc.id) && !pendingCreate.includes(lc)).length} existing channels to live's topics, overwrites, tags and settings`);

    // Channels staging has and live does not: kept (and left untouched) unless
    // --prune. This is where things are built before they ship to live.
    const keptChannelIds = new Set();
    for (const c of extraStaging) {
        if (!PRUNE) { keptChannelIds.add(c.id); continue; }
        await d.req('DELETE', `/channels/${c.id}`);
        note(`   pruned staging-only channel #${c.name}`);
    }
    if (keptChannelIds.size) {
        note(`   kept ${keptChannelIds.size} staging-only channel(s) untouched: ${extraStaging.map(c => (c.type === T.CATEGORY ? '[' + c.name + ']' : '#' + c.name)).join(', ')}`);
    }

    // Positions + parents. Discord allows only ONE category change per bulk call,
    // and treats any entry that merely includes parent_id as a change — so
    // category moves go one at a time, and the bulk call carries positions only.
    const current = APPLY ? await d.get(`/guilds/${STAGING_GUILD}/channels`) : S.channels;
    const currentParent = new Map(current.map(c => [c.id, c.parent_id || null]));
    // A relocated channel belongs to the staging category the layout names —
    // if that category exists yet. If not, leave it where it is; staging-mods
    // will create the category and move it.
    const parentFor = (lc) => {
        const target = LAYOUT.relocate[lc.name];
        if (target) {
            const cat = current.find(c => c.type === T.CATEGORY && c.name === target);
            return cat ? cat.id : (currentParent.get(chanMap.get(lc.id)) ?? null);
        }
        return lc.parent_id ? (chanMap.get(lc.parent_id) || null) : null;
    };
    const layout = [...liveCats, ...liveRest].filter(lc => chanMap.has(lc.id)).map(lc => ({
        id: chanMap.get(lc.id),
        position: lc.position,
        parent_id: parentFor(lc),
        isCategory: lc.type === T.CATEGORY,
    }));
    const moves = layout.filter(l => !l.isCategory && currentParent.has(l.id) && currentParent.get(l.id) !== l.parent_id);
    for (const mv of moves) {
        await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`,
            [{ id: mv.id, parent_id: mv.parent_id, lock_permissions: false }]);
    }
    // Categories by index, in live's order, with kept staging-only categories
    // (e.g. 🕺 PUNCHY! MOVES) staying next to the category they follow now.
    const liveCatOrder = layout.filter(l => l.isCategory).sort((a, b) => a.position - b.position).map(l => l.id);
    const currentCatOrder = current.filter(c => c.type === T.CATEGORY)
        .sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).map(c => c.id);
    const catOrder = mergeOrder(liveCatOrder, currentCatOrder, id => keptChannelIds.has(id));
    await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`, [
        ...catOrder.map((id, i) => ({ id, position: i })),
        ...layout.filter(l => !l.isCategory).map(({ id, position }) => ({ id, position })),
    ]);
    note(`   laid out ${layout.length} channels in live's order (${moves.length} moved category)`);

    // ── 5b. Settings that point at channels ─────────────────────────────────
    const mapCh = id => id ? (chanMap.get(id) || null) : null;
    await d.req('PATCH', `/guilds/${STAGING_GUILD}`, {
        system_channel_id: mapCh(L.guild.system_channel_id),
        rules_channel_id: mapCh(liveRules),
        public_updates_channel_id: mapCh(liveUpdates),
        safety_alerts_channel_id: mapCh(L.guild.safety_alerts_channel_id),
        afk_channel_id: mapCh(L.guild.afk_channel_id),
        verification_level: Math.max(1, L.guild.verification_level),
    });
    note('   system / rules / updates / safety / AFK channels pointed at staging twins');

    // ── 6. AutoMod ───────────────────────────────────────────────────────────
    note('\n── 6. automod');
    const stagingRules = await d.get(`/guilds/${STAGING_GUILD}/auto-moderation/rules`).catch(() => []);
    for (const lr of L.automod || []) {
        const body = {
            name: lr.name,
            event_type: lr.event_type,
            trigger_type: lr.trigger_type,
            trigger_metadata: lr.trigger_metadata,
            actions: (lr.actions || []).map(a => {
                const md = { ...(a.metadata || {}) };
                if (md.channel_id) md.channel_id = mapCh(md.channel_id);
                return { type: a.type, metadata: md };
            }).filter(a => a.type !== 2 || a.metadata.channel_id),
            enabled: lr.enabled,
            exempt_roles: (lr.exempt_roles || []).map(id => roleMap.get(id)).filter(Boolean),
            exempt_channels: (lr.exempt_channels || []).map(id => chanMap.get(id)).filter(Boolean),
        };
        const twin = stagingRules.find(r => r.name === lr.name);
        const same = twin
            && JSON.stringify(twin.trigger_metadata) === JSON.stringify(body.trigger_metadata)
            && JSON.stringify(twin.actions) === JSON.stringify(body.actions)
            && twin.enabled === body.enabled
            && JSON.stringify([...twin.exempt_roles].sort()) === JSON.stringify([...body.exempt_roles].sort())
            && JSON.stringify([...twin.exempt_channels].sort()) === JSON.stringify([...body.exempt_channels].sort());
        if (same) { note(`   AutoMod rule "${lr.name}" already matches`); continue; }
        // Discord's built-in default rules (enabled with Community) carry the SAME
        // fixed id in every guild, so staging's twin can share an id with live's.
        // The guard refuses any route containing a live id, and that is correct —
        // this is flagged for a human rather than excepted in the guard.
        if (twin && d.liveIds.has(twin.id)) {
            skip(`AutoMod rule "${lr.name}" differs, but its id is shared with live (a Discord default rule) — edit it by hand in staging`);
            continue;
        }
        if (twin) await d.req('PATCH', `/guilds/${STAGING_GUILD}/auto-moderation/rules/${twin.id}`, body);
        else await d.req('POST', `/guilds/${STAGING_GUILD}/auto-moderation/rules`, body);
        note(`   ${twin ? 'updated' : 'created'} AutoMod rule "${lr.name}"`);
    }

    // ── 7. Onboarding ────────────────────────────────────────────────────────
    note('\n── 7. onboarding');
    if (!L.onboarding) {
        skip('onboarding — could not read live onboarding');
    } else {
        const prompts = (L.onboarding.prompts || []).map(p => ({
            id: newSnowflake(),
            type: p.type,
            title: p.title,
            single_select: p.single_select,
            required: p.required,
            in_onboarding: p.in_onboarding,
            options: (p.options || []).map(o => {
                const opt = {
                    id: newSnowflake(),
                    title: o.title,
                    description: o.description,
                    channel_ids: (o.channel_ids || []).map(id => chanMap.get(id)).filter(Boolean),
                    role_ids: (o.role_ids || []).map(id => roleMap.get(id)).filter(Boolean),
                };
                const e = o.emoji;
                if (e?.id && emojiMap.get(e.id)) { opt.emoji_id = emojiMap.get(e.id); opt.emoji_name = e.name; opt.emoji_animated = !!e.animated; }
                else if (e?.name && !e.id) opt.emoji_name = e.name;
                const lostRoles = (o.role_ids || []).filter(id => !roleMap.get(id));
                if (lostRoles.length) skip(`onboarding option "${o.title}": ${lostRoles.length} role(s) with no staging twin`);
                return opt;
            }),
        }));
        // Merge rather than replace — a PUT replaces the whole configuration, and
        // staging carries prompts and options that live does not have yet.
        const stagingOb = await d.get(`/guilds/${STAGING_GUILD}/onboarding`).catch(() => null);
        const isKeptRole = id => !PRUNE && keptRoleIds.has(id);
        const isKeptChannel = id => !PRUNE && keptChannelIds.has(id);
        const finalPrompts = mergeOnboarding(prompts, stagingOb?.prompts || [], isKeptRole, isKeptChannel);
        const body = {
            prompts: finalPrompts,
            default_channel_ids: [...new Set([
                ...(L.onboarding.default_channel_ids || []).map(id => chanMap.get(id)).filter(Boolean),
                ...(stagingOb?.default_channel_ids || []).filter(isKeptChannel),
            ])],
            enabled: L.onboarding.enabled,
            mode: L.onboarding.mode,
        };
        const keptPrompts = finalPrompts.length - prompts.length;
        try {
            await d.req('PUT', `/guilds/${STAGING_GUILD}/onboarding`, body);
            note(`   ${finalPrompts.length} prompts (${keptPrompts} staging-only kept), ${body.default_channel_ids.length} default channels, enabled=${body.enabled}`);
        } catch (e) {
            skip(`onboarding — Discord rejected it: ${e.message}`);
        }
    }

    // ── 8. Staging's own structure, on top of the mirror ─────────────────────
    // Mirroring live just reset Punchy!'s channel permissions to live's, which
    // ungates them. Re-apply the multi-mod layer (access roles, per-mod
    // categories, gated channels, onboarding) so a sync never leaves staging
    // half-built. --no-mods mirrors live and stops.
    if (!process.argv.includes('--no-mods')) {
        note('\n── 8. staging mods layer (scripts/staging-mods.js)');
        await require('./staging-mods').run(d, { apply: APPLY, log: (s) => note(s.replace(/^/gm, '   ')) });
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const report = {
        mode: APPLY ? 'apply' : 'dry-run',
        live: LIVE_GUILD, staging: STAGING_GUILD,
        writes: d.writes.length, refused: d.refused, skipped,
        roleMap: Object.fromEntries(roleMap), channelMap: Object.fromEntries(chanMap), emojiMap: Object.fromEntries(emojiMap),
        writeLog: d.writes,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`\n=== ${APPLY ? 'done' : 'dry run complete'} — ${d.writes.length} writes${APPLY ? '' : ' planned'}, ${skipped.length} skipped, ${d.refused.length} refused by the guard ===`);
    console.log(`report: ${REPORT}`);
    if (d.refused.length) process.exitCode = 2;
}

if (require.main === module) main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });

async function readStaging(d) {
    return {
        guild: await d.get(`/guilds/${STAGING_GUILD}`),
        channels: await d.get(`/guilds/${STAGING_GUILD}/channels`),
        roles: await d.get(`/guilds/${STAGING_GUILD}/roles`),
        emojis: await d.get(`/guilds/${STAGING_GUILD}/emojis`),
        stickers: await d.get(`/guilds/${STAGING_GUILD}/stickers`),
    };
}

module.exports = { GuardedDiscord, LIVE_GUILD, STAGING_GUILD, mergeOrder, mergeOnboarding, reshapeOption };
