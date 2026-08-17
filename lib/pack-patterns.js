/**
 * pack-patterns.js — what REAL, WORKING Punchy compat packs actually look like.
 *
 * Derived by parsing 137 compat files and 75 animation files from 14 shipping
 * community resource packs (2026-08-17). This is structural evidence, not
 * documentation: it records which keys, types and value vocabularies authors
 * actually use, and in what proportion.
 *
 * WHY THIS EXISTS
 * Shubba's worst failure mode is composing a config that is individually valid
 * everywhere and wrong as a whole — real path, real ToolKind, real animation
 * type, wrong answer. Frequency data fixes that: if 163 real packs route attack
 * animations through `attack` + `var_1` and exactly 4 use `use_bow`, then a bow
 * question has one obvious shape and inventing another is a mistake.
 *
 * PRIVACY / ATTRIBUTION RULE — NON-NEGOTIABLE
 * The packs were shared privately for learning. Nothing here names a pack, an
 * author, an asset, a texture, or a model, and nothing here may be attributed
 * to one. Shubba must never say "as seen in <pack>", never recommend or compare
 * specific community packs from this data, and never reproduce pack-specific
 * values as if they were defaults. Teach the SHAPE, never the source.
 */

'use strict';

const PACK_PATTERNS_KNOWLEDGE = `
════════════════════════════════════════════════════════════
VERIFIED COMPAT-PACK STRUCTURE (measured from working packs)
Use these shapes when a creator asks "how do I write this".
Frequencies show what authors really do — prefer the common form.
════════════════════════════════════════════════════════════

FILE LOCATION
  assets/minecraft/punchy/compat/<any_name>.json   (every .json in that folder loads)
  Reload in-game with F3 + T after editing.

TOP-LEVEL KEYS, by how often they appear
  item           — tune a whole ToolKind or a customGroup   (most common by far)
  customGroups   — define your own named group of item IDs
  itemSpecific   — tune ONE exact item ID; overrides group/kind
  globalArm / globalItem  — apply to everything (use sparingly)
  emptyHand      — the empty-hand pose
  default_animations
  NOTE: keys are case-sensitive. A file using "ITEM" instead of "item" silently
  does nothing — that is a real mistake found in shipping packs.

KEYS INSIDE AN item / itemSpecific ENTRY
  kind, transforms          — the core pair, present in nearly every entry
  armKind, armTransforms    — the arm equivalents
  customAnimation           — array of animation routing entries
  physics                   — array (see below)
  Boolean behaviour flags actually used in the wild:
    disable_sprint_lateral_tilt, keep_arm_tuning, keep_trigger_arm_tuning,
    disable_swim_animation, disable_walk_on_water_animation

TRANSFORM FIELDS (identical for transforms and armTransforms, per hand)
  scale, offX, offY, offZ, rotX, rotY, rotZ, pivotX, pivotY, pivotZ
  Shape: "transforms": { "right": { ...fields }, "left": { ...fields } }
  pivot* appears about as often as off*/rot* — pivot is normal, not exotic.

customGroups — shape is an ARRAY of objects:
  "customGroups": [
    { "name": "MY_GROUP", "items": ["minecraft:painting", "minecraft:item_frame"] }
  ]
  Group names are UPPERCASE by convention. Reference the group by its name in
  the "item" block exactly as you would a built-in ToolKind.

customAnimation TYPES, by real-world usage
  attack (by far the most common), triggerable, mining, inspect, useItem,
  interaction, hand_in, hand_out, mining_v2, use_drink, use_bow, use_crossbow,
  use_crossbow_shot, spear_charge, use_shield, falling, idle
  Fields seen inside an entry: type, name, var_1, var_2, critical_hit, key,
  items, animation, blockState
  - attack uses var_1 / var_2 for combo steps, plus optional critical_hit.
  - triggerable is { "type": "triggerable", "name": "<clip>", "key": "I" } —
    a single-letter default key the PLAYER can then remap in Controls.
  - Bows use use_bow. Do NOT reach for useItem for a bow.
  - Casing matters: use_drink is correct; "useDrink" appears once in the wild
    and is a typo, not an alternative spelling.

physics — an ARRAY of pendulum definitions:
  "physics": [
    { "name": "FORWARD_PENDULUM", "limitDegUp": 90, "limitDegDown": 5,
      "force": 0.5, "speed": 2, "cameraSens": 0.25, "gravity": 55,
      "handSpace": false }
  ]
  Modes seen: FORWARD_PENDULUM, FULL_PENDULUM.

ToolKind VALUES AUTHORS ACTUALLY TUNE (most-used first)
  BLOCK, INGREDIENT, SWORD, BUTTON_PLATE, TRAPDOOR, BOAT, CARPET, BED, SPEAR,
  AXE, CHEST, FULL_BLOCK, MINECART, TRIDENT, CREATURE_BUCKET, BUCKET, FOOD,
  BOW, HOE, SHOVEL, LANTERN, PICKAXE, SHIELD, CROSSBOW
  BLOCK and INGREDIENT dominate because they cover huge swathes of items in one
  entry — suggest a group/kind edit before a per-item one.
  GOTCHA: a couple of shipping packs put an item ID (e.g. "minecraft:bow") where
  a ToolKind belongs. If a creator's kind isn't matching, check for that.

ANIMATION FILES
  Bedrock-format .animation.json. Bones that carry Punchy meaning:
    right_arm, left_arm       — move the whole arm (item follows rigidly)
    itemgrip_right, itemgrip_left — move the held item independently of the arm
    camera                    — camera motion
  If a clip has no itemgrip_* keyframes, the item cannot move independently of
  the arm — that is the usual reason an item "doesn't follow the animation".

TIMELINE EFFECT FLAGS — real syntax is semicolon-terminated tokens in one string
  "anim_speed_1;"                      speed multiplier (1, 1.2, 1.5, 1.6, 2 seen)
  "dual_handed;"                       both hands participate
  "keep_arm_tuning;"                   preserve arm tuning through the clip
  "hide_item;"                         hide the held item for the segment
  "start_mesh_animation;"              begin the mesh animation
  "left_switch_item_minecraft:arrow;"  swap the shown item mid-clip
  "hide_left_switch_item_<id>;"        hide a switched item (supports *)
  Combine by concatenating: "anim_speed_1.6;keep_arm_tuning;"
  Do NOT invent flag names. If the effect a creator wants isn't in the wiki's
  Flags Reference or Animation Effects page, say so rather than guessing.
════════════════════════════════════════════════════════════
`.trim();

module.exports = { PACK_PATTERNS_KNOWLEDGE };
