// ---------------------------------------------------------------------------------------------------
// The mod format: what the editor writes out and checks, with no DOM in it so the tests can run it in Node.
// editor.js holds the page; everything here takes the mod and the catalog as arguments.
// ---------------------------------------------------------------------------------------------------

export function allSections(mod) {
  return [mod.faction.characters, mod.faction.battleLine, ...mod.faction.sections];
}

export function referencedImages(mod) {
  const paths = new Set();
  const add = (p) => p && paths.add(p);

  add(mod.faction.factionImage);
  mod.faction.icons.forEach(add);

  for (const section of allSections(mod)) {
    for (const unit of section.units) {
      add(unit.icon);
      add(unit.image);
      for (const models of unit.models ?? []) {
        (models.images ?? []).forEach(add);
        (models.steedImages ?? []).forEach(add);
      }
    }
  }
  return paths;
}

/** The built-in spells, by id. A mod cannot define spells of its own: its properties are effects, not spells. */
export function spellIds(catalog) {
  return catalog.properties.filter((p) => p.type === 'UnitPropertySpell').map((p) => p.id);
}

/**
 * What choosing a property kind in the unit's property list does to that entry. Each kind starts out as
 * something the game can load. Fields another kind left behind stay, so switching back loses nothing; the
 * export writes only the current kind's fields (see exportSelector).
 */
export function setSelectorKind(selector, kind, catalog) {
  selector.kind = kind;
  switch (kind) {
    case 'spellList':
      if (!selector.propertyIds?.length) selector.propertyIds = spellIds(catalog).slice(0, 1);
      selector.spellCount = selector.spellCount ?? 1;
      break;
    case 'enchantments':
      // Neither ticked would offer nothing at all, so start with both.
      if (!selector.weapons && !selector.items) {
        selector.weapons = true;
        selector.items = true;
      }
      break;
    case 'banners':
      selector.eliteUnit = selector.eliteUnit ?? false;
      break;
  }
}

/**
 * One unit property entry in the shape ModFactionBuilder.BuildSelector reads for its kind, and nothing else.
 * The game matches kinds case-insensitively, so this does too.
 */
export function exportSelector(selector) {
  const kind = selector.kind;
  switch ((kind ?? '').toLowerCase()) {
    case 'builtin':
      return { kind, propertyId: selector.propertyId };
    case 'optional':
      return { kind, propertyId: selector.propertyId, cost: selector.cost ?? 0 };
    case 'pickone': {
      const propertyIds = selector.propertyIds ?? [];
      return { kind, propertyIds, costs: propertyIds.map((_, i) => selector.costs?.[i] ?? 0) };
    }
    case 'spelllist':
      return { kind, propertyIds: selector.propertyIds ?? [], spellCount: selector.spellCount ?? 1 };
    case 'enchantments':
      return { kind, weapons: !!selector.weapons, items: !!selector.items };
    case 'banners':
      return { kind, eliteUnit: !!selector.eliteUnit };
    default:
      return selector;
  }
}

