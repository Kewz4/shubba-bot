'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_FORUM_TAGS,
    FALLBACK_TAG_CATEGORIES,
    isVersionName,
    isLoaderName,
    categorizeTags,
    sortVersionsBySpecificity,
    resolveTagIds,
    capTagIds,
} = require('../lib/forum-tags');

// A realistic #bug-report forum, shaped like discord.js v14's
// ForumChannel#availableTags ({ id, name, emoji, moderated }).
// Includes the versions the old hardcoded list could not tag.
const FORUM_TAGS = [
    { id: 't-all', name: 'All', emoji: null, moderated: false },
    { id: 't-1201', name: '1.20.1', emoji: null, moderated: false },
    { id: 't-1211', name: '1.21.1', emoji: null, moderated: false },
    { id: 't-1215', name: '1.21.5', emoji: null, moderated: false },
    { id: 't-12111', name: '1.21.11', emoji: null, moderated: false },
    { id: 't-261', name: '26.1', emoji: null, moderated: false },
    { id: 't-2611', name: '26.1.1', emoji: null, moderated: false },
    { id: 't-2612', name: '26.1.2', emoji: null, moderated: false },
    { id: 't-262', name: '26.2', emoji: null, moderated: false },
    { id: 't-263s', name: '26.3-snapshot-8', emoji: null, moderated: false },
    { id: 't-fabric', name: 'Fabric', emoji: null, moderated: false },
    { id: 't-forge', name: 'Forge', emoji: null, moderated: false },
    { id: 't-neo', name: 'NeoForge', emoji: null, moderated: false },
    { id: 't-visual', name: 'Visual Bug', emoji: null, moderated: false },
    { id: 't-anim', name: 'Animation Bug', emoji: null, moderated: false },
    { id: 't-crash', name: 'Crash / Fatal Error', emoji: null, moderated: true },
    { id: 't-compat', name: 'Compatibility Issue', emoji: null, moderated: false },
];

// ── name classification ─────────────────────────────────────────────────────
test('isVersionName: accepts every version Modrinth reports for punchy-fpa', () => {
    for (const v of ['1.20.1', '1.21.1', '1.21.5', '1.21.11', '26.1', '26.1.1', '26.1.2', '26.2', '26.3-snapshot-8']) {
        assert.equal(isVersionName(v), true, `${v} should classify as a version`);
    }
    assert.equal(isVersionName('All'), true, '"All" is the catch-all version tag');
    assert.equal(isVersionName('25w14a'), true, 'weekly snapshots are versions');
});
test('isVersionName: rejects issue/loader names', () => {
    for (const n of ['Visual Bug', 'Crash / Fatal Error', 'Fabric', '', null, undefined]) {
        assert.equal(isVersionName(n), false, `${JSON.stringify(n)} is not a version`);
    }
});
test('isLoaderName: case-insensitive', () => {
    assert.equal(isLoaderName('NeoForge'), true);
    assert.equal(isLoaderName('neoforge'), true);
    assert.equal(isLoaderName('FABRIC'), true);
    assert.equal(isLoaderName('Visual Bug'), false);
});

// ── categorizeTags: resolution against a mocked availableTags list ──────────
test('categorizeTags: buckets a real forum tag list correctly', () => {
    const c = categorizeTags(FORUM_TAGS);
    assert.deepEqual(c.LOADERS, ['Fabric', 'Forge', 'NeoForge']);
    assert.deepEqual(c.VERSIONS, [
        'All', '1.20.1', '1.21.1', '1.21.5', '1.21.11',
        '26.1', '26.1.1', '26.1.2', '26.2', '26.3-snapshot-8',
    ]);
    assert.deepEqual(c.ISSUES, ['Visual Bug', 'Animation Bug', 'Crash / Fatal Error', 'Compatibility Issue']);
});

test('categorizeTags: picks up versions the old hardcoded list was missing', () => {
    const { VERSIONS } = categorizeTags(FORUM_TAGS);
    // These four are exactly what the stale hardcoded array could not tag.
    for (const v of ['26.1.1', '26.1.2', '26.2', '26.3-snapshot-8']) {
        assert.ok(VERSIONS.includes(v), `${v} must be taggable from live forum tags`);
    }
});

