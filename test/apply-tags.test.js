'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ─── Loading the real code under test ────────────────────────────────────────
// Same approach as interaction-ack.test.js: index.js can't be require()'d (it
// logs into Discord on import), so we lift applyTagsFromText straight out of
// the source and run it in a sandbox with stubbed dependencies. That keeps
// these assertions pointed at the code that actually ships.

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const { MAX_FORUM_TAGS, resolveTagIds, capTagIds, sortVersionsBySpecificity } =
    require('../lib/forum-tags');

function extractApplyTagsFromText() {
    const start = INDEX_SRC.indexOf('async function applyTagsFromText(');
    assert.ok(start !== -1, 'index.js no longer defines applyTagsFromText');
    // The function is top-level, so its body ends at the first closing brace
    // sitting in column 0.
    const end = INDEX_SRC.indexOf('\n}', start);
    assert.ok(end > start, 'could not find the end of applyTagsFromText');
    return INDEX_SRC.slice(start, end + 2);
}

/**
 * Build a sandbox holding the real applyTagsFromText plus the minimum stubs it
 * needs. `versions` becomes the live TAG_CATEGORIES.VERSIONS view.
 */
function loadFn({ versions = ['All', '1.20.1', '1.21.1', '26.1', '26.1.2', '26.2'] } = {}) {
    const logs = [];
    const sandbox = {
        console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
        TAG_CATEGORIES: { VERSIONS: versions },
        sortVersionsBySpecificity,
        // Mirrors the real buildAppliedTagIds in index.js.
        buildAppliedTagIds(forumChannel, desiredNames, existingIds = []) {
            const availableTags = (forumChannel && Array.isArray(forumChannel.availableTags))
                ? forumChannel.availableTags : [];
            return capTagIds({
                existingIds,
                desiredIds: resolveTagIds(availableTags, desiredNames),
                availableTags,
                max: MAX_FORUM_TAGS
            });
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractApplyTagsFromText(), sandbox);
    return { fn: sandbox.applyTagsFromText, logs };
}

// A forum offering every tag applyTagsFromText might ask for.
const AVAILABLE_TAGS = [
    'Fabric', 'Forge', 'NeoForge',
    '1.20.1', '1.21.1', '26.1', '26.1.2', '26.2',
    'Crash / Fatal Error', 'Visual Bug', 'Animation Bug',
    'Modpack Issue', 'Compatibility Issue',
].map((name, i) => ({ id: `tag${i}`, name }));

function makeThread(appliedTags = []) {
    const calls = [];
    return {
        calls,
        name: 'test thread',
        appliedTags,
        parent: { availableTags: AVAILABLE_TAGS },
        async setAppliedTags(ids) { calls.push(ids); },
    };
}

const idOf = (name) => AVAILABLE_TAGS.find(t => t.name === name).id;

test('caps at Discord\'s 5-tag limit instead of sending 8 and applying none', async () => {
    const { fn } = loadFn();
    const thread = makeThread();
    // Matches: Fabric + 26.2 + Crash + Visual + Animation + Modpack + Compat = 7
    await fn({ content: 'fabric 26.2 crash with a visual glitch and animation bug in my modpack, compat conflict' }, thread);

    assert.equal(thread.calls.length, 1, 'setAppliedTags should be called once');
    const sent = thread.calls[0];
    assert.ok(sent.length <= MAX_FORUM_TAGS,
        `sent ${sent.length} tags, exceeding Discord's cap of ${MAX_FORUM_TAGS}`);
    // Loader and version are the triage-critical ones and must survive the cap.
    assert.ok(sent.includes(idOf('Fabric')), 'loader tag should survive the cap');
    assert.ok(sent.includes(idOf('26.2')), 'version tag should survive the cap');
});

test('picks the most specific version, not a prefix match', async () => {
    const { fn } = loadFn();
    const thread = makeThread();
    await fn({ content: 'broken on 26.1.2 with fabric' }, thread);

    const sent = thread.calls[0];
    assert.ok(sent.includes(idOf('26.1.2')), 'should tag 26.1.2');
    assert.ok(!sent.includes(idOf('26.1')), 'should not also tag the less specific 26.1');
});

test('newer versions are taggable (the old hardcoded list stopped at 26.1)', async () => {
    const { fn } = loadFn();
    for (const v of ['26.1.2', '26.2']) {
        const thread = makeThread();
        await fn({ content: `crash on ${v}` }, thread);
        assert.ok(thread.calls[0].includes(idOf(v)), `${v} should be taggable`);
    }
});

test('does not call the API when nothing matches', async () => {
    const { fn } = loadFn();
    const thread = makeThread();
    await fn({ content: 'hello, does anyone know what this mod is about?' }, thread);
    assert.equal(thread.calls.length, 0, 'no matches should mean no API call');
});

test('does not call the API when the tags are already applied', async () => {
    const { fn } = loadFn();
    const thread = makeThread([idOf('Fabric')]);
    await fn({ content: 'fabric' }, thread);
    assert.equal(thread.calls.length, 0, 'unchanged tag set should skip the call');
});

test('preserves tags the thread already had', async () => {
    const { fn } = loadFn();
    const existing = idOf('Modpack Issue');
    const thread = makeThread([existing]);
    await fn({ content: 'crash on fabric' }, thread);

    assert.ok(thread.calls[0].includes(existing), 'existing tag must not be dropped');
});

test('reports failure honestly instead of logging success', async () => {
    const { fn, logs } = loadFn();
    const thread = makeThread();
    thread.setAppliedTags = async () => { throw new Error('Missing Permissions'); };

    // Must not reject — a tagging failure should never break thread handling.
    await fn({ content: 'crash on fabric 26.2' }, thread);

    const joined = logs.join('\n');
    assert.match(joined, /Could not set tags/, 'should log the real failure');
    assert.doesNotMatch(joined, /Auto-applied/,
        'must not claim success after the API rejected — this was the original bug');
});
