import { makeZip, readZip } from './zip.js';
import { allSections as modSections, exportFiles, fillShownValues, loadedSections, readModFiles, setSelectorKind, spellIds, validate as validateMod } from './modformat.js';

// ---------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------

const DRAFT_KEY = 'sovl-mod-editor-draft';
const CATALOG_KEY = 'sovl-mod-editor-catalog';

let catalog = null;
let mod = null;

/** Uploaded PNGs: path -> { bytes, width, height, url }. Kept out of the draft; see saveDraft. */
const images = new Map();

/**
 * The game's Workshop link (workshop.json), carried from an opened mod into the next export. Without it,
 * reinstalling an export made Publish create a second Workshop item instead of updating the first.
 */
let workshopLink = null;

let selection = { kind: 'mod' };

function blankMod() {
  return {
    modId: 'mymod',
    displayName: 'My Mod',
    author: '',
    contentVersion: '1.0.0',
    faction: {
      slug: 'myfaction',
      displayName: 'My Faction',
      materialTemplate: 'Default',
      factionImage: '',
      icons: [],
      defaultColors: { primary: 4, secondary: 30, icon: 40 },
      properties: [],
      characters: newSection('Commanders', 1, 1),
      battleLine: newSection('BattleLine', 2, 4),
      sections: [],
    },
    // Factions after the first, kept as their files' text: the editor edits one faction (see readModFiles).
    otherFactions: [],
  };
}

function newSection(name, min, max) {
  const limits = {};
  for (const size of catalog ? catalog.armySizes.map((a) => a.name) : ['Warband']) {
    limits[size] = { minCount: min, maxCount: max };
  }
  return { sectionName: name, unitLimits: limits, units: [] };
}

function newUnit(kind) {
  const stats = {};
  for (const stat of catalog.stats) stats[stat] = stat === 'Discipline' ? 7 : stat === 'Skill' ? 3 : 3;
  if (stats.Attacks !== undefined) stats.Attacks = 1;
  if (stats.Wounds !== undefined) stats.Wounds = 1;

  const unit = {
    kind,
    unitID: `${mod.modId}:newunit`,
    displayName: 'New Unit',
    pointsCost: 10,
    modelType: 'Infantry',
    unitType: kind === 'character' ? 'CommanderFighter' : 'MeleeInfantry',
    pattern: 'Solid',
    stats,
    icon: '',
    image: '',
    properties: [],
    models: [],
  };

  if (kind === 'regiment') {
    unit.modelCountLimits = { Warband: { minCount: 10, maxCount: 20 } };
  } else {
    unit.retinueOptions = [];
  }

  return unit;
}

function newProperty() {
  return {
    id: `${mod.modId}:newproperty`,
    displayName: 'New Property',
    description: '',
    effects: [{ kind: 'statModifier', stat: 'Power', value: 1 }],
  };
}

// ---------------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------------

function saveDraft() {
  try {
    // Images are excluded on purpose: a few PNGs blow past the localStorage quota, and silently losing
    // the whole draft to a failed write would be worse than re-picking the files.
    localStorage.setItem(DRAFT_KEY, JSON.stringify(mod));
  } catch (e) {
    console.warn('Could not save draft', e);
  }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'label' }, label), control,
    hint ? el('span', { class: 'hint' }, hint) : null);
}

// Nothing in the detail pane is laid out from what is typed into its own text fields, so hold the pane
// still while typing, as numberInput does. Rebuilding it per key broke dead keys, IME input and Ctrl+Z.
function typing(onChange, value) {
  keepDetail = true;
  try { onChange(value); } finally { keepDetail = false; }
}

function textInput(value, onChange, placeholder = '') {
  return el('input', { type: 'text', value: value ?? '', placeholder, oninput: (e) => typing(onChange, e.target.value) });
}

// Ids cannot carry surrounding whitespace, but trimming on every keystroke makes a typed space vanish
// mid-word and drags the caret with it. Take the text as typed and tidy it once the field is left - and
// only when there is something to tidy, so leaving a clean field never disturbs the pane on the way out.
function idInput(value, onChange) {
  return el('input', {
    type: 'text', value: value ?? '',
    oninput: (e) => typing(onChange, e.target.value),
    onchange: (e) => {
      const trimmed = e.target.value.trim();
      if (trimmed === e.target.value) return;
      e.target.value = trimmed;
      onChange(trimmed);
    },
  });
}

// A number input's caret cannot be read back, so it cannot survive its node being replaced. Nothing in the
// detail pane is derived from these numbers - only the outline and the problem list are - so hold the pane
// still while one is being typed into and let the browser keep its own caret.
let keepDetail = false;

function numberInput(value, onChange, { min, max, step } = {}) {
  let last = value ?? 0;
  return el('input', {
    type: 'number', value: last, min, max, step: step ?? 1,
    oninput: (e) => {
      // Chrome reports an empty value for anything not yet a valid number - a cleared field, a lone "-",
      // a trailing "." - so treat that as an edit in progress and leave the model on its last good value
      // rather than forcing a zero the typist then has to delete.
      if (e.target.value === '') return;
      last = Number(e.target.value);
      keepDetail = true;
      try { onChange(last); } finally { keepDetail = false; }
    },
    // Left half-finished: show the value the model actually kept.
    onchange: (e) => { if (e.target.value === '') e.target.value = String(last); },
  });
}

// A select always shows something, so a value the model does not hold yet must be committed rather than
// merely displayed: picking the option already shown fires no change event, and a select with a single
// option (Deployment's "ambusher") could never be set at all. A value that is set but no longer offered -
// a renamed unit, a removed image - is shown as missing instead of quietly retargeted to the first option.
// The mod's own enumerated fields are already filled before anything is drawn (fillShownValues); this covers
// the rest.
function select(value, options, onChange, { allowEmpty = false } = {}) {
  const node = el('select', { onchange: (e) => onChange(e.target.value) });
  const missing = value === undefined || value === null || value === '';
  if (allowEmpty) node.append(el('option', { value: '' }, '(none)'));
  if (!missing && !options.includes(value)) {
    node.append(el('option', { value, selected: 'selected' }, `${value} (missing)`));
  }
  for (const option of options) {
    const opt = el('option', { value: option }, option);
    if (option === value) opt.selected = true;
    node.append(opt);
  }
  if (missing && allowEmpty) node.value = '';
  // Deferred so the handler's own render() does not run inside the render building this node.
  if (missing && !allowEmpty && options.length) queueMicrotask(() => onChange(options[0]));
  return node;
}

