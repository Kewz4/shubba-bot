/**
 * forum-tags.js — resolve Discord forum tags from the forum's OWN configuration.
 *
 * Why this exists: the bot used to carry a hardcoded list of Minecraft version
 * tags. It went stale the moment a new version shipped (26.1.1, 26.1.2, 26.2 and
 * the 26.3 snapshots were all untaggable), and the hardcoded list is not the
 * source of truth anyway — the forum channel is. Discord exposes each forum's
 * configured tags at runtime as `channel.availableTags`, where every entry has
 * `{ id, name, emoji, moderated }`.
 *
 * These helpers are pure so they can be unit-tested without a Discord client.
 * index.js reads `channel.availableTags` and feeds it to `categorizeTags()`.
 */
'use strict';

/**
 * Discord refuses `setAppliedTags()` with more than 5 tags on a forum thread.
 * Exceeding it throws, and a swallowed throw means NO tags get applied at all —
 * so callers must cap the list explicitly instead of hoping.
 */
const MAX_FORUM_TAGS = 5;

/**
 * Last-resort fallback, used ONLY when the forum's availableTags cannot be read
 * (API failure, missing permissions, channel not cached).
 *
 * Verified against the Modrinth API for project `punchy-fpa` on 2026-08-14:
 * game_versions = 1.20.1, 1.21.1, 1.21.5, 1.21.11, 26.1, 26.1.1, 26.1.2, 26.2,
 * 26.3-snapshot-8; loaders = fabric, forge, neoforge.
 *
 * MUST BE UPDATED WHEN A NEW MINECRAFT VERSION SHIPS. Prefer fixing the forum's
 * tags in Discord — the live path picks those up automatically and this list is
 * never consulted while the API is reachable.
 */
const FALLBACK_TAG_CATEGORIES = Object.freeze({
    VERSIONS: Object.freeze([
        'All', '1.20.1', '1.21.1', '1.21.5', '1.21.11',
        '26.1', '26.1.1', '26.1.2', '26.2', '26.3-snapshot-8'
    ]),
    LOADERS: Object.freeze(['Fabric', 'Forge', 'NeoForge']),
    ISSUES: Object.freeze([
        'Visual Bug', 'Animation Bug', 'Modpack Issue',
        'Compatibility Issue', 'Crash / Fatal Error', 'Duplicate'
    ])
});

/** Mod loaders Punchy ships for, plus Quilt so a stray Quilt tag is not mistaken
 *  for an issue category. (Punchy does NOT support Quilt — see the verified KB.) */
const LOADER_NAMES = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

// 1.20.1 / 1.21.11 / 26.1 / 26.2 / 26.3-snapshot-8 / 2.6.2
const NUMERIC_VERSION_RE = /^\d+(\.\d+)*(-[a-z0-9][a-z0-9.-]*)?$/i;
// Mojang weekly snapshots, e.g. 25w14a
const WEEKLY_SNAPSHOT_RE = /^\d{2}w\d{2}[a-z]$/i;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Is this tag name a game-version tag? ("All" is the catch-all version tag.) */
function isVersionName(name) {
    const n = norm(name);
    if (!n) return false;
    if (n === 'all') return true;
    return NUMERIC_VERSION_RE.test(n) || WEEKLY_SNAPSHOT_RE.test(n);
}

/** Is this tag name a mod-loader tag? */
function isLoaderName(name) {
    return LOADER_NAMES.has(norm(name));
}

/**
 * Split a forum's live `availableTags` into the VERSIONS / LOADERS / ISSUES
 * buckets the bot reasons about. Anything that is neither a version nor a
 * loader is treated as an issue-type tag, so newly-added moderator tags work
 * without a code change.
 *
 * Returns the verified fallback when `availableTags` is unusable — this is the
 * fallback path, kept here so it is testable.
 *
 * @param {Array<{id?:string,name?:string}>|null|undefined} availableTags
 * @returns {{VERSIONS:string[],LOADERS:string[],ISSUES:string[]}}
 */
