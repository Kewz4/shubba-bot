/**
 * mention-policy.js — decides whether Shubba may answer an @mention in a normal
 * text channel.
 *
 * Why this exists:
 *   Shubba answered in forum channels only. In #🤖│commands, "@Shubba hello"
 *   (2026-08-05) and "@Shubba how to get the blur effect brilliant in swords"
 *   (2026-07-15) both got NO reply, while #💬│general-en carried a constant
 *   stream of support questions answered entirely by volunteers.
 *
 *   Opening up text channels is easy; opening them up SAFELY is the actual work.
 *   Shubba must not become a chat participant — it answers only when explicitly
 *   summoned, never in the honeypot or staff channels, and never fast enough to
 *   be used as a Gemini-quota faucet by one user.
 *
 * The gate is pure logic over a plain context object (no discord.js types) with
 * an injectable clock, so every branch is unit-testable with no network and no
 * Discord client — see test/mention-policy.test.js.
 */

'use strict';

/** Channel kinds the gate understands. Only 'text' is eligible here; forum
 *  threads keep their own long-standing handling path upstream. */
const ELIGIBLE_CHANNEL_KINDS = new Set(['text']);

/**
 * @param {object} [cfg]
 * @param {function} [cfg.now]              () => epoch ms. Injectable clock.
 * @param {string[]} [cfg.excludedChannelIds] Channels Shubba must never answer in
 *        (honeypot, dev/staff, announcement-style channels).
 * @param {number}   [cfg.cooldownMs]       Min gap between answers to the SAME
 *        user (default 15s) — stops one person chain-pinging.
 * @param {number}   [cfg.maxPerWindow]     Max answers per user per window (default 5).
 * @param {number}   [cfg.windowMs]         Rolling window length (default 10 min).
 */
function createMentionGate(cfg) {
    const {
        now = Date.now,
        excludedChannelIds = [],
        cooldownMs = 15 * 1000,
        maxPerWindow = 5,
        windowMs = 10 * 60 * 1000,
    } = cfg || {};

    const excluded = new Set(excludedChannelIds.filter(Boolean).map(String));
    /** authorId → array of epoch-ms timestamps of answers we actually sent. */
    const recent = new Map();

    /** Drop timestamps that have aged out of the rolling window. */
    function prune(authorId, t) {
        const hits = (recent.get(authorId) || []).filter((ts) => t - ts < windowMs);
        if (hits.length) recent.set(authorId, hits);
        else recent.delete(authorId);
        return hits;
    }

    /**
     * Decide whether to answer. Records the answer when it returns allowed:true,
     * so the caller cannot forget to (a miss there would defeat the rate limit).
     *
     * @param {object} ctx
     * @param {string} ctx.channelId
     * @param {string} ctx.channelKind    'text' | 'thread' | 'forum' | 'dm' | ...
     * @param {string} ctx.authorId
     * @param {boolean} ctx.isBot         Author is any bot.
     * @param {boolean} ctx.isSelf        Author is Shubba itself.
     * @param {boolean} ctx.mentionsBot   Shubba was explicitly mentioned.
     * @param {boolean} ctx.mentionsEveryone  @everyone / @here was used.
     * @returns {{allowed: boolean, reason: string}}
     */
    function shouldAnswer(ctx) {
        const c = ctx || {};

        // Order matters: cheapest and most absolute rejections first, and the
        // rate limit LAST so a rejected message never consumes a user's budget.
        if (c.isSelf) return { allowed: false, reason: 'self' };
        if (c.isBot) return { allowed: false, reason: 'bot' };

        // Explicit summon only. An @everyone that happens to include Shubba is
        // not a summon — otherwise every announcement ping triggers an answer.
        if (c.mentionsEveryone) return { allowed: false, reason: 'everyone-mention' };
        if (!c.mentionsBot) return { allowed: false, reason: 'no-mention' };

        if (!ELIGIBLE_CHANNEL_KINDS.has(c.channelKind)) {
            return { allowed: false, reason: 'not-text-channel' };
        }
        if (excluded.has(String(c.channelId))) {
            return { allowed: false, reason: 'excluded-channel' };
        }

        const t = now();
        const hits = prune(c.authorId, t);

        if (hits.length && t - hits[hits.length - 1] < cooldownMs) {
            return { allowed: false, reason: 'cooldown' };
        }
        if (hits.length >= maxPerWindow) {
            return { allowed: false, reason: 'rate-limited' };
        }

        hits.push(t);
        recent.set(c.authorId, hits);
        return { allowed: true, reason: 'ok' };
    }

    return { shouldAnswer, _recent: recent, _excluded: excluded };
}

/**
 * Map a discord.js channel to the coarse kind the gate uses.
 * Kept here (rather than inline in index.js) so the mapping is testable and the
 * gate itself stays free of discord.js imports.
 *
 * @param {object} channel  A discord.js channel-like object.
 * @param {object} types    The discord.js ChannelType enum.
 */
function channelKindOf(channel, types) {
    if (!channel) return 'unknown';
    if (typeof channel.isThread === 'function' && channel.isThread()) return 'thread';
    if (!types) return 'unknown';
    switch (channel.type) {
        case types.GuildText:      return 'text';
        case types.GuildForum:     return 'forum';
        case types.GuildAnnouncement: return 'announcement';
        case types.DM:             return 'dm';
        default:                   return 'other';
    }
}

module.exports = {
    createMentionGate,
    channelKindOf,
    ELIGIBLE_CHANNEL_KINDS,
};
