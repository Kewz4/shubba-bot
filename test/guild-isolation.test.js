'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Shubba was invited to a staging server, and no event handler checked which
// guild an event came from. The live process would have posted live welcome
// messages for people joining staging, fed staging chat into live's soft-ban
// logic, and let a dev command typed in staging write to the knowledge every
// live answer is built from. These tests pin the isolation.

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const LIVE = '1433991244966658072';
const STAGING = '1523847700037107742';

function lift(name) {
    const start = SRC.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `index.js no longer defines ${name}`);
    return SRC.slice(start, SRC.indexOf('\n}', start) + 2);
}

function load(env = {}) {
    const sandbox = { DEV_GUILD_ID: LIVE, process: { env } };
    vm.createContext(sandbox);
    vm.runInContext(lift('allowedGuildIds') + '\n' + lift('isForeignGuild'), sandbox);
    return sandbox.isForeignGuild;
}

test('the live guild is ours', () => {
    assert.equal(load()(LIVE), false);
});

test('staging is foreign to the live deployment', () => {
    assert.equal(load()(STAGING), true);
});

test('any unknown guild is foreign', () => {
    assert.equal(load()('999999999999999999'), true);
});

test('DMs are not foreign — they carry no guild and keep their handling', () => {
    const f = load();
    assert.equal(f(null), false);
    assert.equal(f(undefined), false);
    assert.equal(f(''), false);
});

test('a staging instance can opt in explicitly', () => {
    const f = load({ SHUBBA_GUILD_IDS: STAGING });
    assert.equal(f(STAGING), false);
    assert.equal(f(LIVE), true, 'a staging instance must not act on live either');
});

test('the opt-in list tolerates spaces and several ids', () => {
    const f = load({ SHUBBA_GUILD_IDS: ` ${LIVE} , ${STAGING} ` });
    assert.equal(f(LIVE), false);
    assert.equal(f(STAGING), false);
});

test('numeric ids compare the same as strings', () => {
    assert.equal(load()(BigInt(STAGING)), true);
});

// ─── Every guild-scoped handler checks, first thing ─────────────────────────

const HANDLERS = [
    "client.on('raw'",
    'client.on(Events.ThreadCreate',
    'client.on(Events.MessageCreate',
    'client.on(Events.InteractionCreate',
    "client.on('messageReactionAdd'",
    "client.on('messageReactionRemove'",
    "client.on('guildMemberAdd'",
    "client.on('guildMemberRemove'",
];

for (const h of HANDLERS) {
    test(`${h} rejects foreign guilds before doing anything`, () => {
        const at = SRC.indexOf(h);
        assert.ok(at !== -1, `${h} is gone — update this list`);
        // The guard must be among the first few lines, ahead of any side effect.
        const head = SRC.slice(at, at + 260);
        assert.match(head, /isForeignGuild\(/, `${h} has no guild check at its top`);
    });
}

test('no new guild-scoped handler has slipped in unguarded', () => {
    // Anything registered with client.on that is not in the list above, the
    // error handler, or ClientReady is a new handler nobody has checked.
    const all = [...SRC.matchAll(/client\.(?:on|once)\((Events\.\w+|'[\w]+')/g)].map(m => m[1]);
    const known = new Set([
        "'raw'", 'Events.ThreadCreate', 'Events.MessageCreate', 'Events.InteractionCreate',
        "'messageReactionAdd'", "'messageReactionRemove'", "'guildMemberAdd'", "'guildMemberRemove'",
        "'error'", 'Events.ClientReady',
    ]);
    const unknown = all.filter(e => !known.has(e));
    assert.deepEqual(unknown, [], `unreviewed handler(s): ${unknown.join(', ')} — add a guild check and list them here`);
});

test('getHomeGuild no longer falls back to whichever guild is cached first', () => {
    const fn = lift('getHomeGuild');
    assert.doesNotMatch(fn, /cache\.first\(\)/,
        'with two guilds, .first() is chance — role audits and dashboard bans could bind to staging');
});

// ─── Channel lookup by NAME must stay inside the live guild ─────────────────
// Found by an independent isolation audit: the auto-message features resolved
// their target with a global fetch plus a global name match. Staging mirrors
// live's channel names exactly, so a live welcome could land in staging.

test('no code path matches a channel by name across every guild', () => {
    const code = SRC.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    assert.doesNotMatch(code, /client\.channels\.cache\.find\(\s*c\s*=>\s*c\.name/,
        'a global name lookup is back — scope it to getHomeGuild() or use resolveHomeChannel()');
});

test('resolveHomeChannel only ever returns a channel from the live guild', async () => {
    const fn = SRC.slice(SRC.indexOf('async function resolveHomeChannel('), SRC.indexOf('\n}', SRC.indexOf('async function resolveHomeChannel(')) + 2);
    const liveGuild = {
        id: LIVE,
        channels: {
            cache: new Map([['1600000000000000001', { id: '1600000000000000001', guildId: LIVE, name: '👋│welcome' }]]),
            fetch: async (id) => (id === '1700000000000000009' ? { id, guildId: STAGING, name: '👋│welcome' } : null),
        },
    };
    liveGuild.channels.cache.find = (pred) => [...liveGuild.channels.cache.values()].find(pred);
    const sandbox = { getHomeGuild: () => liveGuild };
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    const r = sandbox.resolveHomeChannel;
    assert.equal((await r('1600000000000000001'))?.guildId, LIVE, 'a live id resolves');
    assert.equal((await r('👋│welcome'))?.guildId, LIVE, 'a name resolves within live');
    const stray = await r('1700000000000000009');
    assert.ok(!stray || stray.guildId === LIVE, 'a channel reporting another guild must never be returned');
    assert.equal(await r(null), null);
});

test('every auto-message sender goes through resolveHomeChannel', () => {
    assert.ok((SRC.match(/await resolveHomeChannel\(/g) || []).length >= 6);
});
