#!/usr/bin/env node
'use strict';
/**
 * Staging's multi-mod structure, layered on top of the live mirror.
 *
 *   node scripts/staging-mods.js            # dry run
 *   node scripts/staging-mods.js --apply    # perform it
 * (staging-sync.js runs this automatically at the end; pass it --no-mods to skip.)
 *
 * The server is organised around FOUR mods — Punchy!, Punchy! Moves, Enchanted
 * Fishing Line and Better Fishing — each in its own category, plus a 🏠 HOME
 * category for server-wide channels. Onboarding asks which mods you are here
 * for; each answer grants that mod's access role, and every mod channel is
 * visible only to its role (and staff).
 *
 * ── How the "conditional" pings work ────────────────────────────────────────
 * Discord onboarding has no conditional questions, and an answer can only hand
 * out a fixed set of roles — so "teasers, but only for the mods I picked"
 * cannot be expressed as an answer. It does not need to be:
 *
 *   Discord only notifies a role mention to members who can SEE the channel.
 *
 * So the ping roles stay generic, exactly as live has them ("Punchers!" =
 * announcements, "Teaser" = teasers), and each mod has its OWN announcements
 * and teasers channels, gated by its access role. @Teaser in #efl-teasers
 * reaches exactly the people who picked Teasers AND Enchanted Fishing Line.
 * Pick 3 mods + "Teasers and Announcements" → both pings, for those 3 only.
 * Change your mods later and your pings follow, with nothing to re-answer.
 *
 * ── Living alongside the live mirror ────────────────────────────────────────
 * This layout moves, renames and removes channels that live has. LAYOUT (below)
 * declares exactly that, and staging-sync reads it so a sync does not undo it:
 * it will not recreate what is removed, move relocated channels back, or
 * rename a renamed category. Everything else still mirrors live, then this
 * script re-applies the gates. Idempotent: every step finds by name.
 *
 * Every write goes through staging-sync's GuardedDiscord, armed with every
 * live id first, so none of this can reach the live server.
 */

const VIEW = 1n << 10n;
const LANGS = [
    { code: 'en', topic: m => `${m} chat — English.` },
    { code: 'br', topic: m => `Chat do ${m} — Português.` },
    { code: 'es', topic: m => `Chat de ${m} — Español.` },
    { code: 'ru', topic: m => `Чат ${m} — Русский.` },
];

// Roles that must see every gated channel. Administrators bypass anyway.
const STAFF_ROLES = ['Moderator', 'Helper', 'Helper | Bug Hunter'];
// Forum tags that name WHICH mod a post is about — meaningless in a forum that
// already belongs to one mod, so they are not copied into per-mod forums.
const MOD_SCOPE_TAGS = new Set(['Punchy', 'EFL', 'Better Fishing']);

// ─── Server-wide layout ─────────────────────────────────────────────────────

// Server-wide channels: welcome, rules, the general FAQ, server updates, music,
// boosters — plus commands and the flytrap honeypot, moved in from 💬 GENERAL.
// (The flytrap is found by id in Shubba's spam detection, so moving it between
// categories changes nothing there.)
const HOME = { from: '📌 IMPORTANT', name: '🏠 HOME', adopt: ['🤖│commands', 'dont-message-here-flytrap'] };
const REMOVED_CHANNELS = [
    '🐛│killed-bug', '📋│roadmap-board', 'peak',
    // Built by an earlier version, before Punchy! adopted the original general chats.
    '💬│punchy-general-en', '💬│punchy-general-br', '💬│punchy-general-es', '💬│punchy-general-ru',
];
// Emptied by moving their channels into mod categories.
const REMOVED_CATEGORIES_IF_EMPTY = ['🧠 FORUMS'];
const PLACE_MOD_CATEGORIES_AFTER = 'YOUR CREATIONS';
// Channels everyone can post in, kept as onboarding defaults. Discord requires
// at least 5 such defaults; the general chats used to supply them, but they
// are Punchy!'s now and gated.
const PUBLIC_DEFAULTS = ['🤖│commands', '🌇│gallery', '🧱│minecraft-showcase'];

// ─── Channel templates ──────────────────────────────────────────────────────

