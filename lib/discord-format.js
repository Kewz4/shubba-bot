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

// ─── Moderation log embeds ───────────────────────────────────────────────────
//
// Mod actions used to be plain-text interaction replies. An interaction reply is
// tied to the command invocation, easy to miss, and reads as private even when
// it isn't. A moderation action is a public record: it should be a real message
// in the channel, colour-coded, naming who did what to whom and why.

const MOD_ACTION_STYLE = {
    warn:      { title: '⚠️ Warning issued',      color: 0xF7C948 },
    warn2:     { title: '🔇 Second warning',      color: 0xE8951F },
    ban:       { title: '🔨 Member banned',       color: 0xF7706E },
    kick:      { title: '👢 Member kicked',       color: 0xE8951F },
    mute:      { title: '🔇 Member muted',        color: 0xE8951F },
    unmute:    { title: '🔊 Timeout removed',     color: 0x3DD68C },
    unban:     { title: '✅ Member unbanned',     color: 0x3DD68C },
    clearwarn: { title: '🧹 Warnings cleared',    color: 0x3DD68C },
};

/**
 * Build the public record of a moderation action.
 *
 * @param {object} o
 * @param {keyof MOD_ACTION_STYLE} o.action
 * @param {{id:string, tag:string}} o.target      who it was applied to
 * @param {{id:string, tag:string}} o.moderator   who did it
 * @param {string} [o.reason]
 * @param {Array<{name:string,value:string,inline?:boolean}>} [o.extra] duration, strike count, …
 */
function modActionEmbed({ action, target, moderator, reason, extra = [] }) {
    const style = MOD_ACTION_STYLE[action] || { title: 'Moderation action', color: COLORS.INFO };
    const fields = [
        { name: 'Member', value: target?.id ? `<@${target.id}>\n\`${target.tag || target.id}\`` : String(target?.tag || 'unknown'), inline: true },
        { name: 'Moderator', value: moderator?.id ? `<@${moderator.id}>` : String(moderator?.tag || 'unknown'), inline: true },
        ...extra,
        { name: 'Reason', value: clamp(reason || 'No reason provided', 1024), inline: false },
    ];
    return noticeEmbed({ title: style.title, color: style.color, fields, footer: `User ID: ${target?.id || 'unknown'}` });
}

module.exports.MOD_ACTION_STYLE = MOD_ACTION_STYLE;
module.exports.modActionEmbed = modActionEmbed;

// ─── Mention safety ──────────────────────────────────────────────────────────
//
// Shubba writes its own answers, and it will happily put "<@OWNER_ID>" in one.
// Observed in production: the model authored an escalation reading
//   "🚩 Human Help Requested!  Attention: @Godku @punchymod"
// which pinged both owners — without ever calling requestHumanHelp(). Every
// notify-tier safeguard was bypassed because the ping was just text in a reply.
//
// Discord decides what pings from allowed_mentions, NOT from the text. So the
// fix is to send with mentions disabled by default and opt in deliberately.

/** Nothing in this message pings, whatever the text says. */
const NO_MENTIONS = { parse: [] };

/**
 * Wrap a message payload so it cannot ping unless explicitly allowed.
 * @param {object|string} payload
 * @param {{users?:string[], roles?:string[], repliedUser?:boolean}} [allow]
 */
function noPing(payload, allow) {
    const base = typeof payload === 'string' ? { content: payload } : { ...payload };
    base.allowedMentions = allow
        ? { parse: [], users: allow.users || [], roles: allow.roles || [], repliedUser: !!allow.repliedUser }
        : NO_MENTIONS;
    return base;
}

/**
 * Strip mention SYNTAX from model-authored text, leaving readable names.
 * Belt and braces alongside noPing(): keeps "@Godku" out of the visible text so
 * users aren't misled into thinking a dev was summoned.
 */
function stripMentions(text) {
    return String(text ?? '')
        .replace(/<@!?(\d+)>/g, '@someone')
        .replace(/<@&(\d+)>/g, '@role')
        .replace(/@everyone/g, 'everyone')
        .replace(/@here/g, 'here');
}

module.exports.NO_MENTIONS = NO_MENTIONS;
module.exports.noPing = noPing;
module.exports.stripMentions = stripMentions;
