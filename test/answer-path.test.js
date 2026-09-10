'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// These are structural assertions over index.js. They cannot exercise the
// Discord handlers (importing index.js logs the bot in), but the defects they
// guard were all structural: a check placed after an await, a second handler
// nobody remembered existed, a send that skipped the safeguards. Shape is
// exactly what went wrong, so shape is what we pin.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// ─── One post, one answer ────────────────────────────────────────────────────
// Discord delivers a forum post as BOTH a THREAD_CREATE and a MESSAGE_CREATE.
// Both handlers answered it, so users got the tag gate twice ~3 seconds apart
// and, on bug reports, two contradictory Deep Analysis reports.

test('MessageCreate ignores the forum starter message', () => {
    assert.match(SRC, /if \(message\.id === message\.channel\.id\) return;/,
        'without this filter the starter post is answered by two handlers');
});

test('the starter claim happens BEFORE the first await, not after', () => {
    // The old guard sat after `await thread.fetchStarterMessage()`, on the far
    // side of a 4s timer plus a REST round-trip — a window wide enough for the
    // other handler to answer AND release the lock in between.
    for (const m of SRC.matchAll(/answeredStarters\.add\(thread\.id\);/g)) {
        const before = SRC.slice(Math.max(0, m.index - 600), m.index);
        assert.doesNotMatch(before, /await thread\.fetchStarterMessage\(\)/,
            'the claim must precede fetchStarterMessage(), or it races');
    }
    const claims = (SRC.match(/answeredStarters\.add\(thread\.id\)/g) || []).length;
    assert.equal(claims, 2, 'both the support and wiki starter handlers must claim');
});

test('answeredStarters is never released mid-flight', () => {
    // processingThreads is a mutex and IS released; this one is the memory.
    assert.doesNotMatch(SRC, /answeredStarters\.delete\(thread\.id\)/,
        'releasing the dedupe turns it back into a mutex and the double-answer returns');
});

test('answeredStarters is still evicted eventually, or it leaks forever', () => {
    const cleanup = SRC.slice(SRC.indexOf('function cleanupOldMemories('));
    assert.match(cleanup.slice(0, 1500), /answeredStarters\.delete/,
        'a bot up for months would otherwise hold one entry per thread ever seen');
});

// ─── Escalation is claimed synchronously ────────────────────────────────────

test('requestHumanHelp guards on local state, not on the renamed title', () => {
    const fn = SRC.slice(SRC.indexOf('async function requestHumanHelp('));
    const head = fn.slice(0, 1600);
    assert.match(head, /escalatedThreads\.has\(thread\.id\)/,
        'the "(HUMAN HELP)" prefix only exists after a rate-limited REST rename lands');
    const guardAt = head.indexOf('escalatedThreads.add(thread.id)');
    const renameAt = head.indexOf('thread.setName(');
    assert.ok(guardAt !== -1 && guardAt < renameAt,
        'the claim must be taken before the rename, not after');
});

test('a failed rename does not swallow the escalation notice', () => {
    const fn = SRC.slice(SRC.indexOf('async function requestHumanHelp('));
    assert.match(fn.slice(0, 1600), /setName\([^)]*\)\s*\n?\s*\.catch\(/,
        'a throw here used to skip the embed entirely — thread unflagged, nobody told');
});

test('a silent escalation still reaches a human somewhere', () => {
    assert.match(SRC, /async function postEscalationRecord\(/);
    assert.match(SRC, /sweepStaleEscalations/,
        'without the sweep, an unanswered escalation is never revisited');
});

// ─── One way out ────────────────────────────────────────────────────────────
// The wiki path had quality-check + embeds + noPing. The busier support path
// had none of them, which is why "@kewz." reached real users.

test('every model answer leaves through sendAnswer', () => {
    const calls = (SRC.match(/await sendAnswer\(/g) || []).length;
    assert.ok(calls >= 4, `expected the support, wiki and text-channel paths to use it, found ${calls}`);
});

test('sendAnswer strips mentions before anything else touches the text', () => {
    const fn = SRC.slice(SRC.indexOf('async function sendAnswer('));
    const body = fn.slice(0, 2000);
    const qc = body.indexOf('qualityCheckResponse(');
    const visuals = body.indexOf('processAiVisuals(');
    assert.ok(qc !== -1 && qc < visuals,
        'qualityCheckResponse is the only thing that calls stripMentions — it must run first');
    assert.match(body, /noPing\(/, 'the payload must be sent mention-free');
    assert.match(body, /answerEmbeds\(/, 'answers go out as embeds, not 1750-char chunks');
});

test('no answer path hand-rolls a chunked send any more', () => {
    // The exact shape that skipped every safeguard.
    assert.doesNotMatch(SRC, /const chunks = splitMessage\(parsedText\)/,
        'a hand-rolled support send has come back — route it through sendAnswer');
});

// ─── Files ──────────────────────────────────────────────────────────────────

test('logs are decompressed, not read as UTF-8 gzip', () => {
    assert.match(SRC, /isLikelyLog\(attachment\.name, contentType\)/,
        'latest.log.gz matched name.includes("log") and was toString("utf8")-ed into mojibake');
    assert.match(SRC, /analyzeLog\(buffer, attachment\.name\)/);
});

test('parsed log facts feed thread memory, so the gate can see them', () => {
    assert.match(SRC, /memory\.userInfo\.version = facts\.minecraftVersion/,
        'otherwise the version sits in a local while Shubba asks the user for it');
});

test('attached packs and JSON are validated in the support forum too', () => {
    const calls = (SRC.match(/validatePunchyFiles\(/g) || []).length;
    assert.ok(calls >= 5,
        `the validator ran only on the wiki path; expected support paths too, found ${calls} references`);
});

// ─── Honesty ────────────────────────────────────────────────────────────────

test('Shubba is told it cannot see images, not told to pretend it can', () => {
    assert.match(SRC, /YOU CANNOT SEE THIS IMAGE/,
        'the old wording told it to "acknowledge that you can see it" — it has no vision');
    assert.doesNotMatch(SRC, /Acknowledge that you can see it/,
        'that instruction produced confident descriptions of screenshots it never received');
});

test('internals are withheld by code, not by asking the model nicely', () => {
    assert.match(SRC, /function ownerKnowledge\(/);
    assert.match(SRC, /ownerKnowledge\(isOwnerQuery\)/,
        'the public prompt must append the dev block conditionally');
    const staticBlock = SRC.slice(SRC.indexOf('const PUNCHY_STATIC_KNOWLEDGE = `'),
        SRC.indexOf('const PUNCHY_DEV_INTERNALS = `'));
    assert.ok(!staticBlock.includes('- Architecture: state machine per action'),
        'the internals are back inside the always-injected constant');
});

test('a removed button is not advertised to users', () => {
    const qc = SRC.slice(SRC.indexOf('function qualityCheckResponse('));
    assert.match(qc.slice(0, 4000), /Request\\s\+Human\\s\+Help/,
        'the model kept offering a button that is no longer rendered — strip it deterministically');
});
