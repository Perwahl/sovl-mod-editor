import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportFiles, readModFiles, referencedImages, validate } from '../modformat.js';

const readText = (path) => readFileSync(new URL(path, import.meta.url));
const readJson = (path) => JSON.parse(readText(path).toString('utf8'));

const catalog = readJson('../catalog.v2.json');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const decoder = new TextDecoder();

// A mod the editor cannot fully edit: its first faction has a mounts section, which the editor has no panel for,
// and a second faction follows it. The same files are committed in the game (Perwahl/FBS) and loaded there by the
// mod loader's tests, so what the editor writes back out is what the game reads.
const fixture = './fixtures/mounts/';
const fixtureFiles = () => new Map([
  ['manifest.json', readText(fixture + 'manifest.json')],
  ['factions/spellcaster.json', readText(fixture + 'factions/spellcaster.json')],
  ['factions/second.json', readText(fixture + 'factions/second.json')],
  ['images/icon.png', png],
  ['images/unit.png', png],
  ['preview.png', png],
]);

/** Opens the files the way the page does, then exports them again. */
function reopenAndExport(entries) {
  const opened = readModFiles(entries, catalog);
  const { manifest, faction, otherFactions } = opened;
  const mod = { modId: manifest.modId, displayName: manifest.displayName, author: manifest.author, contentVersion: manifest.contentVersion, faction, otherFactions };
  const images = new Map([...opened.images].map(([path, bytes]) => [path, { bytes }]));
  const files = new Map(exportFiles(mod, catalog, images).map((f) => [f.name, f.data]));
  return { opened, mod, images, files };
}

test('a faction\'s mounts section is exported as it was opened', () => {
  const { files } = reopenAndExport(fixtureFiles());

  const exported = JSON.parse(decoder.decode(files.get('factions/spellcaster.json')));
  assert.deepEqual(exported, readJson(fixture + 'factions/spellcaster.json'));
  assert.equal(exported.mounts.units[0].unitID, 'fixture:horse');
});

test('every faction of a mod is exported: the manifest lists them all and each file is kept', () => {
  const { files } = reopenAndExport(fixtureFiles());

  assert.deepEqual(JSON.parse(decoder.decode(files.get('manifest.json'))), readJson(fixture + 'manifest.json'));
  assert.deepEqual(files.get('factions/second.json'), new Uint8Array(readText(fixture + 'factions/second.json')));
});

test('a faction kept as loaded keeps the path it was declared with, in the form the editor writes', () => {
  const entries = fixtureFiles();
  const manifest = readJson(fixture + 'manifest.json');
  manifest.factions[1] = '.\\factions\\Second.json';
  entries.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));

  const { files } = reopenAndExport(entries);
  assert.deepEqual(JSON.parse(decoder.decode(files.get('manifest.json'))).factions, ['factions/spellcaster.json', 'factions/second.json']);
  assert.ok(files.has('factions/second.json'));
});

test('opening a mod with more than one faction, or with mounts, says what cannot be edited', () => {
  const { opened } = reopenAndExport(fixtureFiles());

  assert.ok(opened.warnings.some((w) => /only the first/i.test(w) && w.includes('factions/second.json')), JSON.stringify(opened.warnings));
  assert.ok(opened.warnings.some((w) => /mounts/i.test(w)), JSON.stringify(opened.warnings));
});

test('a mod with one faction and no mounts opens without warnings', () => {
  const entries = fixtureFiles();
  const manifest = readJson(fixture + 'manifest.json');
  manifest.factions = ['factions/spellcaster.json'];
  entries.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  const faction = readJson(fixture + 'factions/spellcaster.json');
  delete faction.mounts;
  faction.characters.units[0].retinueOptions.pop();
  entries.set('factions/spellcaster.json', new TextEncoder().encode(JSON.stringify(faction)));

  assert.deepEqual(readModFiles(entries, catalog).warnings, []);
});

test('the mod opened with mounts and a second faction has no problems', () => {
  // A commander that rides a unit from the mounts section is fine: the game finds retinues there too.
  const { mod, images } = reopenAndExport(fixtureFiles());
  assert.deepEqual(validate(mod, catalog, images), []);
  assert.ok(referencedImages(mod).has('images/icon.png'));
});

test('the edited faction cannot be saved over a faction kept as loaded', () => {
  const { mod, images } = reopenAndExport(fixtureFiles());
  mod.faction.slug = 'second';

  assert.ok(validate(mod, catalog, images).some((p) => /factions\/second\.json/.test(p)));
});