const PROPERTY_GROUPS = [
  ['UnitPropertyGeneral', 'Rules'],
  ['UnitPropertyRangedAttack', 'Ranged attacks'],
  ['UnitPropertyWeaponSet', 'Weapon sets'],
  ['UnitPropertyCommanderAbility', 'Commander abilities (characters only)'],
  ['UnitPropertySpell', 'Spells (use a spellList)'],
  ['Enchantment', 'Magic weapons and items'],
  ['UnitBlessing', 'Blessings'],
];

// Properties by readable name, grouped by what they are. A flat list of 270 raw ids hid what each one was
// ("ccw" is the Close Combat Weapon) and let spells and commander abilities land on regiments.
function propertyPicker(value, onChange, { allowEmpty = true } = {}) {
  const node = el('select', { onchange: (e) => onChange(e.target.value) });
  const own = mod.faction.properties;
  const known = new Set([...own.map((p) => p.id), ...catalog.properties.map((p) => p.id)]);

  if (allowEmpty) node.append(el('option', { value: '' }, '(pick a property)'));
  if (value && !known.has(value)) node.append(el('option', { value, selected: 'selected' }, `${value} (missing)`));

  const option = (id, label) => el('option', { value: id, selected: id === value ? 'selected' : false }, label);
  if (own.length) {
    node.append(el('optgroup', { label: 'Your properties' }, own.map((p) => option(p.id, p.displayName || p.id))));
  }
  for (const [type, label] of PROPERTY_GROUPS) {
    const members = catalog.properties.filter((p) => p.type === type).sort((a, b) => a.name.localeCompare(b.name));
    if (members.length) node.append(el('optgroup', { label }, members.map((p) => option(p.id, `${p.name} (${p.id})`))));
  }
  const grouped = new Set(PROPERTY_GROUPS.map(([t]) => t));
  const rest = catalog.properties.filter((p) => !grouped.has(p.type));
  if (rest.length) node.append(el('optgroup', { label: 'Other' }, rest.map((p) => option(p.id, `${p.name} (${p.id})`))));

  if (!value && allowEmpty) node.value = '';
  if (!value && !allowEmpty) queueMicrotask(() => onChange(node.value));
  return node;
}

function describeProperty(id) {
  const own = mod.faction.properties.find((p) => p.id === id);
  if (own) return own.description || '';
  const builtin = catalog.properties.find((p) => p.id === id);
  return builtin ? builtin.description : '';
}

function checkbox(value, label, onChange) {
  return el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: value ? 'checked' : false, onchange: (e) => onChange(e.target.checked) }),
    label);
}

function button(label, onClick, cls = '') {
  return el('button', { class: cls, onclick: onClick }, label);
}

// ---------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------

// The page-side wrappers over modformat.js, which holds the format itself.
function validate() {
  return validateMod(mod, catalog, images);
}

function allSections() {
  return modSections(mod);
}

async function exportZip() {
  const files = exportFiles(mod, catalog, images);
  if (workshopLink) files.push({ name: 'workshop.json', data: workshopLink });
  const blob = makeZip(files);
  const link = el('a', { href: URL.createObjectURL(blob), download: `${mod.modId}.zip` });
  document.body.append(link);
  link.click();
  link.remove();

  // Unzipping into the right place was the first wall most people hit, so say how right after export.
  document.getElementById('installName').textContent = mod.displayName || mod.modId;
  document.getElementById('installZip').textContent = `${mod.modId}.zip`;
  document.getElementById('installId').textContent = mod.modId;
  document.getElementById('installDialog').showModal();
}

// ---------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------

// Every edit re-renders the whole panel, which throws away the node the caret sits in. Remember where
// the caret was as a positional path from the panel root, then put it back once the new tree is in place.
function captureFocus() {
  const node = document.activeElement;
  const root = node ? node.closest('#outline, #detail, #problems') : null;
  if (!root) return null;

  const path = [];
  for (let n = node; n !== root; n = n.parentNode) {
    if (!n.parentNode) return null;
    path.unshift([...n.parentNode.childNodes].indexOf(n));
  }

  // Number inputs report a null caret and cannot be given one back; keepDetail below spares them the rebuild.
  let start = null;
  let end = null;
  try { start = node.selectionStart; end = node.selectionEnd; } catch { /* checkboxes have no caret */ }
  return { rootId: root.id, path, tag: node.tagName, type: node.getAttribute('type'), start, end };
}

function restoreFocus(state) {
  if (!state) return;

  let node = document.getElementById(state.rootId);
  for (const index of state.path) {
    node = node && node.childNodes[index];
    if (!node) return;
  }
  // The tree can change shape - a different kind of control in that slot means the old caret is meaningless.
  if (node.tagName !== state.tag || node.getAttribute('type') !== state.type) return;

  // Still the live node - it was never rebuilt, so the browser has kept a better caret than we recorded.
  if (node === document.activeElement) return;

  node.focus();
  if (state.start === null || state.start === undefined) return;
  // The handler may have rewritten the value shorter than what was typed, so clamp the caret into it.
  const max = (node.value ?? '').length;
  const end = state.end ?? state.start;
  try { node.setSelectionRange(Math.min(state.start, max), Math.min(end, max)); } catch { /* no caret */ }
}

function render() {
  const focus = captureFocus();
  // Before anything is drawn, so each dropdown's shown option is also the stored one (see fillShownValues).
  fillShownValues(mod, catalog);
  saveDraft();
  document.getElementById('outline').replaceChildren(renderOutline());
  if (!keepDetail) document.getElementById('detail').replaceChildren(renderDetail());
  renderProblems();
  restoreFocus(focus);
}

function renderProblems() {
  const problems = validate();
  const notes = advise();
  const bar = document.getElementById('problems');
  const wasOpen = bar.querySelector('details.blocking')?.open ?? false;
  const notesOpen = bar.querySelector('details.notes')?.open ?? false;
  bar.className = problems.length ? 'problems bad' : 'problems good';
  bar.replaceChildren(...[
    problems.length
      ? el('details', { class: 'blocking', open: wasOpen ? 'open' : false },
          el('summary', {}, `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before this mod will load`),
          el('ul', {}, problems.map((p) => el('li', {}, p))))
      : el('span', {}, 'Ready to export.'),
    notes.length
      ? el('details', { class: 'notes', open: notesOpen ? 'open' : false },
          el('summary', {}, `${notes.length} thing${notes.length === 1 ? '' : 's'} worth checking (the mod still loads)`),
          el('ul', {}, notes.map((p) => el('li', {}, p))))
      : null,
  ].filter(Boolean));
}

