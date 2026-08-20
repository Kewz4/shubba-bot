/**
 * punchy-validate.js — check a creator's file instead of reasoning about it.
 *
 * This exists because of how Shubba failed: it told a creator to override
 * `"type": "useItem"` to stop a bow draw. Every token was real — the path, the
 * ToolKind, the animation type — and the answer was still wrong. A model cannot
 * reliably catch that. A validator can, because it compares against the actual
 * accepted vocabulary in lib/punchy-schema.js.
 *
 * Deterministic by construction: no model involved, so it cannot invent a rule.
 * When it says a key is wrong, the key IS wrong.
 *
 * Types auto-detected from shape (filename is only a fallback hint, because
 * creators rename files constantly):
 *   compat · animation · model_parts · geo · mcmeta
 */

'use strict';

const S = require('./punchy-schema');

const ERROR = 'error', WARN = 'warning', INFO = 'info';

/** Cheap edit-distance check, for "did you mean" suggestions. */
function closeTo(a, b) {
    a = String(a).toLowerCase(); b = String(b).toLowerCase();
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 2) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 2) return false;
        if (a.length > b.length) i++;
        else if (a.length < b.length) j++;
        else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 2;
}

const suggest = (value, list) => list.find(v => closeTo(value, v)) || null;
const hintOf = (v, list) => { const h = suggest(v, list); return h ? ' — did you mean `' + h + '`?' : ''; };

/**
 * Parse JSON, reporting the mistakes creators actually make with a line number
 * rather than a bare "Unexpected token".
 */
function parseJson(text) {
    const raw = String(text == null ? '' : text).replace(/^﻿/, '').trim();
    try {
        return { ok: true, data: JSON.parse(raw) };
    } catch (e) {
        const issues = [];
        const m = /position (\d+)/.exec(e.message);
        const line = m ? raw.slice(0, Number(m[1])).split('\n').length : null;

        if (/,\s*[}\]]/.test(raw)) issues.push({ level: ERROR, msg: 'Trailing comma before a `}` or `]` — JSON does not allow it.' });
        const opens = (raw.match(/[{[]/g) || []).length, closes = (raw.match(/[}\]]/g) || []).length;
        if (opens !== closes) issues.push({ level: ERROR, msg: 'Unbalanced brackets: ' + opens + ' opening vs ' + closes + ' closing.' });
        if (/'[^']*'\s*:/.test(raw)) issues.push({ level: ERROR, msg: 'Keys and strings must use double quotes, not single quotes.' });
        if (/\/\/|\/\*/.test(raw)) issues.push({ level: ERROR, msg: 'JSON does not support comments — remove `//` and `/* */`.' });
        if (!issues.length) issues.push({ level: ERROR, msg: e.message });
        if (line) issues[0].line = line;
        return { ok: false, issues };
    }
}

/** Guess the file type from its shape. */
function detectType(data) {
    if (!data || typeof data !== 'object') return 'unknown';
    if (data.pack && data.pack.pack_format !== undefined) return 'mcmeta';
    if (data.animations && typeof data.animations === 'object') return 'animation';
    if (data['minecraft:geometry']) return 'geo';
    if (Array.isArray(data.dynamic_bone_textures) || data.model_parts || data.definitions) return 'model_parts';
    // Case-INSENSITIVE, deliberately: a file using "ITEM" instead of "item" is
    // still a compat file, and it is exactly the one we most need to detect so
    // validateCompat can tell the author their block is being ignored.
    const lowerKeys = Object.keys(data).map(k => k.toLowerCase());
    if (S.COMPAT_TOP_KEYS.some(k => lowerKeys.includes(k.toLowerCase()))) return 'compat';
    // A bare map of ids → entries is a compat file missing its wrapper.
    if (Object.values(data).some(v => v && typeof v === 'object' && ('kind' in v || 'transforms' in v))) return 'compat-unwrapped';
    return 'unknown';
}

// ─── shared entry check (item / itemSpecific / global*) ─────────────────────