function categorizeTags(availableTags) {
    const usable = Array.isArray(availableTags)
        ? availableTags.filter(t => t && typeof t.name === 'string' && t.name.trim())
        : [];

    if (!usable.length) {
        return {
            VERSIONS: [...FALLBACK_TAG_CATEGORIES.VERSIONS],
            LOADERS: [...FALLBACK_TAG_CATEGORIES.LOADERS],
            ISSUES: [...FALLBACK_TAG_CATEGORIES.ISSUES]
        };
    }

    const out = { VERSIONS: [], LOADERS: [], ISSUES: [] };
    const seen = new Set();

    for (const tag of usable) {
        const name = tag.name.trim();
        const key = norm(name);
        if (seen.has(key)) continue;      // two forums can define the same tag
        seen.add(key);

        if (isLoaderName(name)) out.LOADERS.push(name);
        else if (isVersionName(name)) out.VERSIONS.push(name);
        else out.ISSUES.push(name);
    }

    return out;
}

/**
 * Order version strings so the most specific match is tested first — otherwise
 * scanning a message for "1.21.1" matches inside "1.21.11", and "26.1" matches
 * inside "26.1.2". Longer strings are strictly more specific here.
 */
function sortVersionsBySpecificity(versions) {
    return [...(versions || [])]
        .filter(v => norm(v) && norm(v) !== 'all')
        .sort((a, b) => String(b).length - String(a).length || String(a).localeCompare(String(b)));
}

/**
 * Map tag NAMES to the forum's tag IDs, case-insensitively. Names with no
 * matching tag in this forum are dropped (a tag id from another forum is
 * rejected by Discord).
 *
 * @param {Array<{id:string,name:string}>} availableTags
 * @param {string[]} names
 * @returns {string[]} tag ids, input order, de-duplicated
 */
function resolveTagIds(availableTags, names) {
    const tags = Array.isArray(availableTags) ? availableTags : [];
    const byName = new Map();
    for (const t of tags) {
        if (t && typeof t.name === 'string' && t.id != null) {
            const key = norm(t.name);
            if (!byName.has(key)) byName.set(key, t.id);   // first definition wins
        }
    }

    const ids = [];
    const seen = new Set();
    for (const name of (Array.isArray(names) ? names : [])) {
        const id = byName.get(norm(name));
        if (id != null && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
}

/**
 * Enforce Discord's 5-tag-per-thread limit deliberately.
 *
 * Ordering rules:
 *   1. Tags already on the thread are kept first — a moderator or the author
 *      applied them on purpose, and the bot must not silently evict them.
 *   2. Newly detected tags fill the remaining slots, most useful for triage
 *      first: game version, then mod loader, then issue type. That matters
 *      because several call sites gate on "has a version tag AND a loader tag".
 *
 * @returns {string[]} at most `max` tag ids, safe to pass to setAppliedTags()
 */
function capTagIds({ existingIds = [], desiredIds = [], availableTags = [], max = MAX_FORUM_TAGS } = {}) {
    const limit = Number.isInteger(max) && max > 0 ? max : MAX_FORUM_TAGS;
    const byId = new Map(
        (Array.isArray(availableTags) ? availableTags : [])
            .filter(t => t && t.id != null)
            .map(t => [t.id, t])
    );

    // Lower rank = applied first.
    const rank = (id) => {
        const tag = byId.get(id);
        if (!tag || typeof tag.name !== 'string') return 3;
        if (isVersionName(tag.name)) return 0;
        if (isLoaderName(tag.name)) return 1;
        return 2;
    };

    const out = [];
    const seen = new Set();
    const push = (id) => {
        if (id == null || seen.has(id) || out.length >= limit) return;
        seen.add(id);
        out.push(id);
    };

    for (const id of (Array.isArray(existingIds) ? existingIds : [])) push(id);

    // Array#sort is stable in Node >=11, so same-rank tags keep detection order.
    const fresh = (Array.isArray(desiredIds) ? desiredIds : []).filter(id => id != null && !seen.has(id));
    fresh.sort((a, b) => rank(a) - rank(b));
    for (const id of fresh) push(id);

    return out;
}

module.exports = {
    MAX_FORUM_TAGS,
    FALLBACK_TAG_CATEGORIES,
    isVersionName,
    isLoaderName,
    categorizeTags,
    sortVersionsBySpecificity,
    resolveTagIds,
    capTagIds
};
