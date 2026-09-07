# SOVL Mod Editor

A browser tool for building faction mods for [SOVL](https://store.steampowered.com/app/1870300/).

Author a faction — units, stats, points, properties, effects and your own model art — and export a
`mod.zip` you drop into the game's mods folder. Everything runs in your browser; nothing is uploaded
anywhere, and drafts are kept in your browser's own storage.

**Use it here: https://perwahl.github.io/sovl-mod-editor/**

**[Read the modding guide](https://perwahl.github.io/sovl-mod-editor/guide.html)** — the full
workflow, current limitations, and what every option in the editor does. It is
[`guide.html`](guide.html), served from the same Pages site as the editor and linked from its header.

## Using it

1. Fill in a mod id and a faction, add sections and units.
2. Drop in PNG art for unit cards and models.
3. **Export mod.zip**, then unzip it into the game's mods folder — **Mods → Open folder** in the
   game opens the right place.

**Open mod folder** and **Open mod.zip** load an existing mod back in for editing — a folder if it is
one of yours already installed, a zip if someone sent it to you.

Problems are listed at the bottom of the page as you work. A mod with problems will not load in the
game, so clear them all before exporting.

## Running it locally

It is a plain static page, so any web server will do:

```bash
python -m http.server
```

Opening `index.html` straight from disk also works, but the browser will not let the page read
`catalog.v1.json` next to it, so it asks you to pick that file by hand.

## catalog.v1.json

Describes what the current SOVL build understands: model types, the built-in unit properties, the
effect kinds and conditions you can assemble, army sizes, the colour palette, and every limit your mod
is validated against. The editor will not open without it.

It is **generated from the game**, not written by hand. It is regenerated and committed here when a
SOVL release changes the modding surface, so what this tool offers is always something the shipped
game can actually load. The same file ships inside the game, which is what validates your mod on
import.

## Development

The page has no build step and no dependencies — `index.html`, `editor.js`, `zip.js`. Edit and
reload. Published to GitHub Pages straight from `main`.
