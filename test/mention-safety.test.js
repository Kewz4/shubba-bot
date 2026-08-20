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
        'Attention: @someone @someone');
    assert.equal(stripMentions('cc <@&1480084666408239379>'), 'cc @role');
    assert.equal(stripMentions('@everyone please read'), 'everyone please read');
    assert.equal(stripMentions('@here'), 'here');
});

test('ordinary text is untouched', () => {
    const t = 'Press `F8` and open the Hand Positioner. Email a@b.com if stuck.';
    assert.equal(stripMentions(t), t);
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
    assert.match(src, /is NOT a command/i,
        'typing "request human help" must not be treated as a trigger');
});
