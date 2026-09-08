'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { listEntries, readEntry, inspectResourcePack, classify, LIMITS } = require('../lib/zip-reader');

// Build a real ZIP in memory so these tests do not depend on files on disk.
function makeZip(files) {
    const locals = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
        const nameBuf = Buffer.from(f.name, 'utf8');
        const raw = Buffer.from(f.content, 'utf8');
        const stored = f.stored === true;
        const data = stored ? raw : zlib.deflateRawSync(raw);
        const method = stored ? 0 : 8;

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(0, 14);              // crc — not verified by the reader
        lh.writeUInt32LE(data.length, 18);
        lh.writeUInt32LE(raw.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        locals.push(lh, nameBuf, data);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt32LE(0, 16);
        ch.writeUInt32LE(data.length, 20);
        ch.writeUInt32LE(raw.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt32LE(offset, 42);
        central.push(ch, nameBuf);

        offset += lh.length + nameBuf.length + data.length;
    }

    const localPart = Buffer.concat(locals);
    const centralPart = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
}

const COMPAT = JSON.stringify({ item: { SWORD: { kind: 'SWORD' } } });

test('lists entries in a real archive', () => {
    const zip = makeZip([
        { name: 'pack.mcmeta', content: '{"pack":{"pack_format":15,"description":"x"}}' },
        { name: 'assets/minecraft/punchy/compat/swords.json', content: COMPAT },
    ]);
    const { entries } = listEntries(zip);
    assert.equal(entries.length, 2);
    assert.ok(entries.some(e => e.name === 'pack.mcmeta'));
});

test('inflates deflated entries back to their exact contents', () => {
    const zip = makeZip([{ name: 'assets/minecraft/punchy/compat/a.json', content: COMPAT }]);
    const { entries } = listEntries(zip);
    assert.equal(readEntry(zip, entries[0]), COMPAT);
});

test('reads stored (uncompressed) entries too', () => {
    const zip = makeZip([{ name: 'pack.mcmeta', content: '{"pack":{}}', stored: true }]);
    const { entries } = listEntries(zip);
    assert.equal(readEntry(zip, entries[0]), '{"pack":{}}');
});

test('directories are not reported as files', () => {
    const zip = makeZip([
        { name: 'assets/', content: '' },
        { name: 'assets/minecraft/punchy/compat/a.json', content: COMPAT },
    ]);
    assert.equal(listEntries(zip).entries.length, 1);
});

// ── Classification ──────────────────────────────────────────────────────────

test('recognises the Punchy file kinds', () => {
    assert.equal(classify('assets/minecraft/punchy/compat/swords.json'), 'compat');
    assert.equal(classify('assets/minecraft/punchy/animations/swords.animation.json'), 'animation');
    assert.equal(classify('assets/minecraft/punchy/model_parts/torch.json'), 'model_parts');
    assert.equal(classify('assets/minecraft/models/item/x.geo.json'), 'geo');
    assert.equal(classify('pack.mcmeta'), 'mcmeta');
    assert.equal(classify('assets/minecraft/textures/item/sword.png'), null);
});

// ── Pack inspection ─────────────────────────────────────────────────────────

test('summarises a pack and reads its Punchy files', () => {
    const zip = makeZip([
        { name: 'pack.mcmeta', content: '{"pack":{"pack_format":15,"description":"d"}}' },
        { name: 'assets/minecraft/punchy/compat/swords.json', content: COMPAT },
        { name: 'assets/minecraft/textures/item/sword.png', content: 'notreallyapng' },
    ]);
    const r = inspectResourcePack(zip);
    assert.equal(r.ok, true);
    assert.equal(r.hasPunchy, true);
    assert.equal(r.counts.textures, 1);
    const compat = r.files.find(f => f.kind === 'compat');
    assert.ok(compat && compat.text.includes('SWORD'), 'compat contents must be readable');
});

test('compat and mcmeta are read before animations when capped', () => {
    // A real pack had 15 animation files and one compat file; reading in
    // archive order consumed the budget before reaching the compat.
    const files = [{ name: 'assets/minecraft/punchy/compat/z.json', content: COMPAT }];
    for (let i = 0; i < 20; i++) {
        files.unshift({ name: `assets/minecraft/punchy/animations/a${i}.animation.json`, content: '{"animations":{}}' });
    }
    const r = inspectResourcePack(makeZip(files), { maxFiles: 3 });
    assert.ok(r.files.some(f => f.kind === 'compat'), 'the compat file must survive the cap');
    assert.match(r.warnings.join(' '), /skipped/);
});

test('a pack with no Punchy content says so', () => {
    const r = inspectResourcePack(makeZip([{ name: 'assets/minecraft/textures/a.png', content: 'x' }]));
    assert.equal(r.ok, true);
    assert.equal(r.hasPunchy, false);
});

test('reports the archive structure', () => {
    const r = inspectResourcePack(makeZip([
        { name: 'assets/minecraft/punchy/compat/a.json', content: COMPAT },
        { name: 'assets/minecraft/punchy/compat/b.json', content: COMPAT },
    ]));
    assert.ok(r.structure.length > 0);
    assert.match(r.structure.join(' '), /assets\/minecraft\/punchy/);
});

// ── Hostile input ───────────────────────────────────────────────────────────

test('a non-zip is rejected, not crashed on', () => {
    const r = inspectResourcePack(Buffer.from('this is definitely not a zip file'));
    assert.equal(r.ok, false);
    assert.match(r.warnings.join(' '), /not a ZIP|corrupt|readable/i);
});

test('empty and tiny buffers are handled', () => {
    for (const b of [Buffer.alloc(0), Buffer.alloc(10)]) {
        assert.doesNotThrow(() => inspectResourcePack(b));
        assert.equal(inspectResourcePack(b).ok, false);
    }
});

test('path traversal entries are refused', () => {
    const zip = makeZip([{ name: '../../etc/passwd', content: 'x' }]);
    const { entries } = listEntries(zip);
    assert.equal(readEntry(zip, entries[0]), null, 'must never read a traversal path');
});

test('an oversized entry is skipped rather than inflated', () => {
    const fake = { name: 'big.json', size: LIMITS.MAX_ENTRY_BYTES + 1, compressedSize: 10, method: 8, offset: 0 };
    assert.equal(readEntry(Buffer.alloc(100), fake), null);
});

test('a shared budget stops a zip bomb', () => {
    const budget = { remaining: 100 };
    const fake = { name: 'a.json', size: 5000, compressedSize: 10, method: 8, offset: 0 };
    assert.equal(readEntry(Buffer.alloc(100), fake, budget), null, 'must refuse once the budget is spent');
});

test('an unsupported compression method returns null, not garbage', () => {
    const fake = { name: 'a.json', size: 10, compressedSize: 10, method: 12, offset: 0 };
    assert.equal(readEntry(Buffer.alloc(100), fake), null);
});

test('a corrupt entry offset does not throw', () => {
    const zip = makeZip([{ name: 'a.json', content: COMPAT }]);
    const bad = { name: 'a.json', size: 10, compressedSize: 10, method: 8, offset: 999999 };
    assert.doesNotThrow(() => readEntry(zip, bad));
    assert.equal(readEntry(zip, bad), null);
});
