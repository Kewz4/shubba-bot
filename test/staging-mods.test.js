'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MODS, LANGS, MOD_SCOPE_TAGS } = require('../scripts/staging-mods');

// The staging server is organised around four mods. Pings reach only the mods
// a member picked because each mod has its OWN announcements/teasers channels,
// gated by its access role, while the ping roles stay generic. These tests pin
// the parts of that design that would silently break it.

const byKey = Object.fromEntries(MODS.map(m => [m.key, m]));
const names = (m) => (m.channels || []).map(c => c.name);
const all = (m) => m.order;   // adopted + built, in category order

test('exactly the four mods', () => {
    assert.deepEqual(MODS.map(m => m.name), ['Punchy!', 'Punchy! Moves', 'Enchanted Fishing Line', 'Better Fishing']);
});

test('every mod can be pinged for announcements AND teasers in a channel of its own', () => {
    // Without a per-mod channel, a generic @Teaser ping cannot be scoped to that mod.
    for (const m of MODS) {
        assert.ok(all(m).some(n => /announcements$/.test(n)), `${m.name} has no announcements channel`);
        assert.ok(all(m).some(n => /teasers$/.test(n)), `${m.name} has no teasers channel`);
    }
});

test('Punchy! gates its own announcements and teasers — or picking only EFL still pings for Punchy!', () => {
    assert.ok(byKey.punchy.adopt.includes('📢│announcements'));
    assert.ok(byKey.punchy.adopt.includes('🎬│teasers'));
});

test('Moves, EFL and Better Fishing each have a chat in all four languages', () => {
    for (const k of ['moves', 'efl', 'bf']) {
        const langs = byKey[k].channels.filter(c => c.lang).map(c => c.lang).sort();
        assert.deepEqual(langs, LANGS.map(l => l.code).sort(), `${byKey[k].name} is missing a language chat`);
    }
});

test('every mod has a bug-report and a suggestions forum', () => {
    for (const k of ['moves', 'efl', 'bf']) {
        assert.ok(names(byKey[k]).some(n => n.endsWith('bug-report')), `${byKey[k].name}: no bug-report`);
        assert.ok(names(byKey[k]).some(n => n.endsWith('suggestions')), `${byKey[k].name}: no suggestions`);
    }
});

test('the fishing mods have no wiki, as asked; Moves does', () => {
    assert.ok(!names(byKey.efl).some(n => n.includes('wiki')));
    assert.ok(!names(byKey.bf).some(n => n.includes('wiki')));
    assert.ok(names(byKey.moves).some(n => n.includes('wiki')));
});

test('no mod-channel name collides with anything live has — or the sync would claim it as a live twin', () => {
    const live = new Set([
        '📢│announcements', '🎬│teasers', '💬│general-en', '💬│general-br', '💬│general-es', '💬│general-ru',
        '🪲│bug-report', '⁉️│wiki-questions', '💡│suggestions', '📦│addons',
    ]);
    for (const m of MODS.filter(x => x.channels)) for (const n of names(m)) {
        assert.ok(!live.has(n), `${n} shares a name with a live channel`);
    }
});

test('channel names are unique across the whole layer', () => {
    const all = MODS.flatMap(names);
    assert.equal(new Set(all).size, all.length, 'two mod channels share a name');
});

test('a mod-scope tag is never copied into a single-mod forum', () => {
    assert.ok(MOD_SCOPE_TAGS.has('EFL') && MOD_SCOPE_TAGS.has('Better Fishing') && MOD_SCOPE_TAGS.has('Punchy'));
});

test('every templated link points at a channel that exists', () => {
    const known = new Set([
        ...MODS.flatMap(names),
        '🪲│bug-report', '⁉️│wiki-questions', '💬│general-en', '❓│faq',
    ]);
    for (const m of MODS.filter(x => x.channels)) for (const c of m.channels) {
        for (const [, ref] of (c.topic || '').matchAll(/\{\{([^}]+)\}\}/g)) {
            assert.ok(known.has(ref), `#${c.name} links to {{${ref}}}, which is not a channel`);
        }
    }
});

test('the fishing mods point questions at their chat, since they have no wiki', () => {
    for (const k of ['efl', 'bf']) {
        const bug = byKey[k].channels.find(c => c.name.endsWith('bug-report'));
        assert.match(bug.topic, new RegExp(`\\{\\{💬│${byKey[k].prefix}-general-en\\}\\}`));
        assert.doesNotMatch(bug.topic, /wiki/i);
    }
});

test('no per-mod PING role exists — it would reach people outside that mod', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'staging-mods.js'), 'utf8');
    assert.match(src, /OBSOLETE_ROLES = \['Moves Updates'\]/, 'the per-mod ping role must be cleaned up, not recreated');
    for (const m of MODS) assert.doesNotMatch(m.role.name, /update|ping|teaser|announce/i, `${m.role.name} looks like a ping role`);
});

