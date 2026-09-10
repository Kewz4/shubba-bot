'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isExplicitHumanRequest, humanRequestAcknowledgement } = require('../lib/human-request');

// The transcripts show a user asking for a developer and receiving another
// round of bot triage. Removing the button closed the ping — it also closed the
// only route to a person, and nothing replaced it.

test('plain requests for a person are recognised', () => {
    for (const t of [
        'can I talk to a human please',
        'Can I speak with a developer?',
        'could a dev look at this',
        'can a moderator please check this',
        'I need a real person',
        'i want to talk to a human',
        'is there a human here',
        'are there any devs around',
        'request human help',
        'human help please',
    ]) {
        assert.equal(isExplicitHumanRequest(t), true, `missed: ${t}`);
    }
});

test('frustration with the bot counts as the same request', () => {
    assert.equal(isExplicitHumanRequest('stop the bot I want a human'), true);
    assert.equal(isExplicitHumanRequest("I don't want a bot, get me a developer"), true);
});

// False positives are the expensive direction — they drag a person into a
// thread Shubba could have closed itself.
test('ordinary support questions are not requests for staff', () => {
    for (const t of [
        'my sword renders wrong on 1.21.1 with fabric',
        'how do I open the Hand Positioner?',
        'the humanoid model animation is broken for my custom mob',
        'is there a config option for this?',
        'can I get a copy of the compat file?',
        'could a resource pack cause this',
        'thanks, a dev already helped me with this one',
        'I see there is no Request Human Help button any more',
    ]) {
        assert.equal(isExplicitHumanRequest(t), false, `false positive: ${t}`);
    }
});

test('a passing mention buried in a long report is not a request', () => {
    const wall = 'can a dev look at this. ' + 'x'.repeat(700);
    assert.equal(isExplicitHumanRequest(wall), false,
        'a wall of technical detail is a report to answer, not a summons');
});

test('never throws on junk', () => {
    for (const junk of [null, undefined, '', 0, {}, [], NaN]) {
        assert.doesNotThrow(() => isExplicitHumanRequest(junk), `threw on ${JSON.stringify(junk)}`);
        assert.equal(isExplicitHumanRequest(junk), false);
    }
});

// ─── What it says back ──────────────────────────────────────────────────────

test('the acknowledgement promises nothing it cannot deliver', () => {
    const msg = humanRequestAcknowledgement();
    assert.doesNotMatch(msg, /@/, 'it must not appear to summon anyone — nobody is pinged');
    assert.doesNotMatch(msg, /\b(?:ping|pinged|notified)\b/i,
        'saying "I pinged them" would be a lie: this path is deliberately silent');
    assert.doesNotMatch(msg, /\b(?:soon|shortly|within|minutes|hours)\b/i,
        'no response-time promise — there is no SLA behind it');
    assert.match(msg, /flagged/i, 'it must say what actually happened');
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

test('index.js actually consults the detector', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(SRC, /isExplicitHumanRequest\(/,
        'the detector exists but nothing calls it — the user is still ignored');
    assert.match(SRC, /require\('\.\/lib\/human-request'\)/);
});

test('honouring the request stays silent — the owner asked for no user-triggered pings', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const at = SRC.indexOf('isExplicitHumanRequest(');
    const nearby = SRC.slice(at, at + 900);
    assert.match(nearby, /requestHumanHelp\([^)]*'silent'\)/,
        "a user must never be able to trigger a ping by typing — that is the exact thing the owner asked to stop");
    assert.doesNotMatch(nearby, /'devs'|'mods'/);
});
