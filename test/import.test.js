import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillShownValues, readModFiles, referencedImages, validate } from '../modformat.js';

const readText = (path) => readFileSync(new URL(path, import.meta.url));
const readJson = (path) => JSON.parse(readText(path).toString('utf8'));

const catalog = readJson('../catalog.v1.json');
const encoder = new TextEncoder();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// The spellcaster mod as a modder might write it by hand: the game loads it (comments, trailing commas, a byte
// order mark, single quotes, an unquoted key, a field in the wrong case, "./" and backslash paths, a path in the
// wrong case). The editor should read it as the same mod it exports itself.
const workshopFiles = () => new Map([
  ['manifest.json', readText('./fixtures/workshop/manifest.json')],
  ['factions/Spellcaster.json', readText('./fixtures/workshop/factions/Spellcaster.json')],
  ['images/icon.png', png],
  ['images/unit.png', png],
  ['preview.png', png],
]);
const cleanFaction = () => readJson('./fixtures/spellcaster/export/factions/spellcaster.json');

/** The same files under a folder prefix, as a picked folder or a zipped folder lists them. */
const under = (prefix, files) => new Map([...files].map(([path, bytes]) => [prefix + path, bytes]));

/** The mod as the editor holds it once opened: the page fills in what its dropdowns show on the first render. */
function opened(entries) {
  const { manifest, faction, images } = readModFiles(entries, catalog);
  const mod = { modId: manifest.modId, displayName: manifest.displayName, faction };
  fillShownValues(mod, catalog);
  return { manifest, mod, images };
}

for (const [layout, entries] of [
  ['at the top of a zip', workshopFiles()],
  ['in a folder zipped with the mod (Windows "Send to > Compressed folder")', under('spellcaster/', workshopFiles())],
  ['in the Workshop item folder, picked from above', under('1870300/3412345678/', workshopFiles())],
  ['with Windows separators in the zip', new Map([...under('spellcaster\\', workshopFiles())].map(([p, b]) => [p.replaceAll('/', '\\'), b]))],
]) {
  test(`a hand-written Workshop mod opens: ${layout}`, () => {
    const { manifest, mod, images } = opened(entries);

    assert.equal(manifest.modId, 'fixture');
    assert.deepEqual(mod.faction, cleanFaction());
    assert.deepEqual([...images.keys()].sort(), ['images/icon.png', 'images/unit.png', 'preview.png']);
    assert.deepEqual(validate(mod, catalog, images), []);
    for (const path of referencedImages(mod)) assert.ok(images.has(path), path);
  });
}

test('macOS zip clutter beside the mod is ignored', () => {
  const entries = under('spellcaster/', workshopFiles());
  entries.set('__MACOSX/spellcaster/._manifest.json', png);
  entries.set('spellcaster/.DS_Store', png);

  assert.equal(opened(entries).manifest.modId, 'fixture');
});

/** The fixture with one file's text changed. */
function withText(path, change) {
  const entries = workshopFiles();
  entries.set(path, encoder.encode(change(new TextDecoder().decode(entries.get(path)))));
  return entries;
}

for (const [what, entries, message] of [
  ['no manifest anywhere', new Map([['factions/spellcaster.json', png]]), /no manifest\.json/i],
  ['two mods side by side', new Map([...under('a/', workshopFiles()), ...under('b/', workshopFiles())]), /a\/manifest\.json.*b\/manifest\.json/],
  ['a faction path out of the mod', withText('manifest.json', (t) => t.replace('.\\\\factions', '..\\\\factions')), /outside the mod/],
  ['an absolute faction path', withText('manifest.json', (t) => t.replace('.\\\\factions', 'C:\\\\factions')), /relative to the mod/],
  ['a faction file that is not there', withText('manifest.json', (t) => t.replace('spellcaster.json', 'missing.json')), /missing\.json.*not in the mod/],
  ['broken JSON', withText('factions/Spellcaster.json', (t) => t.replace('"materialTemplate": "Default",', '"materialTemplate": "Default"')), /Spellcaster\.json.*not valid JSON.*line 6/],
  ['a manifest that is not an object', withText('manifest.json', () => '["factions/spellcaster.json"]'), /manifest\.json.*object/],
]) {
  test(`a mod the game would refuse shows a clear error: ${what}`, () => {
    assert.throws(() => readModFiles(entries, catalog), message);
  });
}
