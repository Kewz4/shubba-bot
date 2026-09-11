#!/usr/bin/env node
'use strict';
/**
 * Build the Punchy! Moves section in the STAGING server.
 *
 *   node scripts/staging-moves.js            # dry run
 *   node scripts/staging-moves.js --apply    # perform it
 *
 * Punchy! Moves is the third-person counterpart to Punchy!. This adds, in
 * staging only:
 *   • a "Punchy! Moves" access role and a "Moves Updates" ping role;
 *   • a 🕺 PUNCHY! MOVES category, visible only to that role (and staff),
 *     holding announcements / general / bug-report / wiki-questions /
 *     suggestions / addons — each cloned from its Punchy! counterpart's tags,
 *     slowmode, layout and permissions, with guidelines rewritten for Moves;
 *   • an onboarding question that grants access, and a Moves option in the
 *     existing notifications question.
 * The original Punchy! channels stay visible to everyone: nothing changes for
 * existing members.
 *
 * Every write goes through the same GuardedDiscord as staging-sync.js, loaded
 * with every live id, so this cannot touch the live server. It reads live only
 * to arm that guard. Idempotent: re-running updates in place, by name.
 */

const {
    GuardedDiscord, LIVE_GUILD, STAGING_GUILD,
} = require('./staging-sync');

const APPLY = process.argv.includes('--apply');
const VIEW = 1n << 10n;

// ─── The spec — edit here ───────────────────────────────────────────────────

const ACCESS_ROLE = { name: 'Punchy! Moves', color: 0x9B59B6, hoist: false, mentionable: false };
const PING_ROLE = { name: 'Moves Updates', color: 0, hoist: false, mentionable: false };
const CATEGORY = '🕺 PUNCHY! MOVES';
const PLACE_CATEGORY_AFTER = '🧠 FORUMS';
// Roles that must still see a gated channel. Administrators bypass anyway.
const STAFF_ROLES = ['Moderator', 'Helper', 'Helper | Bug Hunter'];
// Forum tags naming WHICH mod a post is about. Inside a Moves-only forum
// they mean nothing, so they are not copied.
const MOD_SCOPE_TAGS = new Set(['Punchy', 'EFL', 'Better Fishing']);

