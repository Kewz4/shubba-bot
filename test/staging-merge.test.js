'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeOrder, mergeOnboarding } = require('../scripts/staging-sync');

// A "fresh sync" from live used to DELETE anything staging had that live did
// not, and to REPLACE staging's onboarding wholesale. That is exactly where new
// work lives: the Punchy! Moves section is staging-only until it ships. These
// pin that a sync keeps it.

// ─── mergeOrder ─────────────────────────────────────────────────────────────

test('live order wins for things live has', () => {
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'a', 'b'], () => false), ['a', 'b', 'c']);
});

test('a staging-only item stays next to the item it currently follows', () => {
    // Staging: FORUMS, MOVES, DEVELOPER. Live reorders nothing — MOVES stays after FORUMS.
    const out = mergeOrder(['GENERAL', 'FORUMS', 'DEV'], ['GENERAL', 'FORUMS', 'MOVES', 'DEV'], id => id === 'MOVES');
    assert.deepEqual(out, ['GENERAL', 'FORUMS', 'MOVES', 'DEV']);
});

test('it follows its anchor even when live moves the anchor', () => {
    const out = mergeOrder(['FORUMS', 'GENERAL', 'DEV'], ['GENERAL', 'FORUMS', 'MOVES', 'DEV'], id => id === 'MOVES');
    assert.deepEqual(out, ['FORUMS', 'MOVES', 'GENERAL', 'DEV']);
});

test('several staging-only items keep their own order', () => {
    const out = mergeOrder(['x', 'y'], ['x', 'm1', 'm2', 'y'], id => id.startsWith('m'));
    assert.deepEqual(out, ['x', 'm1', 'm2', 'y']);
});

test('a staging-only item at the very start stays at the start', () => {
    assert.deepEqual(mergeOrder(['x', 'y'], ['m', 'x', 'y'], id => id === 'm'), ['m', 'x', 'y']);
});

test('nothing is dropped and nothing is duplicated', () => {
    const live = ['a', 'b', 'c', 'd'];
    const cur = ['d', 'k1', 'a', 'k2', 'c', 'b'];
    const out = mergeOrder(live, cur, id => id.startsWith('k'));
    assert.equal(out.length, 6);
    assert.deepEqual([...out].sort(), ['a', 'b', 'c', 'd', 'k1', 'k2']);
});

// ─── mergeOnboarding ────────────────────────────────────────────────────────

const LIVE = [
    { title: 'Languages', type: 0, single_select: false, required: false, in_onboarding: true,
      options: [{ id: 'n1', title: 'English', description: '', channel_ids: ['en'], role_ids: [] }] },
    { title: 'Notifications', type: 0, single_select: false, required: false, in_onboarding: true,
      options: [
          { id: 'n2', title: 'Everything', description: '', channel_ids: ['ann'], role_ids: ['srv', 'addon'] },
          { id: 'n3', title: 'Server Updates', description: '', channel_ids: [], role_ids: ['srv'] },
      ] },
];
const STAGING = [
    { id: 'P-moves', title: 'Which Punchy! mods are you here for?', type: 0, single_select: false, required: true, in_onboarding: true,
      options: [{ id: 'O-moves', title: 'Punchy! Moves', description: 'd', channel_ids: ['moves-gen'], role_ids: ['movesRole'], emoji: { id: null, name: '🕺' } }] },
    { id: 'P-lang', title: 'Languages', type: 0, single_select: false, required: false, in_onboarding: true,
      options: [{ id: 'O-en', title: 'English', description: '', channel_ids: ['en'], role_ids: [] }] },
    { id: 'P-notify', title: 'Notifications', type: 0, single_select: false, required: false, in_onboarding: true,
      options: [
          { id: 'O-every', title: 'Everything', description: '', channel_ids: ['ann', 'moves-ann'], role_ids: ['srv', 'addon', 'movesPing', 'movesRole'] },
          { id: 'O-srv', title: 'Server Updates', description: '', channel_ids: [], role_ids: ['srv'] },
          { id: 'O-mupd', title: 'Punchy! Moves Updates', description: '', channel_ids: ['moves-ann'], role_ids: ['movesPing', 'movesRole'] },
      ] },
];
const keptRole = id => ['movesRole', 'movesPing'].includes(id);
const keptChan = id => ['moves-gen', 'moves-ann'].includes(id);

test('the staging-only Moves question survives, and stays first', () => {
    const out = mergeOnboarding(LIVE, STAGING, keptRole, keptChan);
    assert.equal(out[0].title, 'Which Punchy! mods are you here for?');
    assert.equal(out[0].id, 'P-moves');
    assert.deepEqual(out[0].options[0].role_ids, ['movesRole']);
    assert.equal(out[0].options[0].emoji_name, '🕺', 'the GET emoji object must be reshaped for PUT');
});

test('a staging-only option inside a shared prompt survives', () => {
    const notify = mergeOnboarding(LIVE, STAGING, keptRole, keptChan).find(p => p.title === 'Notifications');
    assert.ok(notify.options.find(o => o.title === 'Punchy! Moves Updates'), 'Moves Updates was dropped');
});

test('"Everything" keeps its staging-only Moves grants alongside live\'s', () => {
    const every = mergeOnboarding(LIVE, STAGING, keptRole, keptChan)
        .find(p => p.title === 'Notifications').options.find(o => o.title === 'Everything');
    assert.deepEqual([...every.role_ids].sort(), ['addon', 'movesPing', 'movesRole', 'srv']);
    assert.deepEqual([...every.channel_ids].sort(), ['ann', 'moves-ann']);
});

test('live stays authoritative for what it has — a grant live removed is removed', () => {
    // Live drops "addon" from Everything; staging still lists it. "addon" is NOT
    // staging-only, so it must not be resurrected.
    const live = structuredClone(LIVE);
    live[1].options[0].role_ids = ['srv'];
    const every = mergeOnboarding(live, STAGING, keptRole, keptChan)
        .find(p => p.title === 'Notifications').options.find(o => o.title === 'Everything');
    assert.ok(!every.role_ids.includes('addon'), 'a role live removed came back from staging');
    assert.ok(every.role_ids.includes('movesRole'));
});

test('ids are reused by title, so they stay stable across syncs', () => {
    const out = mergeOnboarding(LIVE, STAGING, keptRole, keptChan);
    const lang = out.find(p => p.title === 'Languages');
    assert.equal(lang.id, 'P-lang');
    assert.equal(lang.options[0].id, 'O-en');
});

test('a prompt new in live is appended', () => {
    const live = [...LIVE, { title: 'Brand new', type: 0, single_select: true, required: false, in_onboarding: true,
        options: [{ id: 'n9', title: 'x', description: '', channel_ids: ['en'], role_ids: [] }] }];
    const out = mergeOnboarding(live, STAGING, keptRole, keptChan);
    assert.equal(out[out.length - 1].title, 'Brand new');
});

test('with nothing kept (--prune), staging-only grants are dropped from shared options', () => {
    const every = mergeOnboarding(LIVE, STAGING, () => false, () => false)
        .find(p => p.title === 'Notifications').options.find(o => o.title === 'Everything');
    assert.deepEqual([...every.role_ids].sort(), ['addon', 'srv']);
});

test('an empty staging onboarding just yields live', () => {
    const out = mergeOnboarding(LIVE, [], keptRole, keptChan);
    assert.deepEqual(out.map(p => p.title), ['Languages', 'Notifications']);
});
