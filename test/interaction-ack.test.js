'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ─── Loading the real code under test ────────────────────────────────────────
// The interaction helpers live in index.js, which cannot be require()'d from a
// test: importing it logs into Discord and starts timers. Instead we lift the
// self-contained helper block straight out of the source and evaluate it in a
// sandbox. That keeps these assertions pointed at the code that actually ships
// rather than at a copy that can drift.

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const INDEX_SRC = fs.readFileSync(INDEX_PATH, 'utf8');

const BLOCK_START = '// ─── SAFE INTERACTION HELPERS';
const BLOCK_END = 'client.on(Events.InteractionCreate';

function loadHelpers() {
    const startIdx = INDEX_SRC.indexOf(BLOCK_START);
    const endIdx = INDEX_SRC.indexOf(BLOCK_END);
    assert.ok(startIdx !== -1, `index.js is missing the "${BLOCK_START}" marker`);
    assert.ok(endIdx > startIdx, `index.js is missing the "${BLOCK_END}" marker after the helpers`);

    const block = INDEX_SRC.slice(startIdx, endIdx);
    const logs = [];
    const sandbox = {
        MessageFlags: { Ephemeral: 64 },
        console: {
            log: (...a) => logs.push(['log', a.join(' ')]),
            warn: (...a) => logs.push(['warn', a.join(' ')]),
            error: (...a) => logs.push(['error', a.join(' ')]),
        },
        setTimeout,
        setImmediate,
    };
    vm.createContext(sandbox);

    // const/let bindings do not survive between runInContext calls, so the block
    // and the export expression have to be evaluated as one script.
    const exported = vm.runInContext(
        `${block}\n;({ safeReply, safeDefer, safeEditReply, clampModalLabel, MODAL_LABEL_MAX,
            reportInteractionFailure, shouldAckUpFront, deferOptionsFor, enqueueUserCommand,
            userCommandQueue, EXPIRED_INTERACTION_CODES, INSTANT_COMMANDS, MODAL_COMMANDS,
            SELECT_MENU_COMMANDS, DEFER_PUBLIC_COMMANDS });`,
        sandbox,
        { filename: 'index.js#interaction-helpers' }
    );
    return { ...exported, logs, EPHEMERAL: 64 };
}

const H = loadHelpers();

// ─── Mock interaction ────────────────────────────────────────────────────────
// Enforces discord.js's real state machine. If a helper picks the wrong method
// the mock throws exactly like the library would, so a wrong branch fails the
// test instead of silently "passing".

class InteractionAlreadyReplied extends Error {
    constructor() { super('InteractionAlreadyReplied'); this.name = 'InteractionAlreadyReplied'; }
}
class InteractionNotReplied extends Error {
    constructor() { super('InteractionNotReplied'); this.name = 'InteractionNotReplied'; }
}

function makeInteraction(overrides = {}) {
    const it = {
        commandName: 'editrole',
        customId: undefined,
        user: { id: 'u1', username: 'cardinalkbs' },
        deferred: false,
        replied: false,
        calls: [],
        isAutocomplete() { return false; },

        async deferReply(opts) {
            if (this.deferred || this.replied) throw new InteractionAlreadyReplied();
            this.calls.push(['deferReply', opts]);
            this.deferred = true;
        },
        async reply(payload) {
            if (this.deferred || this.replied) throw new InteractionAlreadyReplied();
            this.calls.push(['reply', payload]);
            this.replied = true;
        },
        async editReply(payload) {
            if (!this.deferred && !this.replied) throw new InteractionNotReplied();
            this.calls.push(['editReply', payload]);
            this.replied = true; // discord.js sets this on editReply
        },
        async followUp(payload) {
            if (!this.deferred && !this.replied) throw new InteractionNotReplied();
            this.calls.push(['followUp', payload]);
        },
        async showModal(modal) {
            if (this.deferred || this.replied) throw new InteractionAlreadyReplied();
            this.calls.push(['showModal', modal]);
            this.replied = true; // only on success — a rejected showModal leaves it false
        },
    };
    return Object.assign(it, overrides);
}

const methods = (it) => it.calls.map(c => c[0]);
const apiError = (code, message = 'api error') => Object.assign(new Error(message), { code });

// Values produced inside the vm sandbox carry that realm's prototypes, so
// assert/strict's deep-equal rejects them against plain literals here. Round-trip
// through JSON to compare structure rather than realm identity.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ═════════════════════════════════════════════════════════════════════════════
// 1. Acknowledge-first routing
// ═════════════════════════════════════════════════════════════════════════════

test('shouldAckUpFront: modal commands are never deferred (deferring breaks showModal)', () => {
    for (const cmd of H.MODAL_COMMANDS) {
        assert.equal(H.shouldAckUpFront(cmd), false, `/${cmd} shows a modal and must not be deferred`);
    }
    assert.ok(H.MODAL_COMMANDS.has('editrole'), 'editrole must stay registered as a modal command');
    assert.ok(H.MODAL_COMMANDS.has('createrole'), 'createrole must stay registered as a modal command');
});

