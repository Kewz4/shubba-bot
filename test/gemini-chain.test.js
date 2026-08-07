'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseChain,
    nextUtcMidnight,
    classifyError,
    extractText,
    createGeminiRunner,
} = require('../lib/gemini-chain');

// ── parseChain ──────────────────────────────────────────────────────────────
test('parseChain: splits on commas/whitespace, trims, dedupes', () => {
    assert.deepEqual(parseChain('a, b ,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseChain('a a  b'), ['a', 'b']);
    assert.deepEqual(parseChain(''), []);
    assert.deepEqual(parseChain(null), []);
});
test('parseChain: prepends primary and dedupes it out of the list', () => {
    assert.deepEqual(parseChain('x,y', 'x'), ['x', 'y']);
    assert.deepEqual(parseChain('y,z', 'x'), ['x', 'y', 'z']);
});

// ── nextUtcMidnight ─────────────────────────────────────────────────────────
test('nextUtcMidnight: returns 00:00 UTC of the following day', () => {
    const noon = Date.UTC(2026, 2, 23, 12, 30, 0);
    assert.equal(nextUtcMidnight(noon), Date.UTC(2026, 2, 24, 0, 0, 0));
});
test('nextUtcMidnight: just before midnight rolls to the very next day', () => {
    const late = Date.UTC(2026, 2, 23, 23, 59, 59, 999);
    assert.equal(nextUtcMidnight(late), Date.UTC(2026, 2, 24, 0, 0, 0));
});

// ── classifyError ───────────────────────────────────────────────────────────
const errWith = (status, message, details) => {
    // Realistic axios-style error: a real Error instance with .response attached.
    const e = new Error(message);
    e.response = { status, data: { error: { message, details } }, headers: {} };
    return e;
};
test('classifyError: per-day 429 → rate/day', () => {
    const e = errWith(429, 'Quota exceeded', [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }]);
    assert.deepEqual(classifyError(e), { kind: 'rate', scope: 'day' });
});
test('classifyError: per-minute 429 → rate/minute', () => {
    const e = errWith(429, 'Resource exhausted', [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }]);
    assert.deepEqual(classifyError(e), { kind: 'rate', scope: 'minute' });
});
test('classifyError: 404 / unsupported model → not_found', () => {
    assert.equal(classifyError(errWith(404, 'models/foo is not found')).kind, 'not_found');
    assert.equal(classifyError(errWith(400, 'model is not supported')).kind, 'not_found');
});
test('classifyError: 401/403 → auth', () => {
    assert.equal(classifyError(errWith(403, 'API key not valid')).kind, 'auth');
    assert.equal(classifyError(errWith(401, 'unauthorized')).kind, 'auth');
});
test('classifyError: plain 400 → bad_request', () => {
    assert.equal(classifyError(errWith(400, 'Invalid JSON payload')).kind, 'bad_request');
});
test('classifyError: 500/network → transient', () => {
    assert.equal(classifyError(errWith(503, 'backend unavailable')).kind, 'transient');
    assert.equal(classifyError({ message: 'socket hang up' }).kind, 'transient');
});

// ── extractText ─────────────────────────────────────────────────────────────
test('extractText: returns the answer, skipping thought parts', () => {
    const data = { candidates: [{ content: { parts: [
        { thought: true, text: 'internal reasoning' },
        { text: 'the real answer' },
    ] } }] };
    assert.equal(extractText(data), 'the real answer');
});
test('extractText: throws on empty candidates', () => {
    assert.throws(() => extractText({ candidates: [{ content: { parts: [] } }] }), /Empty Gemini/);
});

// ── runGeminiChain (the point of the whole thing) ───────────────────────────
function fakePost(script) {
    // script: model → () => Promise (resolve {data} or reject err)
    return async (url) => {
        const model = url.match(/models\/([^:]+):/)[1];
        const handler = script[model];
        if (!handler) throw new Error('no handler for ' + model);
        return handler();
    };
}
const ok = (text) => async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
const fail = (status, message, details) => async () => { throw errWith(status, message, details); };

