'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, detectType, parseJson } = require('../lib/punchy-validate');

const errs = (r) => r.issues.filter(i => i.level === 'error').map(i => i.msg).join(' | ');
const all = (r) => r.issues.map(i => i.msg).join(' | ');

// ── The incident this whole module exists for ───────────────────────────────

test('catches the bow answer that Shubba got wrong', () => {
    // Every token here is real — path, ToolKind, animation type — and the
    // config still does not do what was claimed. This is the case a model
    // cannot reliably catch and a validator can.
    const r = validate(JSON.stringify({
        itemSpecific: { 'minecraft:bow': { kind: 'BOW', customAnimation: [{ type: 'useItem', name: 'idle' }] } },
    }));
    assert.equal(r.ok, false);
    assert.match(errs(r), /use_bow/, 'must point at the correct animation type');
});

test('a correct bow config passes', () => {
    const r = validate(JSON.stringify({
        itemSpecific: { 'minecraft:bow': { kind: 'BOW', customAnimation: [{ type: 'use_bow', name: 'draw' }] } },
    }));
    assert.equal(r.ok, true, all(r));
});

// ── Real mistakes found in shipping packs ───────────────────────────────────

test('wrong-case top-level key is detected AND explained', () => {
    // A shipping pack used "ITEM"; Punchy silently ignored the whole block.
    const r = validate(JSON.stringify({ ITEM: { SWORD: { kind: 'SWORD' } } }));
    assert.equal(r.type, 'compat', 'must still be recognised as a compat file');
    assert.equal(r.ok, false);
    assert.match(errs(r), /wrong case/i);
    assert.match(errs(r), /ignored/i, 'the author needs to know it does nothing');
});

test('an item ID where a ToolKind belongs', () => {
    const r = validate(JSON.stringify({ item: { SWORD: { kind: 'minecraft:bow' } } }));
    assert.equal(r.ok, false);
    assert.match(errs(r), /ITEM ID/);
    assert.match(errs(r), /itemSpecific/, 'should say where item IDs actually go');
});

test('physics as an object instead of an array', () => {
    const r = validate(JSON.stringify({ item: { BUCKET: { kind: 'BUCKET', physics: { name: 'FORWARD_PENDULUM' } } } }));
    assert.equal(r.ok, false);
    assert.match(errs(r), /must be an ARRAY/);
    assert.match(errs(r), /silently does nothing/);
});

test('a valid physics array passes', () => {
    const r = validate(JSON.stringify({
        item: { CREATURE_BUCKET: { kind: 'CREATURE_BUCKET', physics: [{ name: 'FORWARD_PENDULUM', limitDegUp: 90, force: 0.5 }] } },
    }));
    assert.equal(r.ok, true, all(r));
});

// ── Vocabulary checks ───────────────────────────────────────────────────────

test('invalid ToolKind gets a suggestion', () => {
    const r = validate(JSON.stringify({ item: { SWORD: { kind: 'SWORDS' } } }));
    assert.match(errs(r), /did you mean `SWORD`/);
});

test('known animation-type typos are named', () => {
    const r = validate(JSON.stringify({ item: { FOOD: { kind: 'FOOD', customAnimation: [{ type: 'use_drink', name: 'x' }] } } }));
    assert.match(errs(r), /did you mean `usedrink`/);
});

test('a group referenced but never defined is an error', () => {
    const r = validate(JSON.stringify({ item: { my_group: { kind: 'SWORD' } } }));
    assert.equal(r.ok, false);
    assert.match(errs(r), /neither a ToolKind nor a group/);
});

test('a group that IS defined passes', () => {
    const r = validate(JSON.stringify({
        customGroups: [{ name: 'fish_items', items: ['minecraft:cod'] }],
        item: { fish_items: { kind: 'FOOD' } },
    }));
    assert.equal(r.ok, true, all(r));
});

test('customGroups must be an array', () => {
    const r = validate(JSON.stringify({ customGroups: { name: 'x', items: [] } }));
    assert.match(errs(r), /must be an ARRAY/);
});

test('missing namespace is flagged, not fatal', () => {
    const r = validate(JSON.stringify({ itemSpecific: { diamond_sword: { kind: 'SWORD' } } }));
    assert.equal(r.ok, true, 'a namespace warning should not block');
    assert.match(all(r), /minecraft:diamond_sword/);
});

test('transform values must be numbers', () => {
    const r = validate(JSON.stringify({ item: { SWORD: { kind: 'SWORD', transforms: { right: { scale: '1.0' } } } } }));
    assert.match(errs(r), /must be a number/);
});