function checkEntry(entry, where, out) {
    if (!entry || typeof entry !== 'object') {
        out.push({ level: ERROR, msg: where + ' should be an object.' });
        return;
    }
    for (const k of Object.keys(entry)) {
        if (!S.ENTRY_KEYS.includes(k)) {
            out.push({ level: WARN, msg: where + ': unknown key `' + k + '`' + hintOf(k, S.ENTRY_KEYS) });
        }
    }

    if (entry.kind !== undefined) {
        const kind = String(entry.kind);
        if (/^[a-z0-9_]+:[a-z0-9_/.]+$/.test(kind)) {
            // A real mistake found in shipping packs.
            out.push({ level: ERROR, msg: where + ': `kind` is "' + kind + '", which is an ITEM ID. `kind` takes a ToolKind such as `SWORD`. To target one exact item, put it under `itemSpecific` instead.' });
        } else if (!S.TOOL_KINDS.includes(kind)) {
            out.push({ level: ERROR, msg: where + ': `kind` "' + kind + '" is not a valid ToolKind' + hintOf(kind, S.TOOL_KINDS) });
        }
    }

    for (const side of ['transforms', 'armTransforms']) {
        const t = entry[side];
        if (t === undefined) continue;
        if (typeof t !== 'object' || Array.isArray(t)) {
            out.push({ level: ERROR, msg: where + ': `' + side + '` must be an object with `right` and/or `left`.' });
            continue;
        }
        for (const hand of Object.keys(t)) {
            if (!['right', 'left'].includes(hand)) {
                out.push({ level: WARN, msg: where + '.' + side + ': `' + hand + '` is not a hand — expected `right` or `left`.' });
                continue;
            }
            const h = t[hand] || {};
            for (const f of Object.keys(h)) {
                if (S.TRANSFORM_FIELDS.includes(f)) {
                    if (typeof h[f] !== 'number') {
                        out.push({ level: ERROR, msg: where + '.' + side + '.' + hand + '.' + f + ' must be a number, got ' + typeof h[f] + '.' });
                    }
                } else {
                    out.push({ level: WARN, msg: where + '.' + side + '.' + hand + ': unknown field `' + f + '`' + hintOf(f, S.TRANSFORM_FIELDS) });
                }
            }
        }
    }

    if (entry.physics !== undefined) {
        if (!Array.isArray(entry.physics)) {
            out.push({ level: ERROR, msg: where + ': `physics` must be an ARRAY of pendulum definitions, e.g. `"physics": [ { "name": "FORWARD_PENDULUM", ... } ]`. An object here silently does nothing.' });
        } else {
            entry.physics.forEach((p, i) => {
                if (!p || typeof p !== 'object') return;
                const at = where + '.physics[' + i + ']';
                if (p.name && !S.PHYSICS_MODES.includes(p.name)) {
                    out.push({ level: ERROR, msg: at + ': `name` "' + p.name + '" is not a physics mode' + hintOf(p.name, S.PHYSICS_MODES) });
                }
                for (const k of Object.keys(p)) {
                    if (!S.PHYSICS_KEYS.includes(k)) {
                        out.push({ level: WARN, msg: at + ': unknown key `' + k + '`' + hintOf(k, S.PHYSICS_KEYS) });
                    }
                }
            });
        }
    }

    const ca = entry.customAnimation;
    if (ca !== undefined) {
        if (!Array.isArray(ca)) {
            out.push({ level: ERROR, msg: where + ': `customAnimation` must be an array.' });
        } else {
            ca.forEach((a, i) => {
                const at = where + '.customAnimation[' + i + ']';
                if (!a || typeof a !== 'object') { out.push({ level: ERROR, msg: at + ' should be an object.' }); return; }

                if (a.type === undefined) {
                    out.push({ level: ERROR, msg: at + ' is missing `type`.' });
                } else if (!S.ANIMATION_TYPES.includes(a.type)) {
                    const typo = S.ANIMATION_TYPE_TYPOS[a.type];
                    const hint = typo ? ' — did you mean `' + typo + '`?' : hintOf(a.type, S.ANIMATION_TYPES);
                    out.push({ level: ERROR, msg: at + ': `type` "' + a.type + '" is not a valid animation type' + hint });
                }

                // The exact shape of the original bad answer.
                if (a.type === 'useItem' && String(entry.kind || '').match(/^(BOW|CROSSBOW)$/)) {
                    out.push({ level: ERROR, msg: at + ': `useItem` does not drive a bow draw. Bow charging is `use_bow` (crossbows: `use_crossbow` / `use_crossbow_shot`). Overriding `useItem` here will not change the draw.' });
                }

                if (a.type === 'triggerable') {
                    if (!a.name) out.push({ level: ERROR, msg: at + ': a `triggerable` needs `name` (the clip to play).' });
                    if (!a.key) out.push({ level: WARN, msg: at + ': no `key` set — give a sensible default; players can rebind it in Controls.' });
                    if (!a.id || !a.title) out.push({ level: INFO, msg: at + ': add `id` and `title` so it shows a friendly name in Controls and survives player remaps across updates.' });
                }
                if (a.type === 'attack' && !a.var_1 && !a.name) {
                    out.push({ level: WARN, msg: at + ': an `attack` normally sets `var_1` (optionally `var_2`/`var_3`) for combo steps.' });
                }
                for (const k of Object.keys(a)) {
                    if (!S.ANIM_ENTRY_KEYS.includes(k)) {
                        out.push({ level: WARN, msg: at + ': unknown field `' + k + '`' + hintOf(k, S.ANIM_ENTRY_KEYS) });
                    }
                }
            });
        }
    }
}

