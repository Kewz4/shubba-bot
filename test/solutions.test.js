'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    detectVersions, minorLine, keywords, detectMods, distil,
    isDuplicate, pickRelevant, renderForPrompt,
} = require('../lib/solutions');

// ── Version detection: the old store filed everything under a constant ──────

test('reads the Punchy version out of a report', () => {
    assert.equal(detectVersions('crash on Punchy 2.7d').punchy, '2.7d');
    assert.equal(detectVersions('using v2.6.2 here').punchy, '2.6.2');
});

test('separates the Minecraft version from the Punchy one', () => {
    const v = detectVersions('Punchy 2.7d on Fabric 26.1.2, arm is floating');
    assert.equal(v.punchy, '2.7d');
    assert.equal(v.mc, '26.1.2');
});

test('does not mistake a Minecraft version for a Punchy one', () => {
    const v = detectVersions('this happens on 1.21.1');
    assert.equal(v.mc, '1.21.1');
    assert.equal(v.punchy, null, 'an MC version must not be filed as a Punchy version');
});

test('forum tags beat prose', () => {
    // A tag was chosen deliberately; prose may be quoting someone else's setup.
    const v = detectVersions('my friend was on 1.20.1 but I am not', { tags: ['26.2', 'Crash / Fatal Error'] });
    assert.equal(v.mc, '26.2');
});

test('prefers the more specific MC version', () => {
    assert.equal(detectVersions('broken on 26.1 — actually 26.1.2').mc, '26.1.2');
});

test('release line groups patch releases', () => {
    assert.equal(minorLine('2.7d'), '2.7');
    assert.equal(minorLine('2.6.2'), '2.6');
    assert.equal(minorLine(null), null);
});

test('falls back only when nothing is stated', () => {
    assert.equal(detectVersions('no version here', { fallbackPunchy: '2.7' }).punchy, '2.7');
    assert.equal(detectVersions('on 2.5.7', { fallbackPunchy: '2.7' }).punchy, '2.5.7',
        'a stated version must win over the fallback');
});

// ── Distillation: keep the signal, drop the chat ────────────────────────────

const thread = {
    threadName: 'Sword floats in hand on 26.1.2',
    threadId: 't1',
    tags: ['26.1.2', 'Visual Bug'],
    messages: [
        { author: 'op', content: 'My sword floats away from my hand since updating to Punchy 2.7d on 26.1.2. Better Combat is installed.' },
        { author: 'helper', content: 'ok' },
        { author: 'helper', content: 'That is Better Combat overriding the grip. Open F8, Hand Positioner, set the scope to Specific for the sword and re-save — that pins the offset back.' },
        { author: 'op', content: 'thanks it works!' },
    ],
};

test('captures the symptom and the actual fix, not the acks', () => {
    const s = distil(thread);
    assert.match(s.symptom, /floats away/);
    assert.match(s.fix, /Hand Positioner/);
    assert.doesNotMatch(s.fix, /^ok$/i);
    assert.doesNotMatch(s.fix, /thanks it works/i, 'an ack is never the fix');
});

test('files it under the version the reporter was actually on', () => {
    const s = distil(thread);
    assert.equal(s.punchyVersion, '2.7d');
    assert.equal(s.mcVersion, '26.1.2');
    assert.equal(s.line, '2.7');
});

test('records the mods involved', () => {
    const s = distil({ ...thread, knownMods: ['Better Combat', 'Controlify'] });
    assert.ok(s.mods.includes('Better Combat'), `mods were ${JSON.stringify(s.mods)}`);
});

test('mod ids in text are picked up', () => {
    const mods = detectMods('crashes with create:crushing_wheel and minecraft:bow');
    assert.ok(mods.includes('create'));
    assert.ok(!mods.includes('minecraft'), 'minecraft is not a third-party mod');
});

test('keywords drop filler', () => {
    const k = keywords('the sword is not working with my punchy mod please help');
    assert.ok(k.includes('sword'));
    assert.ok(!k.includes('the'));
    assert.ok(!k.includes('punchy'), 'every thread mentions punchy — it carries no signal');
});

test('a record stays small', () => {
    // The old store kept 50 messages of transcript per solution.
    const s = distil(thread);
    assert.ok(JSON.stringify(s).length < 2000, 'records must stay compact');
});

// ── Dedupe ──────────────────────────────────────────────────────────────────

test('the same thread is never stored twice', () => {
    const a = distil(thread);
    assert.equal(isDuplicate(a, a), true);
});

test('near-identical symptoms on the same line are duplicates', () => {
    const a = distil(thread);
    const b = distil({ ...thread, threadId: 't2' });
    assert.equal(isDuplicate(b, a), true);
});

test('the same symptom on a different release line is kept', () => {
    // Fixes legitimately differ between release lines.
    const a = distil(thread);
    const b = distil({ ...thread, threadId: 't3', messages: [{ author: 'op', content: 'My sword floats away from my hand on Punchy 2.5.7 with Better Combat installed.' }] });
    assert.equal(isDuplicate(b, a), false);
});

// ── Retrieval ───────────────────────────────────────────────────────────────

const store = {
    '2.7': [distil(thread)],
    '2.6': [distil({
        threadName: 'Bow draw animation missing',
        threadId: 't9',
        tags: ['26.1'],
        messages: [
            { author: 'op', content: 'The bow draw animation does not play at all on Punchy 2.6.2.' },
            { author: 'helper', content: 'That was a known 2.6 regression in the use_bow clip; updating to 2.7 fixes it and no config change is needed.' },
        ],
    })],
};

test('finds the relevant solution and ignores the rest', () => {
    const hits = pickRelevant(store, { text: 'my sword floats away from my hand, Better Combat installed' });
    assert.equal(hits.length, 1);
    assert.match(hits[0].threadName, /floats/);
});

test('searches EVERY version, not just the current one', () => {
    // The old code only read CURRENT_VERSION_SET, so this was invisible.
    const hits = pickRelevant(store, { text: 'bow draw animation is missing entirely' });
    assert.ok(hits.length >= 1, 'a 2.6 fix must be reachable from a 2.7 question');
    assert.match(hits[0].threadName, /Bow draw/);
});

test('an unrelated question returns nothing', () => {
    // Better to say nothing than to paste an irrelevant "fix".
    assert.deepEqual(pickRelevant(store, { text: 'how do I change the resource pack load order' }), []);
});

test('respects the limit', () => {
    const big = { '2.7': Array.from({ length: 20 }, (_, i) => distil({ ...thread, threadId: 'x' + i })) };
    assert.ok(pickRelevant(big, { text: 'sword floats away from hand' }, { limit: 3 }).length <= 3);
});

test('rendering stays compact and flags uncertainty', () => {
    const out = renderForPrompt(pickRelevant(store, { text: 'sword floats away from my hand' }));
    assert.match(out, /PREVIOUSLY SOLVED/);
    assert.match(out, /Hand Positioner/);
    assert.match(out, /only if they match/i, 'the model must be told these may not apply');
    assert.ok(out.length < 2000, 'must not bloat the prompt');
});

test('rendering nothing produces nothing', () => {
    assert.equal(renderForPrompt([]), '');
    assert.equal(renderForPrompt(null), '');
});

test('retrieval never throws on a malformed store', () => {
    assert.doesNotThrow(() => pickRelevant(null, { text: 'x' }));
    assert.doesNotThrow(() => pickRelevant({ '2.7': null }, { text: 'x' }));
    assert.doesNotThrow(() => distil({}));
});
