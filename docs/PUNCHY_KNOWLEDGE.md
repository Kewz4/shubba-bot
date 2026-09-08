# Shubba's Punchy knowledge base

Shubba's understanding of the mod comes from two layers:

1. **Live knowledge** — fetched at runtime by `getFreshKnowledge()`: the FAQ
   channel, the wiki, Trello, and current Modrinth versions.
2. **Static verified reference** — `lib/punchy-knowledge.js`
   (`PUNCHY_VERIFIED_KNOWLEDGE`), appended to `PUNCHY_STATIC_KNOWLEDGE` and
   injected into every prompt. This is the durable, code-verified core.

The static reference was built from analysis of the shipping **punchy-2.6.x jar**
plus the current wiki at **wiki.punchymod.com** (the newer numbered pages, which
match current code — prefer them over the older GitHub wiki).

> ⚠️ **Re-verified 2026-08-14:** those numbered pages are **not currently
> readable** at wiki.punchymod.com — the site reports 0 synced guides and serves
> an empty shell on every route (details in "Wiki sources" below). The facts in
> `lib/punchy-knowledge.js` still stand on the jar analysis, but they could not
> be re-confirmed against the live wiki on this date.

It intentionally
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

## Wiki sources: what we link vs. what we ingest (verified 2026-08-14)

These are deliberately two different URLs in `index.js`:

| Constant | Value | Purpose |
| --- | --- | --- |
| `WIKI_LINK` | `https://wiki.punchymod.com/` | Canonical link **shown to users** |
| `WIKI_BASE_URL` | `raw.githubusercontent.com/wiki/punchy-guys/punchy-wiki/` | Article text **ingested** by `getFreshKnowledge()` |

They differ because **wiki.punchymod.com currently serves no machine-readable
article content.** Measured directly:

- Every route (`/en-us/home`, `/en-us/compat`, `/en-us/debug`, …) returns one
  byte-identical **26,572-byte** client-rendered shell.
- The page reports its own status as **"Guias: 0 / 0 não sincronizado"**
  (0 guides, 0 synced).
- No `/api/` route, no `__NEXT_DATA__` / `__next_f` payload to parse.
- `sitemap.xml` lists 113 URLs (8 locales × 14 slugs: `home`, `animation`,
  `animation-effects`, `animation-conditions`, `dynamic-textures`,
  `model-parts-items`, `model-parts-overview`, `model-parts-variants`,
  `particles`, `pendulum-physics`, `compat`, `flags-reference`, `debug`,
  `tutorials`) — but they are routes, not yet content.
- The site itself links back to the GitHub wiki, labelled "GitHub Original".

So the GitHub raw markdown remains the only actual source of article prose.
**When wiki.punchymod.com finishes syncing, repoint `WIKI_BASE_URL` at it** —
its locale codes are lowercase (`en-us`), unlike the GitHub `EN-US` folders.

`Punchy!-Mod-Debug-Position` has been **removed from `WIKI_PAGES`** and must not
be re-added: it documents the non-existent INSERT/PAGE UP/HOME/PAGE DOWN/END
keybinds and mislabels F8 as "Mirror".

## Forum tags come from Discord, not from code

`TAG_CATEGORIES` in `index.js` is no longer a hardcoded list. It is a live view
over the two forums' `channel.availableTags` (`#🪲│bug-report`
`1433994315402838127`, `#⁉️│wiki-questions` `1541938344324243586`), refreshed in
the background every 10 minutes. Adding a version tag in Discord is now enough —
no code change. Pure helpers live in `lib/forum-tags.js` (tested in
`test/forum-tags.test.js`), including the explicit **5-tags-per-thread cap**
Discord enforces.

`FALLBACK_TAG_CATEGORIES` is used only if the API read fails; it is current as
of 2026-08-14 and must be updated per Minecraft release.

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
