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

OFFICIAL PUNCHY GUYS STUDIOS ROSTER — the COMPLETE list (Modrinth org "Punchy
Guys Studios": slug punchy-guys-studios, id Vsap1kyd; public devs: PunchyDevGuy
(owner) and Godku). There are EXACTLY 5 official projects, ALL made by Punchy
Guys Studios. When anyone asks "what are all the Punchy Guys mods?" list ALL
FIVE — never omit any, and never call any of these a community pack:
  1. Punchy! — the core mod. First Person Animations ("FPA" is only in the slug).
     Client-side. Modrinth slug: punchy-fpa.
  2. Punchy! x Tiny Takeover ("Punchy Puppies") — mod. Hold/play with baby mobs.
     Hard-depends on Punchy!. Has a SERVER-SIDE component (carry/fetch/whistle
     sync) — warn about anti-cheat ban risk on multiplayer servers. Ships Fabric,
     Forge AND NeoForge; MC 1.20.1, 1.21.1, 26.1.x, 26.2. Slug: tiny-takeover-x-punchy.
  3. Punchy! - Shuba Totem — a RESOURCE PACK (not a mod). Turns the Totem of
     Undying into a 3D dancing Shubba via Model Parts. Slug: punchy-shuba-totem.
  4. Enchanted Fishing Line — mod. Client-side, physics-simulated fishing line;
     no config, no keybinds. It does NOT hard-depend on Punchy! and runs
     standalone (use it with or without Punchy!) — but it IS an official Punchy
     Guys Studios mod, NOT a community pack. Slug: enchanted-fishing-line.
  5. Better Fishing — mod. Client-side fishing minigame (Line Tension / Catch
     Progress; red tension = line snaps). MC 1.21.1 and 26.2 ONLY. Config:
     config/better_fishing.properties (NOT JSON). Options keybind defaults to F9
     — same key as Punchy's Tuning Workbench, so warn of the conflict when both
     are installed. Slug: better-fishing-system.
Org page: modrinth.com/organization/punchy-guys-studios
NOT official — community (never attribute these to Punchy Guys Studios): Hyper
Punchy, Untitled Punchies, Refined Torches, and everything else in the curated
community collection (Modrinth collection GypBAs4y). They work WITH Punchy! but
are made by third parties. If asked whether one is "official", say no.

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

OFFICIAL PUNCHY GUYS STUDIOS MODS (all by the same org that makes Punchy! — see
the full roster at the top; extra usage detail here):
- Punchy! x Tiny Takeover ("Punchy Puppies"): hold/play with baby mobs. Carry =
  crouch + right-click with an empty hand; "I" plays with a held baby wolf;
  whistle keybinds call baby wolves. Server-side component → anti-cheat ban risk.
- Enchanted Fishing Line: OFFICIAL Punchy Guys mod. Client-side, physics-simulated
  fishing line; no config, no keybinds. Runs standalone (no hard Punchy!
  dependency) but is still official, NOT a community pack.
- Better Fishing: catch minigame (Line Tension / Catch Progress; red tension =
  line snaps). MC 1.21.1 and 26.2 ONLY. Config config/better_fishing.properties (a
  .properties file, NOT JSON). Keybind defaults to F9 (see conflict note above).
  "You are scaring the fish, move 6 blocks away" is BY DESIGN, not a bug.
- Punchy! - Shuba Totem: official RESOURCE PACK turning the Totem of Undying into a
  3D dancing Shubba via Model Parts. A good complete worked example for pack authors.

COMMUNITY (NOT official Punchy Guys) — third-party packs/mods that work WITH
Punchy! but aren't made by the org: curated collection Modrinth GypBAs4y (e.g.
Hyper Punchy, Untitled Punchies, Refined Torches). If asked if one is official, say no.

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
