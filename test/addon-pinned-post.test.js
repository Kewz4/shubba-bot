'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { answerEmbeds, COLORS, embedSize, LIMITS } = require('../lib/discord-format');

// The pinned "About This Forum" post was sent as ONE plain-text message. A
// plain message caps at 2000 characters; the guidelines alone are past that,
// and the post grows by a line per registered addon. Every boot logged
//   Invalid Form Body — content[BASE_TYPE_MAX_LENGTH]: Must be 2000 or fewer
// and the post silently stopped updating, so newly created addon roles never
// appeared on it. Found in the live console, not in a test — hence this test.

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function lift(name) {
    const start = SRC.indexOf(`async function ${name}(`);
    assert.ok(start !== -1, `index.js no longer defines ${name}`);
    const end = SRC.indexOf('\n}', start);
    return SRC.slice(start, end + 2);
}

function build(addonCount) {
    const addonRolesStore = {};
    for (let i = 0; i < addonCount; i++) {
        addonRolesStore['t' + i] = { roleId: '1'.repeat(19), threadId: '2'.repeat(19) };
    }
    const sandbox = { addonRolesStore, answerEmbeds, COLORS };
    vm.createContext(sandbox);
    vm.runInContext(lift('buildAddonPinnedContent') + '\n' + lift('buildAddonPinnedPayload'), sandbox);
    return sandbox.buildAddonPinnedPayload();
}

function assertSendable(payload, label) {
    assert.ok((payload.content || '').length <= LIMITS.MESSAGE,
        `${label}: content is ${payload.content.length} chars, over Discord's ${LIMITS.MESSAGE}`);
    assert.ok(payload.embeds.length >= 1, `${label}: no embeds built`);
    assert.ok(payload.embeds.length <= LIMITS.EMBEDS_PER_MESSAGE,
        `${label}: ${payload.embeds.length} embeds, over the 10 per message`);
    payload.embeds.forEach((e, i) => {
        assert.ok(e.description.length <= LIMITS.EMBED_DESCRIPTION,
            `${label}: embed ${i} description ${e.description.length} > ${LIMITS.EMBED_DESCRIPTION}`);
        assert.ok(embedSize(e) <= LIMITS.EMBED_TOTAL,
            `${label}: embed ${i} total ${embedSize(e)} > ${LIMITS.EMBED_TOTAL}`);
    });
}

test('the pinned post is sendable with no addons registered', async () => {
    assertSendable(await build(0), 'empty roster');
});

test('the pinned post is sendable at today\'s roster size', async () => {
    assertSendable(await build(35), '35 addons');
});

test('the pinned post survives a roster far past today\'s', async () => {
    // It must not break again the next time a few creators sign up.
    assertSendable(await build(120), '120 addons');
});

test('the guidelines actually survive into the embeds', async () => {
    const payload = await build(5);
    const all = payload.embeds.map(e => e.description).join('\n');
    assert.match(all, /Pick the right tag/, 'the body was dropped, not just resized');
    assert.match(all, /Subscriber Roles/);
    assert.match(all, /Active Addon Roles/, 'the roster is the part that grows — it must be present');
});

test('the heading becomes the embed title, not a duplicated body line', async () => {
    const payload = await build(1);
    assert.match(payload.embeds[0].title, /Addon Showcase/);
    assert.ok(!payload.embeds[0].description.startsWith('# '),
        'the markdown heading should have been lifted out, not left in the body');
});

test('the updater sends the payload, not the raw string', () => {
    assert.match(SRC, /await starter\.edit\(payload\)/,
        'editing with the raw >2000-char string is what Discord rejected');
    assert.doesNotMatch(SRC, /starter\.edit\(content\)/,
        'the plain-text edit is back — Discord will reject it again');
    assert.doesNotMatch(SRC, /message: \{ content \}/,
        'thread creation is back to the plain-text form');
    // buildAddonPinnedContent is still called — but only from inside the payload
    // builder, which is what turns it into something sendable.
    // `await ...` so the function's own declaration is not counted as a call.
    const directCalls = (SRC.match(/await buildAddonPinnedContent\(guild\)/g) || []).length;
    assert.equal(directCalls, 1, 'exactly one caller: buildAddonPinnedPayload');
});
