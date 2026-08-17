'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PACK_PATTERNS_KNOWLEDGE: K } = require('../lib/pack-patterns');

// The packs this knowledge was derived from were shared privately. The whole
// point is to teach the SHAPE of a working config without ever surfacing a
// source. These tests make that a build failure rather than a promise.
const PACK_NAMES = [
    'Untitled Punchies', 'Untitled Punchy', 'Charmsy', 'Fresh End Crystal',
    'HyperPunchy', 'Hyper Punchy', 'Just 3D Potions', 'Luminous Lanterns',
    'Modded Swords', 'MoveThoseHands', 'Move Those Hands', 'Punched Better',
    'Fresher 3D', 'Punchy refined', 'Cobblemon', 'Refined Buckets',
    'refined torches', 'zMezo', 'Tijōn', 'GLORPY', 'Silly Punchies',
];

test('no community pack is named anywhere in the knowledge', () => {
    for (const name of PACK_NAMES) {
        assert.doesNotMatch(K, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            `pack name "${name}" leaked into pack-patterns knowledge`);
    }
});

test('the no-attribution rule is stated in the module itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pack-patterns.js'), 'utf8');
    assert.match(src, /never names a pack|NON-NEGOTIABLE/i,
        'the privacy rule must stay documented in the source');
});

test('carries no texture, model or asset paths from any pack', () => {
    // Asset paths would identify a pack even without its name.
    assert.doesNotMatch(K, /assets\/[a-z0-9_]+\/textures\//i, 'texture path leaked');
    assert.doesNotMatch(K, /\.png|\.geo\.json|\.bbmodel/i, 'asset filename leaked');
});

test('teaches the real compat file location', () => {
    assert.match(K, /assets\/minecraft\/punchy\/compat\//);
    assert.match(K, /F3 \+ T/);
});

test('records the correct customGroups shape (array of {name, items})', () => {
    assert.match(K, /"customGroups":\s*\[/);
    assert.match(K, /"name":\s*"MY_GROUP"/);
    assert.match(K, /"items":\s*\[/);
});

test('records physics as an ARRAY, not an object', () => {
    // Getting this wrong is a silent no-op for a creator.
    assert.match(K, /"physics":\s*\[/);
    assert.match(K, /FORWARD_PENDULUM/);
    assert.match(K, /limitDegUp/);
});

test('steers bows to use_bow, not useItem — the original hallucination', () => {
    assert.match(K, /use_bow/);
    assert.match(K, /Do NOT reach for useItem for a bow/i);
});

test('documents the semicolon-terminated timeline flag syntax', () => {
    assert.match(K, /anim_speed_1;/);
    assert.match(K, /dual_handed;/);
    assert.match(K, /keep_arm_tuning;/);
    assert.match(K, /Do NOT invent flag names/i);
});

test('names the itemgrip vs arm bone distinction', () => {
    assert.match(K, /itemgrip_right/);
    assert.match(K, /right_arm/);
});

test('warns about the case-sensitivity footgun found in shipping packs', () => {
    assert.match(K, /case-sensitive/i);
    assert.match(K, /"ITEM"/);
});

test('is injected into the wiki prompts, not just defined', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(idx, /require\('\.\/lib\/pack-patterns'\)/, 'module not required');
    const uses = (idx.match(/\$\{PACK_PATTERNS_KNOWLEDGE\}/g) || []).length;
    assert.ok(uses >= 2, `expected both wiki prompts to include it, found ${uses}`);
});
