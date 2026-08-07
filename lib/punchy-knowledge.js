/**
 * punchy-knowledge.js — curated, verified Punchy! reference for Shubba's prompts.
 *
 * Source: analysis of the shipping punchy-2.6.2 jar + wiki.punchymod.com (the
 * newer numbered wiki, which matches current code) + Modrinth. Only
 * user-actionable facts live here (config keys, file paths, keybinds, item/arm
 * kinds, known issues). No internal class names — those stay out of anything
 * that can reach users, per the bot's existing "don't leak internals" rule.
 *
 * Kept deliberately tight so it fits the prompt token budget alongside the live
 * FAQ/wiki/Modrinth knowledge. Exported as one string and appended to
 * PUNCHY_STATIC_KNOWLEDGE in index.js.
 */
'use strict';

const PUNCHY_VERIFIED_KNOWLEDGE = `
--- PUNCHY! VERIFIED REFERENCE (from the shipping 2.6.x jar + current wiki) ---

CORRECTIONS — these override any older/stale info:
- GeckoLib is NOT required and NOT bundled. Only 8 very early 1.0.7 alpha/beta
  builds ever needed it. NEVER tell a user to install GeckoLib. (Animations are
  authored in Blockbench/GeckoLib FORMAT, but the mod ships its own engine.)
- Debug keybinds INSERT / PAGE UP / HOME / PAGE DOWN / END do NOT exist in
  current versions. The old GitHub "Mod Debug Position" wiki page is stale.
  Prefer wiki.punchymod.com (the numbered pages) over the GitHub wiki.
- Better Fishing's options keybind defaults to F9 — the SAME key Punchy uses for
  its Tuning Workbench. If a user has both installed and F9 "does the wrong
  thing", that's the conflict; have them rebind one in Controls.

WHAT "FPA" MEANS: First Person Animations. The display name is just "Punchy!";
"FPA" only appears in the Modrinth URL slug (punchy-fpa).

PLATFORM / DEPENDENCIES:
- 100% CLIENT-SIDE (client: required, server: unsupported). It does nothing
  installed on a server jar.
- MC versions: 1.20.1, 1.21.1, 1.21.5, 1.21.11, plus the 26.x line
  (26.1, 26.1.1, 26.1.2, 26.2). Loaders: Fabric, Forge, NeoForge. NO Quilt.
- Fabric REQUIRES Fabric API (even though Modrinth doesn't list it as a dep).
- Java floor rises with MC version — the 26.2 build needs Java >=25. A "won't
  launch" report on 26.2 is very often a Java-version problem. Ask for the exact
  MC version + Java version + loader before deep-diving a launch crash.
- Latest version is the 2.6.x line. Always confirm the user's exact
  punchy-<ver>-<loader>-<mc>.jar filename — many "bugs" are fixed in a newer build.

KEYBINDS (current builds — defaults):
- F8  = open the Punchy menu (settings). Also opens the Tuning Workbench via a button.
- F9  = Tuning Workbench control (closes it in current builds).
- F6  = save session   F7 = toggle grip pivot   R = reset   I = inspect
- Numpad 4/5/6 = axis X/Y/Z   Numpad 7/8 = target arm R/L   Numpad 9/0 = target item R/L
- Up/Down = adjust value   Numpad Enter = print   (hold Sprint = 5x step, Shift = 0.2x step)
- In-game helpers: F3+H shows item IDs; F3+T reloads resource packs after editing pack JSON.
- Commands: /punchy debugposition, /punchy pos <x y z>, /punchy rot <x y z>, /punchy scale <s>.

CONFIG FILE LOCATIONS (under .minecraft/):
- config/punchy/punchy_config.json          — main settings
- config/punchy/punchy_tuning.json          — saved item/arm tuning
- config/punchy/creator_tuning_helper.json  — clean export for compat packs
                                              (ONLY exports item + itemSpecific;
                                               copy armMesh from punchy_tuning.json by hand)
- config/punchy/config_profiles/ and mix_profiles/ — saved profiles

MAIN SETTINGS — note the INCONSISTENT enableX / disableX naming (a top confusion source):
- enableMod (master switch), enableTuning (default OFF — must be ON to use tuning keys)
- renderArmorArmsFP (first-person armor sleeves), animationSpeed (float)
- disableArmPhysics, disableNativeItemPhysics (UI shows these as "Enable ... Physics")
- disableResourcePackModelParts, disableChestModels, disablePistonModels,
  disableEnchantingTableModels, disableBoatMinecartRaftModels, disableBoatFirstPersonAnimations
- enableCrawlAnimation, enableClimbAnimation, enableSwimAnimation, enableElytraFlightAnimation,
  enableCustomWalk (NOTE: this disables vanilla view-bobbing by design),
  enableSprintArmSwing, enableFallArmAnimation
- firstPersonModelHideEnabled + firstPersonModelHidePitch (default 60; set >85 shows as "never")
- itemBlacklist (array), compat toggles: bettercombatCompat, swordBlockingCompat,
  interactiveStuffCompat

ITEM BLACKLIST: turns Punchy OFF for chosen items so they look vanilla.
Use "modid:item" for one item, or "modid" for a whole mod. Regex is supported
(2.3+). Find an item's ID with F3+H. Each entry has a "Dual" (dual-handed) toggle.

RESOURCE PACK COMPATIBILITY (for pack authors):
- Compat files go in: assets/minecraft/punchy/compat/<any_name>.json  (all JSON there is loaded)
- Priority within a pack: specific item > group > global. Renamed / customModelData
  matches are more specific than a plain item id.
- Geo mapping file: assets/<namespace>/punchy/<anything>rp_geo_map.json — maps a
  vanilla item to a custom geo. Keys "geo" AND "model" both work ("model" maps to a
  Java item model; the official Shuba Totem pack uses "model"). Put the most
  specific mapping first; require_enchant needs the full enchantment id.
- Model Parts definitions: assets/<namespace>/punchy/model_parts_items/definitions/*.json
- ALWAYS reload with F3+T after editing pack JSON.
- Authoring flow: position visually in F8/Workbench -> export helper (or F6) ->
  copy from creator_tuning_helper.json into your compat file -> F3+T.
- Physics modes: NONE, FULL_PENDULUM, FORWARD_PENDULUM.
- Item kinds (for item.<KIND> / itemSpecific.kind): EMPTY_HAND, AXE, PICKAXE, HOE,
  SWORD, SHOVEL, SHIELD, BLOCK, FULL_BLOCK, BUILDING/COLORED/NATURAL/FUNCTIONAL_BLOCKS,
  CHEST, TORCH, LANTERN, BOW, ARROW, CROSSBOW, SPYGLASS, FOOD, MACE, SPEAR, TRIDENT,
  FISHING_ROD, BUCKET, CREATURE_BUCKET, MINECART, BOAT, BED, REDSTONE, INGREDIENT, etc.
- "compat" file = how the HAND HOLDS the item. Model Parts "definition" = how the
  3D ITEM MODEL behaves. Different systems.

MODEL PARTS "nothing renders" #1 cause: a definition MUST have items(or item) + geo
+ texture. Miss any one and it's discarded SILENTLY. Unknown keys are ignored
silently too. Animated-texture height must equal frame_height x frames or it's
ignored. Animation-timeline particles are disabled — emit particles from the
definition's "particles", not the .animation timeline.

COMPANION MODS:
- Punchy! x Tiny Takeover ("Punchy Puppies"): hold/play with baby mobs. HARD
  dependency on Punchy. It's SERVER-SIDE — warn users NOT to use it on servers
  with anti-cheat (ban risk). Carry = crouch + right-click empty hand; "I" plays
  with a held baby wolf; whistle keybinds call baby wolves.
- Enchanted Fishing Line: physics-simulated fishing line, 100% client-side, NO
  config, NO keybinds, NO Punchy dependency. Pure renderer.
- Better Fishing: catch minigame (Line Tension / Catch Progress; red tension = line
  snaps). MC 1.21.1 and 26.2 ONLY. Config is config/better_fishing.properties (a
  .properties file, NOT JSON). Its keybind defaults to F9 (see conflict note above).
  "You are scaring the fish, move 6 blocks away" is BY DESIGN, not a bug.
- Punchy! - Shuba Totem: resource pack turning the Totem of Undying into a 3D
  dancing Shubba via Model Parts. A good complete worked example for pack authors.
- Curated compatible packs/mods: Modrinth collection GypBAs4y.

COMMON ISSUES -> FIRST MOVES:
- FPS drops / stutter: usually a MOD CONFLICT, not Punchy itself. Binary-search the
  modlist; suspect particle-heavy Model Parts packs. (Dev's own stated position.)
- Shaders: Iris/Oculus is supported. Complementary shaders recommended for best
  particle/emissive visuals. Many shader glitches are fixed in newer builds — update first.
- On 1.20.1 and 1.21.1, particle GLOW and boat/raft animation are intentionally
  missing/off. A user asking why glow doesn't work there is NOT misconfigured.
- Fresh Animations / EMF+ETF piece-splitting, 3D Skin Layers, trident inversion,
  minecart/chest crashes: these were bugs FIXED in the 2.5.x–2.6.x line. If a user
  hits one, first confirm they're on the latest jar.
- "Punchy changed my GUI scale": the menu temporarily forces GUI Scale 1 while
  open and restores on close; a crash while open can leave it at 1. Harmless.
- Shield animation is intentionally one-handed (preserves vanilla swing-cancel).

SUPPORT LINKS: Discord discord.gg/CXttaCyGCN (also the official bug tracker).
Wiki wiki.punchymod.com (prefer over the GitHub wiki).
`;

module.exports = { PUNCHY_VERIFIED_KNOWLEDGE };
