/**
 * solutions.js — remembering what already got solved, usefully.
 *
 * The old store had three problems:
 *   1. VERSION WAS A CONSTANT. Every solution was filed under
 *      CURRENT_VERSION_SET, a hand-maintained literal, regardless of what
 *      version the reporter was actually on. It drifted to '2.4' while users
 *      were on 2.7d.
 *   2. IT KEPT RAW TRANSCRIPTS. Up to 50 messages of chat per solution, so the
 *      signal (what broke, what fixed it) was buried in "ok thanks" noise.
 *   3. RETRIEVAL WAS ALL-OR-NOTHING. buildSolutionsKnowledge() pasted EVERY
 *      solution for the current version into every prompt and ignored all other
 *      versions — simultaneously too much noise and too little recall.
 *
 * This module keeps the parsing/scoring pure so it is testable, and leaves the
 * Discord and storage plumbing in index.js.
 */

'use strict';

// ─── Version detection ───────────────────────────────────────────────────────

// Punchy's own version: 2.7, 2.7d, 2.6.2, v2.5.7
const PUNCHY_VERSION_RE = /\bv?(\d+\.\d+(?:\.\d+)?[a-z]?)\b/gi;
// Minecraft: 1.21.1, 1.20.1, 26.1.2, 26.2, 26.3-snapshot-8
const MC_VERSION_RE = /\b(1\.\d{2}(?:\.\d+)?|2\d\.\d+(?:\.\d+)?(?:-snapshot-\d+)?)\b/gi;

/** Everything after the first two digits groups a Punchy release line: 2.7d → 2.7 */
function minorLine(version) {
    const m = /^(\d+\.\d+)/.exec(String(version || ''));
    return m ? m[1] : null;
}

/**
 * Work out which versions a thread is about, from its text and forum tags.
 * Tags win over prose: a tag was chosen deliberately, prose may be quoting
 * someone else's setup.
 *
 * @param {string} text
 * @param {{tags?: string[], fallbackPunchy?: string}} [opts]
 * @returns {{punchy: string|null, mc: string|null, line: string|null}}
 */
function detectVersions(text, opts = {}) {
    const tags = (opts.tags || []).map(String);
    const body = String(text || '');

    let mc = null;
    for (const t of tags) {
        const m = String(t).match(/^(1\.\d{2}(?:\.\d+)?|2\d\.\d+(?:\.\d+)?)$/);
        if (m) { mc = m[1]; break; }
    }
    if (!mc) {
        const found = body.match(MC_VERSION_RE);
        if (found && found.length) {
            // Prefer the most specific mention (26.1.2 over 26.1).
            mc = found.slice().sort((a, b) => b.length - a.length)[0];
        }
    }

    // A Punchy version is a x.y[.z][letter] that is NOT one of the MC versions.
    let punchy = null;
    const seen = new Set((body.match(MC_VERSION_RE) || []).map(s => s.toLowerCase()));
    let m;
    PUNCHY_VERSION_RE.lastIndex = 0;
    while ((m = PUNCHY_VERSION_RE.exec(body)) !== null) {
        const v = m[1];
        if (seen.has(v.toLowerCase())) continue;
        if (/^1\.\d{2}/.test(v) || /^2\d\./.test(v)) continue; // an MC version
        punchy = v;
        break;
    }
    if (!punchy && opts.fallbackPunchy) punchy = opts.fallbackPunchy;

    return { punchy, mc, line: minorLine(punchy) };
}

// ─── Distillation ────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'have', 'has', 'not', 'but',
    'you', 'your', 'its', 'it', 'is', 'are', 'was', 'were', 'can', 'cant', 'will', 'when', 'why',
    'how', 'what', 'from', 'into', 'out', 'get', 'got', 'any', 'all', 'like', 'just', 'try',
    'tried', 'still', 'also', 'here', 'there', 'i', 'a', 'an', 'to', 'of', 'in', 'on', 'my',
    'me', 'so', 'if', 'or', 'do', 'does', 'did', 'be', 'been', 'thanks', 'thank', 'ok', 'okay',
    'punchy', 'mod', 'minecraft', 'game', 'please', 'help']);