const bugReportTopic = (mod, { questionsIn, reproHint, knownIssues }) => [
    `> # 🐛 HOW TO REPORT A ${mod.name.toUpperCase()} BUG`,
    '> ',
    `> **This forum is for ${mod.name} only.** Each of our mods has its own bug-report forum.`,
    `> **Check {{${knownIssues}}} first** — your bug may already be known, with a workaround.`,
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
    `> (The exact version of ${mod.name} you are running.)`,
    '> ',
    '> **2. CRASH REPORT / LOGS (Mandatory if crashing)**',
    '> **If your game crashed, we ABSOLUTELY need the crash report.**',
    '> *(Upload the file or use a site like <https://mclo.gs/>. Do not paste the raw text here.)*',
    '> ',
    '> **3. Modlist & Resource Pack List (Mandatory)**',
    '> **We need to know what else you have installed** — including any of our other mods, even if you think they are unrelated.',
    '> *(Screenshots of your folder or a text list are acceptable.)*',
    '> ',
    '> **4. What happened?**',
    `> (Description of the bug + **Steps to reproduce**.${reproHint ? ' ' + reproHint : ''})`,
    '> ',
    '> **5. Media (Optional)**',
    '> (Screenshots or video evidence.)',
    '> If video you can use https://catbox.moe/ to bypass discord size limit.',
    '> ',
    '> ---',
    '> ',
    `> Just a question, not a bug? Ask in {{${questionsIn}}}.`,
].join('\n');

/** Channels a mod gets built for it, by template name. */
function buildChannels(mod) {
    const n = (base) => base.replace('│', `│${mod.prefix}-`);
    const T = {
        announcements: () => [{ name: n('📢│announcements'), source: '📢│announcements', topic: `${mod.name} announcements and releases.` }],
        teasers: () => [{ name: n('🎬│teasers'), source: '🎬│teasers', topic: `Sneak peeks of what is coming to ${mod.name}.` }],
        faq: () => [{ name: n('❓│faq'), source: '❓│faq', topic: `Frequently asked questions about ${mod.name}. General server questions live in {{❓│faq}}.` }],
        knownIssues: () => [{ name: n('🛠️│known-issues'), source: '🛠️│known-issues', topic: `Known problems in ${mod.name}, and their workarounds. Check here before reporting a bug.` }],
        chats: () => LANGS.map(l => ({ name: n(`💬│general-${l.code}`), source: `💬│general-${l.code}`, topic: l.topic(mod.name), lang: l.code })),
        bugReport: () => [{
            name: n('🪲│bug-report'), source: '🪲│bug-report',
            topic: bugReportTopic(mod, {
                questionsIn: mod.build.includes('wiki') ? n('⁉️│wiki-questions') : n('💬│general-en'),
                reproHint: mod.reproHint,
                knownIssues: n('🛠️│known-issues'),
            }),
        }],
        wiki: () => [{ name: n('⁉️│wiki-questions'), source: '⁉️│wiki-questions', topic: mod.wikiTopic(n) }],
        suggestions: () => [{
            name: n('💡│suggestions'), source: '💡│suggestions',
            rewrite: [
                ['**SUGGESTION FLOW IN THIS CHANNEL**', `**${mod.name.toUpperCase()} — SUGGESTION FLOW**`],
                ['Thanks for helping me improve the mod!', `Thanks for helping me improve ${mod.name}!`],
            ],
        }],
        addons: () => [{ name: n('📦│addons'), source: '📦│addons', rewrite: mod.addonsRewrite }],
    };
    return mod.build.flatMap(k => T[k]());
}

// ─── The mods ───────────────────────────────────────────────────────────────

