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