// {{name}} in a topic becomes a mention of the staging channel with that name.
const CHANNELS = [
    {
        name: '📢│moves-announcements', source: '📢│announcements',
        topic: 'Punchy! Moves news, releases and teasers.',
    },
    {
        name: '💬│moves-general', source: '💬│general-en',
        topic: 'Chat about Punchy! Moves, the third-person mod. Bugs → {{🪲│moves-bug-report}} · Questions → {{⁉️│moves-wiki-questions}}',
    },
    {
        name: '🪲│moves-bug-report', source: '🪲│bug-report',
        topic: [
            '> # 🐛 HOW TO REPORT A PUNCHY! MOVES BUG',
            '> ',
            '> **This forum is for Punchy! Moves — the third-person mod.**',
            '> A bug in the original first-person Punchy!? Post it in {{🪲│bug-report}} instead.',
            '> ',
            '> ## 🛑 STOP! READ THIS FIRST! 🛑',
            '> **WE WILL NOT OFFER ASSISTANCE WITHOUT THE REQUIRED INFORMATION.**',
            '> If your report lacks a Modlist, Resource Pack list, or Crash Report (if applicable), we cannot help you.',
            '> ',
            '> **YOU MUST USE TAGS FOR:**',
            '> 🏷️ **Minecraft Version** (e.g., `1.21.11`)',
            '> 🏷️ **Modloader** (e.g., `NeoForge`, `Fabric`)',
            '> 🏷️ **Issue Type** (e.g., `Visual Bug`, `Crash`)',
            '> ',
            '> *Do not include these in the text body. Use the tags above!*',
            '> ',
            '> ---',
            '> ',
            '> ### 📝 INCLUDE THIS IN YOUR POST:',
            '> ',
            '> **1. Mod Version**',
            '> (The exact version of Punchy! Moves you are running.)',
            '> ',
            '> **2. CRASH REPORT / LOGS (Mandatory if crashing)**',
            '> **If your game crashed, we ABSOLUTELY need the crash report.**',
            '> *(Upload the file or use a site like <https://mclo.gs/>. Do not paste the raw text here.)*',
            '> ',
            '> **3. Modlist & Resource Pack List (Mandatory)**',
            '> **We need to know what else you have installed** — and say whether you also run the original Punchy!, even if you think it is unrelated.',
            '> *(Screenshots of your folder or a text list are acceptable.)*',
            '> ',
            '> **4. What happened?**',
            '> (Description of the bug + **Steps to reproduce**. Which third-person view were you in — behind the player, or facing it?)',
            '> ',
            '> **5. Media (Optional)**',
            '> (Screenshots or video evidence — for an animation bug, a short clip is worth a paragraph.)',
            '> If video you can use https://catbox.moe/ to bypass discord size limit.',
            '> ',
            '> ---',
            '> ',
            '> **⚙️ BUG FLOW**',
            '> > • I may ask for more info here.',
            "> > • Once confirmed, I'll add it to my work board and archive this thread.",
            '> > • Fixed bugs are posted in {{🐛│killed-bug}}.',
        ].join('\n'),
    },
    {
        name: '⁉️│moves-wiki-questions', source: '⁉️│wiki-questions',
        topic: [
            '> # 📚 PUNCHY! MOVES — HOW-TO QUESTIONS',
            '> ',
            '> **This forum is for questions about how Punchy! Moves WORKS — not for bugs.**',
            '> Found something broken? Post in {{🪲│moves-bug-report}} instead.',
            '> Got a feature idea? Post in {{💡│moves-suggestions}}.',
            '> Asking about the original first-person Punchy!? That is {{⁉️│wiki-questions}}.',
            '> ',
            '> ---',
            '> ',
            '> ### ✅ ASK HERE ABOUT:',
            '> • Installing and configuring Punchy! Moves',
            '> • Resource packs and animations for third person',
            '> • Compatibility with other mods — including running it alongside Punchy!',
            '> • Config options and what they actually do',
            '> ',
            '> ### 📝 TO GET A GOOD ANSWER, INCLUDE:',
            '> **1.** What you are trying to achieve (the goal, not just the step)',
            '> **2.** Your Punchy! Moves version, Minecraft version, and mod loader',
            '> **3.** The exact file you are editing, and its contents in a code block',
            '> **4.** What you expected vs. what actually happened',
            '> ',
            '> *Tags are optional here — but adding your version, loader, and topic helps a lot.*',
        ].join('\n'),
    },
    {
        name: '💡│moves-suggestions', source: '💡│suggestions',
        // Targeted edits of the source text; each must match or the run stops.
        rewrite: [
            ['**SUGGESTION FLOW IN THIS CHANNEL**', '**PUNCHY! MOVES — SUGGESTION FLOW**'],
            ['Thanks for helping me improve the mod!', 'Thanks for helping me improve Punchy! Moves!'],
        ],
    },
    {
        name: '📦│moves-addons', source: '📦│addons',
        rewrite: [
            ['custom first-person animations, arm packs, item animations', 'custom third-person animations, poses and item animations'],
            ['make Punchy! work with another mod', 'make Punchy! Moves work with another mod'],
            ['pre-made F9 tuning profiles for specific items or mods', 'pre-made presets that fix how specific items or mods look in third person'],
            ['Which Punchy! version(s) it supports', 'Which Punchy! Moves version(s) it supports'],
            ['if it breaks after a Punchy! update', 'if it breaks after a Punchy! Moves update'],
        ],
    },
];

const ACCESS_PROMPT = {
    title: 'Which Punchy! mods are you here for?',
    required: true,
    single_select: false,
    options: [
        {
            title: 'Punchy!',
            description: 'First-person animations — the original mod.',
            emoji_name: '👊',
            channels: ['🪲│bug-report', '⁉️│wiki-questions', '💡│suggestions', '📦│addons'],
            roles: [],
        },
        {
            title: 'Punchy! Moves',
            description: 'Third-person animations — the new one.',
            emoji_name: '🕺',
            channels: ['📢│moves-announcements', '💬│moves-general', '🪲│moves-bug-report', '⁉️│moves-wiki-questions', '💡│moves-suggestions', '📦│moves-addons'],
            roles: [ACCESS_ROLE.name],
        },
    ],
};
const NOTIFY_PROMPT_TITLE = 'What notifications would you like to receive?';   // prefix match
const NOTIFY_OPTION = {
    title: 'Punchy! Moves Updates',
    description: 'Get pinged for Punchy! Moves news and releases.',
    emoji_name: '🕺',
    channels: ['📢│moves-announcements'],
    // A Moves ping is useless without being able to see Moves — grant both.
    roles: [PING_ROLE.name, ACCESS_ROLE.name],
};
const EVERYTHING_OPTION_TITLE = 'Everything';