const MODS = [
    {
        key: 'punchy',
        name: 'Punchy!',
        prefix: 'punchy',
        role: { name: 'Punchy!', color: 0xE69A09 },
        category: '👊 PUNCHY!',
        emoji_name: '👊',
        description: 'First-person animations — the original.',
        // Live's Punchy! channels, moved into this category as they are.
        adopt: [
            '📢│announcements', '🎬│teasers', '⬆️│addon-updates', '🛠️│known-issues',
            '💬│general-en', '💬│general-br', '💬│general-es', '💬│general-ru',   // the original chats ARE Punchy!'s
            '🪲│bug-report', '⁉️│wiki-questions', '💡│suggestions', '📦│addons',
        ],
        // Its own FAQ; the existing ❓│faq stays in HOME for general questions.
        build: ['faq'],
        order: [
            '📢│announcements', '🎬│teasers', '⬆️│addon-updates', '❓│punchy-faq', '🛠️│known-issues',
            '💬│general-en', '💬│general-br', '💬│general-es', '💬│general-ru',
            '🪲│bug-report', '⁉️│wiki-questions', '💡│suggestions', '📦│addons',
        ],
    },
    {
        key: 'moves',
        name: 'Punchy! Moves',
        prefix: 'moves',
        role: { name: 'Punchy! Moves', color: 0x9B59B6 },
        category: '🕺 PUNCHY! MOVES',
        emoji_name: '🕺',
        description: 'Third-person animations — the new one.',
        reproHint: 'Which third-person view were you in — behind the player, or facing it?',
        build: ['announcements', 'teasers', 'faq', 'knownIssues', 'chats', 'bugReport', 'wiki', 'suggestions', 'addons'],
        wikiTopic: (n) => [
            '> # 📚 PUNCHY! MOVES — HOW-TO QUESTIONS',
            '> ',
            '> **This forum is for questions about how Punchy! Moves WORKS — not for bugs.**',
            `> Found something broken? Post in {{${n('🪲│bug-report')}}} instead.`,
            `> Got a feature idea? Post in {{${n('💡│suggestions')}}}.`,
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
        addonsRewrite: [
            ['custom first-person animations, arm packs, item animations', 'custom third-person animations, poses and item animations'],
            ['make Punchy! work with another mod', 'make Punchy! Moves work with another mod'],
            ['pre-made F9 tuning profiles for specific items or mods', 'pre-made presets that fix how specific items or mods look in third person'],
            ['Which Punchy! version(s) it supports', 'Which Punchy! Moves version(s) it supports'],
            ['if it breaks after a Punchy! update', 'if it breaks after a Punchy! Moves update'],
        ],
        // An earlier version of this script created this channel under another name.
        renamed: { '💬│moves-general': '💬│moves-general-en' },
    },
    {
        key: 'efl',
        name: 'Enchanted Fishing Line',
        prefix: 'efl',
        role: { name: 'Enchanted Fishing Line', color: 0x1ABC9C },
        category: '🎣 ENCHANTED FISHING LINE',
        emoji_name: '🎣',
        description: 'Chat, bug reports and updates for Enchanted Fishing Line.',
        build: ['announcements', 'teasers', 'faq', 'knownIssues', 'chats', 'bugReport', 'suggestions'],
    },
    {
        key: 'bf',
        name: 'Better Fishing',
        prefix: 'bf',
        role: { name: 'Better Fishing', color: 0x3498DB },
        category: '🐟 BETTER FISHING',
        emoji_name: '🐟',
        description: 'Chat, bug reports and updates for Better Fishing.',
        build: ['announcements', 'teasers', 'faq', 'knownIssues', 'chats', 'bugReport', 'suggestions'],
    },
];
for (const m of MODS) {
    m.adopt = m.adopt || [];
    m.channels = buildChannels(m);
    m.order = m.order || [...m.adopt, ...m.channels.map(c => c.name)];
}

/**
 * What this layout changes about live's structure. staging-sync reads this so a
 * sync does not undo it.
 *   omit           — live channels/categories staging deliberately does not have
 *   categoryAlias  — live category name → the name staging gives it
 *   relocate       — live channel name → the staging category it lives in
 */
const LAYOUT = {
    omit: [...REMOVED_CHANNELS, ...REMOVED_CATEGORIES_IF_EMPTY],
    categoryAlias: { [HOME.from]: HOME.name },
    relocate: Object.fromEntries([
        ...MODS.flatMap(m => m.adopt.map(name => [name, m.category])),
        ...HOME.adopt.map(name => [name, HOME.name]),
    ]),
};

const MODS_PROMPT_TITLE = 'Which mods are you here for?';
// An earlier version asked this; it is replaced in place (same prompt id).
const LEGACY_MODS_PROMPT_TITLES = ['Which Punchy! mods are you here for?'];
const LANG_PROMPT_TITLE = 'Which languages do you speak?';
const NOTIFY_PROMPT_PREFIX = 'What notifications would you like to receive?';
// Left over from an earlier, mod-specific ping design that the generic ping
// roles make wrong: a per-mod ping role would reach people outside that mod.
const OBSOLETE_ROLES = ['Moves Updates'];
const OBSOLETE_NOTIFY_OPTIONS = ['Punchy! Moves Updates'];

// ─── Run ────────────────────────────────────────────────────────────────────

let snowSeq = 0n;
const newSnowflake = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) + (snowSeq++ & 0xFFFn)).toString();