test('triggerable guidance mirrors the wiki', () => {
    const r = validate(JSON.stringify({ item: { SWORD: { kind: 'SWORD', customAnimation: [{ type: 'triggerable', name: 'inspect_alt', key: 'G' }] } } }));
    assert.equal(r.ok, true, all(r));
    assert.match(all(r), /id.*title/i, 'should nudge toward id/title for stable remaps');
});

// ── JSON syntax help ────────────────────────────────────────────────────────

test('trailing comma is named plainly', () => {
    const r = validate('{ "item": { "SWORD": { "kind": "SWORD" }, } }');
    assert.equal(r.type, 'invalid-json');
    assert.match(errs(r), /Trailing comma/);
});

test('unbalanced brackets are counted', () => {
    const r = validate('{ "item": { "SWORD": { "kind": "SWORD" } ');
    assert.match(errs(r), /Unbalanced brackets/);
});

test('single quotes and comments are explained', () => {
    assert.match(errs(validate("{ 'item': {} }")), /double quotes/);
    assert.match(errs(validate('{ // note\n "item": {} }')), /does not support comments/);
});

test('a syntax error reports a line number', () => {
    const r = validate('{\n "item": {\n  "SWORD": { "kind": "SWORD" },\n }\n}');
    assert.ok(r.issues.some(i => i.line), 'should locate the problem');
});

// ── Other file types ────────────────────────────────────────────────────────

test('animation files are detected and checked', () => {
    const r = validate(JSON.stringify({
        animations: { attack_1: { animation_length: 1.3, bones: { itemgrip_right: { scale: {} } } } },
    }));
    assert.equal(r.type, 'animation');
    assert.equal(r.ok, true, all(r));
});

test('an animation touching no Punchy bone is flagged', () => {
    const r = validate(JSON.stringify({ animations: { x: { animation_length: 1, bones: { some_bone: {} } } } }));
    assert.match(all(r), /itemgrip_right/, 'should say which bones Punchy actually drives');
});

test('invented timeline flags are caught', () => {
    const r = validate(JSON.stringify({
        animations: { x: { animation_length: 1, bones: { right_arm: {} }, timeline: { '0.0': 'anim_speed_1;make_it_cool;' } } },
    }));
    assert.match(all(r), /make_it_cool/);
});

test('real timeline flags pass, including parameterised ones', () => {
    const r = validate(JSON.stringify({
        animations: { x: { animation_length: 1, bones: { right_arm: {} }, timeline: { '0.0': 'anim_speed_1.6;keep_arm_tuning;dual_handed;' } } },
    }));
    assert.doesNotMatch(all(r), /unknown timeline flag/);
});

test('geo, mcmeta and model parts are recognised', () => {
    assert.equal(validate(JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.sword' } }] })).type, 'geo');
    assert.equal(validate(JSON.stringify({ pack: { pack_format: 15, description: 'x' } })).type, 'mcmeta');
    assert.equal(validate(JSON.stringify({ dynamic_bone_textures: [{ type: 'geo' }] })).type, 'model_parts');
});

test('pack_format as a string is a real, common error', () => {
    const r = validate(JSON.stringify({ pack: { pack_format: '15', description: 'x' } }));
    assert.match(errs(r), /must be a number/);
});

test('dynamic bone texture rules match the wiki', () => {
    // `bone` is required for texture, not for geo.
    assert.match(errs(validate(JSON.stringify({ dynamic_bone_textures: [{ type: 'texture' }] }))), /`bone` is required/);
    assert.equal(validate(JSON.stringify({ dynamic_bone_textures: [{ type: 'geo' }] })).ok, true);
});

test('entries pasted without their wrapper are explained', () => {
    const r = validate(JSON.stringify({ 'minecraft:bow': { kind: 'BOW' } }));
    assert.equal(r.type, 'compat-unwrapped');
    assert.match(errs(r), /item.*itemSpecific/);
});

test('non-Punchy JSON is reported, not guessed at', () => {
    const r = validate(JSON.stringify({ hello: 'world' }));
    assert.match(all(r), /does not match a Punchy file shape/);
});

test('filename is a fallback hint when shape is ambiguous', () => {
    assert.equal(validate('{}', { filename: 'sword.animation.json' }).type, 'animation');
    assert.equal(validate('{}', { filename: 'pack.mcmeta' }).type, 'mcmeta');
});

test('validation never throws on junk input', () => {
    for (const junk of ['', '   ', 'null', '[]', '"a string"', '12']) {
        assert.doesNotThrow(() => validate(junk), `threw on ${JSON.stringify(junk)}`);
    }
});
