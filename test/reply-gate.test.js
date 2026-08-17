'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldReplyInThread } = require('../lib/reply-gate');

const OP = 'op-user';
const HELPER = 'helper-user';

// Convenience: a thread where only the OP has spoken.
const base = { authorId: OP, opId: OP, recentHumanAuthorIds: [], content: 'my sword renders wrong, any idea why?' };

test('answers the thread author asking a follow-up', () => {
    const r = shouldReplyInThread(base);
    assert.equal(r.reply, true, r.reason);
});

test('stays out of a conversation between two members', () => {
    // The exact complaint: two people talking, Shubba answering every line.
    const r = shouldReplyInThread({
        ...base,
        authorId: HELPER,
        recentHumanAuthorIds: [OP, HELPER, OP],
        content: 'try turning off your resource pack first',
    });
    assert.equal(r.reply, false, 'should not interject');
});

test('a helper answering the OP is left alone', () => {
    const r = shouldReplyInThread({
        ...base,
        authorId: HELPER,
        content: 'thats a known issue with 26.1, use the F8 menu',
    });
    assert.equal(r.reply, false);
    assert.match(r.reason, /not the thread author/i);
});

test('does not reply when someone replies to another member', () => {
    const r = shouldReplyInThread({ ...base, isReplyToOtherUser: true });
    assert.equal(r.reply, false);
    assert.match(r.reason, /another member/i);
});

test('does not reply when the message addresses another member', () => {
    const r = shouldReplyInThread({ ...base, mentionsOtherHumans: true });
    assert.equal(r.reply, false);
});

// The escape hatches — being quiet must never mean being unreachable.
test('an explicit @mention always wins, even mid-conversation', () => {
    const r = shouldReplyInThread({
        ...base,
        isMentioned: true,
        authorId: HELPER,
        mentionsOtherHumans: true,
        isReplyToOtherUser: true,
        recentHumanAuthorIds: [OP, HELPER],
    });
    assert.equal(r.reply, true, 'a direct mention must always get through');
});

test('replying to Shubba always gets an answer', () => {
    const r = shouldReplyInThread({
        ...base,
        authorId: HELPER,
        isReplyToShubba: true,
        recentHumanAuthorIds: [OP, HELPER],
    });
    assert.equal(r.reply, true);
});

test('the OP continuing after Shubba spoke still gets answered', () => {
    // Shubba answered, OP follows up. Nobody else involved — keep helping.
    const r = shouldReplyInThread({
        ...base,
        recentHumanAuthorIds: [OP],
        lastResponderWasShubba: true,
        content: 'that didnt work, the arm is still floating',
    });
    assert.equal(r.reply, true, r.reason);
});

test('bare acknowledgements get no reply', () => {
    for (const content of ['thanks', 'ty', 'ok', 'nice', 'got it', 'it works', 'lol', '👍']) {
        const r = shouldReplyInThread({ ...base, content });
        assert.equal(r.reply, false, `"${content}" should not trigger a reply`);
    }
});

test('"thanks, but how do I do X?" is still a question', () => {
    const r = shouldReplyInThread({ ...base, content: 'thanks! but how do I apply that to every sword?' });
    assert.equal(r.reply, true, r.reason);
});

test('very short chatter is ignored, short questions are not', () => {
    assert.equal(shouldReplyInThread({ ...base, content: 'hmm' }).reply, false);
    assert.equal(shouldReplyInThread({ ...base, content: 'why?' }).reply, true);
});

test('an attachment from the OP is always worth a look', () => {
    // A screenshot or log with no text is a real support signal.
    const r = shouldReplyInThread({ ...base, content: '', hasAttachments: true });
    assert.equal(r.reply, true, r.reason);
});

test('every decision comes with a reason for the logs', () => {
    for (const args of [base, { ...base, content: 'ok' }, { ...base, isMentioned: true }]) {
        const r = shouldReplyInThread(args);
        assert.equal(typeof r.reason, 'string');
        assert.ok(r.reason.length > 0, 'reason must be logged so behaviour is debuggable');
    }
});

test('missing opId does not silence the bot', () => {
    // Older threads may have no remembered OP; fail open rather than go mute.
    const r = shouldReplyInThread({ authorId: HELPER, content: 'how do I fix the bow animation?' });
    assert.equal(r.reply, true, r.reason);
});