async function run(d, { apply, log = console.log } = {}) {
    const { STAGING_GUILD } = require('./staging-sync');
    const say = log;
    let channels = await d.get(`/guilds/${STAGING_GUILD}/channels`);
    for (const c of channels) d.markStagingChannel(c);
    let roles = await d.get(`/guilds/${STAGING_GUILD}/roles`);

    const byName = (list, name) => list.filter(x => x.name === name);
    const one = (list, name, what) => {
        const hits = byName(list, name);
        if (hits.length !== 1) throw new Error(`expected exactly one ${what} named "${name}" in staging, found ${hits.length}`);
        return hits[0];
    };
    const refresh = async () => {
        if (!apply) return;
        channels = await d.get(`/guilds/${STAGING_GUILD}/channels`);
        roles = await d.get(`/guilds/${STAGING_GUILD}/roles`);
    };

    // Snapshot the SOURCE channels before anything moves or is removed: the
    // built channels copy their settings, and a source may be relocated below.
    const sources = new Map();
    for (const m of MODS) for (const spec of m.channels) {
        if (!sources.has(spec.source)) sources.set(spec.source, structuredClone(one(channels, spec.source, 'source channel')));
    }

    // ── Roles ────────────────────────────────────────────────────────────────
    say('── mod access roles');
    const roleIds = {};
    for (const m of MODS) {
        const spec = { name: m.role.name, color: m.role.color, hoist: false, mentionable: false };
        const have = byName(roles, spec.name)[0];
        if (have) {
            if (have.color !== spec.color || have.hoist || have.mentionable) {
                await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles/${have.id}`, { color: spec.color, hoist: false, mentionable: false });
            }
            roleIds[m.key] = have.id;
        } else {
            roleIds[m.key] = (await d.req('POST', `/guilds/${STAGING_GUILD}/roles`, { ...spec, permissions: '0' })).id;
            say(`   created role "${spec.name}"`);
        }
    }
    for (const name of OBSOLETE_ROLES) {
        for (const r of byName(roles, name)) {
            await d.req('DELETE', `/guilds/${STAGING_GUILD}/roles/${r.id}`);
            say(`   removed obsolete role "${name}" (a per-mod ping would reach people outside that mod)`);
        }
    }
    await refresh();
    const anchor = byName(roles, 'Server Updates')[0];
    if (anchor) {
        await d.req('PATCH', `/guilds/${STAGING_GUILD}/roles`,
            [...MODS].reverse().map((m, i) => ({ id: roleIds[m.key], position: anchor.position + 1 + i })));
    }
    say(`   ${MODS.map(m => `"${m.role.name}"`).join(', ')} — placed above "Server Updates"`);

    const staffIds = STAFF_ROLES.map(n => byName(roles, n)[0]?.id).filter(Boolean);
    const accessRoleIds = new Set(Object.values(roleIds));
    const gate = (base, modKey) => {
        const out = new Map();
        for (const o of base || []) out.set(o.id, { id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) });
        const set = (id, allowView) => {
            const cur = out.get(id) || { id, type: 0, allow: 0n, deny: 0n };
            if (allowView) { cur.allow |= VIEW; cur.deny &= ~VIEW; } else { cur.deny |= VIEW; cur.allow &= ~VIEW; }
            out.set(id, cur);
        };
        set(STAGING_GUILD, false);
        set(roleIds[modKey], true);
        for (const id of staffIds) set(id, true);
        // Another mod's access role must never open this channel.
        for (const id of accessRoleIds) if (id !== roleIds[modKey] && out.has(id)) out.delete(id);
        // ONLY this mod's role and staff may grant VIEW here. Any other role that
        // allows VIEW overrides the gate — a role allow beats the @everyone deny.
        // Live's "Punchers!" (which is also the announcements PING role, so nearly
        // everyone holds it) explicitly allows VIEW on #teasers. Copied as-is,
        // every mod's teasers channel was visible — and so ping-able — to members
        // of every other mod. Such roles keep their other permissions (reactions,
        // threads); they just stop opening the door.
        const keepView = new Set([STAGING_GUILD, roleIds[modKey], ...staffIds]);
        for (const [id, o] of out) if (!keepView.has(id) && o.type === 0) o.allow &= ~VIEW;
        return [...out.values()].map(o => ({ ...o, allow: o.allow.toString(), deny: o.deny.toString() }));
    };

    // ── Categories, adopted channels, built channels ─────────────────────────
    say('\n── mod categories and channels');
    const made = new Map();   // channel name -> id, for every channel a mod owns
    const resolveTopic = (text) => text.replace(/\{\{([^}]+)\}\}/g, (_, name) => {
        const id = made.get(name) || byName(channels, name)[0]?.id;
        return id ? `<#${id}>` : `#${name}`;
    });

    for (const m of MODS) {
        let cat = channels.find(c => c.type === 4 && c.name === m.category);
        if (!cat) {
            cat = await d.req('POST', `/guilds/${STAGING_GUILD}/channels`, { name: m.category, type: 4, permission_overwrites: gate([], m.key) });
            d.markStagingChannel(cat);
            channels.push({ ...cat, name: m.category, type: 4, permission_overwrites: [] });
            say(`   created [${m.category}]`);
        } else {
            await d.req('PATCH', `/channels/${cat.id}`, { permission_overwrites: gate([], m.key) });
        }
        m.categoryId = cat.id;

        for (const [oldName, newName] of Object.entries(m.renamed || {})) {
            const old = channels.find(c => c.name === oldName && c.parent_id === cat.id);
            if (old && !channels.some(c => c.name === newName && c.parent_id === cat.id)) {
                await d.req('PATCH', `/channels/${old.id}`, { name: newName });
                old.name = newName;
                say(`   renamed #${oldName} → #${newName}`);
            }
        }

        // Adopt: move live's channels in, as they are.
        let moved = 0;
        for (const name of m.adopt) {
            const ch = one(channels, name, 'channel to adopt');
            made.set(name, ch.id);
            if (ch.parent_id !== cat.id) {
                await d.req('PATCH', `/channels/${ch.id}`, { parent_id: cat.id, lock_permissions: false });
                ch.parent_id = cat.id;
                moved++;
            }
        }

        // Build: create what does not exist yet.
        for (const spec of m.channels) {
            const src = sources.get(spec.source);
            const existing = channels.find(c => c.name === spec.name && c.parent_id === cat.id);
            if (existing) { made.set(spec.name, existing.id); continue; }
            const created = await d.req('POST', `/guilds/${STAGING_GUILD}/channels`, {
                name: spec.name, type: src.type, parent_id: cat.id, permission_overwrites: gate(src.permission_overwrites, m.key),
            });
            d.markStagingChannel(created);
            channels.push({ ...created, name: spec.name, parent_id: cat.id, type: src.type });
            made.set(spec.name, created.id);
        }
        say(`   [${m.category}] ${m.order.length} channels${moved ? ` (${moved} moved in from live's layout)` : ''}: ${m.order.map(c => c.split('│')[1]).join(', ')}`);
    }

    // Configure every BUILT channel now that all of them exist (topics link across).
    for (const m of MODS) {
        for (const spec of m.channels) {
            const src = sources.get(spec.source);
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
                permission_overwrites: gate(src.permission_overwrites, m.key),
            };
            if (src.default_auto_archive_duration) body.default_auto_archive_duration = src.default_auto_archive_duration;
            if (src.type === 15) {
                const own = channels.find(c => c.id === made.get(spec.name));
                body.available_tags = (src.available_tags || [])
                    .filter(t => !MOD_SCOPE_TAGS.has(t.name))
                    .map(t => {
                        const tag = { name: t.name, moderated: !!t.moderated, emoji_id: t.emoji_id || null, emoji_name: t.emoji_name || null };
                        const twin = own?.available_tags?.find(x => x.name === t.name);
                        if (twin) tag.id = twin.id;   // keep ids so posts keep their tags
                        return tag;
                    });
                body.default_reaction_emoji = src.default_reaction_emoji || null;
                if (src.default_sort_order != null) body.default_sort_order = src.default_sort_order;
                if (src.default_forum_layout != null) body.default_forum_layout = src.default_forum_layout;
                if (src.default_thread_rate_limit_per_user != null) body.default_thread_rate_limit_per_user = src.default_thread_rate_limit_per_user;
                if (src.default_tag_setting) body.default_tag_setting = src.default_tag_setting;
            }
            await d.req('PATCH', `/channels/${made.get(spec.name)}`, body);
            // REQUIRE_TAG is validated against the forum's CURRENT tags, so a fresh
            // forum rejects it (40066) until the tags exist.
            if (src.type === 15 && (src.flags || 0) !== 0) {
                await d.req('PATCH', `/channels/${made.get(spec.name)}`, { flags: src.flags });
            }
        }
    }

    // ── HOME, and what the layout removes ────────────────────────────────────
    say('\n── server-wide layout');
    await refresh();
    const home = channels.find(c => c.type === 4 && (c.name === HOME.from || c.name === HOME.name));
    if (home && home.name !== HOME.name) {
        await d.req('PATCH', `/channels/${home.id}`, { name: HOME.name });
        say(`   renamed [${HOME.from}] → [${HOME.name}]`);
    }
    if (home) {
        home.name = HOME.name;
        // Pull in the server-wide channels that lived in other categories.
        for (const name of HOME.adopt) {
            const ch = byName(channels, name)[0];
            if (!ch) { say(`   ⚠ #${name} not found — cannot move it into HOME`); continue; }
            if (ch.parent_id !== home.id) {
                await d.req('PATCH', `/channels/${ch.id}`, { parent_id: home.id, lock_permissions: false });
                ch.parent_id = home.id;
                say(`   moved #${name} into [${HOME.name}]`);
            }
        }
        // HOME order: what it already had, then the adopted channels at the end.
        const homeKids = channels
            .filter(c => c.parent_id === home.id && !made.has(c.name) && !REMOVED_CHANNELS.includes(c.name))
            .sort((a, b) => (HOME.adopt.includes(a.name) - HOME.adopt.includes(b.name)) || (a.position - b.position)
                || (HOME.adopt.indexOf(a.name) - HOME.adopt.indexOf(b.name)));
        await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`, homeKids.map((c, i) => ({ id: c.id, position: i })));
        say(`   [${HOME.name}]: ${homeKids.map(c => c.name.split('│').pop()).join(', ')}`);
    }

    // Removed first from onboarding (a PUT naming a deleted channel is
    // rejected), then deleted. See the onboarding step, which filters ids.
    const removeIds = new Set();
    for (const name of REMOVED_CHANNELS) for (const c of byName(channels, name)) removeIds.add(c.id);

    // ── Layout ───────────────────────────────────────────────────────────────
    const modCatIds = MODS.map(m => m.categoryId);
    const removedCatNames = new Set(REMOVED_CATEGORIES_IF_EMPTY);
    const cats = channels
        .filter(c => c.type === 4 && !modCatIds.includes(c.id) && !removedCatNames.has(c.name))
        .sort((a, b) => a.position - b.position);
    const at = cats.findIndex(c => c.name === PLACE_MOD_CATEGORIES_AFTER);
    cats.splice(at === -1 ? cats.length : at + 1, 0, ...modCatIds.map(id => ({ id })));
    await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`, cats.map((c, i) => ({ id: c.id, position: i })));
    for (const m of MODS) {
        await d.req('PATCH', `/guilds/${STAGING_GUILD}/channels`, m.order.map((name, i) => ({ id: made.get(name), position: i })));
    }
    say(`   category order: ${cats.map(c => channels.find(x => x.id === c.id)?.name || MODS.find(m => m.categoryId === c.id)?.category).join(' → ')}`);

    // ── Onboarding (before gating and deleting, so no gated or deleted channel
    //    is ever a default or a stale reference) ────────────────────────────
    say('\n── onboarding');
    const gatedIds = new Set([...made.values()]);
    const ob = await d.get(`/guilds/${STAGING_GUILD}/onboarding`);

    const reshape = (o) => {
        const out = { id: o.id, title: o.title, description: o.description, channel_ids: [...(o.channel_ids || [])], role_ids: [...(o.role_ids || [])] };
        if (o.emoji?.id) { out.emoji_id = o.emoji.id; out.emoji_name = o.emoji.name; out.emoji_animated = !!o.emoji.animated; }
        else if (o.emoji?.name) out.emoji_name = o.emoji.name;
        return out;
    };
    let prompts = ob.prompts.map(p => ({ id: p.id, type: p.type, title: p.title, single_select: p.single_select, required: p.required, in_onboarding: p.in_onboarding, options: p.options.map(reshape) }));

    // 1. "Which mods are you here for?" — first, required, multi-select.
    const oldMods = prompts.find(p => p.title === MODS_PROMPT_TITLE || LEGACY_MODS_PROMPT_TITLES.includes(p.title));
    const langNames = new Set([
        ...MODS.flatMap(m => m.channels.filter(c => c.lang).map(c => c.name)),
        ...LANGS.map(l => `💬│general-${l.code}`),   // Punchy!'s adopted chats
    ]);
    const modsPrompt = {
        id: oldMods?.id || newSnowflake(),
        type: 0,
        title: MODS_PROMPT_TITLE,
        single_select: false,
        required: true,
        in_onboarding: true,
        options: MODS.map(m => {
            const prev = oldMods?.options.find(o => o.title === m.name);
            return {
                id: prev?.id || newSnowflake(),
                title: m.name,
                description: m.description,
                emoji_name: m.emoji_name,
                role_ids: [roleIds[m.key]],
                // Language chats come from the language question instead.
                channel_ids: m.order.filter(n => !langNames.has(n)).map(n => made.get(n)),
            };
        }),
    };
    prompts = [modsPrompt, ...prompts.filter(p => p !== oldMods)];

    // 2. Languages: each language also adds that language's chat in every mod.
    //    Visibility still comes from the mod roles, so you only ever see the
    //    chats of mods you picked — in the languages you picked.
    const lang = prompts.find(p => p.title === LANG_PROMPT_TITLE);
    const langChatIds = {};
    for (const m of MODS) for (const c of m.channels.filter(x => x.lang)) {
        (langChatIds[c.lang] = langChatIds[c.lang] || []).push(made.get(c.name));
    }
    if (lang) {
        for (const o of lang.options) {
            const code = LANGS.map(l => l.code).find(code =>
                o.channel_ids.some(id => channels.find(c => c.id === id)?.name === `💬│general-${code}`));
            if (code) o.channel_ids = [...new Set([...o.channel_ids, ...(langChatIds[code] || [])])];
        }
        say('   languages: each answer also adds that language\'s chat for every mod');
    }

    // 3. Notifications: generic, exactly as live — strip obsolete per-mod bits.
    const notify = prompts.find(p => p.title.startsWith(NOTIFY_PROMPT_PREFIX));
    if (notify) {
        notify.options = notify.options.filter(o => !OBSOLETE_NOTIFY_OPTIONS.includes(o.title));
        for (const o of notify.options) {
            o.role_ids = o.role_ids.filter(id => !accessRoleIds.has(id));
            o.channel_ids = o.channel_ids.filter(id => !MODS.some(m => m.channels.some(c => made.get(c.name) === id)));
        }
        say('   notifications: generic (announcements / teasers / …) — each mod\'s pings reach only that mod\'s members');
    }

    // Drop any id that no longer exists — or is about to be deleted. A PUT
    // naming a deleted role or channel is rejected outright (UNKNOWN_ROLE), and
    // looking an obsolete role up by name cannot find it once it is gone,
    // which is exactly when its id is still sitting in an option.
    await refresh();
    const existingRoles = new Set(roles.map(r => r.id));
    const existingChannels = new Set([...channels.map(c => c.id), ...made.values()]);
    for (const p of prompts) for (const o of p.options) {
        const r0 = o.role_ids.length, c0 = o.channel_ids.length;
        o.role_ids = o.role_ids.filter(id => (existingRoles.has(id) || !apply));
        o.channel_ids = o.channel_ids.filter(id => (existingChannels.has(id) || !apply) && !removeIds.has(id));
        if (o.role_ids.length < r0 || o.channel_ids.length < c0) {
            say(`   dropped ${r0 - o.role_ids.length} stale role / ${c0 - o.channel_ids.length} removed channel id(s) from "${o.title}"`);
        }
    }

    const body = {
        prompts,
        // Gated or removed channels cannot be everyone's defaults.
        // The public community channels join the defaults: once the general chats
        // became Punchy!'s (gated), they could no longer count toward Discord's
        // minimum of default channels members can post in.
        default_channel_ids: [...new Set([...ob.default_channel_ids,
            ...PUBLIC_DEFAULTS.map(n => byName(channels, n)[0]?.id).filter(Boolean)])].filter(id => !gatedIds.has(id) && !removeIds.has(id)
            && !channels.some(c => c.id === id && removedCatNames.has(c.name))),
        enabled: ob.enabled,
        mode: ob.mode,
    };
    await d.req('PUT', `/guilds/${STAGING_GUILD}/onboarding`, body);
    say(`   "${MODS_PROMPT_TITLE}" is question 1 of ${prompts.length}; ${body.default_channel_ids.length} default channels`);

    // ── Gate every adopted channel (a live sync resets them to live's) ───────
    await refresh();
    for (const m of MODS) for (const name of m.adopt) {
        const ch = channels.find(c => c.id === made.get(name));
        await d.req('PATCH', `/channels/${ch.id}`, { permission_overwrites: gate(ch.permission_overwrites, m.key) });
    }
    say(`\n── gated ${MODS.reduce((a, m) => a + m.order.length, 0)} mod channels behind their mod's role`);
    say('   ⚠ when this ships to LIVE, give every existing member the "Punchy!" role FIRST, or they lose the Punchy! channels');

    // ── Delete what the layout removes ───────────────────────────────────────
    for (const id of removeIds) {
        const c = channels.find(x => x.id === id);
        await d.req('DELETE', `/channels/${id}`);
        say(`   removed #${c?.name}`);
    }
    await refresh();
    for (const name of REMOVED_CATEGORIES_IF_EMPTY) {
        for (const cat of byName(channels, name).filter(c => c.type === 4)) {
            const kids = channels.filter(c => c.parent_id === cat.id);
            if (kids.length) { say(`   kept [${name}] — still holds ${kids.map(k => '#' + k.name).join(', ')}`); continue; }
            await d.req('DELETE', `/channels/${cat.id}`);
            say(`   removed empty category [${name}]`);
        }
    }

    // ── Self-audit ───────────────────────────────────────────────────────────
    // Re-read what Discord actually stored and prove that no gated channel can
    // be opened by anything but its own mod's role, staff, or an admin role.
    if (apply) {
        await refresh();
        const gatedByMod = Object.fromEntries(MODS.map(m => [m.key, [m.categoryId, ...m.order.map(n => made.get(n))]]));
        const leaks = auditGates({ guildId: STAGING_GUILD, channels, roles, gatedByMod, roleIds, staffIds });
        if (leaks.length) {
            for (const l of leaks) say(`   ✗ LEAK: #${l.channel} can be opened by "${l.role}" without the "${l.mod}" role`);
            throw new Error(`${leaks.length} gate leak(s) — see above`);
        }
        const stray = channels.filter(c => REMOVED_CHANNELS.includes(c.name));
        if (stray.length) throw new Error(`removed channels still exist: ${stray.map(c => c.name).join(', ')}`);
        say(`\n── self-audit: every gated channel opens only for its own mod's role or staff ✓`);
    }

    return { roleIds, made, gatedIds };
}

/**
 * Every role that grants VIEW on a gated channel, other than that mod's own
 * access role, a staff role, or a role with Administrator (which sees all
 * anyway). Any hit is a leak: holding that role opens the channel — and makes
 * its pings reach you — without having picked the mod.
 */
function auditGates({ guildId, channels, roles, gatedByMod, roleIds, staffIds }) {
    const ADMIN = 1n << 3n;
    const byId = new Map(roles.map(r => [r.id, r]));
    const modName = Object.fromEntries(MODS.map(m => [m.key, m.name]));
    const leaks = [];
    for (const [modKey, ids] of Object.entries(gatedByMod)) {
        for (const id of ids) {
            const ch = channels.find(c => c.id === id);
            if (!ch) continue;
            const everyone = (ch.permission_overwrites || []).find(o => o.id === guildId);
            if (!everyone || !(BigInt(everyone.deny) & VIEW)) {
                leaks.push({ channel: ch.name, role: '@everyone', mod: modName[modKey] });
                continue;
            }
            for (const o of ch.permission_overwrites || []) {
                if (o.type !== 0 || o.id === guildId || o.id === roleIds[modKey] || staffIds.includes(o.id)) continue;
                const role = byId.get(o.id);
                if (role && (BigInt(role.permissions) & ADMIN)) continue;
                if (BigInt(o.allow) & VIEW) leaks.push({ channel: ch.name, role: role?.name || o.id, mod: modName[modKey] });
            }
        }
    }
    return leaks;
}

async function main() {
    const { GuardedDiscord, LIVE_GUILD } = require('./staging-sync');
    const apply = process.argv.includes('--apply');
    const d = new GuardedDiscord();
    console.log(`=== staging-mods — ${apply ? 'APPLYING' : 'DRY RUN (nothing will change)'} ===\n`);
    d.markLive((await d.get(`/guilds/${LIVE_GUILD}/channels`)).map(c => c.id));
    d.markLive((await d.get(`/guilds/${LIVE_GUILD}/roles`)).map(r => r.id));
    d.markLive((await d.get(`/guilds/${LIVE_GUILD}/emojis`)).map(e => e.id));
    await run(d, { apply });
    console.log(`\n=== ${apply ? 'done' : 'dry run complete'} — ${d.writes.length} writes${apply ? '' : ' planned'}, ${d.refused.length} refused by the guard ===`);
    if (d.refused.length) process.exitCode = 2;
}

if (require.main === module) main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
module.exports = { run, auditGates, MODS, LANGS, LAYOUT, HOME, REMOVED_CHANNELS, MODS_PROMPT_TITLE, MOD_SCOPE_TAGS };