/**
 * Things that load fine but rarely do what the author meant - the surprises players ran into on Discord.
 * Unlike validate(), none of these stop an export.
 */
function advise() {
  const notes = [];
  const sizes = catalog.armySizes.map((s) => s.name);

  for (const section of allSections()) {
    for (const size of sizes) {
      const limit = section.unitLimits[size];
      if (limit && limit.maxCount === 0 && (section === mod.faction.characters || section === mod.faction.battleLine)) {
        notes.push(`${section.sectionName} allows no units in ${size}, so no ${size} army can be built.`);
      }
    }
    for (const unit of section.units) {
      if (unit.kind === 'regiment') {
        // Unrestricted has no points cap, so any size there is expected rather than an oversight.
        const unset = sizes.filter((s) => s !== 'Unrestricted' && !unit.modelCountLimits?.[s]);
        if (unset.length && unset.length < sizes.length - 1) {
          notes.push(`${unit.displayName || unit.unitID}: no model count for ${unset.join(', ')}, so it can be taken there at 1-100 models.`);
        }
      }
      for (const selector of unit.properties ?? []) {
        for (const id of [selector.propertyId, ...(selector.propertyIds ?? [])].filter(Boolean)) {
          const type = catalog.properties.find((p) => p.id === id)?.type;
          if (type === 'UnitPropertyCommanderAbility' && unit.kind === 'regiment') {
            notes.push(`${unit.displayName || unit.unitID}: ${id} is a commander ability, which only works on characters. The game leaves it off this regiment.`);
          }
          if (type === 'UnitPropertySpell' && selector.kind !== 'spellList') {
            notes.push(`${unit.displayName || unit.unitID}: give spells through a spellList, not as a plain property (${id}).`);
          }
        }
      }
      if ((unit.models ?? []).length === 0) {
        notes.push(`${unit.displayName || unit.unitID}: no model graphics; it is drawn as plain bases on the battlefield.`);
      }
      if ((unit.models ?? []).filter((m) => !m.propertyId).length > 1) {
        notes.push(`${unit.displayName || unit.unitID}: only the first model graphics card without "Only with" is used. Put variety in its Sprites list instead.`);
      }
    }
  }

  for (const property of mod.faction.properties) {
    const used = allSections().some((s) => s.units.some((u) => (u.properties ?? []).some((sel) =>
      sel.propertyId === property.id || (sel.propertyIds ?? []).includes(property.id))));
    if (!used) notes.push(`${property.displayName || property.id} is not given to any unit.`);
  }

  return notes;
}

function outlineItem(label, sel, extra) {
  const active = JSON.stringify(sel) === JSON.stringify(selection);
  return el('div', { class: 'outline-row' + (active ? ' active' : '') },
    el('button', { class: 'outline-link', onclick: () => { selection = sel; render(); } }, label), extra);
}

function renderOutline() {
  const wrap = el('div');

  wrap.append(outlineItem('Mod & Faction', { kind: 'mod' }));
  wrap.append(el('div', { class: 'outline-head' }, 'Images',
    button('+', () => document.getElementById('imageInput').click(), 'tiny')));
  wrap.append(outlineItem(`${images.size} image${images.size === 1 ? '' : 's'}`, { kind: 'images' }));

  wrap.append(el('div', { class: 'outline-head' }, 'Properties',
    button('+', () => { mod.faction.properties.push(newProperty()); selection = { kind: 'property', index: mod.faction.properties.length - 1 }; render(); }, 'tiny')));
  mod.faction.properties.forEach((p, index) =>
    wrap.append(outlineItem(p.displayName || p.id, { kind: 'property', index })));

  wrap.append(el('div', { class: 'outline-head' }, 'Sections',
    button('+', () => { mod.faction.sections.push(newSection('New Section', 0, 2)); render(); }, 'tiny')));

  allSections().forEach((section, sectionIndex) => {
    wrap.append(outlineItem(section.sectionName, { kind: 'section', sectionIndex },
      button('+ unit', () => {
        section.units.push(newUnit(sectionIndex === 0 ? 'character' : 'regiment'));
        selection = { kind: 'unit', sectionIndex, unitIndex: section.units.length - 1 };
        render();
      }, 'tiny')));

    section.units.forEach((unit, unitIndex) =>
      wrap.append(el('div', { class: 'nested' },
        outlineItem(unit.displayName || unit.unitID, { kind: 'unit', sectionIndex, unitIndex }))));
  });

  return wrap;
}

function renderDetail() {
  switch (selection.kind) {
    case 'images': return renderImages();
    case 'property': return renderProperty(mod.faction.properties[selection.index], selection.index);
    case 'section': return renderSection(allSections()[selection.sectionIndex], selection.sectionIndex);
    case 'unit': {
      const section = allSections()[selection.sectionIndex];
      return renderUnit(section.units[selection.unitIndex], selection);
    }
    default: return renderMod();
  }
}

function renderMod() {
  const faction = mod.faction;
  const imagePaths = [...images.keys()];

  return el('div', {},
    el('h2', {}, 'Mod'),
    field('Mod id', idInput(mod.modId, (v) => { mod.modId = v; render(); }),
      'Lower-case. Every unit and property id must start with this, followed by a colon.'),
    field('Display name', textInput(mod.displayName, (v) => { mod.displayName = v; render(); })),
    field('Author', textInput(mod.author, (v) => { mod.author = v; saveDraft(); })),
    field('Version', textInput(mod.contentVersion, (v) => { mod.contentVersion = v; saveDraft(); })),

    el('h2', {}, 'Faction'),
    keptAsLoaded(),
    field('Slug', idInput(faction.slug, (v) => { faction.slug = v; render(); })),
    field('Display name', textInput(faction.displayName, (v) => { faction.displayName = v; render(); })),
    field('Material template', select(faction.materialTemplate, catalog.materialTemplates, (v) => { faction.materialTemplate = v; saveDraft(); })),
    field('Faction image', select(faction.factionImage, imagePaths, (v) => { faction.factionImage = v; render(); }, { allowEmpty: true })),

    el('div', { class: 'field' }, el('span', { class: 'label' }, 'Icons'),
      el('div', {}, faction.icons.map((icon, i) =>
        el('div', { class: 'row' },
          select(icon, imagePaths, (v) => { faction.icons[i] = v; render(); }),
          button('remove', () => { faction.icons.splice(i, 1); render(); }, 'tiny'))),
        button('+ icon', () => { faction.icons.push(imagePaths[0] ?? ''); render(); }, 'tiny'))),

    el('h2', {}, 'Colours'),
    el('p', { class: 'hint' }, `Palette indices, 0-${catalog.limits.colorPaletteSize - 1}.`),
    field('Primary', numberInput(faction.defaultColors.primary, (v) => { faction.defaultColors.primary = v; saveDraft(); }, { min: 0, max: catalog.limits.colorPaletteSize - 1 })),
    field('Secondary', numberInput(faction.defaultColors.secondary, (v) => { faction.defaultColors.secondary = v; saveDraft(); }, { min: 0, max: catalog.limits.colorPaletteSize - 1 })),
    field('Icon', numberInput(faction.defaultColors.icon, (v) => { faction.defaultColors.icon = v; saveDraft(); }, { min: 0, max: catalog.limits.colorPaletteSize - 1 })));
}

