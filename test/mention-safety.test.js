'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { noPing, stripMentions, NO_MENTIONS } = require('../lib/discord-format');

// Production incident this guards: Shubba authored
//   "🚩 Human Help Requested!  Attention: @Godku @punchymod"
// inside a normal reply. Both owners were pinged, requestHumanHelp() was never
// called, and every notify-tier safeguard was bypassed — because the ping was
// just text the model wrote.

test('a payload cannot ping by default', () => {
    assert.deepEqual(noPing({ content: '<@422458713987612685> look at this' }).allowedMentions, NO_MENTIONS);
    assert.deepEqual(noPing('plain string').allowedMentions, NO_MENTIONS);
});

test('opting in allows only the IDs named', () => {
    const p = noPing({ content: 'x' }, { users: ['1', '2'] });
    assert.deepEqual(p.allowedMentions.parse, [], 'must never fall back to parsing everything');
    assert.deepEqual(p.allowedMentions.users, ['1', '2']);
    assert.deepEqual(p.allowedMentions.roles, []);
});

test('noPing preserves the rest of the payload', () => {
    const p = noPing({ embeds: [{ title: 't' }], components: ['c'] });
    assert.equal(p.embeds[0].title, 't');
    assert.deepEqual(p.components, ['c']);
});

test('mention syntax is stripped from model output', () => {
    assert.equal(stripMentions('Attention: <@422458713987612685> <@1413670292970274836>'),
        'Attention: someone someone');
    assert.equal(stripMentions('cc <@&1480084666408239379>'), 'cc the team');
    assert.equal(stripMentions('@everyone please read'), 'everyone please read');
    assert.equal(stripMentions('@here'), 'here');
});

// Nothing is left holding an @. A leftover "@someone" still READS as a summons,
// and a user apologised in the forum for pinging the devs over text Shubba
// wrote itself — the apology was for text, not for an actual ping.
test('no @ survives anywhere in the output', () => {
    for (const t of [
        'Attention: <@422458713987612685>',
        'cc <@&1480084666408239379>',
        '@everyone @here',
        'ping @kewz. and @punchymod about this',
    ]) {
        assert.ok(!stripMentions(t).includes('@'), `an @ survived: ${stripMentions(t)}`);
    }
});

// The exact production string, verbatim.
test('the incident text no longer reads as a summons', () => {
    assert.equal(
        stripMentions('🚩 Human Help Requested!  Attention: @Godku @punchymod'),
        '🚩 Human Help Requested!  Attention: Godku punchymod');
});

test('bare handles lose the @ wherever they sit', () => {
    assert.equal(stripMentions('@kewz. can help'), 'kewz. can help');       // start of string
    assert.equal(stripMentions('ask @shbashi'), 'ask shbashi');            // after a space
    assert.equal(stripMentions('(@thiageitor)'), '(thiageitor)');          // parenthesised
    assert.equal(stripMentions('see [@dev]'), 'see [dev]');                // bracketed
    assert.equal(stripMentions('line\n@dev here'), 'line\ndev here');      // after a newline
});

test('ordinary text is untouched', () => {
    const t = 'Press `F8` and open the Hand Positioner. Email a@b.com if stuck.';
    assert.equal(stripMentions(t), t);
});

// An @ that follows a word character is part of an address, not a handle.
test('email addresses survive', () => {
    for (const t of ['a@b.com', 'support@punchymod.com', 'Contact hello@world.com today']) {
        assert.equal(stripMentions(t), t, `mangled an address: ${t}`);
    }
});

test('stripMentions tolerates junk input', () => {
    assert.equal(stripMentions(null), '');
    assert.equal(stripMentions(undefined), '');
});

test('every answer passes through the strip', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(src, /let fixed = stripMentions\(text\)/,
        'qualityCheckResponse must strip mentions — it is the one choke point all answers cross');
});

test('answer sends are mention-free, and only escalation opts in', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(src, /thread\.send\(noPing\(isLast/, 'wiki answers must send with noPing');
    assert.match(src, /notify === 'devs' \? \{ users: DEV_IDS \}/,
        'only a deliberate devs-tier escalation may ping');
});

test('the prompt forbids the model from writing mentions', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(src, /NEVER WRITE AN @MENTION/, 'the rule must be stated to the model too');
    // A user asking for a person is now handled in code and never reaches the
    // model, so the rule is a guarantee rather than an instruction it might
    // ignore. What must hold either way: typing it can never produce a ping.
    assert.match(src, /never offer to ping anyone/i,
        'the model must not be able to turn a typed request into a summons');
});
