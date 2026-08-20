'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    isStarterMessage, emojiMatches, canGrantRole, findReactionRole, DANGEROUS_PERMISSIONS,
} = require('../lib/reaction-roles');

// ── The leak: 🔥 on any message in an addon thread granted the role ─────────

test('only the thread starter post counts', () => {
    // In a forum, the starter message id equals the thread id.
    assert.equal(isStarterMessage('123', '123'), true);
    assert.equal(isStarterMessage('456', '123'), false, 'a reply must not grant the role');
    assert.equal(isStarterMessage(undefined, '123'), false);
});

test('the handler actually enforces starter-only scoping', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const calls = (src.match(/isStarterMessage\(/g) || []).length;
    assert.ok(calls >= 2, `add and remove handlers must both scope; found ${calls}`);
});

// ── Emoji identity ──────────────────────────────────────────────────────────

test('unicode emoji match by character', () => {
    assert.equal(emojiMatches('🔥', { name: '🔥', id: null }), true);
    assert.equal(emojiMatches('🔥', { name: '💧', id: null }), false);
});

test('custom emoji match by ID, never by name', () => {
    // Two different emoji sharing a name must not collide.
    const configured = '<:punchy:111>';
    assert.equal(emojiMatches(configured, { name: 'punchy', id: '111' }), true);
    assert.equal(emojiMatches(configured, { name: 'punchy', id: '999' }), false,
        'a different emoji with the same name must NOT match');
});

test('animated custom emoji still match', () => {
    assert.equal(emojiMatches('<a:wave:222>', { name: 'wave', id: '222' }), true);
});

test('a bare emoji id is accepted', () => {
    assert.equal(emojiMatches('333', { name: 'thing', id: '333' }), true);
});

test('a unicode config never matches a custom emoji', () => {
    assert.equal(emojiMatches('🔥', { name: '🔥', id: '444' }), false);
});

// ── Privilege guard ─────────────────────────────────────────────────────────

const role = (bits, extra = {}) => ({ id: 'r1', permissions: { bitfield: bits }, ...extra });

test('an ordinary role can be granted', () => {
    assert.equal(canGrantRole(role(0n)).allowed, true);
});

test('privileged roles are refused', () => {
    for (const [name, flag] of Object.entries(DANGEROUS_PERMISSIONS)) {
        const v = canGrantRole(role(flag));
        assert.equal(v.allowed, false, `${name} must not be grantable by reaction`);
        assert.match(v.reason, new RegExp(name));
    }
});

test('managed (integration/booster) roles are refused', () => {
    assert.equal(canGrantRole(role(0n, { managed: true })).allowed, false);
});

test('a missing role is refused rather than throwing', () => {
    assert.equal(canGrantRole(null).allowed, false);
});

test('a role at or above the bot is refused early', () => {
    const bot = { id: 'bot' };
    const above = role(0n, { comparePositionTo: () => 1 });
    const below = role(0n, { comparePositionTo: () => -1 });
    assert.equal(canGrantRole(above, { botHighestRole: bot }).allowed, false);
    assert.equal(canGrantRole(below, { botHighestRole: bot }).allowed, true);
});

// ── Lookup ──────────────────────────────────────────────────────────────────

test('lookup requires both the right message and the right emoji', () => {
    const store = [{ messageId: 'm1', emoji: '🔥', roleId: 'role-a' }];
    assert.equal(findReactionRole(store, 'm1', { name: '🔥', id: null }).roleId, 'role-a');
    assert.equal(findReactionRole(store, 'm2', { name: '🔥', id: null }), null, 'wrong message');
    assert.equal(findReactionRole(store, 'm1', { name: '💧', id: null }), null, 'wrong emoji');
});

test('lookup tolerates a missing or malformed store', () => {
    assert.equal(findReactionRole(null, 'm1', { name: '🔥' }), null);
    assert.equal(findReactionRole([], 'm1', { name: '🔥' }), null);
});

// ── Auto-linking: the "Helper role" leak ────────────────────────────────────
const { canAutoLinkRole, nameSimilarity } = require('../lib/reaction-roles');

const addon = { threadId: '1534498321195077662', threadName: 'GLORPY - Powered by Punchy!' };
const strong = { overlap: 5, ratio: 1.0 };
// A role plausibly created for that addon (newer than the thread).
const glorpyRole = { id: '1534499000000000000', name: 'GLORPY', permissions: { bitfield: 0n } };

test('a genuine addon role links', () => {
    assert.equal(canAutoLinkRole(glorpyRole, addon, strong).allowed, true);
});

test('Helper is never auto-linked, even at 100% overlap', () => {
    // The actual bug: Helper has no permissions, so a permission-only guard
    // missed it, and two holders reacting scored a perfect match.
    const helper = { id: '1512896900465164328', name: 'Helper', permissions: { bitfield: 0n } };
    const v = canAutoLinkRole(helper, addon, { overlap: 2, ratio: 1.0 });
    assert.equal(v.allowed, false);
});

test('staff role names are refused outright', () => {
    for (const name of ['Helper', 'Moderator', 'Punchers', 'Addon Creator', 'Bug Hunter', 'Staff']) {
        const r = { id: '1534499000000000000', name, permissions: { bitfield: 0n } };
        assert.equal(canAutoLinkRole(r, addon, strong).allowed, false, `${name} must not auto-link`);
    }
});

test('two overlapping reactors is a coincidence, not a match', () => {
    assert.equal(canAutoLinkRole(glorpyRole, addon, { overlap: 2, ratio: 1.0 }).allowed, false);
    assert.equal(canAutoLinkRole(glorpyRole, addon, { overlap: 3, ratio: 1.0 }).allowed, true);
});

test('a weak member-ratio is refused', () => {
    assert.equal(canAutoLinkRole(glorpyRole, addon, { overlap: 5, ratio: 0.5 }).allowed, false);
});

test('a role older than the addon thread cannot belong to it', () => {
    const old = { id: '1490000000000000000', name: 'GLORPY', permissions: { bitfield: 0n } };
    const v = canAutoLinkRole(old, addon, strong);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /older than/i);
});

test('a role carrying any permission is refused', () => {
    const r = { id: '1534499000000000000', name: 'GLORPY', permissions: { bitfield: 1n << 13n } };
    assert.equal(canAutoLinkRole(r, addon, strong).allowed, false);
});

test('the name must actually resemble the addon', () => {
    const unrelated = { id: '1534499000000000000', name: 'whimsical individual', permissions: { bitfield: 0n } };
    assert.equal(canAutoLinkRole(unrelated, addon, strong).allowed, false);
});

test('nameSimilarity behaves sensibly', () => {
    assert.ok(nameSimilarity('GLORPY', 'GLORPY - Powered by Punchy!') >= 0.34);
    assert.ok(nameSimilarity('Helper', 'GLORPY - Powered by Punchy!') < 0.34);
    assert.equal(nameSimilarity('', 'anything'), 0);
});