test('categorizeTags: a brand-new moderator tag needs no code change', () => {
    const withNew = [...FORUM_TAGS, { id: 't-27', name: '27.0' }, { id: 't-perf', name: 'Performance' }];
    const c = categorizeTags(withNew);
    assert.ok(c.VERSIONS.includes('27.0'), 'unknown numeric tag → VERSIONS');
    assert.ok(c.ISSUES.includes('Performance'), 'unknown non-numeric tag → ISSUES');
});

test('categorizeTags: de-duplicates tags shared by both forums', () => {
    // #bug-report and #wiki-questions both define "Fabric" with different ids.
    const merged = [...FORUM_TAGS, { id: 'wiki-fabric', name: 'fabric' }];
    const c = categorizeTags(merged);
    assert.deepEqual(c.LOADERS, ['Fabric', 'Forge', 'NeoForge'], 'no duplicate loader entries');
});

test('categorizeTags: ignores malformed entries', () => {
    const c = categorizeTags([{ id: 'x' }, { name: '   ' }, null, { id: 'y', name: '26.2' }]);
    assert.deepEqual(c.VERSIONS, ['26.2']);
});

// ── the fallback path ───────────────────────────────────────────────────────
test('categorizeTags: falls back when the forum tags cannot be read', () => {
    // Every way an availableTags read can fail must yield the verified fallback.
    for (const bad of [null, undefined, [], 'nope', {}, [null, { id: 'a' }]]) {
        const c = categorizeTags(bad);
        assert.deepEqual(c.VERSIONS, [...FALLBACK_TAG_CATEGORIES.VERSIONS], `fallback VERSIONS for ${JSON.stringify(bad)}`);
        assert.deepEqual(c.LOADERS, [...FALLBACK_TAG_CATEGORIES.LOADERS]);
        assert.deepEqual(c.ISSUES, [...FALLBACK_TAG_CATEGORIES.ISSUES]);
    }
});

test('fallback list is CURRENT — it must match what Modrinth reports', () => {
    // Verified against api.modrinth.com/v2/project/punchy-fpa on 2026-08-14.
    for (const v of ['1.20.1', '1.21.1', '1.21.5', '1.21.11', '26.1', '26.1.1', '26.1.2', '26.2', '26.3-snapshot-8']) {
        assert.ok(FALLBACK_TAG_CATEGORIES.VERSIONS.includes(v), `fallback is missing ${v}`);
    }
    assert.deepEqual([...FALLBACK_TAG_CATEGORIES.LOADERS], ['Fabric', 'Forge', 'NeoForge']);
});

test('fallback is immutable — a caller cannot corrupt it', () => {
    assert.throws(() => { FALLBACK_TAG_CATEGORIES.VERSIONS.push('9.9'); }, TypeError);
    const c = categorizeTags(null);
    c.VERSIONS.push('mutated');   // returned copy is safe to mutate
    assert.ok(!FALLBACK_TAG_CATEGORIES.VERSIONS.includes('mutated'));
});

// ── version specificity ─────────────────────────────────────────────────────
test('sortVersionsBySpecificity: longest first, so 1.21.1 cannot shadow 1.21.11', () => {
    const sorted = sortVersionsBySpecificity(categorizeTags(FORUM_TAGS).VERSIONS);
    assert.ok(sorted.indexOf('1.21.11') < sorted.indexOf('1.21.1'), '1.21.11 must be tested before 1.21.1');
    assert.ok(sorted.indexOf('26.1.1') < sorted.indexOf('26.1'), '26.1.1 must be tested before 26.1');
    assert.ok(!sorted.includes('All'), '"All" is not a matchable version string');
});

