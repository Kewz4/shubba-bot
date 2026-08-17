'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// splitMessage lives in index.js, which can't be require()'d (it logs into
// Discord on import). Lift it out so these assertions test shipping code.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function loadSplit() {
    const start = SRC.indexOf('function splitMessage(');
    assert.ok(start !== -1, 'index.js no longer defines splitMessage');
    const end = SRC.indexOf('\n}', start);
    assert.ok(end > start, 'could not find the end of splitMessage');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(SRC.slice(start, end + 2), sandbox);
    return sandbox.splitMessage;
}
const split = loadSplit();

const fenceCount = (s) => (s.match(/^[ \t]*```/gm) || []).length;
const balanced = (s) => fenceCount(s) % 2 === 0;

test('short messages pass through as one chunk', () => {
    const chunks = split('just a short answer');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'just a short answer');
});

test('every chunk stays within the limit', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of the answer`).join('\n');
    for (const c of split(text, 1900)) {
        assert.ok(c.length <= 1900, `chunk of ${c.length} chars exceeds the limit`);
    }
});

test('a code fence spanning the split is closed and reopened — the real bug', () => {
    // A JSON block straddling the boundary used to leave chunk 1 with an
    // unclosed fence, so Discord rendered everything after it as code.
    const filler = Array.from({ length: 120 }, (_, i) => `explanation line ${i}`).join('\n');
    const json = Array.from({ length: 120 }, (_, i) => `  "key${i}": "value${i}",`).join('\n');
    const text = `${filler}\n\`\`\`json\n{\n${json}\n}\n\`\`\`\ntrailing note`;

    const chunks = split(text, 1900);
    assert.ok(chunks.length > 1, 'test needs a multi-chunk input');
    chunks.forEach((c, i) => {
        assert.ok(balanced(c), `chunk ${i + 1} has an unbalanced code fence`);
    });
});

test('the reopened fence keeps its language tag', () => {
    const json = Array.from({ length: 200 }, (_, i) => `  "k${i}": ${i},`).join('\n');
    const chunks = split(`\`\`\`json\n${json}\n\`\`\``, 1900);
    assert.ok(chunks.length > 1);
    assert.match(chunks[1], /^```json/, 'continuation should reopen as ```json');
});

test('a single line longer than the limit still splits', () => {
    const chunks = split('word '.repeat(1200), 1900);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 1900);
});

test('no empty chunks are ever produced', () => {
    // Discord rejects an empty message outright.
    for (const input of ['\n\n\n', 'a\n\n\n\nb', '   ', '']) {
        for (const c of split(input, 50)) {
            assert.ok(c.trim().length > 0, `empty chunk from ${JSON.stringify(input)}`);
        }
    }
});

test('content is preserved across chunks', () => {
    const text = Array.from({ length: 300 }, (_, i) => `sentence number ${i}`).join('\n');
    const rejoined = split(text, 1900).join('\n');
    // Every original line must survive somewhere.
    for (const line of text.split('\n')) {
        assert.ok(rejoined.includes(line), `lost line: ${line}`);
    }
});

test('handles a message that is entirely one code block', () => {
    const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const chunks = split(`\`\`\`\n${body}\n\`\`\``, 1900);
    chunks.forEach((c, i) => assert.ok(balanced(c), `chunk ${i + 1} unbalanced`));
});

test('default limit leaves headroom for post-split decoration', () => {
    // Call sites prepend headers and append version warnings to chunks[0].
    // The default must stay far enough under Discord's 2000 that decorating
    // cannot push a send over the cap.
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const first = split(long)[0];
    assert.ok(first.length <= 1750, `default chunk was ${first.length} chars`);

    const decorated = `📊 **Deep Technical Analysis Report**\n\n${first}\n\n⚠️ You are on an outdated version, please update to the latest build before reporting.`;
    assert.ok(decorated.length < 2000,
        `decorated first chunk would be ${decorated.length} chars — Discord rejects over 2000`);
});

test('the Discord formatting rules are stated in the prompt', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wiki-prompt.js'), 'utf8');
    assert.match(prompt, /does NOT support ####/i, 'must warn that #### is not supported');
    assert.match(prompt, /NEVER use markdown tables/i, 'must ban tables — Discord cannot render them');
    assert.match(prompt, /always close the\s*\n?\s*fence/i, 'must require closing code fences');
});