// ─── per-type validators ────────────────────────────────────────────────────

function validateCompat(data, out) {
    for (const k of Object.keys(data)) {
        if (S.COMPAT_TOP_KEYS.includes(k)) continue;
        const h = suggest(k, S.COMPAT_TOP_KEYS);
        if (h && h.toLowerCase() === k.toLowerCase()) {
            // The real bug: a shipping pack used "ITEM" and did nothing at all.
            out.push({ level: ERROR, msg: 'Top-level key `' + k + '` has the wrong case — Punchy expects `' + h + '`. As written this entire block is ignored.' });
        } else {
            out.push({ level: WARN, msg: 'Unknown top-level key `' + k + '`' + hintOf(k, S.COMPAT_TOP_KEYS) });
        }
    }

    if (data.customGroups !== undefined) {
        if (!Array.isArray(data.customGroups)) {
            out.push({ level: ERROR, msg: '`customGroups` must be an ARRAY of `{ "name": ..., "items": [...] }`.' });
        } else {
            data.customGroups.forEach((g, i) => {
                if (!g || typeof g !== 'object') return;
                if (!g.name) out.push({ level: ERROR, msg: 'customGroups[' + i + '] is missing `name`.' });
                if (!Array.isArray(g.items)) {
                    out.push({ level: ERROR, msg: 'customGroups[' + i + '].items must be an array of item IDs.' });
                } else {
                    g.items.forEach(it => {
                        if (typeof it === 'string' && !it.includes(':')) {
                            out.push({ level: WARN, msg: 'customGroups[' + i + ']: "' + it + '" has no namespace — use `minecraft:' + it + '`.' });
                        }
                    });
                }
            });
        }
    }

    const groupNames = (Array.isArray(data.customGroups) ? data.customGroups : []).map(g => g && g.name).filter(Boolean);

    if (data.item && typeof data.item === 'object') {
        for (const key of Object.keys(data.item)) {
            if (!S.TOOL_KINDS.includes(key) && !groupNames.includes(key)) {
                out.push({ level: ERROR, msg: '`item.' + key + '` is neither a ToolKind nor a group defined in `customGroups`' + hintOf(key, S.TOOL_KINDS.concat(groupNames)) });
            }
            checkEntry(data.item[key], 'item.' + key, out);
        }
    }
    if (data.itemSpecific && typeof data.itemSpecific === 'object') {
        for (const id of Object.keys(data.itemSpecific)) {
            if (!id.includes(':')) out.push({ level: WARN, msg: 'itemSpecific: "' + id + '" has no namespace — use `minecraft:' + id + '`.' });
            checkEntry(data.itemSpecific[id], 'itemSpecific["' + id + '"]', out);
        }
    }
    for (const g of ['globalItem', 'globalArm', 'emptyHand']) {
        if (data[g]) checkEntry(data[g], g, out);
    }
}

function validateAnimation(data, out) {
    const anims = data.animations || {};
    const names = Object.keys(anims);
    if (!names.length) {
        out.push({ level: ERROR, msg: 'No animations found — expected `{"animations": { "<name>": { ... } }}`.' });
        return;
    }
    for (const name of names) {
        const a = anims[name] || {};
        const bones = Object.keys(a.bones || {});
        if (!bones.length) {
            out.push({ level: WARN, msg: '"' + name + '" has no `bones` — it will not move anything.' });
        } else if (!bones.some(b => S.PUNCHY_BONES.includes(b))) {
            out.push({ level: WARN, msg: '"' + name + '" keyframes none of Punchy\'s bones (' + S.PUNCHY_BONES.join(', ') + '). For a held item use `itemgrip_right`/`itemgrip_left`; for the arm use `right_arm`/`left_arm`.' });
        }
        if (a.animation_length === undefined) {
            out.push({ level: INFO, msg: '"' + name + '" has no `animation_length` — Blockbench normally writes one.' });
        }
        for (const [t, v] of Object.entries(a.timeline || {})) {
            const items = Array.isArray(v) ? v : [v];
            for (const s of items) {
                if (typeof s !== 'string') continue;
                for (const tok of s.split(';').map(x => x.trim()).filter(Boolean)) {
                    const ok = S.TIMELINE_FLAGS.includes(tok) || S.TIMELINE_FLAG_PREFIXES.some(p => tok.startsWith(p));
                    if (!ok) {
                        out.push({ level: WARN, msg: '"' + name + '" @' + t + ': unknown timeline flag `' + tok + '`' + hintOf(tok, S.TIMELINE_FLAGS) });
                    }
                }
            }
        }
    }
}

