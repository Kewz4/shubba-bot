/**
 * punchy-schema.js — the vocabularies Punchy actually accepts.
 *
 * Sourced from two places, not from memory:
 *   - the wiki corpus (Compat Pack Reference, Animation and Tuning Reference,
 *     Flags Reference), and
 *   - 137 compat files + 75 animation files from shipping community packs.
 *
 * Keep this file boring and factual. It is the ground truth the validator
 * checks against, so a wrong entry here becomes a wrong error message.
 */

'use strict';

// VanillaFirstPersonItemLayer.ToolKind
const TOOL_KINDS = [
    'EMPTY_HAND', 'AXE', 'PICKAXE', 'HOE', 'SWORD', 'SHOVEL', 'SHIELD',
    'BLOCK', 'FULL_BLOCK', 'BLOCK_DOUBLE', 'BUILDING_BLOCKS', 'COLORED_BLOCKS',
    'NATURAL_BLOCKS', 'FUNCTIONAL_BLOCKS', 'CHEST', 'TORCH', 'LANTERN',
    'FLOWER_PENDULUM', 'CREATURE_BUCKET', 'BUCKET', 'MINECART', 'BOAT',
    'BUTTON_PLATE', 'TRAPDOOR', 'CARPET', 'BED', 'BOW', 'ARROW', 'CROSSBOW',
    'SPYGLASS', 'FLINT', 'FOOD', 'SHUBBA_DUCK', 'MACE', 'SPEAR', 'TRIDENT',
    'FISHING_ROD', 'REDSTONE', 'INGREDIENT',
];

// customAnimation "type" values.
const ANIMATION_TYPES = [
    'attack', 'mining', 'mining_v2', 'useItem', 'interaction', 'inspect',
    'hand_in', 'hand_out', 'falling', 'triggerable', 'idle',
    'walk_on_water_v2', 'spear_charge', 'fishingrod',
    'use_shield', 'use_bow', 'use_crossbow', 'use_crossbow_shot',
    'useeat', 'usedrink', 'in_water',
];

// Spellings seen in real packs that Punchy does NOT accept, and what was meant.
const ANIMATION_TYPE_TYPOS = {
    usedrink_: 'usedrink',
    use_drink: 'usedrink',
    useDrink: 'usedrink',
    use_eat: 'useeat',
    useItem_: 'useItem',
    useitem: 'useItem',
    use_item: 'useItem',
    attack_: 'attack',
};

const TRANSFORM_FIELDS = [
    'scale', 'offX', 'offY', 'offZ', 'rotX', 'rotY', 'rotZ',
    'pivotX', 'pivotY', 'pivotZ',
];

// Keys valid inside an item / itemSpecific / global* entry.
const ENTRY_KEYS = [
    'kind', 'armKind', 'transforms', 'armTransforms', 'customAnimation',
    'customItemAnimations', 'physics', 'particles', 'particle_emitters',
    'betterCombat', 'disable_sprint_lateral_tilt', 'keep_arm_tuning',
    'keep_trigger_arm_tuning', 'disable_swim_animation',
    'disable_walk_on_water_animation',
];

const COMPAT_TOP_KEYS = [
    'item', 'itemSpecific', 'customGroups', 'globalItem', 'globalArm',
    'emptyHand', 'default_animations', 'chestProxy', 'paddleProxy',
    'fishingLineProxy', 'enchantParticleProxy',
];

const PHYSICS_MODES = ['FORWARD_PENDULUM', 'FULL_PENDULUM'];
const PHYSICS_KEYS = [
    'name', 'limitDegUp', 'limitDegDown', 'force', 'speed', 'cameraSens',
    'gravity', 'handSpace',
];

// Fields allowed inside one customAnimation entry.
const ANIM_ENTRY_KEYS = [
    'type', 'name', 'var_1', 'var_2', 'var_3', 'critical_hit', 'key', 'id',
    'title', 'items', 'animation', 'blockState', 'start', 'looping', 'end',
    'stage_1', 'stage_2', 'stage_3', 'throw', 'pull', 'min_blocks',
];

// Bones Punchy gives meaning to in a .animation.json.
const PUNCHY_BONES = ['right_arm', 'left_arm', 'itemgrip_right', 'itemgrip_left', 'camera'];

// Timeline effect flag prefixes. Parameterised ones (anim_speed_1.6) are
// matched by prefix, so this list stays short.
const TIMELINE_FLAGS = [
    'dual_handed', 'keep_arm_tuning', 'keep_trigger_arm_tuning', 'hide_item',
    'start_mesh_animation', 'disable_tuning', 'disable_arm_tuning',
];
const TIMELINE_FLAG_PREFIXES = [
    'anim_speed_', 'left_switch_item_', 'right_switch_item_',
    'hide_left_switch_item_', 'hide_right_switch_item_',
];

module.exports = {
    TOOL_KINDS, ANIMATION_TYPES, ANIMATION_TYPE_TYPOS, TRANSFORM_FIELDS,
    ENTRY_KEYS, COMPAT_TOP_KEYS, PHYSICS_MODES, PHYSICS_KEYS, ANIM_ENTRY_KEYS,
    PUNCHY_BONES, TIMELINE_FLAGS, TIMELINE_FLAG_PREFIXES,
};
