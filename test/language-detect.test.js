'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// detectLanguage lives in index.js, which cannot be require()'d (it logs into
// Discord on import). Lift the function out and run it in a sandbox so these
// assertions test the code that actually ships.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function loadDetect() {
    const start = SRC.indexOf('function detectLanguage(');
    assert.ok(start !== -1, 'index.js no longer defines detectLanguage');
    const end = SRC.indexOf('\n}', start);
    assert.ok(end > start, 'could not find the end of detectLanguage');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(SRC.slice(start, end + 2), sandbox);
    return sandbox.detectLanguage;
}
const detect = loadDetect();

// The regression that prompted this: a plain English question was answered in
// Portuguese because English was never scored, only used as a fallback.
test('English questions are not misdetected as another language', () => {
    const english = [
        'how do I do sword smear frames?',
        'no animations showing up',
        'my sword is in a weird position',
        'the mod does not work',
        'I have an error with my pack',
        'can you help me with this problem',
        'how do I disable the bow charging animation',
        'what does this flag do in the compat file',
    ];
    for (const q of english) {
        assert.equal(detect(q), 'EN-US', `"${q}" should be English`);
    }
});

test('real non-English questions still detect correctly', () => {
    // Actual phrasing seen in the Punchy Discord.
    assert.equal(detect('есть русские? помощь нужна'), 'RU-RU');
    assert.equal(detect('Dónde puedo escribir sobre errores o bugs?'), 'ES-ES');
    assert.equal(detect('如何禁用弓的拉弓动画'), 'ZH-CN');
});

test('Portuguese is still detected when it really is Portuguese', () => {
    assert.equal(detect('como eu faço para desativar a animação do arco com um problema no meu pack'), 'PT-BR');
});

test('script detection wins immediately, before keyword scoring', () => {
    // Cyrillic/CJK are unambiguous; an English loanword must not override them.
    assert.equal(detect('помощь с animation mod'), 'RU-RU');
    assert.equal(detect('animation 问题'), 'ZH-CN');
});

test('ties go to English', () => {
    // "do" is in both the English and Portuguese lists on purpose. Shared
    // tokens are evidence of nothing, so a tie must not hand the answer over.
    assert.equal(detect('do do'), 'EN-US');
});

test('short or contentless input falls back to English', () => {
    for (const q of ['', 'hi', '???', 'F8']) {
        assert.equal(detect(q), 'EN-US', `"${q}" should fall back to English`);
    }
});

test('no single-letter keywords remain in the scoring lists', () => {
    // 'o', 'e', 'y', 'a' collide with English constantly and carry no signal.
    const block = SRC.slice(SRC.indexOf('const languageKeywords = {'), SRC.indexOf('const scores = {}'));
    const singles = [...block.matchAll(/'([a-zà-ú])'/g)].map(m => m[1]);
    assert.deepEqual(singles, [], `single-letter keywords still present: ${singles.join(', ')}`);
});