/** Content words, lowercased and de-duplicated. */
function keywords(text, limit = 24) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_.:-]+/)) {
        const w = raw.replace(/^[.:-]+|[.:-]+$/g, '');
        if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
        if (/^\d+$/.test(w)) continue;
        seen.add(w);
        out.push(w);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Mod names mentioned. Deliberately conservative: matches CamelCase names,
 * quoted names and known-mod words rather than guessing at every noun.
 */
function detectMods(text, known = []) {
    const body = String(text || '');
    const found = new Set();
    for (const k of known) {
        if (k && new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(body)) {
            found.add(k);
        }
    }
    // mod ids like "create:crushing_wheel" → "create"
    for (const m of body.matchAll(/\b([a-z][a-z0-9_]{2,}):[a-z0-9_/.]+/g)) {
        if (m[1] !== 'minecraft' && m[1] !== 'punchy') found.add(m[1]);
    }
    return [...found].slice(0, 8);
}

/**
 * Turn a solved thread into a compact record.
 * Keeps the OP's symptom and the resolving message — not the whole transcript.
 *
 * @param {object} o
 * @param {string} o.threadName
 * @param {string} o.threadId
 * @param {Array<{author:string, content:string, isBot?:boolean}>} o.messages oldest-first
 * @param {string[]} [o.tags]
 * @param {string} [o.fallbackPunchy]
 * @param {string[]} [o.knownMods]
 */
function distil({ threadName, threadId, messages = [], tags = [], fallbackPunchy, knownMods = [] }) {
    const human = messages.filter(m => !m.isBot);
    const symptom = (human[0]?.content || threadName || '').slice(0, 400).trim();

    // The fix is normally the last substantial non-OP message — a helper's
    // answer or Shubba's accepted one. Short acks are never the fix.
    const candidates = messages
        .filter(m => (m.content || '').trim().length > 60)
        .filter(m => !/^\s*(ok|thanks|ty|works|fixed|nice|got it)\b/i.test(m.content));
    const fix = (candidates[candidates.length - 1]?.content || '').slice(0, 700).trim();

    const allText = [threadName, ...messages.map(m => m.content)].join('\n');
    const versions = detectVersions(allText, { tags, fallbackPunchy });

    return {
        threadId,
        threadName: String(threadName || '').slice(0, 120),
        symptom,
        fix,
        tags: tags.slice(0, 6),
        mods: detectMods(allText, knownMods),
        keywords: keywords(symptom + ' ' + threadName),
        punchyVersion: versions.punchy,
        mcVersion: versions.mc,
        line: versions.line,
        solvedAt: new Date().toISOString(),
    };
}

// ─── Dedupe ──────────────────────────────────────────────────────────────────

function overlap(a = [], b = []) {
    if (!a.length || !b.length) return 0;
    const sb = new Set(b);
    let hits = 0;
    for (const x of a) if (sb.has(x)) hits++;
    return hits / Math.min(a.length, b.length);
}

/** Same thread, or near-identical symptom on the same release line. */
function isDuplicate(candidate, existing) {
    if (!candidate || !existing) return false;
    if (candidate.threadId && candidate.threadId === existing.threadId) return true;
    if (candidate.line && existing.line && candidate.line !== existing.line) return false;
    return overlap(candidate.keywords, existing.keywords) >= 0.75;
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/**
 * How relevant is a stored solution to the question being asked?
 * Version proximity matters but never outranks topical match — a 2.6 fix for
 * the exact symptom beats an unrelated 2.7 one.
 */
function score(solution, query) {
    const qk = query.keywords || keywords(query.text || '');
    let s = overlap(qk, solution.keywords || []) * 100;

    const qMods = query.mods || [];
    if (qMods.length && solution.mods?.length) s += overlap(qMods, solution.mods) * 40;

    if (query.line && solution.line) {
        s += query.line === solution.line ? 12 : -6; // same release line helps, older mildly penalised
    }
    if (query.mcVersion && solution.mcVersion) {
        s += query.mcVersion === solution.mcVersion ? 8 : -3;
    }
    // Gentle recency nudge so stale advice loses ties.
    const ageDays = solution.solvedAt ? (Date.now() - Date.parse(solution.solvedAt)) / 86400000 : 365;
    if (Number.isFinite(ageDays)) s += Math.max(-8, 6 - ageDays / 30);

    return s;
}

/**
 * Pick the few solutions worth putting in the prompt.
 *
 * Searches EVERY version, not just the current one — the old code only looked
 * at CURRENT_VERSION_SET, so a perfectly good fix filed under 2.6 was invisible
 * to a 2.7 question.
 *
 * @param {Record<string, object[]>} byVersion
 * @param {{text?:string, tags?:string[], knownMods?:string[]}} question
 * @param {{limit?:number, minScore?:number}} [opts]
 */
function pickRelevant(byVersion, question, opts = {}) {
    const limit = opts.limit ?? 4;
    const minScore = opts.minScore ?? 25;

    const text = question.text || '';
    const v = detectVersions(text, { tags: question.tags || [] });
    const query = {
        keywords: keywords(text),
        mods: detectMods(text, question.knownMods || []),
        line: v.line,
        mcVersion: v.mc,
    };

    const flat = [];
    for (const list of Object.values(byVersion || {})) {
        for (const sol of list || []) flat.push(sol);
    }
    return flat
        .map(sol => ({ sol, s: score(sol, query) }))
        .filter(x => x.s >= minScore)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(x => x.sol);
}

/** Render the chosen solutions compactly for the prompt. */
function renderForPrompt(solutions) {
    if (!solutions || !solutions.length) return '';
    const lines = ['', '--- PREVIOUSLY SOLVED, SIMILAR ISSUES ---',
        '(Real fixes from this server. Use them only if they match; say so if they do not.)', ''];
    solutions.forEach((s, i) => {
        lines.push(`[${i + 1}] ${s.threadName}`);
        const ver = [s.punchyVersion && `Punchy ${s.punchyVersion}`, s.mcVersion && `MC ${s.mcVersion}`].filter(Boolean).join(' · ');
        if (ver) lines.push(`    Version: ${ver}`);
        if (s.mods?.length) lines.push(`    Mods involved: ${s.mods.join(', ')}`);
        if (s.symptom) lines.push(`    Symptom: ${s.symptom.slice(0, 220)}`);
        if (s.fix) lines.push(`    What fixed it: ${s.fix.slice(0, 400)}`);
        lines.push('');
    });
    return lines.join('\n');
}

module.exports = {
    detectVersions, minorLine, keywords, detectMods, distil,
    isDuplicate, score, pickRelevant, renderForPrompt, overlap,
};