/** What the opened mod has that the editor cannot edit, and exports as it was loaded. */
function keptAsLoaded() {
  const mounts = mod.faction.mounts?.units ?? [];
  const others = mod.otherFactions ?? [];
  if (!mounts.length && !others.length) return null;

  return el('div', { class: 'card thin' },
    el('strong', {}, 'Kept as loaded'),
    el('p', { class: 'hint' }, 'This mod has parts the editor cannot edit yet. They are exported exactly as they were opened.'),
    el('ul', {},
      mounts.length ? el('li', {}, `Mounts section: ${mounts.map((u) => u.unitID).join(', ')}. Commanders can ride these.`) : null,
      others.map((other) => el('li', {}, `Faction ${other.path}`))));
}

function renderImages() {
  return el('div', {},
    el('h2', {}, 'Images'),
    el('p', { class: 'hint' },
      `PNG only, up to ${catalog.limits.maxImagePixels}px square. Name one preview.png for the Workshop. ` +
      'Images are not saved with the draft, so add them again if you reload.'),
    button('Add images', () => document.getElementById('imageInput').click()),
    el('div', { class: 'gallery' }, [...images.entries()].map(([path, image]) =>
      el('div', { class: 'thumb' },
        el('img', { src: image.url, alt: path }),
        el('code', {}, path),
        el('span', { class: 'hint' }, `${image.width}x${image.height}`),
        button('remove', () => { images.delete(path); render(); }, 'tiny')))));
}

function renderProperty(property, index) {
  if (!property) return el('div', {}, 'Select something on the left.');

  return el('div', {},
    el('h2', {}, 'Property',
      button('delete', () => { mod.faction.properties.splice(index, 1); selection = { kind: 'mod' }; render(); }, 'tiny danger')),
    field('Id', idInput(property.id, (v) => { property.id = v; render(); }), `Must start with "${mod.modId}:".`),
    field('Display name', textInput(property.displayName, (v) => { property.displayName = v; render(); })),
    field('Description', textInput(property.description, (v) => { property.description = v; saveDraft(); })),
    field('Applies to', select(property.appliesTo ?? 'Models', catalog.propertyAppliesTo, (v) => { property.appliesTo = v; saveDraft(); })),

    el('h3', {}, 'Effects', button('+ effect', () => { property.effects.push({ kind: 'statModifier', stat: 'Power', value: 1 }); render(); }, 'tiny')),
    property.effects.map((effect, i) => renderEffect(effect, () => { property.effects.splice(i, 1); render(); })));
}

// ---------------------------------------------------------------------------------------------------
// Plain-language help. The catalog gives the ids the game reads; these say what each one does, because
// the ids alone sent people down the wrong path (extraAttacks vs extraShots, what firstRound means,
// whether a stat modifier sets or adds). Anything missing here simply shows no help.
// ---------------------------------------------------------------------------------------------------

const HELP = {
  effects: {
    combatScore: 'Adds Value to this side\'s combat result in every melee it fights.',
    damageSave: 'Changes the damage saves this unit rolls when it is hit.',
    deployment: 'Changes how the unit deploys.',
    discipline: 'Changes this unit\'s Discipline (break) tests.',
    doubleWounds: 'Every unsaved hit this unit inflicts causes two wounds.',
    extraRankAttacks: 'One more rank of models fights in melee.',
    ignoreDifficultTerrain: 'Moves through difficult terrain without slowing down.',
    ignoreImpassableTerrain: 'Moves over impassable terrain.',
    movement: 'Adds Amount inches to every move the unit makes, charges included, or replaces its move with Amount. Of the When conditions only "withCommander" means anything here; combat ones never hold while moving.',
    rangedAttackBonus: 'Changes this unit\'s shooting. Collected from "opponent" changes shooting aimed at this unit instead.',
    regeneration: 'Can recover lost wounds.',
    statModifier: 'Adds Value to a stat while the condition holds. Negative values lower it. It never sets the stat outright.',
    toHit: 'Changes this unit\'s rolls to hit in melee.',
  },
  effectTypes: {
    damageSave: {
      rerollFailures: 'Re-roll failed saves.',
      rerollSuccesses: 'Re-roll successful saves. Use with Collected from "opponent" so enemies hit by this unit must re-roll their saves.',
      modified: 'Adds Value to the save roll. Positive makes saves easier.',
      capAt4plus: 'Saves can never be better than 4+.',
      reRollSixes: 'Re-roll saves that roll a 6.',
      reRollOnes: 'Re-roll saves that roll a 1.',
    },
    deployment: {
      ambusher: 'Deploys as an ambusher instead of at the start. This is the only deployment type for now.',
    },
    discipline: {
      reroll: 'Re-roll failed Discipline tests.',
      autoSuccess: 'Always passes Discipline tests.',
      unmodified: 'Ignores the combat result when testing.',
      rerollSuccesses: 'Re-roll passed Discipline tests (put this on enemies with "opponent").',
      crumbleD3: 'Never flees: instead of testing, it loses D3 wounds (undead-style crumbling).',
      crumble2D3: 'Never flees: instead of testing, it loses 2D3 wounds.',
      reduceCrumble: 'Crumbles one wound less.',
    },
    rangedAttackBonus: {
      extraRange: 'Adds Value inches to the weapon\'s range. Negative shortens it.',
      toHitMod: 'Adds Value to rolls to hit. Positive makes hitting easier.',
      rerollMisses: 'Re-roll shots that miss.',
      rerollHits: 'Re-roll shots that hit (put this on enemies with "opponent").',
      extraAttacks: 'Value more shots for a war machine or other special attack (cannon, flamer, bolt thrower). Does nothing for ordinary bows and guns: use extraShots there.',
      rerollOnes: 'Re-roll to-hit rolls of 1.',
      plusPower: 'Adds Value to the weapon\'s Power.',
      cover: 'Shots count the target as being in cover.',
      extraShots: 'For ordinary bows, guns and crossbows: shots are multiplied by 1 + Value, so Value 1 makes every model shoot twice. Does nothing for special attacks: use extraAttacks there.',
      ignoreCover: 'Ignores the target\'s cover.',
      extraRank: 'One more rank of models can shoot.',
    },
    toHit: {
      rerollMisses: 'Re-roll attacks that miss.',
      rerollHits: 'Re-roll attacks that hit (put this on enemies with "opponent").',
      plusOne: '+1 to hit.',
      minusOne: '-1 to hit (put this on enemies with "opponent").',
      rerollOnes: 'Re-roll to-hit rolls of 1.',
    },
  },
  conditions: {
    charging: 'This unit charged into this combat.',
    inCombat: 'This unit is in melee.',
    firstRound: 'The first round of each combat, whoever charged.',
    flankOrRear: 'The attack lands on the enemy\'s flank or rear.',
    melee: 'A melee attack.',
    ranged: 'A shooting attack.',
    monstrousTarget: 'The enemy is a monster or monstrous infantry.',
    withCommander: 'A commander has joined this unit.',
    targetUnitType: 'The enemy is one of the ticked unit types.',
    allOf: 'Every condition below holds.',
    anyOf: 'At least one condition below holds.',
  },
  selectors: {
    builtin: 'Always has this property.',
    optional: 'May buy this property for Extra points when building a list.',
    pickOne: 'Picks one of these when building a list, each with its own cost.',
    spellList: 'A spellcaster: picks a number of spells from the ones listed.',
    enchantments: 'May buy magic weapons and/or magic items.',
    banners: 'May carry a magic banner.',
  },
};

