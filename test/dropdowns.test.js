import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportFiles, readModFiles } from '../modformat.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const catalog = readJson('../catalog.v2.json');
const draft = () => readJson('./fixtures/spellcaster/draft.json');
const effectInfo = (kind) => catalog.effects.find((e) => e.kind === kind);

/** Export the mod and open the export again, as someone re-opening their mod.zip would. */
function roundTrip(mod) {
  const entries = new Map(exportFiles(mod, catalog, new Map()).map((f) => [f.name, f.data]));
  return readModFiles(entries, catalog).faction;
}

// A dropdown shows its first option before anything is picked, and picking that same option fires no change,
// so the editor never stored it (SOVL-FB-220, SOVL-FB-224). These are the fields as the editor leaves them then.
function modWithUntouchedDropdowns() {
  const mod = draft();
  mod.faction.properties = [{
    id: 'fixture:steady',
    displayName: 'Steady',
    description: '',
    effects: [
      { kind: 'toHit' },
      { kind: 'statModifier', value: 1 },
      { kind: 'deployment' },
      { kind: 'discipline' },
    ],
  }];
  return mod;
}

test('an effect left at its first options exports them and opens with them selected', () => {
  const [toHit, statModifier, deployment, discipline] = roundTrip(modWithUntouchedDropdowns()).properties[0].effects;

  assert.equal(toHit.effectType, effectInfo('toHit').effectTypeValues[0]);
  assert.equal(toHit.appliesTo, 'ownerUnit');
  assert.equal(statModifier.stat, catalog.stats[0]);
  assert.equal(deployment.effectType, 'ambusher');
  assert.equal(discipline.effectType, effectInfo('discipline').effectTypeValues[0]);
});

test('a property and a unit left at their first options export them', () => {
  const faction = roundTrip(modWithUntouchedDropdowns());

  assert.equal(faction.properties[0].appliesTo, catalog.propertyAppliesTo[0]);
  for (const unit of [faction.characters.units[0], faction.battleLine.units[0]]) {
    assert.equal(unit.sectionLimitCost, catalog.sectionLimitCosts[0], unit.unitID);
  }
});

test('an effect switched to another kind exports what its Type dropdown shows, not the old kind\'s type', () => {
  const mod = modWithUntouchedDropdowns();
  // Chosen as toHit "plusOne", then switched to damageSave, whose list has no "plusOne".
  mod.faction.properties[0].effects = [{ kind: 'damageSave', effectType: 'plusOne', value: 1 }];

  const [effect] = roundTrip(mod).properties[0].effects;
  assert.equal(effect.effectType, effectInfo('damageSave').effectTypeValues[0]);
});

test('a faction with no material template exports the one the game uses for it', () => {
  // A hand-written mod may leave it out; the game then uses "Default", so the editor shows and writes that.
  const mod = draft();
  delete mod.faction.materialTemplate;

  assert.equal(roundTrip(mod).materialTemplate, 'Default');
});

test('choices that were made survive the round trip unchanged', () => {
  const mod = modWithUntouchedDropdowns();
  mod.faction.properties[0].appliesTo = 'Unit';
  mod.faction.properties[0].effects = [
    { kind: 'toHit', effectType: 'rerollOnes', appliesTo: 'opponent' },
    { kind: 'statModifier', stat: 'Defense', value: -1 },
  ];
  mod.faction.materialTemplate = 'DwarfHolds';
  mod.faction.battleLine.units[0].sectionLimitCost = 'Half';

  const faction = roundTrip(mod);
  assert.equal(faction.properties[0].appliesTo, 'Unit');
  assert.deepEqual(faction.properties[0].effects, [
    { kind: 'toHit', effectType: 'rerollOnes', appliesTo: 'opponent' },
    { kind: 'statModifier', stat: 'Defense', value: -1 },
  ]);
  assert.equal(faction.materialTemplate, 'DwarfHolds');
  assert.equal(faction.battleLine.units[0].sectionLimitCost, 'Half');
});
