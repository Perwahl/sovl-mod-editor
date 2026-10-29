import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFactionJson, exportFiles, referencedImages, setSelectorKind, validate } from '../modformat.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const catalog = readJson('../catalog.v2.json');
const spellIds = new Set(catalog.properties.filter((p) => p.type === 'UnitPropertySpell').map((p) => p.id));

// A faction with a spellcaster that can take enchantments, and a regiment that can carry a banner. The same
// export is committed in the game (Perwahl/FBS) and loaded there by the mod loader's tests.
const draft = () => readJson('./fixtures/spellcaster/draft.json');
const expected = (path) => readJson(`./fixtures/spellcaster/export/${path}`);

const mage = (mod) => mod.faction.characters.units[0];
const allImages = (mod) => new Set([...referencedImages(mod), 'preview.png']);

/** A unit property entry as the editor makes it with "+ property", switched to another kind. */
function pickKind(kind) {
  const mod = draft();
  const selector = { kind: 'builtin', propertyId: '' };
  mage(mod).properties = [selector];
  setSelectorKind(selector, kind, catalog);
  return { mod, exported: buildFactionJson(mod).characters.units[0].properties[0] };
}

test('the fixture mod exports exactly what the game reads', () => {
  const decoder = new TextDecoder();
  const files = new Map(exportFiles(draft(), catalog, new Map()).map((f) => [f.name, JSON.parse(decoder.decode(f.data))]));

  assert.deepEqual([...files.keys()], ['manifest.json', 'factions/spellcaster.json']);
  assert.deepEqual(files.get('manifest.json'), expected('manifest.json'));
  assert.deepEqual(files.get('factions/spellcaster.json'), expected('factions/spellcaster.json'));
});

test('the fixture mod has no problems', () => {
  const mod = draft();
  assert.deepEqual(validate(mod, catalog, allImages(mod)), []);
});

test('a spell list chosen in the editor exports with its spells', () => {
  const { exported } = pickKind('spellList');

  assert.equal(exported.kind, 'spellList');
  assert.ok(Array.isArray(exported.propertyIds) && exported.propertyIds.length > 0, 'spellList needs propertyIds');
  for (const id of exported.propertyIds) assert.ok(spellIds.has(id), `${id} is not a spell`);
  assert.ok(exported.spellCount >= 1, 'spellCount');
});

test('enchantments chosen in the editor offer magic weapons or items', () => {
  const { exported } = pickKind('enchantments');

  assert.equal(exported.kind, 'enchantments');
  assert.equal(typeof exported.weapons, 'boolean');
  assert.equal(typeof exported.items, 'boolean');
  assert.ok(exported.weapons || exported.items, 'an enchantments entry with neither offers nothing');
});

test('banners chosen in the editor say whether the unit is elite', () => {
  const { exported } = pickKind('banners');

  assert.equal(exported.kind, 'banners');
  assert.equal(typeof exported.eliteUnit, 'boolean');
});

test('a spell list or enchantments the game cannot use are problems, not a mod that fails to load', () => {
  // What the editor used to save: the kind and nothing else.
  for (const [selector, expectedProblem] of [
    [{ kind: 'spellList' }, /spell/i],
    [{ kind: 'spellList', propertyIds: ['bannerOfFury'], spellCount: 1 }, /bannerOfFury.*not a spell/],
    [{ kind: 'enchantments' }, /weapons|items/i],
    [{ kind: 'pickOne' }, /pickOne.*option/i],
    [{ kind: 'builtin', propertyId: '' }, /no property chosen/i],
  ]) {
    const mod = draft();
    mage(mod).properties = [selector];
    const problems = validate(mod, catalog, allImages(mod));
    assert.ok(problems.some((p) => expectedProblem.test(p)), `${JSON.stringify(selector)}: ${JSON.stringify(problems)}`);
  }
});
