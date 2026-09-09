'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// fitLogForPrompt lives in index.js, which cannot be require()'d (importing it
// logs into Discord). Lift it out so these assertions test shipping code.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function load() {
    const start = SRC.indexOf('function fitLogForPrompt(');
    assert.ok(start !== -1, 'index.js no longer defines fitLogForPrompt');
    const end = SRC.indexOf('\n}', start);
    assert.ok(end > start, 'could not find the end of fitLogForPrompt');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(SRC.slice(start, end + 2), sandbox);
    return sandbox.fitLogForPrompt;
}
const fit = load();

// A realistic log: boot banner at the top, the actual failure at the very end.
function bigLog(lines = 20000) {
    const body = Array.from({ length: lines }, (_, i) => `[Render thread/INFO] chunk ${i} loaded`).join('\n');
    return `[main/INFO] Minecraft 1.21.1 / Fabric Loader 0.16.9\n${body}\n[Render thread/FATAL] java.lang.NullPointerException at FishingHookRendererMixin`;
}

test('a short log is passed through and marked complete', () => {
    const out = fit('boot ok\nshutting down', 'latest.log');
    assert.match(out, /complete/);
    assert.doesNotMatch(out, /TRUNCATED/);
    assert.match(out, /shutting down/);
});

// THE REGRESSION. Shubba told a user their game hung because the log "ended"
// mid-line — that boundary was its own 50KB cap, not the game stopping.
test('a truncated log never claims the log ended there', () => {
    const out = fit(bigLog(), 'latest.log');
    assert.match(out, /TRUNCATED/, 'must announce truncation');
    assert.match(out, /MIDDLE ARE MISSING/i, 'must say which part is gone');
    assert.match(out, /not the game/i, 'must warn the boundary is our limit, not the game stopping');
    assert.doesNotMatch(out, /--- END OF latest\.log ---/,
        'a truncated log must never carry the same end marker as a complete one');
});

test('truncation keeps the tail — a crash is at the END of a log', () => {
    // The old head-only cut discarded exactly the part that mattered.
    const out = fit(bigLog(), 'latest.log');
    assert.match(out, /FishingHookRendererMixin/, 'the fatal exception must survive');
    assert.match(out, /NullPointerException/);
});

test('truncation also keeps some head — versions and loader live there', () => {
    const out = fit(bigLog(), 'latest.log');
    assert.match(out, /Fabric Loader/, 'the boot banner must survive');
    assert.match(out, /Minecraft 1\.21\.1/);
});

test('the excerpt stays within budget', () => {
    const out = fit(bigLog(40000), 'latest.log', 50000);
    assert.ok(out.length < 52000, `excerpt was ${out.length} chars`);
});

test('the omitted amount is stated, not hidden', () => {
    const out = fit(bigLog(), 'latest.log');
    assert.match(out, /CHARACTERS OMITTED FROM THE MIDDLE/);
});

test('respects a custom limit', () => {
    const out = fit('x'.repeat(5000), 'f.txt', 1000);
    assert.match(out, /TRUNCATED/);
    assert.ok(out.length < 2000);
});

test('never throws on junk input', () => {
    for (const junk of [null, undefined, '', 0, {}]) {
        assert.doesNotThrow(() => fit(junk, 'f.txt'), `threw on ${JSON.stringify(junk)}`);
    }
});

test('both call sites use the helper, not a raw substring', () => {
    // Guards against someone reintroducing `substring(0, 50000)` + "END OF LOG".
    const calls = (SRC.match(/fitLogForPrompt\(/g) || []).length;
    assert.ok(calls >= 3, `expected the helper to be defined and used twice, found ${calls} references`);
    const lying = SRC.split('\n').filter(l =>
        l.includes('substring(0, 50000)') && l.includes('END OF'));
    assert.deepEqual(lying, [], 'a truncating call site labelled "END OF" has come back');
});
