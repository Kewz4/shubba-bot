/**
 * discord-format.js — how Shubba's messages are shaped for Discord.
 *
 * Two jobs:
 *   1. splitMessage — cut long text into sendable pieces WITHOUT breaking code
 *      fences. Lives here (not index.js) so it has one definition and tests.
 *   2. Embed builders — a small house style so notices and answers look like
 *      they came from the same bot instead of ad-hoc strings.
 *
 * Why embeds at all: a plain message caps at 2000 characters, so a normal
 * support answer got chopped into 2-3 messages. An embed description holds
 * 4096, which means most answers arrive as ONE message with a coloured spine,
 * and the citation sits in its own footer instead of competing with the text.
 */

'use strict';

// Discord's own limits. Exceed any of these and the API rejects the send.
const LIMITS = {
    MESSAGE: 2000,
    EMBED_DESCRIPTION: 4096,
    EMBED_TITLE: 256,
    EMBED_FOOTER: 2048,
    EMBED_TOTAL: 6000,
    EMBEDS_PER_MESSAGE: 10,
};

// One palette, so colour means something consistent.
const COLORS = {
    ANSWER: 0xE69A09,   // Punchy amber — normal answers
    SOLVED: 0x3DD68C,   // green — resolved / archived
    ESCALATE: 0xF7706E, // red — needs a human
    INFO: 0x5A5A72,     // muted — neutral notices
    WARN: 0xCBBE55,     // amber-gold — warnings
};

/**
 * Split text into chunks that never exceed `limit` and never leave a code fence
 * open. A fence still open at a cut is closed on the way out and reopened with
 * its original language tag on the way in, so each chunk renders correctly
 * standing alone.
 */
function splitMessage(text, limit = 1750) {
    const chunks = [];
    let current = String(text ?? '');
    let carryFence = null;

    const fenceState = (s, startOpen) => {
        let open = startOpen;
        for (const m of s.matchAll(/^[ \t]*```([A-Za-z0-9_+-]*)[ \t]*$/gm)) {
            open = open ? null : '```' + (m[1] || '');
        }
        return open;
    };

    while (current.length > 0) {
        const prefix = carryFence ? carryFence + '\n' : '';
        const budget = limit - prefix.length - 4;

        if (prefix.length + current.length <= limit) {
            chunks.push(prefix + current);
            break;
        }

        let splitIndex = current.lastIndexOf('\n', budget);
        if (splitIndex <= 0) {
            splitIndex = current.lastIndexOf(' ', budget);
            if (splitIndex <= 0) splitIndex = budget;
        }

        let piece = current.substring(0, splitIndex);
        const stillOpen = fenceState(piece, carryFence);
        if (stillOpen) piece += '\n```';
        chunks.push(prefix + piece);
        carryFence = stillOpen;

        current = current.substring(splitIndex).replace(/^\n+/, '');
        if (!current.trim()) break;
    }

    return chunks.filter(c => c.trim().length > 0);
}

const clamp = (s, max) => {
    const str = String(s ?? '');
    return str.length <= max ? str : str.slice(0, max - 1) + '…';
};

/**
 * Turn an answer into one or more embed payloads.
 *
 * Most answers fit in a single embed. Only the title and footer appear on the
 * first and last respectively, so a split answer still reads as one unit
 * rather than repeating its header three times.
 *
 * @returns {Array<object>} plain embed objects (JSON), safe for .send({ embeds })
 */
function answerEmbeds(text, { title, color = COLORS.ANSWER, footer, url } = {}) {
    const parts = splitMessage(text, LIMITS.EMBED_DESCRIPTION - 100);
    const total = parts.length || 1;

    return parts.map((description, i) => {
        const embed = { color, description };
        if (i === 0 && title) {
            embed.title = clamp(title, LIMITS.EMBED_TITLE);
            if (url) embed.url = url;
        }
        if (i === total - 1) {
            const suffix = total > 1 ? ` · part ${i + 1}/${total}` : '';
            if (footer || suffix) {
                embed.footer = { text: clamp((footer || 'Punchy! Wiki') + suffix, LIMITS.EMBED_FOOTER) };
            }
        } else {
            embed.footer = { text: `part ${i + 1}/${total} — continued below` };
        }
        return embed;
    });
}

/**
 * A short, coloured notice: escalation, resolution, warning.
 * `fields` is [{ name, value, inline? }] and is trimmed to Discord's caps.
 */
function noticeEmbed({ title, description, color = COLORS.INFO, fields = [], footer }) {
    const embed = { color };
    if (title) embed.title = clamp(title, LIMITS.EMBED_TITLE);
    if (description) embed.description = clamp(description, LIMITS.EMBED_DESCRIPTION);
    if (fields.length) {
        embed.fields = fields.slice(0, 25).map(f => ({
            name: clamp(f.name, 256),
            value: clamp(f.value, 1024),
            inline: !!f.inline,
        }));
    }
    if (footer) embed.footer = { text: clamp(footer, LIMITS.EMBED_FOOTER) };
    return embed;
}

/**
 * Total rendered size of an embed, per Discord's accounting (title +
 * description + fields + footer). Over EMBED_TOTAL the send is rejected.
 */
function embedSize(embed) {
    let n = (embed.title || '').length + (embed.description || '').length;
    for (const f of embed.fields || []) n += (f.name || '').length + (f.value || '').length;
    n += (embed.footer?.text || '').length;
    return n;
}

module.exports = { LIMITS, COLORS, splitMessage, answerEmbeds, noticeEmbed, embedSize, clamp };
