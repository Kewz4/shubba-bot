'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// splitMessage now lives in lib/discord-format.js (one definition, importable),
// so these tests exercise it directly instead of lifting it out of index.js.
const { splitMessage: split, answerEmbeds, noticeEmbed, embedSize, LIMITS, COLORS } =
    require('../lib/discord-format');

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
    assert.match(prompt, /There is NO ####/i, 'must warn that #### is not supported');
    assert.match(prompt, /NEVER use markdown tables/i, 'must ban tables — Discord cannot render them');
    assert.match(prompt, /ALWAYS closed/i, 'must require closing code fences');
});

test('the house style is specified, not left to chance', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wiki-prompt.js'), 'utf8');
    // The answer-first rule is what makes replies scannable.
    assert.match(prompt, /FIRST LINE = THE ANSWER/i, 'must require answer-first');
    // Identifiers in backticks are what make them skimmable.
    assert.match(prompt, /ALWAYS wrap identifiers in/i, 'must require inline code for identifiers');
    // Subtext citations keep links from dominating the message.
    assert.match(prompt, /-# /, 'must teach the subtext prefix');
    assert.match(prompt, /masked links/i, 'must specify masked links for citations');
    // Padding is the main thing that made old answers hard to read.
    assert.match(prompt, /Great question|No .Great question/i, 'must ban filler openers');
});

// ─── Embed house style ───────────────────────────────────────────────────────

test('a normal answer becomes ONE embed, not three messages', () => {
    // The whole point: 4096 in an embed vs 2000 in a plain message.
    const answer = Array.from({ length: 90 }, (_, i) => `A line of explanation number ${i}.`).join('\n');
    assert.ok(answer.length > LIMITS.MESSAGE, 'test input must exceed the plain-message cap');
    // Would have been 2 plain messages; is 1 embed.
    assert.ok(split(answer).length > 1, 'this would have split as a plain message');
    assert.equal(answerEmbeds(answer, { title: 'Wiki Help', footer: 'Punchy! Wiki' }).length, 1,
        'an answer under 4k should fit a single embed');
});

test('embeds never exceed Discord limits', () => {
    const huge = Array.from({ length: 900 }, (_, i) => `line ${i} with some text`).join('\n');
    for (const e of answerEmbeds(huge, { title: 'T', footer: 'F' })) {
        assert.ok((e.description || '').length <= LIMITS.EMBED_DESCRIPTION, 'description too long');
        assert.ok((e.title || '').length <= LIMITS.EMBED_TITLE, 'title too long');
        assert.ok(embedSize(e) <= LIMITS.EMBED_TOTAL, `embed total ${embedSize(e)} exceeds cap`);
    }
});

test('a split answer reads as one unit, not a repeated header', () => {
    const huge = Array.from({ length: 900 }, (_, i) => `line ${i} with some text`).join('\n');
    const embeds = answerEmbeds(huge, { title: 'Wiki Help', footer: 'Punchy! Wiki' });
    assert.ok(embeds.length > 1, 'test needs a split');
    assert.ok(embeds[0].title, 'first embed should carry the title');
    for (const e of embeds.slice(1)) assert.equal(e.title, undefined, 'title repeated on a later embed');
    assert.match(embeds[embeds.length - 1].footer.text, /Punchy! Wiki/, 'citation belongs on the last embed');
});

test('code fences stay balanced inside embeds too', () => {
    const json = Array.from({ length: 400 }, (_, i) => `  "key${i}": "value${i}",`).join('\n');
    for (const e of answerEmbeds('intro\n```json\n{\n' + json + '\n}\n```\nafter')) {
        const fences = (e.description.match(/^[ \t]*```/gm) || []).length;
        assert.equal(fences % 2, 0, 'unbalanced fence inside an embed description');
    }
});

test('colour carries meaning consistently', () => {
    assert.equal(answerEmbeds('x')[0].color, COLORS.ANSWER);
    assert.equal(noticeEmbed({ title: 'Solved', color: COLORS.SOLVED }).color, COLORS.SOLVED);
    assert.notEqual(COLORS.ESCALATE, COLORS.SOLVED, 'escalation and solved must be distinguishable');
});

test('notice fields are clamped rather than rejected by the API', () => {
    const e = noticeEmbed({
        title: 'x'.repeat(400),
        description: 'y'.repeat(5000),
        fields: [{ name: 'n'.repeat(400), value: 'v'.repeat(2000) }],
        footer: 'f'.repeat(3000),
    });
    assert.ok(e.title.length <= LIMITS.EMBED_TITLE);
    assert.ok(e.description.length <= LIMITS.EMBED_DESCRIPTION);
    assert.ok(e.fields[0].name.length <= 256);
    assert.ok(e.fields[0].value.length <= 1024);
    assert.ok(e.footer.text.length <= LIMITS.EMBED_FOOTER);
});