// ─── Build ──────────────────────────────────────────────────────────────────

let snowSeq = 0n;
const newSnowflake = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) + (snowSeq++ & 0xFFFn)).toString();

async function main() {
    const d = new GuardedDiscord();
    const say = (s) => console.log(s);
    say(`=== staging-moves — ${APPLY ? 'APPLYING' : 'DRY RUN (nothing will change)'} ===\n`);

    // Arm the guard with every live id before anything else.
    d.markLive((await d.get(`/guilds/${LIVE_GUILD}/channels`)).map(c => c.id));
    d.markLive((await d.get(`/guilds/${LIVE_GUILD}/roles`)).map(r => r.id));
    d.markLive((await d.get(`/guilds/${LIVE_GUILD}/emojis`)).map(e => e.id));

    let channels = await d.get(`/guilds/${STAGING_GUILD}/channels`);
    for (const c of channels) d.markStagingChannel(c);
    let roles = await d.get(`/guilds/${STAGING_GUILD}/roles`);

    const byName = (list, name) => list.filter(x => x.name === name);
    const one = (list, name, what) => {
        const hits = byName(list, name);
        if (hits.length !== 1) throw new Error(`expected exactly one ${what} named "${name}" in staging, found ${hits.length}`);
        return hits[0];
    };

    // ── Roles ────────────────────────────────────────────────────────────────
    say('── roles');
    const ensureRole = async (spec, abovePos) => {
        const have = byName(roles, spec.name)[0];
        if (have) {
            await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles/${have.id}`, { color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable });
            say(`   "${spec.name}" exists — settings refreshed`);
            return have.id;
        }
        const created = await d.req('POST', `/guilds/${STAGING_GUILD}/roles`, { ...spec, permissions: '0' });
        say(`   created role "${spec.name}"`);
        return created.id;
    };
    const accessRoleId = await ensureRole(ACCESS_ROLE);
    const pingRoleId = await ensureRole(PING_ROLE);

    // Sit them with the other opt-in roles, just above "Server Updates".
    if (APPLY) roles = await d.get(`/guilds/${STAGING_GUILD}/roles`);
    const anchor = byName(roles, 'Server Updates')[0];
    if (anchor) {
        await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles`, [
            { id: pingRoleId, position: anchor.position + 1 },
            { id: accessRoleId, position: anchor.position + 2 },
        ]);
        say('   placed both above "Server Updates"');
    }

    const staffIds = STAFF_ROLES.map(n => byName(roles, n)[0]?.id).filter(Boolean);
    if (staffIds.length !== STAFF_ROLES.length) say(`   ⚠ only found ${staffIds.length}/${STAFF_ROLES.length} staff roles`);

    // ── Category ─────────────────────────────────────────────────────────────
    say('\n── category');
    // Gate: @everyone may not view; the access role and staff may.
    const gate = (base = []) => {
        const out = new Map();
        for (const o of base) out.set(o.id, { id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) });
        const set = (id, allowView) => {
            const cur = out.get(id) || { id, type: 0, allow: 0n, deny: 0n };
            if (allowView) { cur.allow |= VIEW; cur.deny &= ~VIEW; } else { cur.deny |= VIEW; cur.allow &= ~VIEW; }
            out.set(id, cur);
        };
        set(STAGING_GUILD, false);
        set(accessRoleId, true);
        for (const id of staffIds) set(id, true);
        return [...out.values()].map(o => ({ ...o, allow: o.allow.toString(), deny: o.deny.toString() }));
    };

    let category = channels.find(c => c.type === 4 && c.name === CATEGORY);
    if (category) {
        await d.req('PATCH', `/channels/${category.id}`, { permission_overwrites: gate() });
        say(`   [${CATEGORY}] exists — permissions refreshed`);
    } else {
        category = await d.req('POST', `/guilds/${STAGING_GUILD}/channels`, { name: CATEGORY, type: 4, permission_overwrites: gate() });
        d.markStagingChannel(category);
        say(`   created [${CATEGORY}]`);
    }

    // ── Channels ─────────────────────────────────────────────────────────────
    say('\n── channels');
    const made = new Map();   // name -> id, for channels this script owns
    const nameToId = (name) => made.get(name) || one(channels, name, 'channel').id;
    const resolveTopic = (text) => text.replace(/\{\{([^}]+)\}\}/g, (_, n) => {
        const id = made.get(n) || byName(channels, n)[0]?.id;
        return id ? `<#${id}>` : `#${n}`;
    });

    // Two passes: create/find everything first, so topics can link to siblings.
    for (const spec of CHANNELS) {
        const src = one(channels, spec.source, 'source channel');
        const existing = channels.find(c => c.name === spec.name && c.parent_id === category.id);
        if (existing) { made.set(spec.name, existing.id); continue; }
        const created = await d.req('POST', `/guilds/${STAGING_GUILD}/channels`, {
            name: spec.name, type: src.type, parent_id: category.id, permission_overwrites: gate(src.permission_overwrites),
        });
        d.markStagingChannel(created);
        made.set(spec.name, created.id);
        say(`   created #${spec.name} (${src.type === 15 ? 'forum' : src.type === 5 ? 'announcement' : 'text'}, from #${spec.source})`);
    }

    for (const spec of CHANNELS) {
        const src = one(channels, spec.source, 'source channel');
        let topic = spec.topic;
        if (!topic && spec.rewrite) {
            topic = src.topic || '';
            for (const [from, to] of spec.rewrite) {
                if (!topic.includes(from)) throw new Error(`#${spec.source}'s text changed — "${from.slice(0, 40)}…" no longer appears. Update the rewrite list.`);
                topic = topic.split(from).join(to);
            }
        }
        const body = {
            topic: resolveTopic(topic || ''),
            nsfw: !!src.nsfw,
            rate_limit_per_user: src.rate_limit_per_user || 0,
            permission_overwrites: gate(src.permission_overwrites),
        };
        if (src.default_auto_archive_duration) body.default_auto_archive_duration = src.default_auto_archive_duration;
        if (src.type === 15) {
            body.available_tags = (src.available_tags || [])
                .filter(t => !MOD_SCOPE_TAGS.has(t.name))
                .map(t => ({ name: t.name, moderated: !!t.moderated, emoji_id: t.emoji_id || null, emoji_name: t.emoji_name || null }));
            // Keep the ids of tags this forum already has, so posts keep their tags on a re-run.
            const own = channels.find(c => c.id === made.get(spec.name));
            for (const t of body.available_tags) {
                const twin = own?.available_tags?.find(x => x.name === t.name);
                if (twin) t.id = twin.id;
            }
            body.default_reaction_emoji = src.default_reaction_emoji || null;
            if (src.default_sort_order != null) body.default_sort_order = src.default_sort_order;
            if (src.default_forum_layout != null) body.default_forum_layout = src.default_forum_layout;
            if (src.default_thread_rate_limit_per_user != null) body.default_thread_rate_limit_per_user = src.default_thread_rate_limit_per_user;
            if (src.default_tag_setting) body.default_tag_setting = src.default_tag_setting;   // AND/OR tag filtering
        }
        await d.req('PATCH', `/channels/${made.get(spec.name)}`, body);
        // REQUIRE_TAG is validated against the forum's CURRENT tags — on a
        // freshly created forum that is none, and Discord rejects the flag
        // (40066) even when the same request adds the tags. So: tags, then flag.
        if (src.type === 15 && (src.flags || 0) !== 0) {
            await d.req('PATCH', `/channels/${made.get(spec.name)}`, { flags: src.flags });
        }
    }
    say(`   ${CHANNELS.length} channels configured: guidelines, tags (minus mod-scope tags), slowmode, permissions`);

    // ── Layout ───────────────────────────────────────────────────────────────
    if (APPLY) channels = await d.get(`/guilds/${STAGING_GUILD}/channels`);
    const cats = channels.filter(c => c.type === 4 && c.id !== category.id).sort((a, b) => a.position - b.position);
    const at = cats.findIndex(c => c.name === PLACE_CATEGORY_AFTER);
    cats.splice(at === -1 ? cats.length : at + 1, 0, category);
    await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`, cats.map((c, i) => ({ id: c.id, position: i })));
    await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`, CHANNELS.map((s, i) => ({ id: made.get(s.name), position: i })));
    say(`\n── layout\n   [${CATEGORY}] placed after [${PLACE_CATEGORY_AFTER}], channels ordered`);

    // ── Onboarding ───────────────────────────────────────────────────────────
    say('\n── onboarding');
    const ob = await d.get(`/guilds/${STAGING_GUILD}/onboarding`);
    const roleIdByName = (n) => n === ACCESS_ROLE.name ? accessRoleId : n === PING_ROLE.name ? pingRoleId : one(roles, n, 'role').id;
    const buildOption = (spec, existing) => ({
        id: existing?.id || newSnowflake(),
        title: spec.title,
        description: spec.description,
        emoji_name: spec.emoji_name,
        channel_ids: spec.channels.map(nameToId),
        role_ids: spec.roles.map(roleIdByName),
    });
    // Re-send existing options in the shape the PUT expects.
    const reshape = (o) => {
        const out = { id: o.id, title: o.title, description: o.description, channel_ids: o.channel_ids, role_ids: o.role_ids };
        if (o.emoji?.id) { out.emoji_id = o.emoji.id; out.emoji_name = o.emoji.name; out.emoji_animated = !!o.emoji.animated; }
        else if (o.emoji?.name) out.emoji_name = o.emoji.name;
        return out;
    };

    const prompts = ob.prompts.map(p => ({
        id: p.id, type: p.type, title: p.title, single_select: p.single_select,
        required: p.required, in_onboarding: p.in_onboarding, options: p.options.map(reshape),
    }));

    // 1. The access question, first.
    const oldAccess = prompts.find(p => p.title === ACCESS_PROMPT.title);
    const access = {
        id: oldAccess?.id || newSnowflake(),
        type: 0,
        title: ACCESS_PROMPT.title,
        single_select: ACCESS_PROMPT.single_select,
        required: ACCESS_PROMPT.required,
        in_onboarding: true,
        options: ACCESS_PROMPT.options.map(o => buildOption(o, oldAccess?.options.find(x => x.title === o.title))),
    };
    const rest = prompts.filter(p => p.title !== ACCESS_PROMPT.title);

    // 2. Moves in the notifications question — and in "Everything".
    const notify = rest.find(p => p.title.startsWith(NOTIFY_PROMPT_TITLE.slice(0, 40)));
    if (notify) {
        const i = notify.options.findIndex(o => o.title === NOTIFY_OPTION.title);
        const opt = buildOption(NOTIFY_OPTION, i >= 0 ? notify.options[i] : null);
        if (i >= 0) notify.options[i] = opt; else notify.options.push(opt);
        const everything = notify.options.find(o => o.title === EVERYTHING_OPTION_TITLE);
        if (everything) {
            everything.role_ids = [...new Set([...everything.role_ids, pingRoleId, accessRoleId])];
            everything.channel_ids = [...new Set([...everything.channel_ids, nameToId('📢│moves-announcements')])];
        }
        say(`   notifications: "${NOTIFY_OPTION.title}" option${everything ? ', and added to "Everything"' : ''}`);
    } else {
        say('   ⚠ notifications prompt not found — Moves Updates option not added');
    }

    const body = {
        prompts: [access, ...rest],
        default_channel_ids: ob.default_channel_ids,   // Moves channels are gated, so never defaults
        enabled: ob.enabled,
        mode: ob.mode,
    };
    await d.req('PUT', `/guilds/${STAGING_GUILD}/onboarding`, body);
    say(`   "${ACCESS_PROMPT.title}" is question 1 of ${body.prompts.length} (required, multi-select)`);

    say(`\n=== ${APPLY ? 'done' : 'dry run complete'} — ${d.writes.length} writes${APPLY ? '' : ' planned'}, ${d.refused.length} refused by the guard ===`);
    if (d.refused.length) process.exitCode = 2;
}

if (require.main === module) main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
module.exports = { CHANNELS, ACCESS_PROMPT, NOTIFY_OPTION, ACCESS_ROLE, PING_ROLE, CATEGORY, MOD_SCOPE_TAGS };
