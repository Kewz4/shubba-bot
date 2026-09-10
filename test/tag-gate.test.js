'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The gate lives in index.js, which cannot be require()'d (importing it logs
// into Discord). Lift the three functions out so these assertions test the code
// that actually ships.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function lift(name) {
    const start = SRC.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `index.js no longer defines ${name}`);
    // Each of these ends at a closing brace in column 0.
    const end = SRC.indexOf('\n}', start);
    assert.ok(end > start, `could not find the end of ${name}`);
    return SRC.slice(start, end + 2);
}

const sandbox = {
    TAG_CATEGORIES: {
        VERSIONS: ['1.20.1', '1.21.1', '1.21.11', '26.1', '26.2'],
        LOADERS: ['Fabric', 'Forge', 'NeoForge'],
    },
};
vm.createContext(sandbox);
vm.runInContext(lift('haveSetupFacts') + '\n' + lift('checkTagCompliance') + '\n' + lift('getTagGateMessage'), sandbox);
const { haveSetupFacts, checkTagCompliance, getTagGateMessage } = sandbox;

// ─── The complaint this fixes ────────────────────────────────────────────────
// "Demanded the Minecraft version that was already the first line of the report."
// The gate read forum tags and nothing else, while the same request had already
// parsed the version out of the crash log and put it in the prompt.

test('a crash report supplies the version and loader the tags lack', () => {
    const log = [
        '---- Minecraft Crash Report ----',
        '-- System Details --',
        'Minecraft Version: 1.21.1',
        'Fabric Loader 0.16.9',
    ].join('\n');
    assert.equal(getTagGateMessage([], { logContent: log }), null,
        'the gate must not ask for facts sitting in the log it was handed');
});

test('a version parsed from the jar filename counts', () => {
    assert.equal(getTagGateMessage(['Fabric'], { detectedVersion: 'punchy-2.4-fabric-1.21.11.jar' }), null);
});

test('what the user already told us counts', () => {
    assert.equal(getTagGateMessage([], { userInfo: { version: '1.20.1', loader: 'Forge' } }), null);
});

test('the user writing it in prose counts', () => {
    assert.equal(getTagGateMessage([], { text: "I'm on 1.21.1 with neoforge and my sword floats" }), null);
});

test('tags alone still work — they were never the problem', () => {
    assert.equal(getTagGateMessage(['1.21.1', 'Fabric']), null);
});

// ─── ...without becoming a gate that never fires ─────────────────────────────

test('a genuinely bare post is still gated', () => {
    const msg = getTagGateMessage([], { text: 'my game is broken pls help' });
    assert.ok(msg, 'no evidence at all must still ask');
    assert.match(msg, /Minecraft version/i);
    assert.match(msg, /loader/i);
});

test('half the evidence asks for the other half only', () => {
    const msg = getTagGateMessage(['Fabric'], { text: 'punchy breaks my sword' });
    assert.ok(msg);
    assert.match(msg, /Minecraft version/i);
    assert.doesNotMatch(msg, /Fabric, Forge, or NeoForge/,
        'must not ask for a loader it already has');
});

test('a loader named only in the log satisfies the loader half', () => {
    const { haveLoader, haveVersion } = haveSetupFacts([], { logContent: '[main/INFO] NeoForge 21.1.3 starting' });
    assert.equal(haveLoader, true);
    assert.equal(haveVersion, false, 'a loader line is not a version');
});

// ─── checkTagCompliance feeds the PROMPT, and must agree with the gate ───────
// Otherwise the canned gate goes quiet and the model asks in prose instead —
// which is exactly what users reported as "asked me a third time".

test('the prompt hint and the gate agree', () => {
    const evidence = { logContent: 'Minecraft Version: 1.21.1\nFabric Loader 0.16.9' };
    // Array.from: the lifted function builds its array inside the vm sandbox,
    // whose Array.prototype is a different object, and strict deepEqual checks
    // prototype identity. Copy it into this realm before comparing.
    assert.deepEqual(Array.from(checkTagCompliance([], evidence)), [],
        'the model must not be told to ask for what the gate accepted');
    assert.equal(getTagGateMessage([], evidence), null);
});

test('with nothing at all, both still report both missing', () => {
    assert.deepEqual(Array.from(checkTagCompliance([], { text: 'help' })), ['Game Version', 'Mod Loader']);
});

test('neither throws on junk', () => {
    for (const junk of [undefined, null, {}, { logContent: null, text: 0, userInfo: null }]) {
        assert.doesNotThrow(() => getTagGateMessage([], junk || undefined), `threw on ${JSON.stringify(junk)}`);
        assert.doesNotThrow(() => checkTagCompliance([], junk || undefined));
    }
    assert.doesNotThrow(() => getTagGateMessage(undefined));
});

// ─── Wiring: the evidence has to actually reach the gate ────────────────────

test('both call sites pass evidence, not bare tags', () => {
    const bare = SRC.match(/getTagGateMessage\(tags\)/g) || [];
    assert.deepEqual(bare, [],
        'a call site is still passing tags alone — it will ask for facts we already have');
    const bareCompliance = SRC.match(/checkTagCompliance\(tags\)/g) || [];
    assert.deepEqual(bareCompliance, [],
        'a checkTagCompliance call site is still tag-only');
});

test('the nag budget is enforced on BOTH gate paths', () => {
    // The ThreadCreate side used to increment the counter with no ceiling check,
    // so one post could spend the whole budget and the user's next message went
    // straight to the prose-worded ask.
    const increments = SRC.match(/tagGateNagCount\.set\(/g) || [];
    const ceilingChecks = SRC.match(/TAG_GATE_MAX_NAGS/g) || [];
    assert.ok(increments.length >= 2, 'expected both gate paths to count nags');
    assert.ok(ceilingChecks.length >= increments.length,
        'every increment needs a ceiling check guarding it');
});
