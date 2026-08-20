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

// ─── Auto-linking an existing role to an addon thread ────────────────────────
//
// auditAddonRoles guesses which role belongs to an addon by seeing how many of
// the thread's 🔥 reactors already hold it. With the original thresholds
// (overlap >= 2, ratio >= 50%) a role with two members whose holders both
// reacted scored a perfect 100% — which is how the "Helper" role got attached
// to an addon post and then handed to everyone who reacted. There was no name
// check at all, so "Helper" could match "GLORPY - Powered by Punchy!".
//
// These rules make a link require actual evidence.

/** Roles that must never be auto-linked, regardless of overlap. */
const NEVER_AUTOLINK_NAMES = [
    'helper', 'moderator', 'mod', 'admin', 'administrator', 'owner', 'dev',
    'developer', 'staff', 'punchers', 'addon creator', 'booster', 'bug hunter',
    'everyone', 'member', 'members', 'verified',
];

const DISCORD_EPOCH = 1420070400000;
const snowflakeMs = (id) => {
    try { return Number(BigInt(id) >> 22n) + DISCORD_EPOCH; } catch { return NaN; }
};

/** Cheap token overlap between a role name and a thread name, 0..1. */
function nameSimilarity(roleName, threadName) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 2);
    const a = new Set(norm(roleName));
    const b = new Set(norm(threadName));
    if (!a.size || !b.size) return 0;
    let hits = 0;
    for (const w of a) if (b.has(w)) hits++;
    return hits / Math.min(a.size, b.size);
}

/**
 * May this existing role be auto-linked to this addon thread?
 *
 * @param {{id:string,name:string,managed?:boolean,permissions?:{bitfield?:bigint},members?:{size:number}}} role
 * @param {{threadId:string,threadName:string}} addon
 * @param {{overlap:number, ratio:number}} score
 * @returns {{allowed:boolean, reason:string}}
 */
function canAutoLinkRole(role, addon, score) {
    if (!role) return { allowed: false, reason: 'role missing' };
    if (role.managed) return { allowed: false, reason: 'managed role' };

    const name = String(role.name || '').toLowerCase().trim();
    if (NEVER_AUTOLINK_NAMES.some(n => name === n || name.startsWith(n + ' ') || name.endsWith(' ' + n))) {
        return { allowed: false, reason: `protected role name "${role.name}"` };
    }

    // Any permission at all means it is a functional role, not a cosmetic
    // addon tag. Helper carries none, which is exactly why the old
    // permission-only guard missed it — hence the name and age checks too.
    const bits = role.permissions?.bitfield;
    if (typeof bits === 'bigint' && bits !== 0n) {
        return { allowed: false, reason: 'role carries permissions' };
    }

    // An addon's role cannot predate the addon post it belongs to.
    const roleAge = snowflakeMs(role.id);
    const threadAge = snowflakeMs(addon?.threadId);
    if (Number.isFinite(roleAge) && Number.isFinite(threadAge) && roleAge < threadAge - 86400000) {
        return { allowed: false, reason: 'role is older than the addon thread' };
    }

    // Evidence thresholds: two people is a coincidence, not a signal.
    if (!score || score.overlap < 3) return { allowed: false, reason: 'needs 3+ overlapping reactors' };
    if (score.ratio < 0.8) return { allowed: false, reason: 'needs an 80%+ member match' };

    // And the name has to look like the addon.
    if (nameSimilarity(role.name, addon?.threadName) < 0.34) {
        return { allowed: false, reason: `name "${role.name}" doesn't resemble "${addon?.threadName}"` };
    }
    return { allowed: true, reason: 'ok' };
}

module.exports.NEVER_AUTOLINK_NAMES = NEVER_AUTOLINK_NAMES;
module.exports.nameSimilarity = nameSimilarity;
module.exports.canAutoLinkRole = canAutoLinkRole;