test('staging-sync re-applies this layer, so a live sync never leaves Punchy! ungated', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'staging-sync.js'), 'utf8');
    assert.match(src, /require\('\.\/staging-mods'\)\.run\(d/);
});

// ─── auditGates: the leak that got past the first build ─────────────────────
// Live's "Punchers!" — also the announcements PING role, so nearly everyone
// holds it — explicitly allows VIEW on #teasers. Cloned into a gated channel,
// that allow beat the @everyone deny, and every mod's teasers channel became
// visible (and ping-able) to members of every other mod.

const { auditGates } = require('../scripts/staging-mods');
const G = 'G', VIEW = String(1n << 10n);
const roles = [
    { id: 'G', name: '@everyone', permissions: '0' },
    { id: 'bf', name: 'Better Fishing', permissions: '0' },
    { id: 'punchers', name: 'Punchers!', permissions: '0' },
    { id: 'mod', name: 'Moderator', permissions: '0' },
    { id: 'founder', name: 'Founder | Dev', permissions: String(1n << 3n) },   // Administrator
];
const gated = (overwrites) => ({
    guildId: G, roles, staffIds: ['mod'], roleIds: { bf: 'bf' },
    gatedByMod: { bf: ['c1'] },
    channels: [{ id: 'c1', name: '🎬│bf-teasers', permission_overwrites: overwrites }],
});
const everyoneDeny = { id: G, type: 0, allow: '0', deny: VIEW };

test('a non-mod role that grants VIEW on a gated channel is reported', () => {
    const leaks = auditGates(gated([everyoneDeny, { id: 'bf', type: 0, allow: VIEW, deny: '0' }, { id: 'punchers', type: 0, allow: VIEW, deny: '0' }]));
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].role, 'Punchers!');
});

test('a gated channel is clean when only the mod role and staff grant VIEW', () => {
    const leaks = auditGates(gated([everyoneDeny, { id: 'bf', type: 0, allow: VIEW, deny: '0' }, { id: 'mod', type: 0, allow: VIEW, deny: '0' },
        { id: 'punchers', type: 0, allow: String(1n << 6n), deny: '0' }]));   // reactions only — fine
    assert.deepEqual(leaks, []);
});

test('a gated channel that forgot to deny @everyone is reported', () => {
    const leaks = auditGates(gated([{ id: 'bf', type: 0, allow: VIEW, deny: '0' }]));
    assert.equal(leaks[0]?.role, '@everyone');
});

test('an Administrator role granting VIEW is not a leak — it sees everything anyway', () => {
    assert.deepEqual(auditGates(gated([everyoneDeny, { id: 'founder', type: 0, allow: VIEW, deny: '0' }])), []);
});

// ─── The Punchy!-as-a-category layout ───────────────────────────────────────
const { LAYOUT, HOME, REMOVED_CHANNELS } = require('../scripts/staging-mods');

test('every mod has its own FAQ and known-issues', () => {
    for (const m of MODS) {
        assert.ok(all(m).some(n => /faq$/.test(n)), `${m.name} has no FAQ`);
        assert.ok(all(m).some(n => /known-issues$/.test(n)), `${m.name} has no known-issues`);
    }
});

test('the general FAQ stays in HOME — no mod adopts it', () => {
    for (const m of MODS) assert.ok(!m.adopt.includes('❓│faq'), `${m.name} took the HOME FAQ`);
    assert.equal(HOME.name, '🏠 HOME');
});

test('known-issues moves out of HOME into Punchy!', () => {
    assert.ok(byKey.punchy.adopt.includes('🛠️│known-issues'));
    assert.equal(LAYOUT.relocate['🛠️│known-issues'], '👊 PUNCHY!');
});

test('killed-bug and roadmap are removed, and a sync will not recreate them', () => {
    assert.deepEqual([...REMOVED_CHANNELS].sort(), ['🐛│killed-bug', '📋│roadmap-board'].sort());
    for (const n of REMOVED_CHANNELS) assert.ok(LAYOUT.omit.includes(n));
});

test('no channel is both removed and adopted', () => {
    for (const m of MODS) for (const n of m.adopt) assert.ok(!REMOVED_CHANNELS.includes(n), `${n} is adopted AND removed`);
});

test('every adopted channel tells the sync where it now lives', () => {
    for (const m of MODS) for (const n of m.adopt) assert.equal(LAYOUT.relocate[n], m.category);
});

test('Punchy! has its own four language chats, like every other mod', () => {
    const langs = byKey.punchy.channels.filter(c => c.lang).map(c => c.lang).sort();
    assert.deepEqual(langs, LANGS.map(l => l.code).sort());
});

test('each category lists every one of its channels exactly once', () => {
    for (const m of MODS) {
        const expected = [...m.adopt, ...names(m)].sort();
        assert.deepEqual([...m.order].sort(), expected, `${m.name}: order and channels disagree`);
    }
});