// ── name → id resolution ────────────────────────────────────────────────────
test('resolveTagIds: matches by name, case-insensitively', () => {
    assert.deepEqual(resolveTagIds(FORUM_TAGS, ['neoforge', 'CRASH / FATAL ERROR', '26.2']),
        ['t-neo', 't-crash', 't-262']);
});
test('resolveTagIds: drops names this forum does not define', () => {
    assert.deepEqual(resolveTagIds(FORUM_TAGS, ['Fabric', 'Quilt', 'Nonexistent Tag']), ['t-fabric']);
});
test('resolveTagIds: de-duplicates and tolerates junk input', () => {
    assert.deepEqual(resolveTagIds(FORUM_TAGS, ['Fabric', 'fabric', 'FABRIC']), ['t-fabric']);
    assert.deepEqual(resolveTagIds(FORUM_TAGS, null), []);
    assert.deepEqual(resolveTagIds(null, ['Fabric']), []);
});

// ── the 5-tag cap ───────────────────────────────────────────────────────────
test('capTagIds: never returns more than Discord allows', () => {
    assert.equal(MAX_FORUM_TAGS, 5);
    const desiredIds = resolveTagIds(FORUM_TAGS,
        ['26.2', 'Fabric', 'Visual Bug', 'Animation Bug', 'Crash / Fatal Error', 'Compatibility Issue']);
    assert.equal(desiredIds.length, 6, 'this input really does exceed the cap');

    const capped = capTagIds({ desiredIds, availableTags: FORUM_TAGS });
    assert.equal(capped.length, MAX_FORUM_TAGS);
    assert.equal(new Set(capped).size, MAX_FORUM_TAGS, 'no duplicates');
});

test('capTagIds: keeps version + loader when over the cap (triage depends on them)', () => {
    // Issue tags are detected first here, so a naive truncation would drop the
    // version and loader — exactly the tags other code gates on.
    const desiredIds = resolveTagIds(FORUM_TAGS,
        ['Visual Bug', 'Animation Bug', 'Crash / Fatal Error', 'Compatibility Issue', 'Fabric', '26.2']);
    const capped = capTagIds({ desiredIds, availableTags: FORUM_TAGS });

    assert.equal(capped.length, 5);
    assert.equal(capped[0], 't-262', 'game version first');
    assert.equal(capped[1], 't-fabric', 'mod loader second');
    assert.ok(capped.includes('t-visual') && capped.includes('t-anim'), 'then issues in detection order');
});

test('capTagIds: never evicts tags a human already applied', () => {
    const existingIds = ['t-crash', 't-compat', 't-visual', 't-anim', 't-263s'];  // already 5
    const capped = capTagIds({
        existingIds,
        desiredIds: resolveTagIds(FORUM_TAGS, ['Fabric', '26.2']),
        availableTags: FORUM_TAGS,
    });
    assert.deepEqual(capped, existingIds, 'a full thread keeps exactly its existing tags');
});

test('capTagIds: fills only the free slots when partially full', () => {
    const capped = capTagIds({
        existingIds: ['t-crash', 't-visual', 't-anim'],
        desiredIds: resolveTagIds(FORUM_TAGS, ['26.2', 'Fabric', 'Compatibility Issue']),
        availableTags: FORUM_TAGS,
    });
    assert.deepEqual(capped, ['t-crash', 't-visual', 't-anim', 't-262', 't-fabric'],
        'existing kept, then version + loader take the 2 free slots');
});

test('capTagIds: under the cap is a no-op passthrough', () => {
    const capped = capTagIds({
        desiredIds: resolveTagIds(FORUM_TAGS, ['26.2', 'Fabric']),
        availableTags: FORUM_TAGS,
    });
    assert.deepEqual(capped, ['t-262', 't-fabric']);
});

test('capTagIds: tolerates junk and an unknown-id list', () => {
    assert.deepEqual(capTagIds(), []);
    assert.deepEqual(capTagIds({ desiredIds: null, existingIds: null }), []);
    // ids with no matching availableTags entry still get capped, not thrown on
    const capped = capTagIds({ desiredIds: ['a', 'b', 'c', 'd', 'e', 'f'], availableTags: [] });
    assert.equal(capped.length, 5);
});
