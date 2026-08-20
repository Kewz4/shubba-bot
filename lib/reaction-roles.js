/**
 * reaction-roles.js — matching and safety rules for reaction-granted roles.
 *
 * Two real leaks this closes:
 *
 * 1. SCOPE. The addon-forum 🔥 handler checked only "is this a message in an
 *    addon thread". It never checked WHICH message. So reacting 🔥 to any
 *    random comment inside an addon thread granted that addon's role. Only the
 *    thread's starter post should count — in a Discord forum the starter
 *    message id equals the thread id.
 *
 * 2. EMOJI MATCHING. Matching partly on `reaction.emoji.name` meant a custom
 *    emoji merely NAMED the same thing as a configured one matched. Custom
 *    emoji must be compared by id; unicode emoji by their character.
 *
 * Plus a guard that never existed: a misconfigured mapping could hand out a
 * privileged role to anyone who clicked an emoji. Roles carrying dangerous
 * permissions are refused outright.
 */

'use strict';

// Permission bits that must never be grantable by clicking an emoji.
// Values are Discord's documented permission flags.
const DANGEROUS_PERMISSIONS = {
    Administrator: 1n << 3n,
    ManageGuild: 1n << 5n,
    ManageChannels: 1n << 4n,
    ManageRoles: 1n << 28n,
    ManageWebhooks: 1n << 29n,
    ManageMessages: 1n << 13n,
    KickMembers: 1n << 1n,
    BanMembers: 1n << 2n,
    ModerateMembers: 1n << 40n,
    MentionEveryone: 1n << 17n,
};

/**
 * Is this reaction on the message that actually carries the mapping?
 * For forum threads the starter message id === the thread id.
 */
function isStarterMessage(messageId, threadId) {
    return Boolean(messageId) && messageId === threadId;
}

/**
 * Exact emoji comparison.
 * @param {string} configured  what the mapping stored ("🔥", "<:name:123>", or "123")
 * @param {{name?: string, id?: string|null}} emoji  the reaction's emoji
 */
function emojiMatches(configured, emoji) {
    if (!configured || !emoji) return false;
    const cfg = String(configured).trim();

    if (emoji.id) {
        // Custom emoji: identity is the id. Name collisions must NOT match.
        const m = cfg.match(/^<a?:[^:]+:(\d+)>$/);
        if (m) return m[1] === emoji.id;
        return cfg === emoji.id; // a bare id is also accepted
    }
    // Unicode emoji: compare the character itself, never a name.
    return cfg === emoji.name;
}

/**
 * Decide whether a role may be granted by reaction.
 * @param {{id: string, permissions?: {bitfield?: bigint}, managed?: boolean, comparePositionTo?: Function}} role
 * @param {object} [opts]
 * @param {object} [opts.botHighestRole] the bot's top role, for hierarchy checks
 * @returns {{allowed: boolean, reason: string}}
 */
function canGrantRole(role, { botHighestRole } = {}) {
    if (!role) return { allowed: false, reason: 'role not found' };
    if (role.managed) return { allowed: false, reason: 'managed role (bot/booster integration)' };

    const bits = role.permissions?.bitfield;
    if (typeof bits === 'bigint') {
        for (const [name, flag] of Object.entries(DANGEROUS_PERMISSIONS)) {
            if ((bits & flag) === flag) {
                return { allowed: false, reason: `role grants ${name}` };
            }
        }
    }

    if (botHighestRole && typeof role.comparePositionTo === 'function') {
        // Discord refuses this anyway; failing early gives a clear log line.
        if (role.comparePositionTo(botHighestRole) >= 0) {
            return { allowed: false, reason: 'role is at or above the bot\'s highest role' };
        }
    }
    return { allowed: true, reason: 'ok' };
}

/** Find the mapping for a reaction, with exact message + emoji matching. */
function findReactionRole(store, messageId, emoji) {
    if (!Array.isArray(store)) return null;
    return store.find(r => r.messageId === messageId && emojiMatches(r.emoji, emoji)) || null;
}

module.exports = {
    DANGEROUS_PERMISSIONS,
    isStarterMessage,
    emojiMatches,
    canGrantRole,
    findReactionRole,
};
