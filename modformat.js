// ---------------------------------------------------------------------------------------------------
// The mod format: what the editor reads, checks and writes out, with no DOM in it so the tests can run it in Node.
// editor.js holds the page; everything here takes the mod and the catalog as arguments.
// ---------------------------------------------------------------------------------------------------

/** The sections the editor edits. */
export function allSections(mod) {
  return [mod.faction.characters, mod.faction.battleLine, ...mod.faction.sections];
}

/**
 * Every section the game loads units from: the editable ones and the faction's mounts section, which the editor
 * keeps as it was opened (a hand-written mod may have one; the editor has no panel for it).
 */
export function loadedSections(mod) {
  return mod.faction.mounts ? [...allSections(mod), mod.faction.mounts] : allSections(mod);
}

export function referencedImages(mod) {
  const paths = new Set();
  const add = (p) => p && paths.add(p);

  add(mod.faction.factionImage);
  mod.faction.icons.forEach(add);

  for (const section of loadedSections(mod)) {
    for (const unit of section.units ?? []) {
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

/**
 * Writes down what every dropdown shows. A dropdown whose field is unset, or set to something that is not one of
 * its options, shows its first option, and picking that same option fires no change, so the field used to stay
 * empty and the export left it out (SOVL-FB-220, SOVL-FB-224). The fallbacks are the values the game also uses
 * for a missing field. A value that only differs in case becomes the option it matches.
 */
export function fillShownValues(mod, catalog) {
  const faction = mod.faction;
  faction.materialTemplate = shown(faction.materialTemplate, catalog.materialTemplates, 'Default');

  const effectKinds = catalog.effects.map((e) => e.kind);
  for (const property of faction.properties ?? []) {
    property.appliesTo = shown(property.appliesTo, catalog.propertyAppliesTo);
    for (const effect of property.effects ?? []) {
      effect.kind = shown(effect.kind, effectKinds);
      const info = catalog.effects.find((e) => e.kind === effect.kind);
      const fields = info?.fields ?? [];
      if (fields.includes('stat')) effect.stat = shown(effect.stat, catalog.stats);
      if (fields.includes('effectType')) effect.effectType = shown(effect.effectType, info.effectTypeValues);
      if (fields.includes('appliesTo')) effect.appliesTo = shown(effect.appliesTo, catalog.appliesTo);
    }
  }

  for (const section of allSections(mod)) {
    for (const unit of section.units) {
      unit.kind = shown(unit.kind, catalog.unitKinds);
      unit.modelType = shown(unit.modelType, catalog.modelTypes.map((m) => m.name));
      unit.unitType = shown(unit.unitType, catalog.unitTypes);
      unit.pattern = shown(unit.pattern, catalog.patterns);
      unit.sectionLimitCost = shown(unit.sectionLimitCost, catalog.sectionLimitCosts);
      for (const selector of unit.properties ?? []) {
        selector.kind = shown(selector.kind, catalog.propertySelectorKinds);
      }
    }
  }
}

/** The option a dropdown shows for this value: the value itself, the option it matches ignoring case, or the fallback. */
function shown(value, options, fallback = options[0]) {
  if (options.includes(value)) return value;
  const lower = typeof value === 'string' ? value.toLowerCase() : null;
  return options.find((option) => option.toLowerCase() === lower) ?? (options.includes(fallback) ? fallback : options[0]);
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

  const sections = loadedSections(mod);
  const unitIds = new Set();
  const knownPropertyIds = new Set([...catalog.properties.map((p) => p.id), ...faction.properties.map((p) => p.id)]);
  const spells = new Set(spellIds(catalog));

  for (const section of sections) {
    for (const unit of section.units ?? []) {
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
        if (!unitIds.has(retinue.unitID) && !sections.some((s) => s.units?.some((u) => u.unitID === retinue.unitID))) {
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

  const others = mod.otherFactions ?? [];
  if (others.some((other) => other.path.toLowerCase() === factionPath(mod).toLowerCase())) {
    problems.push(`Faction slug "${faction.slug}" would save over ${factionPath(mod)}, another faction in this mod. Pick another slug.`);
  }
  if (1 + others.length > limits.maxFactionsPerMod) {
    problems.push(`A mod can have at most ${limits.maxFactionsPerMod} factions; this one has ${1 + others.length}.`);
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
    factions: [factionPath(mod), ...(mod.otherFactions ?? []).map((other) => other.path)],
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
    ...(faction.mounts ? { mounts: exportSection(faction.mounts) } : {}),
  };
}

function exportSection(section) {
  return section.units ? { ...section, units: section.units.map(exportUnit) } : section;
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
  // The page fills these on every render already; doing it here too means the export never depends on that.
  mod = structuredClone(mod);
  fillShownValues(mod, catalog);

  const encoder = new TextEncoder();
  const files = [
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(buildManifestJson(mod, catalog), null, 2)) },
    { name: factionPath(mod), data: encoder.encode(JSON.stringify(buildFactionJson(mod), null, 2)) },
    // Factions after the first are written back exactly as they were opened.
    ...(mod.otherFactions ?? []).map((other) => ({ name: other.path, data: encoder.encode(other.text) })),
  ];

  for (const [path, image] of images) {
    files.push({ name: path, data: image.bytes });
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------
// Opening an existing mod
//
// The editor opens whatever the game loads, so this follows the game's reader rather than the editor's own
// export: a mod is the folder that holds manifest.json (ModLoader), paths resolve the way ModPaths resolves
// them on a Windows file system, and JSON is read the way Newtonsoft reads it.
// ---------------------------------------------------------------------------------------------------

const MANIFEST = 'manifest.json';

/**
 * Reads a mod from its files, whichever way they arrived: a zip, or a picked folder with that folder's name in
 * front of every path. Throws an Error whose message is shown to the person opening the mod.
 *
 * @param {Map<string, Uint8Array>} entries path -> bytes
 * @returns {{ manifest: object, faction: object, otherFactions: { path: string, text: string }[],
 *   images: Map<string, Uint8Array>, warnings: string[] }} faction is the first faction, the one the editor edits;
 *   otherFactions are the rest, as their files' text, to be written back unchanged. images are keyed by their path
 *   within the mod, which is also how the faction refers to them. warnings say what the editor cannot edit.
 */
export function readModFiles(entries, catalog) {
  const files = modRootFiles(entries);
  const stored = new Map([...files.keys()].map((path) => [path.toLowerCase(), path]));
  // ignoreBOM keeps a byte order mark in the text, so a faction kept as loaded is written back byte for byte.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

  const find = (declared, owner) => stored.get(modPath(declared, owner).toLowerCase()) ?? null;
  const readJson = (path) => canonicalFields(parseModJson(decoder.decode(files.get(path)), path));

  const manifest = readJson(MANIFEST);

  const declared = Array.isArray(manifest.factions) ? manifest.factions : [];
  if (!declared.length) throw new Error('The manifest lists no factions.');

  const factionPaths = declared.map((path) => {
    const found = find(path, MANIFEST);
    if (!found) throw new Error(`The manifest points at ${path}, which is not in the mod.`);
    return found;
  });

  if (manifest.schemaVersion > catalog.schemaVersion) {
    throw new Error(`This mod is schema v${manifest.schemaVersion}; this catalog only knows v${catalog.schemaVersion}.`);
  }

  const [factionPath, ...otherPaths] = factionPaths;
  const faction = readJson(factionPath);

  // The editor edits one faction. The others are kept as text and written back unchanged; reading them here only
  // makes a broken one fail to open now rather than fail to load in the game.
  const otherFactions = otherPaths.map((path) => {
    readJson(path);
    return { path, text: decoder.decode(files.get(path)) };
  });

  const warnings = [];
  if (otherFactions.length) {
    warnings.push(`This mod has ${factionPaths.length} factions. Only the first, ${factionPath}, can be edited here. `
      + `${otherPaths.join(', ')} ${otherPaths.length === 1 ? 'is' : 'are'} kept as loaded and exported unchanged.`);
  }
  if (faction.mounts?.units?.length) {
    const count = faction.mounts.units.length;
    warnings.push(`${factionPath} has a mounts section (${count} unit${count === 1 ? '' : 's'}). The editor cannot edit `
      + 'it yet; it is kept as loaded and exported with the faction. Commanders can still ride its units.');
  }

  // Point image references at the files as stored. One that does not resolve is left as written, and shows up
  // as a missing image rather than stopping the mod from opening.
  forEachImageField(faction, (owner, key) => {
    try {
      owner[key] = find(owner[key], factionPath) ?? owner[key];
    } catch {
      // Out of the mod or absolute: the game refuses it too, and the problem list says so.
    }
  });

  const images = new Map([...files].filter(([path]) => path.toLowerCase().endsWith('.png')));

  return { manifest, faction, otherFactions, images, warnings };
}

/** The files under the folder that holds manifest.json, keyed by their path from there. */
function modRootFiles(entries) {
  const files = new Map();
  for (const [name, bytes] of entries) {
    const path = name.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!path || path.endsWith('/')) continue;
    // What macOS adds when it zips a folder.
    if (path.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(path)) continue;
    files.set(path, bytes);
  }

  const manifests = [...files.keys()].filter((path) => path.split('/').pop().toLowerCase() === MANIFEST);
  if (!manifests.length) {
    throw new Error('There is no manifest.json in that. Open the mod’s folder (the one with manifest.json in it), or a zip of it.');
  }

  // The shallowest one is the mod; a deeper one is just a file inside it.
  const depth = (path) => path.split('/').length;
  const top = Math.min(...manifests.map(depth));
  const roots = manifests.filter((path) => depth(path) === top).sort();
  if (roots.length > 1) {
    throw new Error(`That holds more than one mod (${roots.join(', ')}). Open one of them.`);
  }

  const root = roots[0].slice(0, -MANIFEST.length);
  const modFiles = new Map();
  for (const [path, bytes] of files) {
    if (path.startsWith(root)) modFiles.set(path.slice(root.length), bytes);
  }

  // Windows does not care how manifest.json is capitalised, and neither does the game there.
  const manifest = roots[0].slice(root.length);
  if (manifest !== MANIFEST) {
    modFiles.set(MANIFEST, modFiles.get(manifest));
    modFiles.delete(manifest);
  }
  return modFiles;
}

/**
 * A path declared inside the mod, in the form the editor stores: forward slashes, no "." segments. Refuses
 * what ModPaths.TryResolve refuses.
 */
function modPath(declared, owner) {
  if (typeof declared !== 'string' || !declared.trim()) throw new Error(`${owner}: a path is empty.`);

  const path = declared.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes(':')) {
    throw new Error(`${owner}: "${declared}" must be relative to the mod folder.`);
  }

  const segments = path.split('/').filter((s) => s && s !== '.');
  if (segments.includes('..')) throw new Error(`${owner}: "${declared}" points outside the mod folder.`);
  return segments.join('/');
}

function forEachImageField(faction, visit) {
  const field = (owner, key) => {
    if (typeof owner?.[key] === 'string' && owner[key]) visit(owner, key);
  };
  const list = (items) => {
    if (Array.isArray(items)) items.forEach((_, i) => field(items, i));
  };

  field(faction, 'factionImage');
  list(faction.icons);
  for (const section of [faction.characters, faction.battleLine, ...(faction.sections ?? []), faction.mounts]) {
    for (const unit of section?.units ?? []) {
      field(unit, 'icon');
      field(unit, 'image');
      for (const models of unit.models ?? []) {
        list(models.images);
        list(models.steedImages);
      }
    }
  }
}

// Newtonsoft matches a JSON property to a field ignoring case when nothing matches exactly, so "UnitID" loads as
// unitID. These are the fields of the game's ModDtos.cs.
const FIELDS = new Map([
  'schemaVersion', 'modId', 'displayName', 'author', 'contentVersion', 'minGameVersion', 'factions',
  'slug', 'materialTemplate', 'factionImage', 'icons', 'defaultColors', 'properties', 'characters', 'battleLine',
  'sections', 'mounts', 'primary', 'secondary', 'icon', 'sectionName', 'unitLimits', 'units', 'minCount', 'maxCount',
  'kind', 'unitID', 'pointsCost', 'modelType', 'unitType', 'pattern', 'sectionLimitCost', 'stats', 'image',
  'largeImage', 'isMount', 'maxUnitCount', 'modelCountLimits', 'weaponSet', 'rangedAttack', 'models',
  'retinueOptions', 'soloCommander', 'images', 'steedImages', 'propertyId', 'scale', 'riderOffset',
  'randomPosition', 'randomRotation', 'randomScale', 'randomBrightness', 'randomFlip', 'lookOutFromCenter',
  'notAvailableInWarband', 'id', 'description', 'appliesTo', 'effects', 'when', 'isAura', 'impact', 'stat', 'value',
  'amount', 'replaceMovement', 'effectType', 'unitTypes', 'conditions', 'cost', 'propertyIds', 'costs', 'spellCount',
  'weapons', 'items', 'eliteUnit',
].map((name) => [name.toLowerCase(), name]));

// Objects keyed by data (army sizes, stat names) rather than by field: their keys are left alone.
const KEYED_BY_DATA = new Set(['unitLimits', 'stats', 'maxUnitCount', 'modelCountLimits']);

function canonicalFields(value, keyedByData = false) {
  if (Array.isArray(value)) return value.map((item) => canonicalFields(item));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const name = keyedByData ? key : FIELDS.get(key.toLowerCase()) ?? key;
    setOwn(out, name, canonicalFields(inner, !keyedByData && KEYED_BY_DATA.has(name)));
  }
  return out;
}

// A key such as "__proto__" stays an ordinary property, as it does with JSON.parse.
function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

const LITERALS = new Map([['true', true], ['false', false], ['null', null], ['undefined', null], ['NaN', NaN], ['Infinity', Infinity]]);
const ESCAPES = new Map([['"', '"'], ["'", "'"], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][\w$]*/y;

/**
 * Parses a mod's JSON as the game does: ModLoader reads it with Newtonsoft's JObject.Load, which also takes
 * comments, trailing commas, single-quoted strings, unquoted property names, NaN and Infinity, and stops at the
 * end of the top-level object.
 *
 * @param {string} name the file, for the error message
 */
export function parseModJson(text, name) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (message) => {
    const before = text.slice(0, i);
    const line = before.split('\n').length;
    const column = i - before.lastIndexOf('\n');
    throw new Error(`${name} is not valid JSON: ${message} (line ${line}, column ${column}).`);
  };

  const skipSpace = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('a comment is never closed');
        i = end + 2;
      } else {
        return;
      }
    }
  };

  const match = (pattern) => {
    pattern.lastIndex = i;
    const found = pattern.exec(text);
    if (found) i += found[0].length;
    return found?.[0];
  };

  const string = () => {
    const quote = text[i++];
    let out = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] !== '\\') {
        out += text[i++];
      } else if (text[i + 1] === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a \\u escape needs four hex digits');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (ESCAPES.has(text[i + 1])) {
        out += ESCAPES.get(text[i + 1]);
        i += 2;
      } else {
        fail(`"\\${text[i + 1] ?? ''}" is not an escape (write a backslash in a path as "\\\\")`);
      }
    }
    if (i >= text.length) fail('a string is never closed');
    i++;
    return out;
  };

  const value = () => {
    skipSpace();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'") return string();
    if (text.startsWith('-Infinity', i)) {
      i += '-Infinity'.length;
      return -Infinity;
    }
    const number = match(NUMBER);
    if (number !== undefined) return Number(number);
    const start = i;
    const word = match(WORD);
    if (word !== undefined && LITERALS.has(word)) return LITERALS.get(word);
    i = start;
    return fail(i >= text.length ? 'the file ends too early' : `unexpected "${word ?? c}"`);
  };

  const object = () => {
    i++;
    const out = {};
    for (;;) {
      skipSpace();
      if (text[i] === '}') {
        i++;
        return out;
      }
      const key = text[i] === '"' || text[i] === "'" ? string() : match(WORD);
      if (key === undefined) fail('expected a property name');
      skipSpace();
      if (text[i] !== ':') fail('expected ":"');
      i++;
      setOwn(out, key, value());
      skipSpace();
      if (text[i] === ',') i++;
      else if (text[i] !== '}') fail('expected "," or "}"');
    }
  };

  const array = () => {
    i++;
    const out = [];
    for (;;) {
      skipSpace();
      if (text[i] === ']') {
        i++;
        return out;
      }
      out.push(value());
      skipSpace();
      if (text[i] === ',') i++;
      else if (text[i] !== ']') fail('expected "," or "]"');
    }
  };

  const root = value();
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error(`${name} must hold a JSON object ({ ... }).`);
  }
  return root;
}