function validateModelParts(data, out) {
    if (Array.isArray(data.dynamic_bone_textures)) {
        data.dynamic_bone_textures.forEach((d, i) => {
            const type = d && d.type ? d.type : 'texture';
            if (!['texture', 'geo'].includes(type)) {
                out.push({ level: ERROR, msg: 'dynamic_bone_textures[' + i + ']: `type` must be `texture` or `geo`.' });
            }
            if (type === 'texture' && !(d && d.bone)) {
                out.push({ level: ERROR, msg: 'dynamic_bone_textures[' + i + ']: `bone` is required when `type` is `texture`.' });
            }
        });
    } else {
        out.push({ level: INFO, msg: 'Model Parts file recognised, but there is no `dynamic_bone_textures` array to check.' });
    }
}

function validateGeo(data, out) {
    if (!data.format_version) out.push({ level: WARN, msg: 'Geo model has no `format_version`.' });
    const geo = data['minecraft:geometry'];
    if (!Array.isArray(geo) || !geo.length) {
        out.push({ level: ERROR, msg: 'Expected a `minecraft:geometry` array — export from Blockbench as a Bedrock Geometry model.' });
        return;
    }
    geo.forEach((g, i) => {
        const id = g && g.description && g.description.identifier;
        if (!id) out.push({ level: ERROR, msg: 'minecraft:geometry[' + i + '] has no `description.identifier`.' });
        else if (!String(id).startsWith('geometry.')) out.push({ level: WARN, msg: 'identifier "' + id + '" normally starts with `geometry.`' });
    });
}

function validateMcmeta(data, out) {
    const f = data && data.pack && data.pack.pack_format;
    if (f === undefined) out.push({ level: ERROR, msg: '`pack.pack_format` is missing.' });
    else if (typeof f !== 'number') out.push({ level: ERROR, msg: '`pack.pack_format` must be a number, not a string.' });
    if (!(data && data.pack && data.pack.description)) out.push({ level: WARN, msg: '`pack.description` is missing.' });
}

/**
 * @param {string} text raw file contents
 * @param {{filename?: string}} [opts]
 * @returns {{type:string, ok:boolean, issues:Array<{level:string,msg:string,line?:number}>}}
 */
function validate(text, opts) {
    const parsed = parseJson(text);
    if (!parsed.ok) return { type: 'invalid-json', ok: false, issues: parsed.issues };

    const data = parsed.data;
    let type = detectType(data);
    const fn = String((opts && opts.filename) || '').toLowerCase();
    if (type === 'unknown') {
        if (fn.endsWith('.animation.json')) type = 'animation';
        else if (fn.endsWith('.geo.json')) type = 'geo';
        else if (fn.endsWith('.mcmeta')) type = 'mcmeta';
    }

    const issues = [];
    switch (type) {
        case 'compat': validateCompat(data, issues); break;
        case 'compat-unwrapped':
            issues.push({ level: ERROR, msg: 'These look like compat entries without their wrapper. Item entries belong under `item` (for a ToolKind or custom group) or `itemSpecific` (for one exact item ID).' });
            break;
        case 'animation': validateAnimation(data, issues); break;
        case 'model_parts': validateModelParts(data, issues); break;
        case 'geo': validateGeo(data, issues); break;
        case 'mcmeta': validateMcmeta(data, issues); break;
        default:
            issues.push({ level: INFO, msg: 'Valid JSON, but it does not match a Punchy file shape (compat, animation, model parts, geo, or pack.mcmeta).' });
    }
    return { type, ok: !issues.some(i => i.level === ERROR), issues };
}

module.exports = { validate, parseJson, detectType, ERROR, WARN, INFO };
