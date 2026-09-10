/**
 * human-request.js — detect a user plainly asking for a person.
 *
 * The "🙋 Request Human Help" button was removed at the owner's request, and
 * the prompt now tells Shubba that typing "request human help" is not a
 * command. That closed the ping, but it also closed the ONLY route a user had
 * to reach a person: asking got them more bot triage, and the transcripts show
 * exactly that — someone asked for a developer and received another round of
 * questions.
 *
 * Both things the owner asked for are satisfiable at once:
 *   • "he shouldn't let the user write request human help to ping"  → no ping.
 *   • "not zero, but ping only when certain"                        → still none here.
 * So a detected request flags the thread SILENTLY. Nobody's phone buzzes; the
 * thread is renamed and a no-ping record goes to the dev channel, where a human
 * will see it. The user is acknowledged instead of ignored.
 *
 * Pure and dependency-free so the matching is unit-testable.
 */

'use strict';

/**
 * Phrases that mean "I want a person", not "I have a question about people".
 *
 * Deliberately narrow. A false positive pulls a human into a thread Shubba
 * could have handled; a false negative just means the user says it again more
 * plainly. Erring toward the false negative is the cheaper mistake.
 */
const HUMAN_REQUEST_PATTERNS = [
    // Direct requests for a person, in the words people actually use.
    /\b(?:can|could|may)\s+(?:i|we)\s+(?:please\s+)?(?:get|have|talk\s+to|speak\s+(?:to|with))\s+(?:a|an|some)?\s*(?:real\s+)?(?:human|person|dev(?:eloper)?|mod(?:erator)?|staff|admin)\b/i,
    /\b(?:can|could|would)\s+(?:a|an|some)\s*(?:real\s+)?(?:human|person|dev(?:eloper)?|mod(?:erator)?|staff|admin)\s+(?:please\s+)?(?:look|check|take\s+a\s+look|help|reply|respond|see)\b/i,
    /\bi\s+(?:need|want|would\s+like)\s+(?:to\s+(?:talk|speak)\s+(?:to|with)\s+)?(?:a|an)\s+(?:real\s+)?(?:human|person|dev(?:eloper)?|mod(?:erator)?|staff|admin)\b/i,
    /\b(?:is|are)\s+(?:there\s+)?(?:a|any)\s+(?:real\s+)?(?:human|person|dev(?:eloper)?s?|mod(?:erator)?s?|staff|admin)\s+(?:here|around|available|online)\b/i,
    /\b(?:get|give|send)\s+me\s+(?:a|an)\s+(?:real\s+)?(?:human|person|dev(?:eloper)?|mod(?:erator)?|staff|admin)\b/i,
    /\brequest\s+human\s+help\b/i,
    /\b(?:human|real\s+person)\s+(?:help|support)\s+(?:please|pls)\b/i,
    // Frustration aimed squarely at the bot, which is the same request.
    /\b(?:stop|quit)\s+(?:the\s+)?(?:bot|ai)\b.*\b(?:human|person|dev)/i,
    /\bnot\s+(?:a\s+)?bot\b.*\b(?:human|person|dev(?:eloper)?)\b/i,
];

/**
 * Things that LOOK like a request but are not one.
 * Checked first, so a match here wins.
 */
const NOT_A_REQUEST = [
    // Talking about the mod's features, not asking for staff.
    /\bhuman(?:oid)?\s+(?:model|mob|entity|player\s+model|skin|animation)\b/i,
    // Reporting that someone already helped.
    /\b(?:a|the)\s+(?:dev|human|mod(?:erator)?)\s+(?:already\s+)?(?:helped|answered|replied|fixed|told)\b/i,
    // Quoting the old button while being told it is gone.
    /\bthere\s+is\s+no\s+.{0,20}request\s+human\s+help\b/i,
];

/**
 * Did this message plainly ask for a person?
 * @param {string} text
 * @returns {boolean}
 */
function isExplicitHumanRequest(text) {
    const s = String(text ?? '').trim();
    // Too short to be unambiguous, or so long the phrase is incidental to a
    // wall of technical detail Shubba should just answer.
    if (s.length < 6 || s.length > 600) return false;
    if (NOT_A_REQUEST.some(re => re.test(s))) return false;
    return HUMAN_REQUEST_PATTERNS.some(re => re.test(s));
}

/**
 * What Shubba says when it honours the request.
 *
 * It must NOT promise a ping — nobody is pinged — and it must not pretend the
 * thread is now someone's job within a set time. It says what actually happens.
 */
function humanRequestAcknowledgement() {
    return [
        "Understood — I've flagged this thread for the team, and I'll stop replying here.",
        '',
        'A human will pick it up from the flag. If anything changes in the meantime, '
        + 'just add it to this thread — they will read the whole thing.',
    ].join('\n');
}

module.exports = { isExplicitHumanRequest, humanRequestAcknowledgement, HUMAN_REQUEST_PATTERNS, NOT_A_REQUEST };