test('runGeminiChain: uses the first healthy model', async () => {
    const { runGeminiChain } = createGeminiRunner({
        apiKey: 'k', now: () => 1000,
        httpPost: fakePost({ 'model-a': ok('A'), 'model-b': ok('B') }),
    });
    const r = await runGeminiChain('hi', { models: ['model-a', 'model-b'], genConfig: {} });
    assert.equal(r.text, 'A');
    assert.equal(r.model, 'model-a');
});

test('runGeminiChain: falls over to the next model on a daily 429', async () => {
    const { runGeminiChain, _cooldownUntil } = createGeminiRunner({
        apiKey: 'k', now: () => Date.UTC(2026, 2, 23, 12, 0, 0),
        httpPost: fakePost({
            'model-a': fail(429, 'quota', [{ quotaId: 'RequestsPerDayPerProjectPerModel-FreeTier' }]),
            'model-b': ok('B'),
        }),
    });
    const r = await runGeminiChain('hi', { models: ['model-a', 'model-b'], genConfig: {} });
    assert.equal(r.text, 'B');
    // model-a should be parked until next UTC midnight
    assert.equal(_cooldownUntil['model-a'], Date.UTC(2026, 2, 24, 0, 0, 0));
});

test('runGeminiChain: drops a 404 model permanently, then succeeds', async () => {
    let aCalls = 0;
    const { runGeminiChain } = createGeminiRunner({
        apiKey: 'k', now: () => 1000,
        httpPost: fakePost({
            'model-a': async () => { aCalls++; throw errWith(404, 'not found'); },
            'model-b': ok('B'),
        }),
    });
    const r1 = await runGeminiChain('hi', { models: ['model-a', 'model-b'], genConfig: {} });
    const r2 = await runGeminiChain('hi', { models: ['model-a', 'model-b'], genConfig: {} });
    assert.equal(r1.text, 'B');
    assert.equal(r2.text, 'B');
    assert.equal(aCalls, 1, 'model-a should not be retried after a 404 (permanently dropped)');
});

test('runGeminiChain: retries a transient error on the same model before moving on', async () => {
    let n = 0;
    const { runGeminiChain } = createGeminiRunner({
        apiKey: 'k', now: () => 1000,
        httpPost: fakePost({
            'model-a': async () => { n++; if (n === 1) throw errWith(503, 'unavailable'); return (await ok('A2')()); },
        }),
    });
    const r = await runGeminiChain('hi', { models: ['model-a'], genConfig: {}, perModelRetries: 1 });
    assert.equal(r.text, 'A2');
    assert.equal(n, 2);
});

test('runGeminiChain: aborts the whole chain on a 400 bad request (does not mask bugs)', async () => {
    let bCalled = false;
    const { runGeminiChain } = createGeminiRunner({
        apiKey: 'k', now: () => 1000,
        httpPost: fakePost({
            'model-a': fail(400, 'Invalid JSON payload'),
            'model-b': async () => { bCalled = true; return (await ok('B')()); },
        }),
    });
    await assert.rejects(
        runGeminiChain('hi', { models: ['model-a', 'model-b'], genConfig: {} }),
        /Invalid JSON payload/
    );
    assert.equal(bCalled, false, 'a real 400 must not silently fall through to another model');
});

test('runGeminiChain: throws allModelsExhausted when every model is rate-limited', async () => {
    const { runGeminiChain } = createGeminiRunner({
        apiKey: 'k', now: () => 1000,
        httpPost: fakePost({
            'model-a': fail(429, 'quota', [{ quotaId: 'PerMinute' }]),
            'model-b': fail(429, 'quota', [{ quotaId: 'PerMinute' }]),
        }),
    });
    await assert.rejects(
        runGeminiChain('hi', { models: ['model-a', 'model-b'], genConfig: {} }),
        (e) => e.allModelsExhausted === true
    );
});