// A new kind starts from its own defaults. Carrying the old fields over left a damageSave's effectType on a
// deployment effect, which the game then rejected as "nothing selected".
function resetEffect(effect, kind) {
  const { isAura, when } = effect;
  for (const key of Object.keys(effect)) delete effect[key];
  Object.assign(effect, { kind }, isAura ? { isAura } : {}, when ? { when } : {});

  const info = catalog.effects.find((e) => e.kind === kind);
  for (const name of info?.fields ?? []) {
    if (name === 'stat') effect.stat = catalog.stats[0];
    else if (name === 'effectType') effect.effectType = info.effectTypeValues[0];
    else if (name === 'value') effect.value = 1;
    else if (name === 'amount') effect.amount = 0;
    else if (name === 'appliesTo') effect.appliesTo = 'ownerUnit';
  }
}

function renderEffect(effect, onRemove) {
  const info = catalog.effects.find((e) => e.kind === effect.kind);
  const rows = [
    el('div', { class: 'row' },
      select(effect.kind, catalog.effects.map((e) => e.kind), (v) => { resetEffect(effect, v); render(); }),
      button('remove', onRemove, 'tiny danger')),
    HELP.effects[effect.kind] ? el('p', { class: 'hint' }, HELP.effects[effect.kind]) : null,
  ];

  const fields = info?.fields ?? [];

  if (fields.includes('stat')) rows.push(field('Stat', select(effect.stat, catalog.stats, (v) => { effect.stat = v; saveDraft(); })));
  if (fields.includes('effectType')) {
    rows.push(field('Type', select(effect.effectType, info.effectTypeValues, (v) => { effect.effectType = v; render(); }),
      HELP.effectTypes[effect.kind]?.[effect.effectType] ?? ''));
  }
  if (fields.includes('value')) rows.push(field('Value', numberInput(effect.value ?? 0, (v) => { effect.value = v; render(); })));
  if (fields.includes('amount')) rows.push(field('Amount', numberInput(effect.amount ?? 0, (v) => { effect.amount = v; saveDraft(); }, { step: 0.5 })));
  if (fields.includes('replaceMovement')) rows.push(checkbox(effect.replaceMovement, 'Replace movement instead of adding', (v) => { effect.replaceMovement = v; saveDraft(); }));
  if (fields.includes('appliesTo')) {
    rows.push(field('Collected from', select(effect.appliesTo ?? 'ownerUnit', catalog.appliesTo, (v) => { effect.appliesTo = v; saveDraft(); }),
      'opponent means the effect sits on one unit but changes its enemy’s rolls.'));
  }

  rows.push(checkbox(effect.isAura, 'Aura - also affects the unit a commander joined', (v) => { effect.isAura = v; saveDraft(); }));
  rows.push(field('When', renderCondition(effect, 'when', 0)));

  return el('div', { class: 'card' }, rows);
}

function renderCondition(owner, key, depth) {
  const condition = owner[key];
  const kinds = catalog.conditions;

  const chooser = select(condition?.kind ?? '', kinds, (v) => {
    owner[key] = v ? { kind: v } : undefined;
    render();
  }, { allowEmpty: true });

  if (!condition) return el('div', { class: 'row' }, chooser, el('span', { class: 'hint' }, 'always'));

  const rows = [el('div', { class: 'row' }, chooser,
    HELP.conditions[condition.kind] ? el('span', { class: 'hint' }, HELP.conditions[condition.kind]) : null)];

  if (condition.kind === 'targetUnitType') {
    rows.push(el('div', { class: 'chips' }, catalog.unitTypes.map((type) =>
      checkbox((condition.unitTypes ?? []).includes(type), type, (on) => {
        condition.unitTypes = condition.unitTypes ?? [];
        if (on) condition.unitTypes.push(type);
        else condition.unitTypes = condition.unitTypes.filter((t) => t !== type);
        saveDraft();
      }))));
  }

  if (condition.kind === 'allOf' || condition.kind === 'anyOf') {
    condition.conditions = condition.conditions ?? [];
    if (depth >= catalog.limits.maxConditionDepth) {
      rows.push(el('span', { class: 'hint' }, `Cannot nest deeper than ${catalog.limits.maxConditionDepth}.`));
    } else {
      condition.conditions.forEach((_, i) =>
        rows.push(el('div', { class: 'nested' },
          renderCondition(condition.conditions, i, depth + 1),
          button('remove', () => { condition.conditions.splice(i, 1); render(); }, 'tiny'))));
      rows.push(button('+ condition', () => { condition.conditions.push({ kind: 'charging' }); render(); }, 'tiny'));
    }
  }

  return el('div', { class: 'card thin' }, rows);
}

