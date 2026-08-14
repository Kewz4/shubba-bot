'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    GROUNDING_RULES,
    buildLanguageDirective,
    buildAnswerPolicy,
} = require('../lib/answer-policy');

// These are prompt strings, so there is no behaviour to execute. What CAN
// regress is someone trimming the prompt for token budget and quietly deleting
// a rule that exists because of a real, expensive failure. Each assertion below
// is anchored to one of those failures so the deletion fails loudly instead.

test('grounding rules cover the conversation-consistency failures', () => {
    const r = GROUNDING_RULES;
    // Thread 1537271088868892680: user said they had only the default pack.
    assert.match(r, /correction is authoritative fact/i,
        'lost the rule that a user reporting their own setup is ground truth');
    // Shubba contradicted its own first answer without acknowledging it.
    assert.match(r, /never contradict your own earlier claim/i,
        'lost the self-contradiction rule');
    // It re-suggested view bobbing after the user said it changed nothing.
    assert.match(r, /never re-suggest a remedy the user already tried/i,
        'lost the spent-remedy rule');
    // It invented "built-in default item animations".
    assert.match(r, /do not invent mechanisms/i,
        'lost the invented-mechanism rule');
    // Escalation must be framed as acceptable, or the model keeps guessing.
    assert.match(r, /i'm not sure.*acceptable answer/i,
        'lost the permission-to-not-know rule');
});

test('grounding rules cover the config-synthesis failure (the bow case)', () => {
    const r = GROUNDING_RULES;
    // The distinct failure: every token real, the claim unsourced.
    assert.match(r, /do not author config the documentation does not demonstrate/i,
        'lost the do-not-author-config rule');
    assert.match(r, /documented capability is not a documented outcome/i,
        'lost the capability-vs-outcome rule');
    assert.match(r, /docs don't cover this/i,
        'lost the "not documented" escape hatch');
    assert.match(r, /cite the specific source/i,
        'lost the citation rule');
});

test('the bow failure is described concretely, not abstractly', () => {
    // A generic "be accurate" instruction does not move a model off a confident
    // wrong answer. The concrete incident is the load-bearing part.
    assert.match(GROUNDING_RULES, /useItem/,
        'the specific wrong animation type should be named');
    assert.match(GROUNDING_RULES, /use_bow/,
        'the correct animation type should be named');
    assert.match(GROUNDING_RULES, /recombined|recombining/i,
        'must explain that recombining real fields is still invention');
});

test('rules are numbered contiguously from 1', () => {
    // Some rules open with a quoted phrase ("I'M NOT SURE" ...), so allow a
    // leading quote as well as a capital.
    const nums = [...GROUNDING_RULES.matchAll(/^(\d+)\. ["A-Z]/gm)].map(m => Number(m[1]));
    assert.ok(nums.length >= 10, `expected at least 10 numbered rules, found ${nums.length}`);
    nums.forEach((n, i) => assert.equal(n, i + 1,
        `rule numbering breaks at position ${i + 1} (found ${n}) — renumber after editing`));
});

test('language directive names a detected language explicitly', () => {
    const d = buildLanguageDirective({ name: 'Russian', nativeName: 'Русский' });
    assert.match(d, /Russian/);
    assert.match(d, /Русский/);
    assert.match(d, /reply in that language/i);
});

test('language directive still works with no detected language', () => {
    // Unlisted languages only work because of the mirror-the-user fallback.
    const d = buildLanguageDirective();
    assert.match(d, /SAME language the user wrote in/i);
    assert.doesNotMatch(d, /detected as/i,
        'should not claim a detection that did not happen');
});

test('language directive protects identifiers from translation', () => {
    // Translating "F3 + T" or a ToolKind would produce unusable instructions.
    assert.match(buildLanguageDirective(), /verbatim/i);
});

test('language directive forbids answering in English by default', () => {
    // The knowledge base and these very rules are English; without this the
    // model mirrors the prompt language instead of the user's.
    assert.match(buildLanguageDirective(), /do NOT answer in English just because/i);
});

test('buildAnswerPolicy composes both blocks', () => {
    const p = buildAnswerPolicy({ langInfo: { name: 'Portuguese' } });
    assert.ok(p.includes(GROUNDING_RULES), 'grounding rules missing from policy');
    assert.match(p, /Portuguese/);
});

test('buildAnswerPolicy tolerates being called with nothing', () => {
    assert.doesNotThrow(() => buildAnswerPolicy());
    assert.ok(buildAnswerPolicy().includes(GROUNDING_RULES));
});
