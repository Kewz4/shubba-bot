/**
 * reply-gate.js — decides whether Shubba should answer a message in a thread.
 *
 * The problem this fixes: in an active thread Shubba replied to EVERY message.
 * When two members talked to each other — someone helping the OP, or the OP
 * thanking them — Shubba answered each line as if it had been asked. That is
 * noisy, it buries the real answer, and it makes the bot feel oblivious.
 *
 * The rule of thumb encoded here: reply when you are ADDRESSED, or when the
 * person who opened the thread is still talking to you and nobody else has
 * joined in. Otherwise stay quiet — a human conversation does not need a
 * third participant.
 *
 * Pure and dependency-free so the decision is unit-testable; index.js supplies
 * the Discord facts.
 */

'use strict';

/** Short acknowledgements that never need an answer from anyone. */
const ACK_PATTERN = /^(ok(ay)?|k|kk|ty|thanks?|thx|thank you|ye(a|ah|p|s)?|no?pe?|lol|lmao|xd|nice|cool|got it|gotcha|fixed|works?|it works|perfect|great|alr(ight)?|sure|np|:\)|👍|❤️|🙏)\b[\s!.…]*$/i;

/**
 * @param {object} o
 * @param {boolean} o.isMentioned         Shubba was @mentioned explicitly
 * @param {boolean} o.isReplyToShubba     Discord reply pointing at a Shubba message
 * @param {boolean} o.isReplyToOtherUser  Discord reply pointing at another human
 * @param {boolean} o.mentionsOtherHumans message @mentions a human who isn't Shubba
 * @param {string}  o.authorId
 * @param {string} [o.opId]               author of the thread's starter post
 * @param {string[]} [o.recentHumanAuthorIds] author ids of recent human messages,
 *                                        newest first, excluding this one
 * @param {boolean} [o.lastResponderWasShubba] Shubba sent the previous message
 * @param {string} [o.content]
 * @param {boolean} [o.hasAttachments]
 * @returns {{reply: boolean, reason: string}}
 */
function shouldReplyInThread({
    isMentioned = false,
    isReplyToShubba = false,
    isReplyToOtherUser = false,
    mentionsOtherHumans = false,
    authorId,
    opId,
    recentHumanAuthorIds = [],
    lastResponderWasShubba = false,
    content = '',
    hasAttachments = false,
} = {}) {
    const text = String(content || '').trim();

    // 1. Explicitly addressed always wins, even mid-conversation.
    if (isMentioned) return { reply: true, reason: 'directly mentioned' };
    if (isReplyToShubba) return { reply: true, reason: 'replying to Shubba' };

    // 2. Clearly aimed at someone else.
    if (isReplyToOtherUser) return { reply: false, reason: 'replying to another member' };
    if (mentionsOtherHumans) return { reply: false, reason: 'addressed to another member' };

    // 3. Someone other than the thread author is talking. In a support forum
    //    that is almost always a helper answering the OP, not a question for us.
    if (opId && authorId && authorId !== opId) {
        return { reply: false, reason: 'not the thread author — likely helping the OP' };
    }

    // 4. Another member has joined in recently and Shubba was not the last to
    //    speak → a human conversation is underway. Stay out of it.
    const others = recentHumanAuthorIds.filter(id => id && id !== authorId);
    if (others.length > 0 && !lastResponderWasShubba) {
        return { reply: false, reason: 'conversation in progress between members' };
    }

    // 5. Bare acknowledgements need no answer, whoever they are for.
    if (!hasAttachments && ACK_PATTERN.test(text)) {
        return { reply: false, reason: 'acknowledgement, not a question' };
    }

    // 6. Very short and not a question — usually chatter.
    if (!hasAttachments && text.length < 12 && !text.includes('?')) {
        return { reply: false, reason: 'too short to be a question' };
    }

    // 7. The thread author, still talking, nobody else involved → answer.
    return { reply: true, reason: 'thread author follow-up' };
}

module.exports = { shouldReplyInThread, ACK_PATTERN };