function renderSection(section, sectionIndex) {
  const removable = sectionIndex >= 2;

  return el('div', {},
    el('h2', {}, 'Section',
      removable ? button('delete', () => { mod.faction.sections.splice(sectionIndex - 2, 1); selection = { kind: 'mod' }; render(); }, 'tiny danger') : null),
    field('Name', textInput(section.sectionName, (v) => { section.sectionName = v; render(); }),
      removable ? '' : 'Commanders and BattleLine are required and cannot be removed.'),

    el('h3', {}, 'How many units of this section an army may take'),
    el('p', { class: 'hint' }, 'An army size left blank has no limit (0 to 99). Set the maximum to 0 to keep this section out of that size.'),
    catalog.armySizes.map((size) => {
      // Only write a size once it is edited: viewing the section used to store 0-0 for every blank size,
      // which silently banned the section from it.
      const limit = section.unitLimits[size.name];
      const commit = (key, v) => {
        section.unitLimits[size.name] = section.unitLimits[size.name] ?? { minCount: 0, maxCount: 99 };
        section.unitLimits[size.name][key] = v;
        render();
      };
      return el('div', { class: 'row' },
        el('span', { class: 'label' }, `${size.name} (${size.points}pts)`),
        numberInput(limit?.minCount ?? 0, (v) => commit('minCount', v), { min: 0 }),
        el('span', {}, 'to'),
        numberInput(limit?.maxCount ?? 99, (v) => commit('maxCount', v), { min: 0 }),
        limit ? button('clear', () => { delete section.unitLimits[size.name]; render(); }, 'tiny') : el('span', { class: 'hint' }, 'no limit'));
    }));
}

function renderUnit(unit, sel) {
  if (!unit) return el('div', {}, 'Select something on the left.');

  const imagePaths = [...images.keys()];
  const section = allSections()[sel.sectionIndex];
  // A retinue must be a regiment: the game refuses a character there. Mounts are offered too, though the editor
  // cannot edit their section.
  const regiments = loadedSections(mod).flatMap((s) => s.units ?? []).filter((u) => u !== unit && u.kind === 'regiment');

  const parts = [
    el('h2', {}, 'Unit',
      button('delete', () => { section.units.splice(sel.unitIndex, 1); selection = { kind: 'mod' }; render(); }, 'tiny danger')),
    field('Kind', select(unit.kind, catalog.unitKinds, (v) => {
      unit.kind = v;
      if (v === 'regiment') { unit.modelCountLimits = unit.modelCountLimits ?? { Warband: { minCount: 10, maxCount: 20 } }; delete unit.retinueOptions; }
      else { unit.retinueOptions = unit.retinueOptions ?? []; delete unit.modelCountLimits; }
      render();
    })),
    field('Unit id', idInput(unit.unitID, (v) => { renameUnit(unit, v); render(); }), `Must start with "${mod.modId}:".`),
    field('Display name', textInput(unit.displayName, (v) => { unit.displayName = v; render(); })),
    field('Points', numberInput(unit.pointsCost, (v) => { unit.pointsCost = v; render(); }, { min: catalog.limits.minPointsCost, max: catalog.limits.maxPointsCost })),
    field('Model type', select(unit.modelType, catalog.modelTypes.map((m) => m.name), (v) => { unit.modelType = v; saveDraft(); }),
      describeModelType(unit.modelType)),
    field('Unit type', select(unit.unitType, catalog.unitTypes, (v) => { unit.unitType = v; saveDraft(); })),
    field('Pattern', select(unit.pattern, catalog.patterns, (v) => { unit.pattern = v; saveDraft(); })),
    field('Section limit cost', select(unit.sectionLimitCost ?? 'One', catalog.sectionLimitCosts, (v) => { unit.sectionLimitCost = v; saveDraft(); })),
    checkbox(unit.isMount, 'Is a mount - a commander can ride this instead of joining it', (v) => { unit.isMount = v; saveDraft(); }),

    el('h3', {}, 'Stats'),
    el('div', { class: 'stats' }, catalog.stats.map((stat) =>
      field(stat, numberInput(unit.stats[stat] ?? 3, (v) => { unit.stats[stat] = v; render(); },
        { min: catalog.limits.minStat, max: catalog.limits.maxStat })))),

    el('h3', {}, 'Images'),
    field('Icon', select(unit.icon, imagePaths, (v) => { unit.icon = v; render(); }, { allowEmpty: true }),
      'The heraldry shape drawn on the base. White shape, black outline, transparent background.'),
    field('Portrait', select(unit.image, imagePaths, (v) => { unit.image = v; render(); }, { allowEmpty: true }),
      'Shown in the army list.'),
  ];

  if (unit.kind === 'regiment') {
    parts.push(el('h3', {}, 'Models per regiment'),
      el('p', { class: 'hint' }, 'An unticked army size does not ban the unit: it can be taken there at any size from 1 to 100 models. ' +
        'To keep a unit out of an army size, limit its section in that size instead.'));
    unit.modelCountLimits = unit.modelCountLimits ?? {};
    parts.push(...catalog.armySizes.map((size) => {
      const limit = unit.modelCountLimits[size.name];
      return el('div', { class: 'row' },
        checkbox(!!limit, size.name, (on) => {
          if (on) unit.modelCountLimits[size.name] = { minCount: 10, maxCount: 20 };
          else delete unit.modelCountLimits[size.name];
          render();
        }),
        limit ? numberInput(limit.minCount, (v) => { limit.minCount = v; saveDraft(); }, { min: 1 }) : null,
        limit ? el('span', {}, 'to') : null,
        limit ? numberInput(limit.maxCount, (v) => { limit.maxCount = v; saveDraft(); }, { min: 1 }) : null);
    }));
  } else {
    parts.push(el('h3', {}, 'Retinue'),
      el('p', { class: 'hint' }, 'The regiments this commander can join, or mounts it can ride.'),
      checkbox(unit.soloCommander, 'Fights alone - no retinue needed', (v) => { unit.soloCommander = v; render(); }));

    unit.retinueOptions = unit.retinueOptions ?? [];
    parts.push(...unit.retinueOptions.map((retinue, i) =>
      el('div', { class: 'row' },
        select(retinue.unitID, regiments.map((u) => u.unitID), (v) => { retinue.unitID = v; render(); }),
        checkbox(retinue.isMount, 'as a mount', (v) => { retinue.isMount = v; saveDraft(); }),
        button('remove', () => { unit.retinueOptions.splice(i, 1); render(); }, 'tiny'))));
    parts.push(button('+ retinue', () => { unit.retinueOptions.push({ unitID: regiments[0]?.unitID ?? '' }); render(); }, 'tiny'));
  }

  parts.push(el('h3', {}, 'Properties'),
    el('p', { class: 'hint' }, 'Rules this unit has. Built-in properties and ones you defined are both listed.'));

  unit.properties = unit.properties ?? [];
  parts.push(...unit.properties.map((selector, i) => renderSelector(selector, () => { unit.properties.splice(i, 1); render(); })));
  parts.push(button('+ property', () => { unit.properties.push({ kind: 'builtin', propertyId: '' }); render(); }, 'tiny'));

  parts.push(el('h3', {}, 'Model graphics'),
    el('p', { class: 'hint' }, 'Sprites drawn per model on the battlefield. One card is the default look; for variety add several sprites to it. ' +
      'Add more cards with "Only with" set to change how the unit looks when an option is picked, such as a weapon.'));

  // The options a player can pick on this unit, which is what "Only with" can key on.
  const optionIds = unit.properties.flatMap((s) => (s.kind === 'optional' ? [s.propertyId] : s.kind === 'pickOne' ? s.propertyIds ?? [] : []))
    .filter(Boolean);
  unit.models = unit.models ?? [];
  parts.push(...unit.models.map((models, i) => renderModels(models, imagePaths, optionIds, () => { unit.models.splice(i, 1); render(); })));
  parts.push(button('+ model graphics', () => { unit.models.push({ images: [], scale: 1.85 }); render(); }, 'tiny'));

  return el('div', {}, parts);
}