/** The problems with one unit property entry, the same ones BuildSelector would refuse the mod for. */
function selectorProblems(selector, owner, knownIds, spells) {
  const problems = [];
  const ids = selector.propertyIds ?? [];

  switch ((selector.kind ?? '').toLowerCase()) {
    case 'builtin':
    case 'optional':
      if (!selector.propertyId) problems.push(`${owner}: a ${selector.kind} property has no property chosen.`);
      else if (!knownIds.has(selector.propertyId)) problems.push(`${owner}: property "${selector.propertyId}" does not exist.`);
      break;
    case 'pickone':
      if (!ids.length) problems.push(`${owner}: a pickOne property needs at least one option.`);
      for (const id of ids) if (!knownIds.has(id)) problems.push(`${owner}: property "${id}" does not exist.`);
      break;
    case 'spelllist':
      if (!ids.length) problems.push(`${owner}: a spell list needs at least one spell.`);
      for (const id of ids) if (!spells.has(id)) problems.push(`${owner}: spell list entry "${id}" is not a spell.`);
      break;
    case 'enchantments':
      if (!selector.weapons && !selector.items) problems.push(`${owner}: enchantments must offer magic weapons, items or both.`);
      break;
    case 'banners':
      break;
    default:
      problems.push(`${owner}: unknown property kind "${selector.kind}".`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// Validation - mirrors what the game enforces, so problems surface here rather than on import
// ---------------------------------------------------------------------------------------------------

/**
 * @param {Set<string>|Map<string, unknown>} imagePaths the images the editor holds, by path
 * @returns {string[]} the problems, empty when the mod is ready to export
 */
export function validate(mod, catalog, imagePaths) {
  const problems = [];
  const limits = catalog.limits;
  const prefix = mod.modId + ':';

  if (!/^[a-z0-9_-]+$/.test(mod.modId)) {
    problems.push('Mod id must be lower-case letters, digits, underscore or hyphen.');
  }
  if (!mod.displayName.trim()) problems.push('Mod needs a display name.');

  const faction = mod.faction;
  if (!/^[a-z0-9_.-]+$/.test(faction.slug)) problems.push('Faction slug must be lower-case letters, digits, "_", "." or "-".');
  if (!faction.displayName.trim()) problems.push('Faction needs a display name.');
  if (!faction.icons.length) problems.push('Faction needs at least one icon.');
  if (!faction.factionImage) problems.push('Faction needs a faction image.');

  const sections = allSections(mod);
  const unitIds = new Set();
  const knownPropertyIds = new Set([...catalog.properties.map((p) => p.id), ...faction.properties.map((p) => p.id)]);
  const spells = new Set(spellIds(catalog));

  for (const section of sections) {
    for (const unit of section.units) {
      if (!unit.unitID.startsWith(prefix)) {
        problems.push(`Unit id "${unit.unitID}" must start with "${prefix}".`);
      }
      if (unitIds.has(unit.unitID)) problems.push(`Unit id "${unit.unitID}" is used more than once.`);
      unitIds.add(unit.unitID);

      if (unit.pointsCost < limits.minPointsCost || unit.pointsCost > limits.maxPointsCost) {
        problems.push(`${unit.unitID}: points must be ${limits.minPointsCost}-${limits.maxPointsCost}.`);
      }
      if (!unit.icon) problems.push(`${unit.unitID}: needs an icon.`);
      if (!unit.image) problems.push(`${unit.unitID}: needs a unit image.`);

      for (const [stat, value] of Object.entries(unit.stats)) {
        if (value < limits.minStat || value > limits.maxStat) {
          problems.push(`${unit.unitID}: ${stat} must be ${limits.minStat}-${limits.maxStat}.`);
        }
      }

      if (unit.kind === 'regiment' && !unit.modelCountLimits?.Warband) {
        problems.push(`${unit.unitID}: regiments need a Warband entry in modelCountLimits.`);
      }
      if (unit.kind === 'character' && !unit.soloCommander && !unit.retinueOptions?.length) {
        problems.push(`${unit.unitID}: characters need at least one retinue, or soloCommander.`);
      }
      for (const retinue of unit.retinueOptions ?? []) {
        if (!unitIds.has(retinue.unitID) && !sections.some((s) => s.units.some((u) => u.unitID === retinue.unitID))) {
          problems.push(`${unit.unitID}: retinue "${retinue.unitID}" is not a unit in this faction.`);
        }
      }
      for (const models of unit.models ?? []) {
        if (!models.images?.length) problems.push(`${unit.unitID}: model graphics need at least one image.`);
      }
      for (const selector of [unit.weaponSet, unit.rangedAttack, ...(unit.properties ?? [])]) {
        if (selector) problems.push(...selectorProblems(selector, unit.unitID, knownPropertyIds, spells));
      }
    }
  }

  if (!faction.characters.units.length) problems.push('The Commanders section needs at least one unit.');
  if (!faction.battleLine.units.length) problems.push('The BattleLine section needs at least one unit.');

  const propertyIds = new Set();
  for (const property of faction.properties) {
    if (!property.id.startsWith(prefix)) problems.push(`Property id "${property.id}" must start with "${prefix}".`);
    if (propertyIds.has(property.id)) problems.push(`Property id "${property.id}" is used more than once.`);
    if (catalog.properties.some((p) => p.id === property.id)) {
      problems.push(`Property id "${property.id}" already exists in the game.`);
    }
    propertyIds.add(property.id);

    if (!property.effects.length) problems.push(`${property.id}: needs at least one effect.`);
    if (property.effects.length > limits.maxEffectsPerProperty) {
      problems.push(`${property.id}: at most ${limits.maxEffectsPerProperty} effects.`);
    }
    for (const effect of property.effects) {
      if (effect.kind === 'statModifier' && Math.abs(effect.value ?? 0) > limits.maxStatModifier) {
        problems.push(`${property.id}: stat modifier must be within ±${limits.maxStatModifier}.`);
      }
    }
  }

  for (const path of referencedImages(mod)) {
    if (!imagePaths.has(path)) problems.push(`Missing image: ${path}`);
  }
  if (!imagePaths.has('preview.png')) {
    problems.push('Add preview.png (shown on the Workshop). Publishing needs it.');
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------

export function buildManifestJson(mod, catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    modId: mod.modId,
    displayName: mod.displayName,
    author: mod.author,
    contentVersion: mod.contentVersion,
    minGameVersion: catalog.gameVersion,
    factions: [factionPath(mod)],
  };
}

export function factionPath(mod) {
  return `factions/${mod.faction.slug}.json`;
}

export function buildFactionJson(mod) {
  const faction = mod.faction;
  return {
    slug: faction.slug,
    displayName: faction.displayName,
    materialTemplate: faction.materialTemplate,
    factionImage: faction.factionImage,
    icons: faction.icons,
    defaultColors: faction.defaultColors,
    properties: faction.properties,
    characters: exportSection(faction.characters),
    battleLine: exportSection(faction.battleLine),
    sections: faction.sections.map(exportSection),
  };
}

function exportSection(section) {
  return { ...section, units: section.units.map(exportUnit) };
}

function exportUnit(unit) {
  const exported = { ...unit };
  if (unit.properties) exported.properties = unit.properties.map(exportSelector);
  if (unit.weaponSet) exported.weaponSet = exportSelector(unit.weaponSet);
  if (unit.rangedAttack) exported.rangedAttack = exportSelector(unit.rangedAttack);
  return exported;
}

/**
 * The files of mod.zip, in the order they are written.
 *
 * @param {Map<string, { bytes: Uint8Array }>} images
 * @returns {{ name: string, data: Uint8Array }[]}
 */
export function exportFiles(mod, catalog, images) {
  const encoder = new TextEncoder();
  const files = [
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(buildManifestJson(mod, catalog), null, 2)) },
    { name: factionPath(mod), data: encoder.encode(JSON.stringify(buildFactionJson(mod), null, 2)) },
  ];

  for (const [path, image] of images) {
    files.push({ name: path, data: image.bytes });
  }
  return files;
}