test('shouldAckUpFront: select-menu and instant commands are also left unacknowledged', () => {
    for (const cmd of H.SELECT_MENU_COMMANDS) {
        assert.equal(H.shouldAckUpFront(cmd), false, `/${cmd} needs the initial response slot for its menu`);
    }
    for (const cmd of H.INSTANT_COMMANDS) {
        assert.equal(H.shouldAckUpFront(cmd), false, `/${cmd} replies immediately`);
    }
});

test('shouldAckUpFront: commands that do I/O are acknowledged up front', () => {
    for (const cmd of ['solve', 'summary', 'versions', 'auditaddons', 'purge', 'deleterole', 'isolate']) {
        assert.equal(H.shouldAckUpFront(cmd), true, `/${cmd} does awaited work and must be deferred first`);
    }
});

test('deferOptionsFor: public commands defer publicly, everything else ephemerally', () => {
    // Ephemerality is locked in at defer time — flags passed to a later editReply
    // are ignored, so this mapping has to match what each handler intends.
    for (const cmd of ['solve', 'warn', 'replied', 'info_request', 'close_report', 'nextupdate', 'modstats']) {
        assert.deepEqual(plain(H.deferOptionsFor(cmd)), {}, `/${cmd} answers the channel and must defer publicly`);
    }
    for (const cmd of ['summary', 'versions', 'purge', 'warnings', 'deleterole', 'faq_preview']) {
        assert.deepEqual(plain(H.deferOptionsFor(cmd)), { flags: [H.EPHEMERAL] }, `/${cmd} should defer ephemerally`);
    }
});

test('safeDefer: acknowledges before slow work, and the work never precedes the ack', async () => {
    const it = makeInteraction({ commandName: 'summary' });
    const order = [];

    // Mirrors the dispatcher: ack first, then the slow part.
    await H.safeDefer(it, H.deferOptionsFor('summary'));
    order.push('acked');
    await new Promise(r => setTimeout(r, 15)); // stand-in for a Gemini / GCS call
    order.push('work-done');

    assert.deepEqual(order, ['acked', 'work-done']);
    assert.deepEqual(methods(it), ['deferReply']);
    assert.deepEqual(plain(it.calls[0][1]), { flags: [H.EPHEMERAL] });
    assert.equal(it.deferred, true);
});

test('safeDefer: is a no-op on an already-acknowledged interaction', async () => {
    const it = makeInteraction();
    await it.reply({ content: 'hi' });
    await H.safeDefer(it, {}); // must not throw InteractionAlreadyReplied
    assert.deepEqual(methods(it), ['reply']);
});

test('safeReply: routes to editReply once the interaction is deferred', async () => {
    const it = makeInteraction({ commandName: 'summary' });
    await H.safeDefer(it, { flags: [H.EPHEMERAL] });
    await H.safeReply(it, 'done');
    assert.deepEqual(methods(it), ['deferReply', 'editReply']);
    assert.deepEqual(plain(it.calls[1][1]), { content: 'done' });
});