// Retinues point at units by id, so a rename carries them along instead of leaving them dangling.
function renameUnit(unit, id) {
  const old = unit.unitID;
  unit.unitID = id;
  for (const other of allSections().flatMap((s) => s.units)) {
    for (const retinue of other.retinueOptions ?? []) {
      if (retinue.unitID === old) retinue.unitID = id;
    }
  }
}

function describeModelType(name) {
  const info = catalog.modelTypes.find((m) => m.name === name);
  return info ? `Base ${info.width}x${info.height}, moves ${info.movement}.` : '';
}

function renderSelector(selector, onRemove) {
  const all = [...catalog.properties.map((p) => p.id), ...mod.faction.properties.map((p) => p.id)];

  return el('div', { class: 'card thin' },
    el('div', { class: 'row' },
      select(selector.kind, catalog.propertySelectorKinds, (v) => { setSelectorKind(selector, v, catalog); render(); }),
      el('span', { class: 'hint' }, HELP.selectors[selector.kind] ?? ''),
      button('remove', onRemove, 'tiny danger')),
    ['builtin', 'optional'].includes(selector.kind)
      ? field('Property', propertyPicker(selector.propertyId, (v) => { selector.propertyId = v; render(); }),
          describeProperty(selector.propertyId))
      : null,
    selector.kind === 'optional'
      ? field('Extra points', numberInput(selector.cost ?? 0, (v) => { selector.cost = v; saveDraft(); }, { min: 0 }))
      : null,
    selector.kind === 'pickOne'
      ? el('div', {}, el('span', { class: 'hint' }, 'Choose between these when building a list.'),
          (selector.propertyIds ?? []).map((id, i) => el('div', { class: 'row' },
            propertyPicker(id, (v) => { selector.propertyIds[i] = v; render(); }, { allowEmpty: false }),
            numberInput(selector.costs?.[i] ?? 0, (v) => { selector.costs = selector.costs ?? []; selector.costs[i] = v; saveDraft(); }, { min: 0 }),
            button('remove', () => { selector.propertyIds.splice(i, 1); selector.costs?.splice(i, 1); render(); }, 'tiny'))),
          button('+ option', () => {
            selector.propertyIds = selector.propertyIds ?? [];
            selector.costs = selector.costs ?? [];
            selector.propertyIds.push(all[0]); selector.costs.push(0);
            render();
          }, 'tiny'))
      : null,
    selector.kind === 'spellList' ? renderSpellList(selector) : null,
    selector.kind === 'enchantments'
      ? el('div', {}, el('span', { class: 'hint' }, 'What this unit can be given when building a list.'),
          checkbox(selector.weapons, 'Magic weapons', (v) => { selector.weapons = v; render(); }),
          checkbox(selector.items, 'Magic items', (v) => { selector.items = v; render(); }))
      : null,
    selector.kind === 'banners'
      ? checkbox(selector.eliteUnit, 'Elite unit - banners up to 100 pts instead of 50', (v) => { selector.eliteUnit = v; saveDraft(); })
      : null);
}

function renderSpellList(selector) {
  const spells = spellIds(catalog);
  selector.propertyIds = selector.propertyIds ?? [];

  return el('div', {},
    el('span', { class: 'hint' }, 'The spells this unit can choose from. Only the game’s own spells: a mod cannot make new ones.'),
    field('Spell count', numberInput(selector.spellCount ?? 1, (v) => { selector.spellCount = v; saveDraft(); }, { min: 1 }),
      'Shown on the unit as Spellcaster(count).'),
    selector.propertyIds.map((id, i) => el('div', { class: 'row' },
      select(id, spells, (v) => { selector.propertyIds[i] = v; render(); }),
      button('remove', () => { selector.propertyIds.splice(i, 1); render(); }, 'tiny'))),
    button('+ spell', () => {
      selector.propertyIds.push(spells.find((s) => !selector.propertyIds.includes(s)) ?? spells[0]);
      render();
    }, 'tiny'));
}

