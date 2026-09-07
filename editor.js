import { makeZip, readZip } from './zip.js';

// ---------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------

const DRAFT_KEY = 'sovl-mod-editor-draft';
const CATALOG_KEY = 'sovl-mod-editor-catalog';

let catalog = null;
let mod = null;

/** Uploaded PNGs: path -> { bytes, width, height, url }. Kept out of the draft; see saveDraft. */
const images = new Map();

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

function textInput(value, onChange, placeholder = '') {
  return el('input', { type: 'text', value: value ?? '', placeholder, oninput: (e) => onChange(e.target.value) });
}

// Ids cannot carry surrounding whitespace, but trimming on every keystroke makes a typed space vanish
// mid-word and drags the caret with it. Take the text as typed and tidy it once the field is left - and
// only when there is something to tidy, so leaving a clean field never disturbs the pane on the way out.
function idInput(value, onChange) {
  return el('input', {
    type: 'text', value: value ?? '',
    oninput: (e) => onChange(e.target.value),
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

function select(value, options, onChange, { allowEmpty = false } = {}) {
  const node = el('select', { onchange: (e) => onChange(e.target.value) });
  if (allowEmpty) node.append(el('option', { value: '' }, '(none)'));
  for (const option of options) {
    const opt = el('option', { value: option }, option);
    if (option === value) opt.selected = true;
    node.append(opt);
  }
  if (allowEmpty && !options.includes(value)) node.value = '';
  return node;
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
// Validation - mirrors what the game enforces, so problems surface here rather than on import
// ---------------------------------------------------------------------------------------------------

function validate() {
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

  const sections = allSections();
  const unitIds = new Set();

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

  for (const path of referencedImages()) {
    if (!images.has(path)) problems.push(`Missing image: ${path}`);
  }
  if (!images.has('preview.png')) {
    problems.push('Add preview.png (shown on the Workshop). Publishing needs it.');
  }

  return problems;
}

function allSections() {
  return [mod.faction.characters, mod.faction.battleLine, ...mod.faction.sections];
}

function referencedImages() {
  const paths = new Set();
  const add = (p) => p && paths.add(p);

  add(mod.faction.factionImage);
  mod.faction.icons.forEach(add);

  for (const section of allSections()) {
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

// ---------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------

function buildFactionJson() {
  const faction = mod.faction;
  return {
    slug: faction.slug,
    displayName: faction.displayName,
    materialTemplate: faction.materialTemplate,
    factionImage: faction.factionImage,
    icons: faction.icons,
    defaultColors: faction.defaultColors,
    properties: faction.properties,
    characters: faction.characters,
    battleLine: faction.battleLine,
    sections: faction.sections,
  };
}

async function exportZip() {
  const encoder = new TextEncoder();
  const files = [
    {
      name: 'manifest.json',
      data: encoder.encode(JSON.stringify({
        schemaVersion: catalog.schemaVersion,
        modId: mod.modId,
        displayName: mod.displayName,
        author: mod.author,
        contentVersion: mod.contentVersion,
        minGameVersion: catalog.gameVersion,
        factions: [`factions/${mod.faction.slug}.json`],
      }, null, 2)),
    },
    {
      name: `factions/${mod.faction.slug}.json`,
      data: encoder.encode(JSON.stringify(buildFactionJson(), null, 2)),
    },
  ];

  for (const [path, image] of images) {
    files.push({ name: path, data: image.bytes });
  }

  const blob = makeZip(files);
  const link = el('a', { href: URL.createObjectURL(blob), download: `${mod.modId}.zip` });
  document.body.append(link);
  link.click();
  link.remove();
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
  saveDraft();
  document.getElementById('outline').replaceChildren(renderOutline());
  if (!keepDetail) document.getElementById('detail').replaceChildren(renderDetail());
  renderProblems();
  restoreFocus(focus);
}

function renderProblems() {
  const problems = validate();
  const bar = document.getElementById('problems');
  const wasOpen = bar.querySelector('details')?.open ?? false;
  bar.className = problems.length ? 'problems bad' : 'problems good';
  bar.replaceChildren(
    problems.length
      ? el('details', { open: wasOpen ? 'open' : false },
          el('summary', {}, `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before this mod will load`),
          el('ul', {}, problems.map((p) => el('li', {}, p))))
      : el('span', {}, 'Ready to export.'));
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

function renderEffect(effect, onRemove) {
  const info = catalog.effects.find((e) => e.kind === effect.kind);
  const rows = [
    el('div', { class: 'row' },
      select(effect.kind, catalog.effects.map((e) => e.kind), (v) => { effect.kind = v; render(); }),
      button('remove', onRemove, 'tiny danger')),
  ];

  const fields = info?.fields ?? [];

  if (fields.includes('stat')) rows.push(field('Stat', select(effect.stat ?? catalog.stats[0], catalog.stats, (v) => { effect.stat = v; saveDraft(); })));
  if (fields.includes('effectType')) {
    rows.push(field('Type', select(effect.effectType ?? info.effectTypeValues[0], info.effectTypeValues, (v) => { effect.effectType = v; saveDraft(); })));
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

  const rows = [el('div', { class: 'row' }, chooser)];

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
    catalog.armySizes.map((size) => {
      const limit = section.unitLimits[size.name] ?? { minCount: 0, maxCount: 0 };
      section.unitLimits[size.name] = limit;
      return el('div', { class: 'row' },
        el('span', { class: 'label' }, `${size.name} (${size.points}pts)`),
        numberInput(limit.minCount, (v) => { limit.minCount = v; saveDraft(); }, { min: 0 }),
        el('span', {}, 'to'),
        numberInput(limit.maxCount, (v) => { limit.maxCount = v; saveDraft(); }, { min: 0 }));
    }));
}

function renderUnit(unit, sel) {
  if (!unit) return el('div', {}, 'Select something on the left.');

  const imagePaths = [...images.keys()];
  const section = allSections()[sel.sectionIndex];
  const otherUnits = allSections().flatMap((s) => s.units).filter((u) => u !== unit);

  const parts = [
    el('h2', {}, 'Unit',
      button('delete', () => { section.units.splice(sel.unitIndex, 1); selection = { kind: 'mod' }; render(); }, 'tiny danger')),
    field('Kind', select(unit.kind, catalog.unitKinds, (v) => {
      unit.kind = v;
      if (v === 'regiment') { unit.modelCountLimits = unit.modelCountLimits ?? { Warband: { minCount: 10, maxCount: 20 } }; delete unit.retinueOptions; }
      else { unit.retinueOptions = unit.retinueOptions ?? []; delete unit.modelCountLimits; }
      render();
    })),
    field('Unit id', idInput(unit.unitID, (v) => { unit.unitID = v; render(); }), `Must start with "${mod.modId}:".`),
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
    parts.push(el('h3', {}, 'Models per regiment'));
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
        select(retinue.unitID, otherUnits.map((u) => u.unitID), (v) => { retinue.unitID = v; render(); }),
        checkbox(retinue.isMount, 'as a mount', (v) => { retinue.isMount = v; saveDraft(); }),
        button('remove', () => { unit.retinueOptions.splice(i, 1); render(); }, 'tiny'))));
    parts.push(button('+ retinue', () => { unit.retinueOptions.push({ unitID: otherUnits[0]?.unitID ?? '' }); render(); }, 'tiny'));
  }

  parts.push(el('h3', {}, 'Properties'),
    el('p', { class: 'hint' }, 'Rules this unit has. Built-in properties and ones you defined are both listed.'));

  unit.properties = unit.properties ?? [];
  parts.push(...unit.properties.map((selector, i) => renderSelector(selector, () => { unit.properties.splice(i, 1); render(); })));
  parts.push(button('+ property', () => { unit.properties.push({ kind: 'builtin', propertyId: '' }); render(); }, 'tiny'));

  parts.push(el('h3', {}, 'Model graphics'),
    el('p', { class: 'hint' }, 'Sprites drawn per model on the battlefield. Add a few for variety.'));

  unit.models = unit.models ?? [];
  parts.push(...unit.models.map((models, i) => renderModels(models, imagePaths, () => { unit.models.splice(i, 1); render(); })));
  parts.push(button('+ model graphics', () => { unit.models.push({ images: [], scale: 1.85 }); render(); }, 'tiny'));

  return el('div', {}, parts);
}

function describeModelType(name) {
  const info = catalog.modelTypes.find((m) => m.name === name);
  return info ? `Base ${info.width}x${info.height}, moves ${info.movement}.` : '';
}

function renderSelector(selector, onRemove) {
  const all = [...catalog.properties.map((p) => p.id), ...mod.faction.properties.map((p) => p.id)];
  const chosen = catalog.properties.find((p) => p.id === selector.propertyId);

  return el('div', { class: 'card thin' },
    el('div', { class: 'row' },
      select(selector.kind, catalog.propertySelectorKinds, (v) => { selector.kind = v; render(); }),
      button('remove', onRemove, 'tiny danger')),
    ['builtin', 'optional'].includes(selector.kind)
      ? field('Property', select(selector.propertyId, all, (v) => { selector.propertyId = v; render(); }, { allowEmpty: true }),
          chosen?.description ?? '')
      : null,
    selector.kind === 'optional'
      ? field('Extra points', numberInput(selector.cost ?? 0, (v) => { selector.cost = v; saveDraft(); }, { min: 0 }))
      : null,
    selector.kind === 'pickOne'
      ? el('div', {}, el('span', { class: 'hint' }, 'Choose between these when building a list.'),
          (selector.propertyIds ?? []).map((id, i) => el('div', { class: 'row' },
            select(id, all, (v) => { selector.propertyIds[i] = v; render(); }),
            numberInput(selector.costs?.[i] ?? 0, (v) => { selector.costs = selector.costs ?? []; selector.costs[i] = v; saveDraft(); }, { min: 0 }),
            button('remove', () => { selector.propertyIds.splice(i, 1); selector.costs?.splice(i, 1); render(); }, 'tiny'))),
          button('+ option', () => {
            selector.propertyIds = selector.propertyIds ?? [];
            selector.costs = selector.costs ?? [];
            selector.propertyIds.push(all[0]); selector.costs.push(0);
            render();
          }, 'tiny'))
      : null);
}

function renderModels(models, imagePaths, onRemove) {
  const list = (key, label, hint) => el('div', { class: 'field' },
    el('span', { class: 'label' }, label),
    hint ? el('span', { class: 'hint' }, hint) : null,
    el('div', {}, (models[key] ?? []).map((path, i) => el('div', { class: 'row' },
      select(path, imagePaths, (v) => { models[key][i] = v; render(); }),
      button('remove', () => { models[key].splice(i, 1); render(); }, 'tiny')))),
    button('+ image', () => { models[key] = models[key] ?? []; models[key].push(imagePaths[0] ?? ''); render(); }, 'tiny'));

  return el('div', { class: 'card' },
    el('div', { class: 'row' }, el('strong', {}, 'Model graphics'), button('remove', onRemove, 'tiny danger')),
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
  const decoder = new TextDecoder();
  const read = (path) => (entries.has(path) ? JSON.parse(decoder.decode(entries.get(path))) : null);

  const manifest = read('manifest.json');
  if (!manifest) {
    throw new Error('No manifest.json at the top of the mod. Pick the folder that contains it.');
  }

  const factionPath = manifest.factions?.[0];
  if (!factionPath) throw new Error('The manifest lists no factions.');

  const faction = read(factionPath);
  if (!faction) throw new Error(`The manifest points at ${factionPath}, which is not in the mod.`);

  if (manifest.schemaVersion > catalog.schemaVersion) {
    throw new Error(`This mod is schema v${manifest.schemaVersion}; this catalog only knows v${catalog.schemaVersion}.`);
  }

  images.clear();
  for (const [path, bytes] of entries) {
    if (!path.toLowerCase().endsWith('.png')) continue;

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
  };

  selection = { kind: 'mod' };
  render();
}

async function openZipFile(file) {
  await openMod(await readZip(await file.arrayBuffer()));
}

async function openFolderFiles(files) {
  const entries = new Map();

  // A picked folder yields paths like "ashen/manifest.json"; the mod's own paths start below that.
  const roots = new Set(files.map((f) => f.webkitRelativePath.split('/')[0]));
  const strip = roots.size === 1 ? [...roots][0] + '/' : '';

  for (const file of files) {
    const path = file.webkitRelativePath.startsWith(strip)
      ? file.webkitRelativePath.slice(strip.length)
      : file.webkitRelativePath;
    entries.set(path, new Uint8Array(await file.arrayBuffer()));
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
