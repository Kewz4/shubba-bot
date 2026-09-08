/**
 * zip-reader.js — read a resource pack .zip with no third-party dependency.
 *
 * Users attach their whole pack as a .zip. Shubba previously logged
 * "Attached: pack.zip (unknown type)" and nothing else, so it answered blind
 * about a file it was holding. This reads the archive with Node's built-in
 * zlib, so nothing is added to package.json (the host runs `npm install
 * --production` at boot; a new dep is a deploy risk for no benefit).
 *
 * Only what a ZIP actually needs:
 *   - locate the End Of Central Directory record
 *   - walk the central directory for names, sizes and offsets
 *   - inflate the entries we care about (method 8) or copy them (method 0)
 *
 * Hostile-input aware: a resource pack is arbitrary user upload, so entry
 * count, per-entry size and total inflated bytes are all capped, and path
 * traversal (`../`) is rejected.
 */

'use strict';

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const LIMITS = {
    MAX_ENTRIES: 4000,
    MAX_ENTRY_BYTES: 4 * 1024 * 1024,     // one file we will inflate
    MAX_TOTAL_BYTES: 24 * 1024 * 1024,    // everything we inflate, combined
};

/** Scan backwards for the EOCD signature (it sits within the last 64KB + comment). */
function findEocd(buf) {
    const start = Math.max(0, buf.length - 66000);
    for (let i = buf.length - 22; i >= start; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}

/**
 * List every entry in the archive without inflating anything.
 * @param {Buffer} buf
 * @returns {{entries: Array<{name:string,size:number,compressedSize:number,method:number,offset:number}>, warnings: string[]}}
 */
function listEntries(buf) {
    const warnings = [];
    if (!Buffer.isBuffer(buf) || buf.length < 22) return { entries: [], warnings: ['Not a readable archive.'] };

    const eocd = findEocd(buf);
    if (eocd === -1) return { entries: [], warnings: ['No ZIP end-of-directory record found — the file may be corrupt or not a ZIP.'] };

    let count = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // ZIP64: the 32-bit fields saturate. We do not parse ZIP64 fully; a pack
    // that large is out of scope, so say so rather than silently truncating.
    if (cdOffset === 0xffffffff || count === 0xffff) {
        const loc = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
        if (loc !== -1) warnings.push('ZIP64 archive — only the first entries can be listed.');
    }
    if (count > LIMITS.MAX_ENTRIES) {
        warnings.push(`Archive has ${count} entries; only the first ${LIMITS.MAX_ENTRIES} were read.`);
        count = LIMITS.MAX_ENTRIES;
    }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
        const method = buf.readUInt16LE(p + 10);
        const compressedSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

        // Directories are entries too; keep only files.
        if (!name.endsWith('/')) entries.push({ name, size, compressedSize, method, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, warnings };
}

/** Inflate one entry to a string. Returns null when it cannot or should not be read. */
function readEntry(buf, entry, budget) {
    if (!entry) return null;
    // Reject traversal and absolute paths outright — we never write these to
    // disk, but a crafted name should not reach a log or an answer either.
    if (entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\..')) return null;
    if (entry.size > LIMITS.MAX_ENTRY_BYTES) return null;
    if (budget && entry.size > budget.remaining) return null;

    const p = entry.offset;
    if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) return null;
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const dataStart = p + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + entry.compressedSize);

    try {
        let out;
        if (entry.method === 0) out = data;                       // stored
        else if (entry.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: LIMITS.MAX_ENTRY_BYTES });
        else return null;                                          // bzip2/lzma: rare in packs
        if (budget) budget.remaining -= out.length;
        return out.toString('utf8');
    } catch (e) {
        return null;
    }
}

// What matters inside a Punchy resource pack.
const INTERESTING = [
    { re: /assets\/[^/]+\/punchy\/compat\/.+\.json$/i, kind: 'compat' },
    { re: /\.animation\.json$/i, kind: 'animation' },
    { re: /assets\/[^/]+\/punchy\/model_parts\/.+\.json$/i, kind: 'model_parts' },
    { re: /\.geo\.json$/i, kind: 'geo' },
    { re: /^pack\.mcmeta$/i, kind: 'mcmeta' },
];

const classify = (name) => {
    for (const t of INTERESTING) if (t.re.test(name)) return t.kind;
    return null;
};

/**
 * Summarise a resource pack: what it contains, and the Punchy files worth checking.
 *
 * @param {Buffer} buf
 * @param {{maxFiles?: number}} [opts]
 * @returns {{ok:boolean, warnings:string[], counts:object, hasPunchy:boolean, files:Array<{name:string,kind:string,text:string|null}>, structure:string[]}}
 */
function inspectResourcePack(buf, opts = {}) {
    const maxFiles = opts.maxFiles || 12;
    const { entries, warnings } = listEntries(buf);
    if (!entries.length) return { ok: false, warnings, counts: {}, hasPunchy: false, files: [], structure: [] };

    const counts = { total: entries.length, textures: 0, models: 0, sounds: 0, punchy: 0, animations: 0 };
    for (const e of entries) {
        const n = e.name.toLowerCase();
        if (n.endsWith('.png')) counts.textures++;
        else if (n.endsWith('.json') && n.includes('/models/')) counts.models++;
        else if (/\.(ogg|wav|mp3)$/.test(n)) counts.sounds++;
        if (n.includes('/punchy/')) counts.punchy++;
        if (n.endsWith('.animation.json')) counts.animations++;
    }

    // Read the interesting files, newest-schema first, within a shared budget.
    const budget = { remaining: LIMITS.MAX_TOTAL_BYTES };
    // Diagnostic value order. Animation files are large and numerous; a pack
    // with 15 of them would otherwise consume the whole budget and we would
    // never reach the compat file, which is what most questions are about.
    const PRIORITY = { compat: 0, mcmeta: 1, model_parts: 2, geo: 3, animation: 4 };
    const candidates = [];
    for (const e of entries) {
        const kind = classify(e.name);
        if (kind) candidates.push({ entry: e, kind });
    }
    candidates.sort((a, b) => (PRIORITY[a.kind] - PRIORITY[b.kind]) || (a.entry.size - b.entry.size));
    const picked = candidates.slice(0, maxFiles);
    const skipped = candidates.length - picked.length;
    if (skipped > 0) {
        warnings.push(`Read ${picked.length} Punchy files; ${skipped} more were skipped (compat and pack.mcmeta are read first).`);
    }

    const files = picked.map(({ entry, kind }) => ({
        name: entry.name,
        kind,
        text: readEntry(buf, entry, budget),
    }));

    // A shallow map of the archive, so an answer can reason about layout.
    const dirs = new Map();
    for (const e of entries) {
        const parts = e.name.split('/');
        const top = parts.slice(0, 3).join('/');
        dirs.set(top, (dirs.get(top) || 0) + 1);
    }
    const structure = [...dirs.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([d, n]) => `${d} (${n})`);

    return {
        ok: true,
        warnings,
        counts,
        hasPunchy: counts.punchy > 0,
        files,
        structure,
    };
}

module.exports = { listEntries, readEntry, inspectResourcePack, classify, LIMITS };