test('safeReply / safeEditReply: swallow expired-interaction errors instead of crashing', async () => {
    const expired = makeInteraction({
        async reply() { throw apiError(10062, 'Unknown interaction'); },
        async editReply() { throw apiError(40060, 'Already acknowledged'); },
    });
    assert.equal(await H.safeReply(expired, 'x'), null);
    assert.equal(await H.safeEditReply(expired, 'x'), null);

    // A non-expiry error must still surface — those are real bugs.
    const broken = makeInteraction({ async reply() { throw apiError(50035, 'Invalid Form Body'); } });
    await assert.rejects(() => H.safeReply(broken, 'x'), /Invalid Form Body/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The already-acknowledged error branch
// ═════════════════════════════════════════════════════════════════════════════

test('reportInteractionFailure: untouched interaction → reply()', async () => {
    const it = makeInteraction();
    await H.reportInteractionFailure(it, new Error('boom'));
    assert.deepEqual(methods(it), ['reply']);
    assert.deepEqual(plain(it.calls[0][1].flags), [H.EPHEMERAL]);
    assert.match(it.calls[0][1].content, /went wrong/i);
});

test('reportInteractionFailure: deferred but unanswered → editReply() fills the pending message', async () => {
    const it = makeInteraction({ commandName: 'summary' });
    await it.deferReply({ flags: [H.EPHEMERAL] });
    it.calls.length = 0;

    await H.reportInteractionFailure(it, new Error('boom'));
    assert.deepEqual(methods(it), ['editReply'], 'reply() here would throw InteractionAlreadyReplied');
});

test('reportInteractionFailure: already replied → followUp()', async () => {
    const it = makeInteraction();
    await it.reply({ content: 'first' });
    it.calls.length = 0;

    await H.reportInteractionFailure(it, new Error('boom'));
    assert.deepEqual(methods(it), ['followUp'], 'reply() here would throw InteractionAlreadyReplied');
});

test('reportInteractionFailure: deferred AND already edited → followUp()', async () => {
    const it = makeInteraction({ commandName: 'solve' });
    await it.deferReply({});
    await it.editReply({ content: 'partial result' });
    assert.equal(it.deferred, true);
    assert.equal(it.replied, true);
    it.calls.length = 0;

    await H.reportInteractionFailure(it, new Error('boom'));
    assert.deepEqual(methods(it), ['followUp'], 'must not clobber the real reply with editReply');
});

test('reportInteractionFailure: a failed showModal still gets a visible error (the /editrole bug)', async () => {
    // Reproduces the reported outage: showModal() rejects with 50035 before the
    // interaction is ever acknowledged. discord.js leaves replied=false, so the
    // guard must open the response with reply() — otherwise the user just sees
    // "The application did not respond".
    const it = makeInteraction({
        commandName: 'editrole',
        async showModal() { throw apiError(50035, 'Invalid Form Body: label Must be between 1 and 45 in length'); },
    });

    let thrown = null;
    try { await it.showModal({}); } catch (e) { thrown = e; }
    assert.ok(thrown, 'showModal should have rejected');
    assert.equal(it.replied, false, 'a rejected showModal must leave the interaction unacknowledged');

    await H.reportInteractionFailure(it, thrown);
    assert.deepEqual(methods(it), ['reply']);
    assert.match(it.calls[0][1].content, /went wrong/i);
});

test('reportInteractionFailure: expired interactions stay silent', async () => {
    for (const code of H.EXPIRED_INTERACTION_CODES) {
        const it = makeInteraction();
        await H.reportInteractionFailure(it, apiError(code, 'expired'));
        assert.deepEqual(methods(it), [], `code ${code} should be dropped quietly`);
    }
});

test('reportInteractionFailure: never throws, even when delivery itself fails', async () => {
    const it = makeInteraction({ async reply() { throw apiError(10062, 'Unknown interaction'); } });
    await H.reportInteractionFailure(it, new Error('boom')); // must resolve

    const hostile = makeInteraction({ async reply() { throw new Error('network down'); } });
    await H.reportInteractionFailure(hostile, new Error('boom')); // must resolve
});

test('reportInteractionFailure: ignores autocomplete interactions', async () => {
    const it = makeInteraction({ isAutocomplete: () => true });
    await H.reportInteractionFailure(it, new Error('boom'));
    assert.deepEqual(methods(it), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Per-user queue
// ═════════════════════════════════════════════════════════════════════════════

test('enqueueUserCommand: serializes commands from the same user', async () => {
    const order = [];
    const slow = async () => { order.push('a:start'); await new Promise(r => setTimeout(r, 20)); order.push('a:end'); };
    const fast = async () => { order.push('b:start'); order.push('b:end'); };

    const p1 = H.enqueueUserCommand('u1', slow);
    const p2 = H.enqueueUserCommand('u1', fast);
    await Promise.all([p1, p2]);

    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('enqueueUserCommand: a throwing command does not produce an unhandled rejection', async () => {
    // Regression guard: the cleanup used to hang off `next.finally(...)`, which
    // returns a NEW promise that rejects whenever `next` does. Nothing handled
    // it, so one throwing command took the whole process down on Node 18+.
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        await H.enqueueUserCommand('u-throw', async () => { throw new Error('boom'); }).catch(() => {});
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(seen, [], 'a failing command must not emit an unhandled rejection');
});

test('enqueueUserCommand: a failed command does not block the next one', async () => {
    await H.enqueueUserCommand('u2', async () => { throw new Error('first fails'); }).catch(() => {});
    const result = await H.enqueueUserCommand('u2', async () => 'second ran');
    assert.equal(result, 'second ran');
});

test('enqueueUserCommand: drains its queue entry once idle', async () => {
    await H.enqueueUserCommand('u3', async () => 'ok');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(H.userCommandQueue.has('u3'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Modal label limit — the actual root cause
// ═════════════════════════════════════════════════════════════════════════════

test('clampModalLabel: truncates labels past Discord\'s 45-char cap', () => {
    assert.equal(H.MODAL_LABEL_MAX, 45);
    const short = 'Role Name';
    assert.equal(H.clampModalLabel(short), short);

    const exact = 'x'.repeat(45);
    assert.equal(H.clampModalLabel(exact), exact);

    const long = 'Secondary Color for gradient (hex, "none" = remove)';
    assert.equal(long.length, 51);
    assert.equal(H.clampModalLabel(long).length, 45);

    assert.equal(H.clampModalLabel(undefined), undefined);
});

test('every modal label in index.js is within Discord\'s 45-char limit', () => {
    // The /editrole outage was a single 51-char label: showModal() rejected with
    // 50035 before acknowledging, so Discord showed "The application did not
    // respond". This walks the real source so it cannot regress unnoticed.
    const re = /setLabel\(\s*(?:clampModalLabel\(\s*)?(['"`])((?:[^\\]|\\.)*?)\1/g;
    const offenders = [];
    let m, count = 0;
    while ((m = re.exec(INDEX_SRC)) !== null) {
        count++;
        const label = m[2];
        if (label.length > 45) offenders.push(`${label} (${label.length} chars)`);
    }
    assert.ok(count > 0, 'expected to find setLabel() calls in index.js');
    assert.deepEqual(offenders, [], `modal/button labels over 45 chars: ${offenders.join(', ')}`);
});
