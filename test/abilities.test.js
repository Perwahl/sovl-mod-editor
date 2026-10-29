import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFactionJson, buildManifestJson, exportFiles, readModFiles, referencedImages, validate } from '../modformat.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const catalog = readJson('../catalog.v2.json');
const draft = () => readJson('./fixtures/spellcaster/draft.json');
const allImages = (mod) => new Set([...referencedImages(mod), 'preview.png']);
const problemsOf = (mod) => validate(mod, catalog, allImages(mod));

/** The fixture with one property of its own that has an ability, as the editor makes it when "Activated ability" is ticked. */
function withAbility(ability, effects = [{ kind: 'statModifier', stat: 'Power', value: 1 }]) {
  const mod = draft();
  const property = {
    id: 'fixture:warcry',
    displayName: 'Warcry',
    description: '',
    effects,
    ability: { type: 'ability', charges: 1, target: 'self', range: 12, allInRange: false, canTargetInCombat: true, inCombat: 'any', duration: 1, ...ability },
  };
  mod.faction.properties.push(property);
  mod.faction.characters.units[0].properties.push({ kind: 'builtin', propertyId: property.id });
  return { mod, property };
}

test('a mod without abilities is exported as schema 1, so games from before abilities still load it', () => {
  assert.equal(buildManifestJson(draft(), catalog).schemaVersion, 1);
});

test('a mod with an ability is exported as schema 2', () => {
  assert.equal(buildManifestJson(withAbility({}).mod, catalog).schemaVersion, 2);
});

test('a buff for one turn on the unit itself has no problems', () => {
  assert.deepEqual(problemsOf(withAbility({}).mod), []);
});

test('an ability with no effects of its own is enough for a property, if it heals or rallies', () => {
  assert.deepEqual(problemsOf(withAbility({ heal: { d3: 1, plus: 0 } }, []).mod), []);
  assert.deepEqual(problemsOf(withAbility({ rally: true }, []).mod), []);
});

test('an attack exports without the effects it had before it was one', () => {
  const { mod } = withAbility({ target: 'enemy', attack: { power: 4, dice: 'RandomD6', count: 1, visual: 'Fireball' } });

  assert.deepEqual(problemsOf(mod), []);
  const exported = buildFactionJson(mod).properties.find((p) => p.id === 'fixture:warcry');
  assert.deepEqual(exported.effects, []);
  assert.equal(exported.ability.attack.power, 4);
});

test('abilities the game would refuse are problems', () => {
  for (const [ability, effects, expected] of [
    [{ charges: 0 }, undefined, /uses per battle/],
    [{ charges: 99 }, undefined, /uses per battle/],
    [{ target: 'friendly', range: 0 }, undefined, /range/],
    [{ target: 'self', attack: { power: 4, dice: 'RandomD6', count: 1, visual: 'Fireball' } }, undefined, /attack must target an enemy/],
    [{ target: 'enemy', attack: { power: 0, dice: 'RandomD6', count: 1, visual: 'Fireball' } }, undefined, /attack power/],
    [{ target: 'enemy', attack: { power: 4, dice: 'RandomD6', count: 0, visual: 'Fireball' } }, undefined, /attack count/],
    [{ heal: { d3: 0, plus: 0 } }, [], /a heal needs/],
    [{}, [], /does nothing/],
    [{ duration: 0 }, undefined, /effects need to last/],
  ]) {
    const problems = problemsOf(withAbility(ability, effects).mod);
    assert.ok(problems.some((p) => expected.test(p)), `${JSON.stringify(ability)}: ${JSON.stringify(problems)}`);
  }
});

test('a property icon is an image the mod needs', () => {
  const { mod, property } = withAbility({});
  property.icon = 'images/warcry.png';

  assert.ok(referencedImages(mod).has('images/warcry.png'));
  assert.ok(validate(mod, catalog, new Set(['preview.png'])).some((p) => p.includes('images/warcry.png')));
});

test('ability fields written in another case are read as the game reads them', () => {
  const { mod } = withAbility({});
  const files = new Map(exportFiles(mod, catalog, new Map()).map((f) => [f.name, f.data]));
  const text = new TextDecoder().decode(files.get('factions/spellcaster.json'))
    .replace('"ability"', '"Ability"').replace('"charges"', '"Charges"');
  files.set('factions/spellcaster.json', new TextEncoder().encode(text));

  const property = readModFiles(files, catalog).faction.properties.find((p) => p.id === 'fixture:warcry');
  assert.equal(property.ability.charges, 1);
});

test('a retinue must be a regiment', () => {
  const mod = draft();
  const [mage] = mod.faction.characters.units;
  mod.faction.characters.units.push({ ...structuredClone(mage), unitID: 'fixture:apprentice' });
  mage.retinueOptions = [{ unitID: 'fixture:apprentice' }];

  assert.ok(problemsOf(mod).some((p) => /fixture:apprentice.*a retinue must be a regiment/.test(p)));
});

test("an opened mod's workshop.json is read, so the next export can update the same Workshop item", () => {
  const link = new TextEncoder().encode('{ "publishedFileId": 3412345678 }');
  const entries = new Map(exportFiles(draft(), catalog, new Map()).map((f) => [`mymod/${f.name}`, f.data]));
  entries.set('mymod/workshop.json', link);

  assert.deepEqual(readModFiles(entries, catalog).workshop, link);
  entries.delete('mymod/workshop.json');
  assert.equal(readModFiles(entries, catalog).workshop, null);
});
