# Shubba's Punchy knowledge base

Shubba's understanding of the mod comes from two layers:

1. **Live knowledge** — fetched at runtime by `getFreshKnowledge()`: the FAQ
   channel, the wiki, Trello, and current Modrinth versions.
2. **Static verified reference** — `lib/punchy-knowledge.js`
   (`PUNCHY_VERIFIED_KNOWLEDGE`), appended to `PUNCHY_STATIC_KNOWLEDGE` and
   injected into every prompt. This is the durable, code-verified core.

The static reference was built from analysis of the shipping **punchy-2.6.x jar**
plus the current wiki at **wiki.punchymod.com** (the newer numbered pages, which
match current code — prefer them over the older GitHub wiki). It intentionally
contains only **user-actionable** facts (config keys, file paths, keybinds,
item/arm kinds, known issues) — no internal class names, matching the bot's
existing "don't leak internals" rule.

## Three corrections it bakes in

These were wrong or stale in older material and would cause Shubba to give bad
advice:

1. **GeckoLib is not required** and not bundled. Only 8 very early `1.0.7`
   alpha/beta builds needed it. Shubba must never tell users to install it.
2. **The `INSERT`/`PAGE UP`/`HOME`/`PAGE DOWN`/`END` debug keybinds don't exist**
   in current builds, and **F8 opens the menu** (it is not "Mirror"). The GitHub
   wiki's "Mod Debug Position" page is stale.
3. **Better Fishing's options keybind defaults to F9** — the same key Punchy uses
   for its Tuning Workbench. A predictable conflict when both are installed.

## Keeping it current

When a new Punchy version ships, update `lib/punchy-knowledge.js` — it's a single
exported string, easy to edit, and requires no other code changes. The live layer
(`getFreshKnowledge()`) already tracks version numbers from Modrinth
automatically, so only durable facts (new config keys, changed keybinds, new
companion mods) need a manual edit here.

## Official roster (keep this correct)

Punchy Guys Studios (Modrinth org `punchy-guys-studios`, id `Vsap1kyd`; public
devs PunchyDevGuy (owner) and Godku) ships **exactly 5** official projects:

1. **Punchy!** — core mod (`punchy-fpa`)
2. **Punchy! x Tiny Takeover** — mod, hard-depends on Punchy!, has a server-side
   component (`tiny-takeover-x-punchy`)
3. **Punchy! - Shuba Totem** — resource pack (`punchy-shuba-totem`)
4. **Enchanted Fishing Line** — mod, client-side, no hard Punchy dep but still
   official (`enchanted-fishing-line`)
5. **Better Fishing** — mod, MC 1.21.1 + 26.2 only (`better-fishing-system`)

Everything else with "punchy" in the name (Hyper Punchy, Refined Torches, etc.,
collection `GypBAs4y`) is **community**, not official. When "what are the Punchy
Guys mods?" is asked, all five must be listed.

Canonical sources: `wiki.punchymod.com` · Modrinth org
`punchy-guys-studios` · Modrinth `punchy-fpa` · Discord `discord.gg/CXttaCyGCN`
(also the official bug tracker).