function renderModels(models, imagePaths, optionIds, onRemove) {
  const list = (key, label, hint) => el('div', { class: 'field' },
    el('span', { class: 'label' }, label),
    hint ? el('span', { class: 'hint' }, hint) : null,
    el('div', {}, (models[key] ?? []).map((path, i) => el('div', { class: 'row' },
      select(path, imagePaths, (v) => { models[key][i] = v; render(); }),
      button('remove', () => { models[key].splice(i, 1); render(); }, 'tiny')))),
    button('+ image', () => { models[key] = models[key] ?? []; models[key].push(imagePaths[0] ?? ''); render(); }, 'tiny'));

  return el('div', { class: 'card' },
    el('div', { class: 'row' }, el('strong', {}, models.propertyId ? `Model graphics with ${models.propertyId}` : 'Model graphics (default look)'),
      button('remove', onRemove, 'tiny danger')),
    field('Only with', select(models.propertyId ?? '', optionIds, (v) => {
      if (v) models.propertyId = v; else delete models.propertyId;
      render();
    }, { allowEmpty: true }), 'Use this art only while the unit has that option picked. (none) is the default look.'),
    list('images', 'Sprites', 'One is picked at random per model.'),
    list('steedImages', 'Steeds (optional)', 'Adding steeds makes this cavalry: the sprites above ride on top. Draw steeds long and narrow.'),
    field('Scale', numberInput(models.scale ?? 1.85, (v) => { models.scale = v; saveDraft(); }, { step: 0.05, min: 0.1, max: catalog.limits.maxModelScale })),
    (models.steedImages ?? []).length
      ? field('Rider offset', numberInput(models.riderOffset ?? 0, (v) => { models.riderOffset = v; saveDraft(); }, { step: 0.01 }),
          'Positive moves the rider towards the rear, which is what a chariot wants.')
      : null,
    checkbox(models.randomFlip, 'Mirror some models - only for symmetric art', (v) => { models.randomFlip = v; saveDraft(); }));
}

// ---------------------------------------------------------------------------------------------------
// Opening an existing mod
// ---------------------------------------------------------------------------------------------------

/**
 * Loads a mod from its files, whichever way they arrived. Everything the editor holds is replaced, so
 * anything not represented in those files is genuinely gone rather than half-merged with the old draft.
 *
 * @param {Map<string, Uint8Array>} entries path within the mod -> bytes
 */
async function openMod(entries) {
  const { manifest, faction, otherFactions, images: pngs, workshop, warnings } = readModFiles(entries, catalog);

  workshopLink = workshop;
  images.clear();
  for (const [path, bytes] of pngs) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const size = await new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve({ width: probe.width, height: probe.height });
      probe.onerror = () => resolve({ width: 0, height: 0 });
      probe.src = url;
    });
    images.set(path, { bytes, url, ...size });
  }

  mod = {
    modId: manifest.modId ?? 'mymod',
    displayName: manifest.displayName ?? '',
    author: manifest.author ?? '',
    contentVersion: manifest.contentVersion ?? '1.0.0',
    // Merged over a blank faction so a mod saved without a newer field still opens.
    faction: { ...blankMod().faction, ...faction },
    otherFactions,
  };

  selection = { kind: 'mod' };
  render();

  // Nothing is dropped, but whoever opened it should know not all of it is editable here.
  if (warnings.length) alert(warnings.join('\n\n'));
}

async function openZipFile(file) {
  await openMod(await readZip(await file.arrayBuffer()));
}

async function openFolderFiles(files) {
  // A picked folder yields paths like "ashen/manifest.json". readModFiles finds where the mod starts, which
  // may be further down when the folder picked was the one above it.
  const entries = new Map();
  for (const file of files) {
    entries.set(file.webkitRelativePath, new Uint8Array(await file.arrayBuffer()));
  }

  await openMod(entries);
}

// ---------------------------------------------------------------------------------------------------
// Image intake
// ---------------------------------------------------------------------------------------------------

async function addImageFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.includes('png')) {
      alert(`${file.name} is not a PNG.`);
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const size = await new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve({ width: probe.width, height: probe.height });
      probe.onerror = () => resolve({ width: 0, height: 0 });
      probe.src = url;
    });

    if (size.width > catalog.limits.maxImagePixels || size.height > catalog.limits.maxImagePixels) {
      alert(`${file.name} is ${size.width}x${size.height}; the limit is ${catalog.limits.maxImagePixels}px.`);
      URL.revokeObjectURL(url);
      continue;
    }

    // preview.png belongs at the root; everything else under images/.
    const path = file.name === 'preview.png' ? 'preview.png' : `images/${file.name}`;
    images.set(path, { bytes, url, width: size.width, height: size.height });
  }

  render();
}

// ---------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------

function start(loaded) {
  catalog = loaded;
  try { localStorage.setItem(CATALOG_KEY, JSON.stringify(loaded)); } catch { /* too big is fine */ }

  mod = loadDraft() ?? blankMod();
  // A draft saved before a field existed should not crash the editor.
  mod.faction = { ...blankMod().faction, ...mod.faction };
  mod.otherFactions = mod.otherFactions ?? [];

  document.getElementById('loader').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('catalogVersion').textContent =
    `catalog v${catalog.schemaVersion}, game ${catalog.gameVersion}`;

  render();
}

document.getElementById('catalogInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) start(JSON.parse(await file.text()));
});

document.getElementById('imageInput').addEventListener('change', (e) => {
  addImageFiles([...e.target.files]);
  e.target.value = '';
});

document.getElementById('exportButton').addEventListener('click', exportZip);

document.getElementById('openZipButton').addEventListener('click', () => document.getElementById('zipInput').click());
document.getElementById('openFolderButton').addEventListener('click', () => document.getElementById('folderInput').click());

document.getElementById('zipInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await openZipFile(file);
  } catch (error) {
    alert(`Could not open that mod:\n\n${error.message}`);
  }
});

document.getElementById('folderInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  try {
    await openFolderFiles(files);
  } catch (error) {
    alert(`Could not open that mod:\n\n${error.message}`);
  }
});

document.getElementById('resetButton').addEventListener('click', () => {
  if (confirm('Discard this mod and start again?')) {
    localStorage.removeItem(DRAFT_KEY);
    mod = blankMod();
    images.clear();
    workshopLink = null;
    selection = { kind: 'mod' };
    render();
  }
});

// Served over http the catalog loads itself; opened straight from disk the browser blocks that, so the
// file picker is the fallback rather than an error.
fetch('catalog.v1.json')
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(start)
  .catch(() => {
    const cached = localStorage.getItem(CATALOG_KEY);
    if (cached) start(JSON.parse(cached));
    else document.getElementById('loader').hidden = false;
  });
