// js/ui/editor.js — Éditeur de runes (le « grimoire ») et vue en lecture seule.
// Propriétaire : editor. Dépend uniquement de js/core/program.js et js/core/data.js. Styles : css/editor.css.
//
// API (docs/INTERFACES.md) :
//   mountEditor(container, opts)               → { getProgram, setProgram, setHighlight, destroy, … }
//   renderProgramView(container, program, opts) → void   (lecture seule, dense ; rappel bon marché à chaque tick)
// Extra :
//   runeBadge(runeId, opts) → HTMLElement      (bloc de rune statique : boutique, vol de rune, aide)
//
// Notes d'intégration :
//   - Le conteneur est vidé puis rempli par l'éditeur. Les popovers (palette, listes, compteur) sont des enfants
//     de l'éditeur affichés dans la « top layer » (API popover) : ils ne sont ni rognés par un panneau à
//     défilement, ni bloqués par une <dialog> modale qui contiendrait l'éditeur.
//   - onChange(program, validation) est appelé à CHAQUE modification, valide ou non (l'appelant décide).
//     `program` est une copie indépendante ; `validation` = validateProgram(...).
//   - Aucun alert/confirm : les actions destructrices proposent « Défaire » (et Ctrl+Z dans l'éditeur). Le mot
//     « Annuler » reste à l'appelant (fermer la fenêtre du corbeau sans l'envoyer).
//   - La bande du haut (nom, compteur d'emplacements, alertes) est collante (position: sticky) dans le premier
//     ancêtre qui défile ; en panneau étroit, seule la ligne du compteur reste visible.

import { RUNES, UNITS, CLASSES, DEFAULT_PROGRAMS, RUNE_KIND_INFO, MAX_TICKS } from '../core/data.js';
import {
  programCost, ruleCost, validateProgram, paramOptions, paramBounds, resolveParams, makeCond, makeAction, textParts as canonicalTextParts,
  describeRule, describeCond, describeAction, runeAllowedFor, isUnlocked, unitSlotsFor, cloneProgram, emptyProgram,
  MAX_RULES, MAX_CONDS_PER_RULE,
} from '../core/program.js';
import { translate } from '../i18n.js';

function textParts(id, params, unitType) {
  const original=canonicalTextParts(id,params,unitType);
  const template=translate(RUNES[id]?.text ?? '?'), parts=[];
  let last=0;
  for(const m of template.matchAll(/\{(\w+)\}/g)){
    if(m.index>last)parts.push({kind:'text',text:template.slice(last,m.index)});
    parts.push(original.find(p=>p.kind==='param'&&p.key===m[1])??{kind:'text',text:'?'});
    last=m.index+m[0].length;
  }
  if(last<template.length)parts.push({kind:'text',text:template.slice(last)});
  return parts;
}

// ------------------------------------------------------------------ Constantes
const NB = '\u00A0';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI'];
const roman = (i) => ROMAN[i] ?? String(i + 1);
const FAM = { cond: 'perc', action: 'act', logic: 'link' };
const PARAM_LABEL = { n: 'Distance', pct: 'Seuil de PV', target: 'Cible', place: 'Lieu', ally: 'Allié', spell: 'Sort', terrain: 'Terrain', cls: 'Classe', t: 'Instant' };
const PARAM_UNIT = { n: 'hex', t: 'instants', pct: '%' };
const INSTINCT = 'attaquer l’ennemi le plus proche s’il est à portée, sinon rester sur place.';
const SUPPORTS_POPOVER = typeof HTMLElement !== 'undefined' && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
const GLOW_PERIOD = 2400; // ms, doit correspondre à l'animation rn-glow de editor.css
const SHEET_BELOW = 600;  // largeur de fenêtre (px) sous laquelle les popovers deviennent des feuilles en bas d'écran

const ICONS = {
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.9 12.2h8.6L17.2 7M10.2 10.5v5.5M13.8 10.5v5.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  reset: '<path d="M5.2 12.5a7 7 0 1 0 2-5.4"/><path d="M5 3.8v4.4h4.4"/>',
  undo: '<path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.8 10H14a5.2 5.2 0 0 1 0 10.4h-3"/>',
  check: '<path d="M5 12.5l4.3 4.3L19 7.2"/>',
};

let uidSeq = 0;
const uid = (p) => `${p}-${++uidSeq}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// ------------------------------------------------------------------ Petits outils DOM
/** Crée un élément. props : class, text, html, dataset, style (objet), on<event>, autres = attributs. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function icon(name, cls = 'rn-ico') {
  const s = document.createElement('span');
  s.className = cls;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${ICONS[name] ?? ''}</svg>`;
  return s;
}
const cssEsc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
const byFk = (root, key) => (key ? root.querySelector(`[data-fk="${cssEsc(key)}"]`) : null);
function scrollParent(el) {
  for (let p = el?.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}
/** Bo\u00eete de d\u00e9filement d'un \u00e9l\u00e9ment collant (m\u00eame si elle ne d\u00e9borde pas encore) ; null = la page. */
function stickyScroller(el) {
  for (let p = el?.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy !== 'visible' && oy !== 'clip') return p;
  }
  return null;
}
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ------------------------------------------------------------------ Modèle
const toLock = (u) => (u == null ? null : new Set(u instanceof Set ? [...u] : Array.isArray(u) ? u : []));
const famOf = (runeId) => FAM[RUNES[runeId]?.kind] ?? 'none';

/** Copie défensive d'un programme : structure garantie, paramètres manquants complétés. */
function normalizeProgram(program, unitType) {
  const p = cloneProgram(program && Array.isArray(program.rules) ? program : emptyProgram());
  p.rules = p.rules.filter((r) => r && typeof r === 'object').map((rule) => {
    const conds = (Array.isArray(rule.conds) ? rule.conds : []).filter((c) => c && typeof c === 'object' && c.id);
    for (const c of conds) {
      if (RUNES[c.id]) c.params = resolveParams(c.id, c.params ?? {}, unitType);
      if (!c.not) delete c.not;
    }
    let action = rule.action && typeof rule.action === 'object' && rule.action.id ? rule.action : null;
    if (action && RUNES[action.id]) action.params = resolveParams(action.id, action.params ?? {}, unitType);
    return { conds, logic: rule.logic === 'OR' ? 'OR' : 'AND', action };
  });
  return p;
}

/** Reporte les paramètres compatibles d'une rune remplacée vers la nouvelle (ex. la cible d'une attaque). */
function carryParams(old, newId, unitType) {
  const out = {};
  if (!old?.params) return out;
  for (const p of RUNES[newId]?.params ?? []) {
    const v = old.params[p.key];
    if (v == null) continue;
    const b = p.type === 'int' ? paramBounds(p, unitType) : null;
    const ok = b ? Number.isInteger(v) && v >= b.min && v <= b.max : paramOptions(p, unitType).some((o) => o.value === v);
    if (ok) out[p.key] = v;
  }
  return out;
}

/** Familles de chaque emplacement consommé, dans l'ordre (pour colorer les pierres du compteur). */
function ruleFamilies(rule) {
  const out = [];
  const conds = rule.conds ?? [];
  for (const c of conds) { out.push('perc'); if (c.not) out.push('link'); }
  if (conds.length >= 2) out.push('link');
  if (rule.action) out.push('act');
  return out;
}
const programFamilies = (p) => (p?.rules ?? []).flatMap(ruleFamilies);

/** Sépare les erreurs de validateProgram : par règle (« Règle II : … », chiffres romains ou arabes) et globales. */
function splitErrors(errors, nRules) {
  const perRule = new Map();
  const global = [];
  for (const e of errors ?? []) {
    const m = /^Règle ([IVXLC]+|\d+)\s*:\s*(.+)$/.exec(e);
    const i = !m ? -1 : /^\d+$/.test(m[1]) ? Number(m[1]) - 1 : ROMAN.indexOf(m[1]);
    if (m && i >= 0 && i < nRules) {
      if (!perRule.has(i)) perRule.set(i, []);
      perRule.get(i).push(cap(m[2]));
    } else global.push(e);
  }
  return { perRule, global };
}

function lockHint(rune) {
  return rune?.price ? `${rune.price}${NB}or chez le Marchand, ou à voler à une armée vaincue` : 'à voler à une armée vaincue';
}

// ------------------------------------------------------------------ Budget d'emplacements (aperçu avant de choisir)
const plural = (n, word) => `${n}${NB}${word}${n > 1 ? 's' : ''}`;
/** Avertissement quand un ajout dépasse les emplacements (note de la palette et toast). */
const budgetWarning = (missing) =>
  `Il manque ${plural(missing, 'emplacement')} : retirez ou simplifiez une règle (une règle TOUJOURS ne coûte que son action).`;

/**
 * Coût d'un choix dans la palette, avant de le faire. pv = { delta, after, slots, parts } (parts : ce que paient
 * les emplacements ajoutés). Remplacer une rune ne coûte rien ; une 2e condition paie aussi la liaison ET/OU ;
 * la création guidée d'une règle compte d'emblée son action.
 */
function costPreview(program, ri, slot, slots, guided = false) {
  const rule = program.rules[ri];
  const parts = [];
  if (rule && slot === 'a') {
    if (!rule.action) parts.push('action');
  } else if (rule) {
    const ci = Number(slot.slice(1));
    if (ci >= rule.conds.length) {
      parts.push('condition');
      if (rule.conds.length === 1) parts.push('liaison');
      if (guided && !rule.action) parts.push('action');
    }
  }
  const after = programCost(program) + parts.length;
  return { delta: parts.length, after, slots, parts };
}

/** Ligne de coût de l'en-tête de la palette : « +2 condition + action · 5/4, 1 de trop ». */
function costLine(pv) {
  const over = pv.after > pv.slots;
  let left = `${pv.after}/${pv.slots}`;
  if (pv.delta && over) left += `, ${pv.after - pv.slots} de trop`;
  else if (pv.delta && pv.after === pv.slots) left += ', grimoire plein';
  else if (pv.delta) left = `il restera ${plural(pv.slots - pv.after, 'emplacement')}`;
  return h('div', { class: `rn-pop-cost${over ? ' is-over' : ''}` },
    h('b', { class: 'rn-pop-delta' }, pv.delta ? `+${pv.delta}` : '±0'),
    h('span', {}, pv.delta ? pv.parts.join(' + ') : 'remplacement'), ' · ',
    h('span', { class: 'rn-pop-left' }, left));
}

/** La règle en cours, l'emplacement choisi remplacé par « … » (rappel dans l'en-tête de la palette). */
function ruleContext(rule, slot, unitType) {
  const conds = rule.conds ?? [];
  const ci = slot === 'a' ? -1 : Number(slot.slice(1));
  const known = ci < 0 ? conds.length > 0 : !!rule.action || conds.some((_, k) => k !== ci);
  if (!known) return null; // rien d'autre à rappeler (nouvelle règle vide, ou action d'une règle TOUJOURS)
  const word = (t) => h('span', { class: 'rn-ctx-kw' }, t);
  const hole = (here) => h('span', { class: `rn-ctx-hole${here ? ' is-here' : ''}` }, '…');
  const join = rule.logic === 'OR' ? 'OU' : 'ET';
  const out = [];
  for (let k = 0; k < Math.max(conds.length, ci + 1); k++) {
    out.push(word(k ? join : 'SI'), ' ', k === ci || !conds[k] ? hole(k === ci) : describeCond(conds[k], unitType), ' ');
  }
  out.push(word('ALORS'), ' ', ci < 0 || !rule.action ? hole(ci < 0) : describeAction(rule.action, unitType));
  return out;
}

// ------------------------------------------------------------------ Construction des blocs (partagée)
// ctx = { unitType, lock: Set|null, interactive: bool, pending: {ri, ci}|null, compact: bool }
const slotKey = (ri, slot) => `r${ri}:${slot}`;

/** Ajuste les espaces autour des pastilles pour éviter « ≤ » ou « hex » orphelins en fin de ligne. */
function tidyText(text, before, after) {
  let t = text;
  if (after) t = t.replace(/ $/, NB);                                    // texte suivi d'une pastille
  if (before) t = t.replace(/^ (?=(hex|%|instants)\b|%)/, NB);           // texte qui suit une pastille
  return t.replace(/≤ /g, `≤${NB}`);
}

function buildChip(ctx, item, ri, slot, part) {
  const rune = RUNES[item.id];
  const param = rune?.params.find((p) => p.key === part.key);
  const opts = param ? paramOptions(param, ctx.unitType) : [];
  const bounds = param?.type === 'int' ? paramBounds(param, ctx.unitType) : null;
  const valid = !!param && (bounds
    ? Number.isInteger(part.value) && part.value >= bounds.min && part.value <= bounds.max
    : opts.some((o) => o.value === part.value));
  const label = valid ? part.label : (part.value == null ? '?' : String(part.label));
  const single = param?.type === 'enum' && opts.length <= 1 && valid;
  const pname = PARAM_LABEL[part.key] ?? part.key;
  if (!ctx.interactive || single) {
    return h('span', { class: `rn-chip is-static${valid ? '' : ' is-invalid'}`, title: single ? `${pname} : seul choix possible` : null }, label);
  }
  return h('button', {
    type: 'button', class: `rn-chip${valid ? '' : ' is-invalid'}`,
    'data-act': 'param', 'data-ri': ri, 'data-slot': slot, 'data-key': part.key, 'data-fk': `${slotKey(ri, slot)}:${part.key}`,
    'aria-haspopup': param?.type === 'int' ? 'dialog' : 'listbox',
    'aria-label': `${pname} : ${label}. Modifier`,
  }, label, h('span', { class: param?.type === 'int' ? 'rn-chip-mark is-int' : 'rn-chip-mark', 'aria-hidden': 'true' }));
}

/** Bloc émaillé d'une condition ou d'une action (sans le bouton NON). */
function buildBlock(ctx, item, ri, slot) {
  const isCond = slot !== 'a';
  const rune = RUNES[item.id];
  const expected = isCond ? 'cond' : 'action';
  if (!rune || rune.kind !== expected) {
    const el = h('div', { class: 'rn-block rn-fam-locked is-invalid', 'data-act': ctx.interactive ? 'pick' : null, 'data-ri': ri, 'data-slot': slot },
      ctx.interactive
        ? h('button', { type: 'button', class: 'rn-glyph', 'data-act': 'pick', 'data-ri': ri, 'data-slot': slot, 'data-fk': slotKey(ri, slot), 'aria-label': 'Rune inconnue. Choisir une rune' }, '?')
        : h('span', { class: 'rn-glyph', 'aria-hidden': 'true' }, '?'),
      h('span', { class: 'rn-text' }, 'rune inconnue'));
    return el;
  }
  const locked = !isUnlocked(item.id, ctx.lock);
  const forbidden = !runeAllowedFor(item.id, ctx.unitType);
  const fam = FAM[rune.kind];
  const params = item.params ?? {};
  const parts = textParts(item.id, params, ctx.unitType);
  const block = h('div', {
    class: `rn-block rn-fam-${fam}${locked || forbidden ? ' is-invalid' : ''}`,
    'data-act': ctx.interactive ? 'pick' : null, 'data-ri': ri, 'data-slot': slot,
    title: ctx.interactive ? null : `${rune.name} — ${rune.help}`,
  });
  const what = isCond ? 'Condition' : 'Action';
  block.append(ctx.interactive
    ? h('button', {
      type: 'button', class: 'rn-glyph', 'data-act': 'pick', 'data-ri': ri, 'data-slot': slot, 'data-fk': slotKey(ri, slot),
      'aria-label': `${what} « ${rune.name} ». Changer de rune${isCond ? ' (Suppr pour retirer)' : ''}`, title: `${rune.name} — ${rune.help}`,
    }, rune.glyph)
    : h('span', { class: 'rn-glyph', 'aria-hidden': 'true' }, rune.glyph));
  const text = h('span', { class: 'rn-text' });
  parts.forEach((part, k) => {
    if (part.kind === 'text') text.append(h('span', {'data-i18n-ignore':'true'}, tidyText(part.text, parts[k - 1]?.kind === 'param', parts[k + 1]?.kind === 'param')));
    else text.append(buildChip(ctx, item, ri, slot, part));
  });
  block.append(text);
  if (locked || forbidden) {
    block.append(h('span', { class: 'rn-block-warn', title: forbidden ? 'Interdite pour cette unité' : 'Rune verrouillée' }, icon('lock')));
  }
  return block;
}

/** Condition = [NON] + bloc. Le bouton NON n'apparaît que si la rune NON est débloquée (ou déjà utilisée). */
function buildCond(ctx, cond, ri, ci, after = null) {
  const wrap = h('div', { class: `rn-cond${cond.not ? ' is-negated' : ''}` });
  const notOk = isUnlocked('NOT', ctx.lock);
  if (cond.not || (ctx.interactive && notOk)) {
    const lockedNot = cond.not && !notOk;
    if (ctx.interactive) {
      wrap.append(h('button', {
        type: 'button', class: `rn-not rn-fam-link${cond.not ? ' is-on' : ''}${lockedNot ? ' is-invalid' : ''}`,
        'data-act': 'not', 'data-ri': ri, 'data-slot': `c${ci}`, 'data-fk': `${slotKey(ri, `c${ci}`)}:not`,
        'aria-pressed': cond.not ? 'true' : 'false',
        'aria-label': cond.not ? 'NON actif : la condition est inversée. Retirer NON' : 'Inverser la condition avec NON (coûte 1)',
        title: cond.not ? 'NON : condition inversée (cliquer pour retirer)' : 'Inverser avec NON (+1 emplacement)',
      }, h('span', { class: 'rn-not-glyph', 'aria-hidden': 'true' }, RUNES.NOT.glyph), h('span', { class: 'rn-not-txt' }, 'NON')));
    } else {
      wrap.append(h('span', { class: 'rn-not rn-fam-link is-on is-static' },
        h('span', { class: 'rn-not-glyph', 'aria-hidden': 'true' }, RUNES.NOT.glyph), h('span', { class: 'rn-not-txt' }, 'NON')));
    }
  }
  wrap.append(buildBlock(ctx, cond, ri, `c${ci}`));
  if (after) wrap.append(after);
  return wrap;
}

function buildEmptySlot(ctx, ri, slot) {
  const isCond = slot !== 'a';
  const label = isCond ? 'Choisir une condition' : 'Choisir une action';
  if (!ctx.interactive) {
    return h('span', { class: `rn-empty rn-fam-${isCond ? 'perc' : 'act'} is-static` }, h('span', { class: 'rn-empty-glyph', 'aria-hidden': 'true' }, '?'), 'aucune action');
  }
  return h('button', {
    type: 'button', class: `rn-empty rn-fam-${isCond ? 'perc' : 'act'}`,
    'data-act': 'pick', 'data-ri': ri, 'data-slot': slot, 'data-fk': slotKey(ri, slot), 'aria-haspopup': 'dialog',
  }, h('span', { class: 'rn-empty-glyph', 'aria-hidden': 'true' }, icon('plus')), h('span', { class: 'rn-empty-txt' }, `${label}…`));
}

const seg = (...kids) => h('div', { class: 'rn-seg' }, kids);
const kw = (text, extra = '') => h('span', { class: `rn-kw${extra}` }, text);

function buildLead(ctx, ri, always) {
  const word = always ? 'TOUJOURS' : 'SI';
  if (!ctx.interactive) return kw(word, always ? ' is-always' : '');
  return h('button', {
    type: 'button', class: `rn-kw rn-lead${always ? ' is-always' : ''}`, 'data-act': 'lead', 'data-ri': ri, 'data-fk': `r${ri}:lead`,
    'aria-pressed': always ? 'true' : 'false',
    'aria-label': always ? 'TOUJOURS. Ajouter une condition (SI)' : 'SI. Passer en TOUJOURS (retire les conditions)',
    title: always ? 'Règle sans condition. Cliquer pour ajouter une condition (SI…)' : 'Cliquer pour passer en TOUJOURS (sans condition)',
  }, word);
}

function buildJoin(ctx, rule, ri, ci) {
  const lg = rule.logic === 'OR' ? 'OR' : 'AND';
  const rune = RUNES[lg];
  const locked = !isUnlocked(lg, ctx.lock);
  const kids = [h('span', { class: 'rn-join-glyph', 'aria-hidden': 'true' }, rune.glyph), h('span', { class: 'rn-join-txt' }, rune.name)];
  if (!ctx.interactive) return h('span', { class: `rn-join rn-fam-link${locked ? ' is-invalid' : ''}` }, kids);
  const other = lg === 'OR' ? 'ET' : 'OU';
  return h('button', {
    type: 'button', class: `rn-join rn-fam-link${locked ? ' is-invalid' : ''}`, 'data-act': 'logic', 'data-ri': ri, 'data-fk': `r${ri}:j${ci}`,
    'aria-label': `Liaison ${rune.name}. Basculer en ${other}`, title: `${rune.help} Cliquer pour basculer en ${other}.`,
  }, kids);
}

function costDots(rule) {
  const fams = ruleFamilies(rule);
  const c = ruleCost(rule);
  return h('span', { class: 'rn-costdots', title: `Coût de la règle : ${c}`, 'aria-hidden': 'true' },
    fams.map((f) => h('span', { class: `rn-costdot rn-fam-${f}` })));
}

/** Une règle (ligne du grimoire). msgs = { errors: string[], hint: string|null }. */
function buildRule(ctx, rule, i, n, msgs) {
  const conds = rule.conds ?? [];
  const pend = ctx.pending && ctx.pending.ri === i ? ctx.pending.ci : -1;
  const hasErr = msgs.errors.length > 0;
  const li = h('li', {
    class: `rn-rule${hasErr ? ' has-error' : ''}`, 'data-ri': i,
    'aria-label': `Règle ${roman(i)} : ${describeRule(rule, ctx.unitType)}`,
  });

  // Tête : numéro enluminé (poignée de glisser-déposer) + coût
  const headKids = [h('span', { class: 'rn-grip', 'aria-hidden': 'true' }), h('span', { class: 'rn-num' }, roman(i)), costDots(rule)];
  li.append(ctx.interactive
    ? h('button', {
      type: 'button', class: 'rn-handle', 'data-act': 'handle', 'data-ri': i, 'data-fk': `r${i}:h`,
      'aria-label': `Règle ${roman(i)}, coût ${ruleCost(rule)}. Glisser, ou flèches haut et bas, pour la déplacer`,
      title: 'Glisser pour réordonner (ou flèches haut/bas)',
    }, headKids)
    : h('div', { class: 'rn-handle is-static' }, headKids.slice(1)));

  // Corps : SI cond ET cond [+] ALORS action  |  TOUJOURS action
  const body = h('div', { class: 'rn-body' });
  const actionEl = rule.action ? buildBlock(ctx, rule.action, i, 'a') : buildEmptySlot(ctx, i, 'a');
  const showConds = conds.length > 0 || pend === 0;
  if (!showConds) {
    const s = seg(buildLead(ctx, i, true), actionEl);
    s.classList.add('is-always');
    body.append(s);
  } else {
    const canPlus = ctx.interactive && pend < 0 && conds.length < MAX_CONDS_PER_RULE;
    conds.forEach((c, ci) => {
      const plus = canPlus && ci === conds.length - 1
        ? h('button', {
          type: 'button', class: 'rn-plus', 'data-act': 'plus', 'data-ri': i, 'data-fk': `r${i}:plus`,
          'aria-label': 'Ajouter une condition', title: conds.length === 1 ? 'Ajouter une condition (+1, et +1 pour la liaison)' : 'Ajouter une condition (+1)',
        }, icon('plus'))
        : null;
      body.append(seg(ci === 0 ? buildLead(ctx, i, false) : buildJoin(ctx, rule, i, ci), buildCond(ctx, c, i, ci, plus)));
    });
    if (pend >= conds.length) {
      body.append(seg(pend === 0 ? buildLead(ctx, i, false) : buildJoin(ctx, rule, i, pend), buildEmptySlot(ctx, i, `c${pend}`)));
    }
    body.append(seg(kw('ALORS', ' is-then'), actionEl));
  }
  li.append(body);

  // Outils
  if (ctx.interactive) {
    li.append(h('div', { class: 'rn-tools' },
      h('button', { type: 'button', class: 'rn-tool', 'data-act': 'up', 'data-ri': i, 'data-fk': `r${i}:up`, 'aria-label': `Monter la règle ${roman(i)}`, title: 'Monter', disabled: i === 0 }, icon('up')),
      h('button', { type: 'button', class: 'rn-tool', 'data-act': 'down', 'data-ri': i, 'data-fk': `r${i}:down`, 'aria-label': `Descendre la règle ${roman(i)}`, title: 'Descendre', disabled: i === n - 1 }, icon('down')),
      h('button', { type: 'button', class: 'rn-tool is-danger', 'data-act': 'del', 'data-ri': i, 'data-fk': `r${i}:del`, 'aria-label': `Supprimer la règle ${roman(i)}`, title: 'Supprimer la règle' }, icon('trash'))));
  }

  // Messages
  if (hasErr || msgs.hint) {
    li.append(h('div', { class: 'rn-msg' },
      msgs.errors.map((e) => h('p', { class: 'rn-err' }, h('span', { class: 'rn-err-mark', 'aria-hidden': 'true' }, '!'), e)),
      msgs.hint ? h('p', { class: 'rn-hint' }, msgs.hint) : null));
  }
  return li;
}

/** Messages par règle : erreurs + indice « lue seulement si… » après une règle TOUJOURS. */
function ruleMessages(program, perRule) {
  const out = [];
  let always = -1;
  program.rules.forEach((rule, i) => {
    const hint = always >= 0 ? `Lue seulement si la règle ${roman(always)} (TOUJOURS) ne peut pas s’appliquer.` : null;
    out.push({ errors: perRule?.get(i) ?? [], hint });
    if (always < 0 && !(rule.conds ?? []).length && rule.action) always = i;
  });
  return out;
}

function buildInstinct(compact) {
  return h('div', { class: 'rn-instinct', 'data-instinct': '' },
    h('span', { class: 'rn-handle is-static' }, h('span', { class: 'rn-num' }, '∴')),
    h('span', { class: 'rn-instinct-body' },
      h('span', { class: 'rn-kw' }, 'Sinon'),
      h('span', { class: 'rn-instinct-txt' }, compact ? 'instinct : frapper à portée, sinon attendre.' : `instinct : ${INSTINCT}`)));
}

function buildMeter(program, slots, { small = false } = {}) {
  const fams = programFamilies(program);
  const cost = fams.length;
  const over = Math.max(0, cost - slots);
  const shownOver = Math.min(over, 10);
  const pips = h('span', { class: 'rn-pips', 'aria-hidden': 'true' });
  for (let k = 0; k < Math.max(slots, 0); k++) {
    pips.append(h('span', { class: k < cost ? `rn-pip is-full rn-fam-${fams[k]}` : 'rn-pip' }));
  }
  if (over) {
    pips.append(h('span', { class: 'rn-pip-sep' }));
    for (let k = 0; k < shownOver; k++) pips.append(h('span', { class: 'rn-pip is-over' }));
    if (over > shownOver) pips.append(h('span', { class: 'rn-pip-more' }, `+${over - shownOver}`));
  }
  return h('div', {
    class: `rn-meter${over ? ' is-over' : ''}${small ? ' is-small' : ''}`, role: 'meter',
    'aria-valuemin': 0, 'aria-valuemax': slots, 'aria-valuenow': Math.min(cost, slots),
    'aria-valuetext': over ? `${cost} runes pour ${slots} emplacements : trop de runes` : `${cost} emplacements utilisés sur ${slots}`,
    'aria-label': 'Emplacements de runes',
  }, pips, h('span', { class: 'rn-count' }, h('b', {}, String(cost)), `${NB}/${NB}${slots}`));
}

// ------------------------------------------------------------------ Popover (palette, listes, compteur)
class Popover {
  constructor(ed) {
    this.ed = ed;
    this.el = h('div', { class: 'rn-pop', role: 'dialog', 'aria-modal': 'false' });
    if (SUPPORTS_POPOVER) this.el.setAttribute('popover', 'manual');
    this.el.addEventListener('click', (e) => e.stopPropagation());
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.isOpen = false;
    this.anchorKey = null;
    this.onClose = null;
    this.preferBelow = 0;
    this._docDown = (e) => {
      if (!this.isOpen) return;
      if (e.target === this.el) { // toucher le ::backdrop (feuille sur téléphone) cible le popover lui-même
        const r = this.el.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.close({ restore: false });
        return;
      }
      if (this.el.contains(e.target)) return;
      const a = this.anchorEl();
      if (a && a.contains(e.target)) return; // le clic sur l'ancre referme (géré par l'éditeur)
      this.close({ restore: false });
    };
    this._docKey = (e) => { if (this.isOpen && e.key === 'Escape') { e.preventDefault(); this.close(); } };
    // repositionne si la page ou un panneau défile (mais pas quand c'est la liste du popover elle-même)
    this._reflow = (e) => { if (this.isOpen && !(e?.type === 'scroll' && e.target instanceof Node && this.el.contains(e.target))) this.position(); };
  }

  anchorEl() { return byFk(this.ed.inner, this.anchorKey); }

  /**
   * @param {{anchorKey:string, fam?:string, kicker?:string, title:string, context?:Array|null, cost?:Node|null,
   *          notice?:Node|null, body:Node[], foot?:Node[], onClose?:Function, focus?:Element, preferBelow?:number}} cfg
   *   context : rappel de la règle en cours sous le titre ; cost : ligne de coût ; notice : avertissement fixe
   *   entre l'en-tête et la liste (il ne défile pas avec elle) ;
   *   preferBelow : se placer sous l'ancre dès qu'il y a au moins autant de px libres (ne pas cacher la règle).
   */
  open({ anchorKey, fam = 'none', kicker = '', title, context = null, cost = null, notice = null, body = [], foot = [], onClose = null, focus = null, preferBelow = 0 }) {
    if (this.isOpen) this.close({ restore: false });
    this.anchorKey = anchorKey;
    this.onClose = onClose;
    this.preferBelow = preferBelow;
    const tid = uid('rn-pop-t');
    const did = uid('rn-pop-d');
    const desc = [context ? h('div', { class: 'rn-pop-ctx' }, context) : null, cost].filter(Boolean);
    const head = h('div', { class: 'rn-pop-head' },
      h('div', { class: 'rn-pop-titles' },
        kicker ? h('div', { class: 'rn-pop-kicker' }, kicker) : null,
        h('div', { class: 'rn-pop-title', id: tid }, title),
        desc.length ? h('div', { class: 'rn-pop-desc', id: did }, desc) : null),
      h('button', { type: 'button', class: 'rn-pop-x', 'aria-label': 'Fermer', onclick: () => this.close() }, icon('close')));
    this.el.className = `rn-pop rn-fam-${fam}`;
    this.el.setAttribute('aria-labelledby', tid);
    if (desc.length) this.el.setAttribute('aria-describedby', did); else this.el.removeAttribute('aria-describedby');
    this.el.replaceChildren(...[head, notice, h('div', { class: 'rn-pop-body' }, body), foot.length ? h('div', { class: 'rn-pop-foot' }, foot) : null].filter(Boolean));
    this.el.classList.add('is-open');
    if (SUPPORTS_POPOVER) { try { this.el.showPopover(); } catch { /* déjà ouvert ou non connecté */ } }
    this.isOpen = true;
    document.addEventListener('pointerdown', this._docDown, true);
    document.addEventListener('keydown', this._docKey);
    window.addEventListener('resize', this._reflow);
    window.addEventListener('scroll', this._reflow, true);
    this.ed.root.classList.add('has-pop');
    this.anchorEl()?.setAttribute('aria-expanded', 'true');
    this.position();
    const f = focus ?? this.el.querySelector('[role=option]:not([aria-disabled=true]), .rn-pop-body button, [tabindex="0"]');
    if (f) {
      setRoving(f);
      f.focus({ preventScroll: true });
      this.reveal(f, true);
    }
  }

  /** Fait défiler la liste du popover (jamais la page) pour montrer `el`, centré ou au plus près. */
  reveal(el, center = false) {
    const body = this.el.querySelector('.rn-pop-body');
    if (!body || !body.contains(el)) return;
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const top = r.top - b.top + body.scrollTop;
    if (center) body.scrollTop = Math.max(0, top - (body.clientHeight - r.height) / 2);
    else if (r.top < b.top) body.scrollTop = top - 6;
    else if (r.bottom > b.bottom) body.scrollTop = top + r.height - body.clientHeight + 6;
  }

  /** Ferme. restore : rendre le focus à l'ancre. picked : un choix a été fait (transmis à onClose). */
  close({ restore = true, picked = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener('pointerdown', this._docDown, true);
    document.removeEventListener('keydown', this._docKey);
    window.removeEventListener('resize', this._reflow);
    window.removeEventListener('scroll', this._reflow, true);
    if (SUPPORTS_POPOVER) { try { this.el.hidePopover(); } catch { /* déjà fermé */ } }
    this.el.classList.remove('is-open', 'rn-pop--sheet', 'is-above');
    this.el.replaceChildren();
    this.el.removeAttribute('style');
    this.ed.root.classList.remove('has-pop');
    this.ed.coalesceKey = null;
    const key = this.anchorKey;
    const cb = this.onClose;
    this.anchorKey = null;
    this.onClose = null;
    this.preferBelow = 0;
    byFk(this.ed.inner, key)?.removeAttribute('aria-expanded');
    let focusKey = key;
    if (cb) { const r = cb({ picked }); if (typeof r === 'string') focusKey = r; }
    if (restore) byFk(this.ed.inner, focusKey)?.focus({ preventScroll: true });
  }

  position() {
    const el = this.el;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const sheet = vw < SHEET_BELOW;
    el.classList.toggle('rn-pop--sheet', sheet);
    if (sheet) { el.style.left = ''; el.style.top = ''; el.style.maxHeight = ''; return; }
    const a = this.anchorEl();
    el.style.maxHeight = '';
    if (!a) { // ancre introuvable : centré en haut de l'écran
      el.style.left = `${Math.round(Math.max(8, (vw - el.offsetWidth) / 2))}px`;
      el.style.top = `${Math.round(Math.max(8, vh * 0.12))}px`;
      return;
    }
    const r = a.getBoundingClientRect();
    const cssMax = 540;
    const pw = el.offsetWidth;
    let ph = el.offsetHeight;
    const below = vh - r.bottom - 14;
    const above = r.top - 14;
    let top;
    let isAbove = false;
    if (ph <= below || below >= above || (this.preferBelow > 0 && below >= this.preferBelow)) {
      if (ph > below) { el.style.maxHeight = `${Math.max(160, Math.min(cssMax, below))}px`; ph = el.offsetHeight; }
      top = r.bottom + 6;
    } else {
      if (ph > above) { el.style.maxHeight = `${Math.max(160, Math.min(cssMax, above))}px`; ph = el.offsetHeight; }
      top = r.top - 6 - ph;
      isAbove = true;
    }
    const left = Math.min(Math.max(8, r.left - 6), vw - pw - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(8, top))}px`;
    el.classList.toggle('is-above', isAbove);
  }

  onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Tab') {
      const f = [...this.el.querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return;
      e.preventDefault();
      const i = f.indexOf(document.activeElement);
      const nxt = f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length];
      nxt.focus();
      return;
    }
    const opt = e.target.closest?.('[role=option]');
    if (!opt) return;
    const opts = [...this.el.querySelectorAll('[role=option]')];
    const i = opts.indexOf(opt);
    let j = -1;
    if (e.key === 'ArrowDown') j = Math.min(opts.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home' || e.key === 'PageUp') j = 0;
    else if (e.key === 'End' || e.key === 'PageDown') j = opts.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opt.click(); return; }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const ch = fold(e.key);
      for (let k = 1; k <= opts.length; k++) {
        const o = opts[(i + k) % opts.length];
        if (fold(o.dataset.label ?? o.textContent).replace(/^(le |la |l’|l'|un |une |des |les |mon |ma |mes |notre )/, '').startsWith(ch)) { j = (i + k) % opts.length; break; }
      }
    }
    if (j >= 0) {
      e.preventDefault();
      setRoving(opts[j]);
      opts[j].focus({ preventScroll: true });
      this.reveal(opts[j]);
    }
  }
}

function setRoving(el) {
  const list = el.closest?.('[role=listbox]');
  if (!list) return;
  for (const o of list.querySelectorAll('[role=option]')) o.tabIndex = o === el ? 0 : -1;
}

// ------------------------------------------------------------------ Éditeur
class RuneEditor {
  constructor(container, opts) {
    this.container = container;
    this.unitType = opts.unitType;
    this.slotsBonus = Number(opts.slotsBonus) || 0;
    this.lock = toLock(opts.unlocked);
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    this.readOnly = !!opts.readOnly;
    this.highlight = Number.isInteger(opts.highlightRule) ? opts.highlightRule : null;
    this.title = opts.title ?? null;
    this.compact = !!opts.compact;
    const src = opts.program === undefined ? DEFAULT_PROGRAMS[this.unitType] : opts.program;
    this.program = normalizeProgram(src, this.unitType);
    this.history = [];
    this.coalesceKey = null;
    this.pending = null;            // { ri, ci } : emplacement de condition en cours de choix
    this.composing = null;          // règle en cours de création guidée (condition puis action)
    this.saved = new WeakMap();     // règle → conditions retirées par TOUJOURS (pour les rétablir)
    this.drag = null;
    this.toastTimer = 0;
    this.top = null;                // bande collante du haut (en-tête + alertes), recréée à chaque rendu
    this.topMargin = 0;
    this.stuckRaf = 0;

    this.root = h('div', {
      class: `rn-ed${this.compact ? ' rn-ed--compact' : ''}${this.readOnly ? ' is-readonly' : ''}`,
      role: 'group', 'aria-label': `Grimoire — ${this.displayName()}`,
    });
    this.inner = h('div', { class: 'rn-inner' });
    this.dock = h('div', { class: 'rn-toast-dock', role: 'status', 'aria-live': 'polite' });
    this.root.append(this.inner, this.dock);
    this.pop = new Popover(this);
    this.root.append(this.pop.el);
    container.replaceChildren(this.root);

    this._click = (e) => this.onClick(e);
    this._key = (e) => this.onKeyDown(e);
    this._down = (e) => this.onPointerDown(e);
    this._dragMove = (e) => { if (this.drag && e.pointerId === this.drag.pid) { this.drag.lastY = e.clientY; this.updateDrag(); } };
    this._dragUp = (e) => { if (this.drag && e.pointerId === this.drag.pid) this.finishDrag(true); };
    this._dragCancel = (e) => { if (this.drag && e.pointerId === this.drag.pid) this.finishDrag(false); };
    this._dragTick = () => { if (!this.drag) return; this.drag.raf = 0; if (!this.drag.v) return; const sc = this.drag.scroller ?? document.scrollingElement; sc?.scrollBy(0, this.drag.v); this.updateDrag(); };
    // bande collante : sa hauteur (décalage du panneau étroit) et son ombre quand elle est décollée
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.syncTop()) : null;
    this._scroll = () => { if (!this.stuckRaf) this.stuckRaf = requestAnimationFrame(() => { this.stuckRaf = 0; this.syncStuck(); }); };
    this.root.addEventListener('click', this._click);
    this.root.addEventListener('keydown', this._key);
    this.root.addEventListener('pointerdown', this._down);
    window.addEventListener('scroll', this._scroll, { capture: true, passive: true });
    this.render(null);
  }

  displayName() { return this.title ?? UNITS[this.unitType]?.name ?? 'Unité'; }
  slots() { return unitSlotsFor(this.unitType, this.slotsBonus); }
  validate() { return validateProgram(this.program, this.unitType, { unlocked: this.lock, slotsBonus: this.slotsBonus }); }
  ctx() { return { unitType: this.unitType, lock: this.lock, interactive: !this.readOnly, pending: this.pending, compact: this.compact }; }
  itemAt(ri, slot) { const r = this.program.rules[ri]; if (!r) return null; return slot === 'a' ? r.action : r.conds[Number(slot.slice(1))]; }

  // ---------------------------------------------------------------- rendu
  render(focusKey) {
    let fkey = focusKey;
    if (fkey === undefined) {
      const a = document.activeElement;
      fkey = a && this.inner.contains(a) ? a.dataset?.fk ?? null : null;
    }
    if (this.drag) this.finishDrag(false, true);
    const v = this.validate();
    const n = this.program.rules.length;
    const { perRule, global } = splitErrors(v.errors, n);
    const msgs = ruleMessages(this.program, perRule);
    // pas de reproche « il manque une action » pendant qu'on est en train de composer la règle
    const composing = this.pending?.ri ?? this.composing ?? -1;
    if (composing >= 0 && msgs[composing]) msgs[composing].errors = msgs[composing].errors.filter((e) => !/manque une action/i.test(e));
    const ctx = this.ctx();

    const list = h('ol', { class: 'rn-rules', 'aria-label': 'Règles, lues de haut en bas : la première applicable est exécutée' });
    this.program.rules.forEach((rule, i) => list.append(buildRule(ctx, rule, i, n, msgs[i])));

    const alerts = global.length
      ? h('div', { class: 'rn-alerts' }, global.map((e) => h('p', { class: 'rn-alert' }, h('span', { class: 'rn-err-mark', 'aria-hidden': 'true' }, '!'), e)))
      : null;
    this.top = h('div', { class: `rn-top${alerts ? ' has-alerts' : ''}` }, this.buildHeader(v), alerts);
    const kids = [this.top];
    if (n) kids.push(list);
    else kids.push(h('p', { class: 'rn-emptynote' }, this.readOnly ? 'Aucune rune.' : 'Aucune règle pour l’instant. Ajoutez-en une : sans programme, l’unité suit son instinct.'));
    kids.push(buildInstinct(this.compact));
    if (!this.readOnly) {
      const full = n >= MAX_RULES;
      kids.push(h('div', { class: 'rn-foot' },
        h('button', { type: 'button', class: 'rn-add', 'data-act': 'add-rule', 'data-fk': 'add', disabled: full },
          icon('plus'), h('span', {}, full ? `${MAX_RULES} règles au plus` : 'Ajouter une règle'),
          h('span', { class: 'rn-add-count' }, `${n}/${MAX_RULES}`))));
    }
    this.inner.replaceChildren(...kids);
    if (this._ro) { this._ro.disconnect(); this._ro.observe(this.top); } else this.syncTop();
    this.applyHighlight();

    if (fkey) {
      let el = byFk(this.inner, fkey);
      if (!el || el.disabled) {
        const m = /^r(\d+):/.exec(fkey);
        const ri = m ? Math.min(Number(m[1]), n - 1) : -1;
        el = (ri >= 0 && byFk(this.inner, `r${ri}:h`)) || byFk(this.inner, 'add');
      }
      if (el && !el.disabled && !this.pop.el.contains(document.activeElement)) el.focus({ preventScroll: true });
    }
    if (this.pop.isOpen) {
      this.pop.anchorEl()?.setAttribute('aria-expanded', 'true');
      this.pop.position();
    }
  }

  buildHeader(v) {
    const unit = UNITS[this.unitType];
    const cls = unit ? CLASSES[unit.cls]?.name : null;
    const bonus = this.slotsBonus > 0 ? ` (dont +${this.slotsBonus})` : '';
    const tools = [];
    if (!this.readOnly) {
      tools.push(h('button', {
        type: 'button', class: 'rn-hbtn', 'data-act': 'undo', 'data-fk': 'undo', disabled: !this.history.length,
        title: 'Défaire la dernière modification (Ctrl+Z)', 'aria-label': 'Défaire la dernière modification',
      }, icon('undo'), h('span', { class: 'rn-hbtn-txt' }, 'Défaire')));
      if (DEFAULT_PROGRAMS[this.unitType]) {
        tools.push(h('button', {
          type: 'button', class: 'rn-hbtn', 'data-act': 'reset', 'data-fk': 'reset',
          title: 'Rétablir le programme par défaut de cette unité', 'aria-label': 'Rétablir le programme par défaut',
        }, icon('reset'), h('span', { class: 'rn-hbtn-txt' }, 'Par défaut')));
      }
    }
    return h('header', { class: 'rn-head' },
      h('div', { class: 'rn-title' },
        h('div', { class: 'rn-name', role: 'heading', 'aria-level': '3' }, this.displayName()),
        h('div', { class: 'rn-sub' }, [cls, `${v.slots} emplacements${bonus}`].filter(Boolean).join(' · '))),
      buildMeter(this.program, v.slots),
      tools.length ? h('div', { class: 'rn-htools' }, tools) : null);
  }

  /**
   * Mesure la bande collante. Si le compteur est seul sur sa ligne (panneau étroit, téléphone), la bande se colle
   * plus haut que sa boîte (--rn-top-shift négatif) : le nom et les outils défilent, seule la ligne du compteur et
   * les alertes restent. Le décalage compense aussi le padding haut de la boîte qui défile (sans quoi la bande se
   * colle sous ce padding et les règles passent au-dessus). --rn-top-h (partie visible) sert au scroll-margin.
   */
  syncTop() {
    const top = this.top;
    if (!top?.isConnected) return;
    const tr = top.getBoundingClientRect();
    if (!tr.height) return; // éditeur caché
    const meter = top.querySelector('.rn-meter');
    const off = meter ? meter.getBoundingClientRect().top - tr.top : 0;
    let shift = 0;
    if (off > 24) { // compteur sous le nom : on cache la ligne du nom et des outils, pas plus
      const rowEnd = Math.max(...[...top.querySelectorAll('.rn-title, .rn-htools')].map((e) => e.getBoundingClientRect().bottom - tr.top), 0);
      shift = Math.round(Math.min(off - 2, Math.max(rowEnd + 1, off - 8)));
    }
    const sc = stickyScroller(this.root);
    const pad = sc ? parseFloat(getComputedStyle(sc).paddingTop) || 0 : 0;
    this.root.style.setProperty('--rn-top-shift', `${-Math.round(shift + pad)}px`);
    this.root.style.setProperty('--rn-top-h', `${Math.round(tr.height - shift)}px`);
    this.topMargin = parseFloat(getComputedStyle(top).marginTop) || 0;
    this.syncStuck();
  }

  /** Ombre sous la bande quand elle est décollée de sa place (des règles passent dessous). */
  syncStuck() {
    const top = this.top;
    if (!top?.isConnected) return;
    const natural = this.inner.getBoundingClientRect().top + this.topMargin;
    top.classList.toggle('is-stuck', top.getBoundingClientRect().top > natural + 1);
  }

  applyHighlight() {
    const rows = this.inner.querySelectorAll('.rn-rule');
    applyHighlightTo(this.root, rows, this.inner.querySelector('[data-instinct]'), this.highlight);
  }

  // ---------------------------------------------------------------- mutations
  emit() {
    if (!this.onChange) return;
    try { this.onChange(cloneProgram(this.program), this.validate()); } catch (err) { console.error('[editor] onChange a levé une erreur', err); }
  }

  /** Applique une mutation : historique (Défaire), rendu, onChange. coalesce : regroupe les pas d'un même réglage. */
  commit(mutator, { focus, coalesce = null } = {}) {
    const before = JSON.stringify(this.program);
    mutator(this.program);
    const changed = JSON.stringify(this.program) !== before;
    if (changed) {
      if (!coalesce || coalesce !== this.coalesceKey) {
        this.history.push(before);
        if (this.history.length > 100) this.history.shift();
      }
      this.coalesceKey = coalesce;
    }
    this.render(focus);
    if (changed) this.emit();
    return changed;
  }

  undo() {
    if (!this.history.length) return;
    this.pop.close({ restore: false });
    this.pending = null;
    this.program = JSON.parse(this.history.pop());
    this.coalesceKey = null;
    this.render();
    this.toast('Modification annulée.');
    this.emit();
  }

  chooseRune(ri, slot, id, guided) {
    this.pending = null;
    const isCond = slot !== 'a';
    const thenAction = guided && isCond && !this.program.rules[ri]?.action;
    if (thenAction) this.composing = ri;
    this.commit((p) => {
      const rule = p.rules[ri];
      if (!rule) return;
      if (!isCond) { rule.action = makeAction(id, carryParams(rule.action, id, this.unitType), this.unitType); return; }
      const ci = Number(slot.slice(1));
      const old = rule.conds[ci];
      const c = makeCond(id, carryParams(old, id, this.unitType), this.unitType);
      if (old?.not) c.not = true;
      rule.conds[ci] = c;
      if (rule.conds.length >= 2 && !isUnlocked(rule.logic, this.lock)) {
        const other = rule.logic === 'OR' ? 'AND' : 'OR';
        if (isUnlocked(other, this.lock)) rule.logic = other;
      }
    }, { focus: slotKey(ri, slot) });
    if (thenAction) this.openPalette(ri, 'a');
  }

  setParam(ri, slot, key, value, opts = {}) {
    this.commit((p) => {
      const r = p.rules[ri];
      const it = r && (slot === 'a' ? r.action : r.conds[Number(slot.slice(1))]);
      if (it) it.params = { ...it.params, [key]: value };
    }, opts);
  }

  removeCond(ri, ci) {
    this.commit((p) => { p.rules[ri]?.conds.splice(ci, 1); },
      { focus: ci > 0 ? slotKey(ri, `c${ci - 1}`) : this.program.rules[ri]?.conds.length > 1 ? slotKey(ri, 'c0') : `r${ri}:lead` });
    this.toast('Condition retirée.', { undo: true });
  }

  toggleLead(ri) {
    const rule = this.program.rules[ri];
    if (!rule) return;
    if (rule.conds.length) {
      const savedConds = JSON.parse(JSON.stringify(rule.conds));
      this.commit((p) => { this.saved.set(p.rules[ri], savedConds); p.rules[ri].conds = []; }, { focus: `r${ri}:lead` });
      this.toast(`Règle ${roman(ri)} : TOUJOURS, sans condition.`, { undo: true });
    } else if (this.saved.has(rule)) {
      const conds = this.saved.get(rule);
      this.saved.delete(rule);
      this.commit((p) => { p.rules[ri].conds = conds; }, { focus: `r${ri}:lead` });
    } else {
      this.warnBudget(1);
      this.startPendingCond(ri, 0);
    }
  }

  /** Prévient, avant d'ouvrir la palette, qu'un ajout de `need` emplacements fera déborder le grimoire. */
  warnBudget(need) {
    const missing = programCost(this.program) + need - this.slots();
    if (missing > 0) this.toast(budgetWarning(missing), { ms: 6500 });
  }

  startPendingCond(ri, ci, guided = false) {
    this.pending = { ri, ci };
    this.render(null);
    this.openPalette(ri, `c${ci}`, { guided });
  }

  toggleLogic(ri) {
    const rule = this.program.rules[ri];
    if (!rule) return;
    const next = rule.logic === 'OR' ? 'AND' : 'OR';
    if (!isUnlocked(next, this.lock)) {
      this.toast(`La rune ${RUNES[next].name} est verrouillée : ${lockHint(RUNES[next])}.`);
      return;
    }
    const fk = document.activeElement?.dataset?.fk;
    this.commit((p) => { p.rules[ri].logic = next; }, { focus: fk });
  }

  toggleNot(ri, ci) {
    const c = this.program.rules[ri]?.conds[ci];
    if (!c) return;
    if (!c.not && !isUnlocked('NOT', this.lock)) { this.toast(`La rune NON est verrouillée : ${lockHint(RUNES.NOT)}.`); return; }
    this.commit((p) => { const cc = p.rules[ri].conds[ci]; if (cc.not) delete cc.not; else cc.not = true; }, { focus: `${slotKey(ri, `c${ci}`)}:not` });
  }

  addCond(ri) {
    const rule = this.program.rules[ri];
    if (!rule || rule.conds.length >= MAX_CONDS_PER_RULE) return;
    if (rule.conds.length >= 1 && !isUnlocked('AND', this.lock) && !isUnlocked('OR', this.lock)) {
      this.toast(`Il faut la rune ET pour lier deux conditions : ${lockHint(RUNES.AND)}.`);
      return;
    }
    this.warnBudget(rule.conds.length === 1 ? 2 : 1); // une 2e condition paie aussi la liaison
    this.startPendingCond(ri, rule.conds.length);
  }

  addRule() {
    const rules = this.program.rules;
    if (rules.length >= MAX_RULES) { this.toast(`Un grimoire tient au plus ${MAX_RULES} règles.`); return; }
    const last = rules[rules.length - 1];
    // La nouvelle règle se glisse avant une règle finale « TOUJOURS » (sinon elle ne serait presque jamais lue).
    const at = last && !last.conds.length && last.action ? rules.length - 1 : rules.length;
    this.warnBudget(2); // SI … ALORS … : une condition et une action
    this.pending = { ri: at, ci: 0 };
    this.commit((p) => { p.rules.splice(at, 0, { conds: [], logic: 'AND', action: null }); }, { focus: null });
    this.openPalette(at, 'c0', { guided: true });
  }

  moveRule(from, to, focusKey) {
    const n = this.program.rules.length;
    if (from === to || to < 0 || to >= n || from < 0 || from >= n) return false;
    return this.commit((p) => { const [r] = p.rules.splice(from, 1); p.rules.splice(to, 0, r); },
      { focus: focusKey ?? (to < from ? `r${to}:up` : `r${to}:down`) });
  }

  deleteRule(ri) {
    const n = this.program.rules.length;
    if (ri < 0 || ri >= n) return;
    this.commit((p) => { p.rules.splice(ri, 1); }, { focus: n > 1 ? `r${Math.min(ri, n - 2)}:del` : 'add' });
    this.toast(`Règle ${roman(ri)} supprimée.`, { undo: true });
  }

  reset() {
    const def = DEFAULT_PROGRAMS[this.unitType];
    if (!def) return;
    const fresh = normalizeProgram(def, this.unitType);
    const changed = this.commit((p) => { p.rules = fresh.rules; }, { focus: 'reset' });
    this.toast(changed ? 'Programme par défaut rétabli.' : 'C’est déjà le programme par défaut.', { undo: changed });
  }

  toast(text, { undo = false, ms = 0 } = {}) {
    clearTimeout(this.toastTimer);
    const t = h('div', { class: 'rn-toast' }, h('span', { class: 'rn-toast-txt' }, text),
      undo ? h('button', {
        type: 'button', class: 'rn-toast-btn', 'data-act': 'undo', title: 'Défaire la dernière modification (Ctrl+Z)',
      }, icon('undo'), 'Défaire') : null);
    this.dock.replaceChildren(t);
    requestAnimationFrame(() => t.classList.add('is-in'));
    this.toastTimer = setTimeout(() => {
      t.classList.remove('is-in');
      setTimeout(() => t.remove(), 300);
    }, ms || (undo ? 6000 : 3800));
  }

  // ---------------------------------------------------------------- popovers
  openPalette(ri, slot, { guided = false } = {}) {
    const rule = this.program.rules[ri];
    if (!rule) return;
    const anchorKey = slotKey(ri, slot);
    if (this.pop.isOpen && this.pop.anchorKey === anchorKey) { this.pop.close(); return; }
    const isCond = slot !== 'a';
    const ci = isCond ? Number(slot.slice(1)) : -1;
    const current = isCond ? rule.conds[ci] : rule.action;
    const kind = isCond ? 'cond' : 'action';
    const all = Object.values(RUNES).filter((r) => r.kind === kind);
    const allowed = all.filter((r) => runeAllowedFor(r.id, this.unitType));
    const open = allowed.filter((r) => isUnlocked(r.id, this.lock));
    const closed = allowed.filter((r) => !isUnlocked(r.id, this.lock));
    const hidden = all.length - allowed.length;

    const list = h('div', { class: 'rn-opts', role: 'listbox', 'aria-label': isCond ? 'Runes de perception' : 'Runes d’action' });
    const group = (label, arr) => {
      if (!arr.length) return;
      if (closed.length) list.append(h('div', { class: 'rn-opt-group', role: 'presentation' }, label));
      for (const r of arr) list.append(this.paletteOption(r, current?.id === r.id));
    };
    group('Débloquées', open);
    group('Verrouillées', closed);
    const note = h('p', { class: 'rn-pop-note', 'aria-live': 'polite' });
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('[role=option]');
      if (!opt) return;
      const id = opt.dataset.rune;
      if (!isUnlocked(id, this.lock)) {
        note.textContent = `« ${RUNES[id].name} » est verrouillée : ${lockHint(RUNES[id])}.`;
        note.classList.add('is-on');
        opt.classList.remove('is-nope');
        void opt.offsetWidth;
        opt.classList.add('is-nope');
        return;
      }
      this.pop.close({ restore: false, picked: true });
      this.chooseRune(ri, slot, id, guided);
    });
    // Coût du choix, montré avant de choisir. Un débordement ne bloque pas : on peut vouloir supprimer une autre règle ensuite.
    const pv = costPreview(this.program, ri, slot, this.slots(), guided);
    const notice = pv.delta && pv.after > pv.slots ? h('p', { class: 'rn-pop-note is-on is-budget' }, budgetWarning(pv.after - pv.slots)) : null;
    const body = [list, note];
    if (hidden > 0) body.push(h('p', { class: 'rn-pop-foot-note' }, `${hidden} rune${hidden > 1 ? 's' : ''} réservée${hidden > 1 ? 's' : ''} à d’autres classes d’unités.`));
    const foot = [];
    if (isCond && current) {
      foot.push(h('button', {
        type: 'button', class: 'rn-pop-btn is-danger',
        onclick: () => { this.pop.close({ restore: false, picked: true }); this.removeCond(ri, ci); },
      }, icon('trash'), 'Retirer la condition'));
    }
    const fam = FAM[kind];
    this.pop.open({
      anchorKey, fam, kicker: `${RUNE_KIND_INFO[kind].name} · règle ${roman(ri)}`,
      title: isCond ? (current ? 'Changer la condition' : 'Choisir une condition') : (current ? 'Changer l’action' : 'Choisir une action'),
      context: ruleContext(rule, slot, this.unitType), cost: costLine(pv), notice,
      // action d'une règle en cours de création : rester sous l'ancre pour laisser voir la condition choisie
      preferBelow: !isCond && this.composing === ri ? (notice ? 300 : 260) : 0,
      body, foot,
      focus: list.querySelector('[aria-selected=true]') ?? list.querySelector('[role=option]:not([aria-disabled=true])'),
      onClose: ({ picked }) => {
        if (this.composing != null) {
          const c = this.composing;
          this.composing = null;
          if (!picked) { this.render(null); return `r${c}:a`; }
        }
        if (picked || !this.pending) return undefined;
        const p = this.pending;
        this.pending = null;
        this.render(null);
        const r = this.program.rules[p.ri];
        return r && r.conds.length ? `r${p.ri}:plus` : `r${p.ri}:lead`;
      },
    });
  }

  paletteOption(rune, current) {
    const locked = !isUnlocked(rune.id, this.lock);
    const fam = locked ? 'locked' : FAM[rune.kind];
    const parts = textParts(rune.id, resolveParams(rune.id, {}, this.unitType), this.unitType);
    const phrase = h('span', { class: 'rn-opt-phrase' }, parts.map((p, k) => (p.kind === 'text'
      ? tidyText(p.text, parts[k - 1]?.kind === 'param', parts[k + 1]?.kind === 'param')
      : h('span', { class: 'rn-opt-param' }, p.label))));
    return h('div', {
      role: 'option', class: `rn-opt rn-fam-${fam}${locked ? ' is-locked' : ''}${current ? ' is-current' : ''}`,
      'aria-selected': current ? 'true' : 'false', 'aria-disabled': locked ? 'true' : null, tabindex: '-1',
      'data-rune': rune.id, 'data-label': rune.name,
    },
    h('span', { class: 'rn-opt-glyph', 'aria-hidden': 'true' }, rune.glyph),
    h('span', { class: 'rn-opt-main' },
      h('span', { class: 'rn-opt-line' }, h('span', { class: 'rn-opt-name' }, rune.name), phrase),
      h('span', { class: 'rn-opt-help' }, rune.help)),
    locked
      ? h('span', { class: 'rn-opt-lock' }, icon('lock'), h('span', { class: 'rn-opt-price' }, rune.price ? `${rune.price}${NB}or` : 'à voler'), rune.price ? h('span', { class: 'rn-opt-sub' }, 'ou à voler') : null)
      : current ? h('span', { class: 'rn-opt-cur' }, icon('check')) : null);
  }

  openParam(ri, slot, key) {
    const item = this.itemAt(ri, slot);
    const rune = item && RUNES[item.id];
    const param = rune?.params.find((p) => p.key === key);
    if (!param) return;
    const anchorKey = `${slotKey(ri, slot)}:${key}`;
    if (this.pop.isOpen && this.pop.anchorKey === anchorKey) { this.pop.close(); return; }
    // bornes propres à l'unité (KITE : au plus sa portée)
    if (param.type === 'int') { this.openStepper(ri, slot, key, { ...param, ...paramBounds(param, this.unitType) }, rune, anchorKey); return; }
    const options = paramOptions(param, this.unitType);
    const cur = item.params?.[key];
    const list = h('div', { class: 'rn-opts is-param', role: 'listbox', 'aria-label': PARAM_LABEL[key] ?? key });
    options.forEach((o, i) => {
      const sel = o.value === cur;
      const label = param.options === 'PCT' ? `${o.label}${NB}%` : o.label;
      list.append(h('div', {
        role: 'option', class: `rn-opt is-param${sel ? ' is-current' : ''}`, 'aria-selected': sel ? 'true' : 'false', tabindex: '-1',
        'data-i': i, 'data-label': o.label,
      },
      h('span', { class: 'rn-opt-check', 'aria-hidden': 'true' }, sel ? icon('check') : null),
      h('span', { class: 'rn-opt-main' }, h('span', { class: 'rn-opt-name' }, label), o.help ? h('span', { class: 'rn-opt-help' }, o.help) : null)));
    });
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('[role=option]');
      if (!opt) return;
      const v = options[Number(opt.dataset.i)]?.value;
      this.pop.close({ restore: false, picked: true });
      this.setParam(ri, slot, key, v, { focus: anchorKey });
    });
    this.pop.open({
      anchorKey, fam: FAM[rune.kind], kicker: rune.name, title: PARAM_LABEL[key] ?? key, body: [list],
      focus: list.querySelector('[aria-selected=true]') ?? list.querySelector('[role=option]'),
    });
  }

  openStepper(ri, slot, key, param, rune, anchorKey) {
    const unitWord = PARAM_UNIT[key] ?? '';
    const get = () => this.itemAt(ri, slot)?.params?.[key];
    const clamp = (v) => Math.max(param.min, Math.min(param.max, Math.round(v)));
    const big = param.max - param.min > 10;
    const num = h('span', { class: 'rn-spin-num' });
    const spin = h('div', {
      class: 'rn-spin', role: 'spinbutton', tabindex: '0', 'aria-label': PARAM_LABEL[key] ?? key,
      'aria-valuemin': param.min, 'aria-valuemax': param.max,
    }, num, unitWord ? h('span', { class: 'rn-spin-unit' }, unitWord) : null);
    const mk = (d, label, aria) => h('button', { type: 'button', class: `rn-step${Math.abs(d) > 1 ? ' is-big' : ''}`, 'data-d': d, 'aria-label': aria }, label);
    const stepper = h('div', { class: 'rn-stepper' },
      big ? mk(-5, '−5', 'Moins cinq') : null, mk(-1, '−', 'Moins un'), spin, mk(1, '+', 'Plus un'), big ? mk(5, '+5', 'Plus cinq') : null);
    const quickVals = big ? [4, 8, 12, 16, 24, 32, 48].filter((v) => v >= param.min && v <= param.max)
      : Array.from({ length: param.max - param.min + 1 }, (_, k) => param.min + k);
    const quick = h('div', { class: 'rn-quick', role: 'group', 'aria-label': 'Valeurs rapides' },
      quickVals.map((v) => h('button', { type: 'button', class: 'rn-quick-btn', 'data-v': v, 'aria-label': `${v} ${unitWord}`.trim() }, String(v))));
    const sync = () => {
      const v = get();
      num.textContent = String(v ?? '?');
      spin.setAttribute('aria-valuenow', String(v));
      spin.setAttribute('aria-valuetext', `${v} ${unitWord}`.trim());
      for (const b of stepper.querySelectorAll('[data-d]')) {
        const d = Number(b.dataset.d);
        b.setAttribute('aria-disabled', (d < 0 ? v <= param.min : v >= param.max) ? 'true' : 'false');
      }
      for (const b of quick.querySelectorAll('[data-v]')) b.setAttribute('aria-pressed', Number(b.dataset.v) === v ? 'true' : 'false');
    };
    const set = (v) => {
      const nv = clamp(v);
      if (nv !== get()) this.setParam(ri, slot, key, nv, { coalesce: anchorKey, focus: null });
      sync();
    };
    stepper.addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) set((get() ?? param.min) + Number(b.dataset.d)); });
    quick.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) set(Number(b.dataset.v)); });
    spin.addEventListener('keydown', (e) => {
      const v = get() ?? param.min;
      const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 };
      if (e.key in map) { e.preventDefault(); set(v + map[e.key]); }
      else if (e.key === 'Home') { e.preventDefault(); set(param.min); }
      else if (e.key === 'End') { e.preventDefault(); set(param.max); }
      else if (e.key === 'Enter') { e.preventDefault(); this.pop.close(); }
    });
    sync();
    const unit = UNITS[this.unitType];
    let hint = null;
    if (key === 'n' && unit) hint = `Repères : ${unit.name.toLowerCase()} — portée ${unit.range}${NB}hex, vitesse ${String(unit.speed).replace('.', ',')}${NB}hex par instant.`;
    if (key === 't') hint = `Une bataille dure au plus ${MAX_TICKS} instants.`;
    this.pop.open({
      anchorKey, fam: FAM[rune.kind], kicker: rune.name, title: PARAM_LABEL[key] ?? key,
      body: [h('div', { class: 'rn-stepwrap' }, stepper, quick, hint ? h('p', { class: 'rn-pop-hint' }, hint) : null)],
      foot: [h('button', { type: 'button', class: 'rn-pop-btn is-primary', onclick: () => this.pop.close() }, icon('check'), 'Valider')],
      focus: spin,
    });
  }

  // ---------------------------------------------------------------- événements
  onClick(e) {
    const el = e.target.closest?.('[data-act]');
    if (!el || !this.root.contains(el) || this.pop.el.contains(el)) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const act = el.dataset.act;
    if (this.readOnly) return;
    const ri = el.dataset.ri != null ? Number(el.dataset.ri) : -1;
    const slot = el.dataset.slot;
    switch (act) {
      case 'pick': this.openPalette(ri, slot); break;
      case 'param': this.openParam(ri, slot, el.dataset.key); break;
      case 'lead': this.toggleLead(ri); break;
      case 'logic': this.toggleLogic(ri); break;
      case 'not': this.toggleNot(ri, Number(slot.slice(1))); break;
      case 'plus': this.addCond(ri); break;
      case 'up': this.moveRule(ri, ri - 1); break;
      case 'down': this.moveRule(ri, ri + 1); break;
      case 'del': this.deleteRule(ri); break;
      case 'add-rule': this.addRule(); break;
      case 'reset': this.reset(); break;
      case 'undo': this.undo(); break;
      default: break;
    }
  }

  onKeyDown(e) {
    if (this.pop.el.contains(e.target) || this.readOnly) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      if (this.history.length) { e.preventDefault(); this.undo(); }
      return;
    }
    const t = e.target;
    const n = this.program.rules.length;
    const ruleEl = t.closest?.('.rn-rule');
    const ri = ruleEl ? Number(ruleEl.dataset.ri) : -1;
    if (ri < 0) return;
    const onHandle = t.matches?.('.rn-handle');
    if ((onHandle && !e.altKey) || (e.altKey && !onHandle)) {
      let to = -1;
      if (e.key === 'ArrowUp') to = ri - 1;
      else if (e.key === 'ArrowDown') to = ri + 1;
      else if (onHandle && e.key === 'Home') to = 0;
      else if (onHandle && e.key === 'End') to = n - 1;
      if (to !== -1) {
        e.preventDefault();
        if (to >= 0 && to < n && to !== ri) {
          this.moveRule(ri, to, `r${to}:h`);
          this.toast(`Règle déplacée en position ${roman(to)}.`);
        }
        return;
      }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && t.matches?.('.rn-glyph[data-slot^="c"]')) {
      e.preventDefault();
      this.removeCond(ri, Number(t.dataset.slot.slice(1)));
    }
  }

  // ---------------------------------------------------------------- glisser-déposer (souris + tactile)
  onPointerDown(e) {
    if (this.readOnly || this.drag) return;
    const handle = e.target.closest?.('.rn-handle');
    if (!handle || handle.classList.contains('is-static') || !this.inner.contains(handle)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const li = handle.closest('.rn-rule');
    const list = li?.parentElement;
    if (!li || !list) return;
    const rows = [...list.children].filter((x) => x.classList.contains('rn-rule'));
    if (rows.length < 2) return;
    this.pop.close({ restore: false });
    const lr = list.getBoundingClientRect();
    const geo = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top - lr.top, h: b.height }; });
    const ri = rows.indexOf(li);
    const gap = Math.max(0, geo[1].top - geo[0].top - geo[0].h);
    this.drag = {
      pid: e.pointerId, ri, li, list, rows, geo, gap, handle, startRel: e.clientY - lr.top, lastY: e.clientY,
      started: false, target: ri, dyNow: 0, scroller: scrollParent(list), raf: 0, v: 0,
    };
    try { handle.setPointerCapture(e.pointerId); } catch { /* évènement synthétique */ }
    window.addEventListener('pointermove', this._dragMove);
    window.addEventListener('pointerup', this._dragUp);
    window.addEventListener('pointercancel', this._dragCancel);
  }

  updateDrag() {
    const d = this.drag;
    if (!d) return;
    const lr = d.list.getBoundingClientRect();
    const dy = d.lastY - lr.top - d.startRel;
    if (!d.started) {
      if (Math.abs(dy) < 6) return;
      d.started = true;
      d.li.classList.add('is-dragging');
      d.list.classList.add('is-sorting');
      this.root.classList.add('is-sorting');
    }
    const g = d.geo;
    const me = g[d.ri];
    const lastG = g[g.length - 1];
    // le centre de la ligne tirée peut aller du haut de la première ligne au bas de la dernière
    const mid0 = me.top + me.h / 2;
    const cdy = Math.max(-mid0 - 4, Math.min(lastG.top + lastG.h - mid0 + 4, dy));
    d.dyNow = cdy;
    d.li.style.transform = `translateY(${cdy}px)`;
    const center = me.top + me.h / 2 + cdy;
    let target = d.ri;
    for (let j = d.ri + 1; j < g.length; j++) if (center > g[j].top + g[j].h / 2) target = j;
    for (let j = d.ri - 1; j >= 0; j--) if (center < g[j].top + g[j].h / 2) target = j;
    d.target = target;
    const shift = me.h + d.gap;
    d.rows.forEach((row, j) => {
      if (j === d.ri) return;
      let t = 0;
      if (j > d.ri && j <= target) t = -shift;
      else if (j < d.ri && j >= target) t = shift;
      row.style.transform = t ? `translateY(${t}px)` : '';
    });
    // défilement automatique près des bords (le bord haut est sous la bande collante du compteur)
    const vr = d.scroller ? d.scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const vTop = Math.max(vr.top, this.top?.isConnected ? this.top.getBoundingClientRect().bottom : vr.top);
    const edge = 56;
    let v = 0;
    if (d.lastY < vTop + edge) v = -Math.ceil((vTop + edge - d.lastY) / 5);
    else if (d.lastY > vr.bottom - edge) v = Math.ceil((d.lastY - (vr.bottom - edge)) / 5);
    d.v = Math.max(-18, Math.min(18, v));
    if (d.v && !d.raf) d.raf = requestAnimationFrame(this._dragTick);
  }

  finishDrag(commit, silent = false) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    window.removeEventListener('pointermove', this._dragMove);
    window.removeEventListener('pointerup', this._dragUp);
    window.removeEventListener('pointercancel', this._dragCancel);
    if (d.raf) cancelAnimationFrame(d.raf);
    try { d.handle.releasePointerCapture(d.pid); } catch { /* */ }
    d.list.classList.remove('is-sorting');
    this.root.classList.remove('is-sorting');
    d.li.classList.remove('is-dragging');
    for (const r of d.rows) r.style.transform = '';
    if (silent || !d.started) return;
    const dropTop = d.geo[d.ri].top + d.dyNow;
    if (commit && d.target !== d.ri) {
      this.moveRule(d.ri, d.target, `r${d.target}:h`);
      this.toast(`Règle déplacée en position ${roman(d.target)}.`);
    } else {
      this.render(`r${d.ri}:h`);
    }
    // petit atterrissage (FLIP) depuis la position lâchée
    const landed = this.inner.querySelectorAll('.rn-rule')[commit ? d.target : d.ri];
    if (landed && !reducedMotion() && landed.animate) {
      const lr = landed.parentElement.getBoundingClientRect();
      const off = dropTop - (landed.getBoundingClientRect().top - lr.top);
      if (Math.abs(off) > 1) landed.animate([{ transform: `translateY(${off}px)` }, { transform: 'none' }], { duration: 170, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }

  // ---------------------------------------------------------------- API publique
  getProgram() { return cloneProgram(this.program); }
  setProgram(p) {
    this.pop.close({ restore: false });
    this.pending = null;
    this.program = normalizeProgram(p, this.unitType);
    this.history = [];
    this.render();
  }
  setHighlight(i) { this.highlight = Number.isInteger(i) ? i : null; this.applyHighlight(); }
  setUnlocked(u) { this.lock = toLock(u); this.render(); }
  setSlotsBonus(b) { this.slotsBonus = Number(b) || 0; this.render(); }
  destroy() {
    this.finishDrag(false, true);
    this.pop.close({ restore: false });
    clearTimeout(this.toastTimer);
    this._ro?.disconnect();
    if (this.stuckRaf) cancelAnimationFrame(this.stuckRaf);
    window.removeEventListener('scroll', this._scroll, { capture: true });
    this.root.removeEventListener('click', this._click);
    this.root.removeEventListener('keydown', this._key);
    this.root.removeEventListener('pointerdown', this._down);
    this.root.remove();
    this.onChange = null;
  }
}

/** Surlignage d'une règle (doré, animé) et atténuation des autres. hl = -1 : l'instinct. */
function applyHighlightTo(root, rows, instinctEl, hl) {
  const n = rows.length;
  const valid = Number.isInteger(hl) && (hl === -1 || (hl >= 0 && hl < n));
  root.classList.toggle('has-highlight', valid);
  const phase = `${-(((typeof performance !== 'undefined' ? performance.now() : Date.now())) % GLOW_PERIOD)}ms`;
  rows.forEach((li, i) => {
    const on = valid && i === hl;
    if (on && !li.classList.contains('is-active')) li.style.animationDelay = phase;
    li.classList.toggle('is-active', on);
    if (on) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  if (instinctEl) {
    const on = valid && hl === -1;
    if (on && !instinctEl.classList.contains('is-active')) instinctEl.style.animationDelay = phase;
    instinctEl.classList.toggle('is-active', on);
  }
}

// ------------------------------------------------------------------ Exports
/**
 * Monte l'éditeur de runes dans `container` (vidé au préalable).
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} opts.unitType            id d'UNITS (ex. 'k_mage')
 * @param {number} [opts.slotsBonus=0]      emplacements supplémentaires (méditation)
 * @param {{rules:Array}} [opts.program]    programme initial (copié ; DEFAULT_PROGRAMS[unitType] si absent)
 * @param {Set<string>|string[]|null} [opts.unlocked=null]  runes débloquées ; null = tout est débloqué
 * @param {(program:object, validation:{ok:boolean,cost:number,slots:number,errors:string[]})=>void} [opts.onChange]
 * @param {boolean} [opts.readOnly=false]   lecture seule (même mise en page, sans outils)
 * @param {number|null} [opts.highlightRule=null]  règle surlignée (-1 = instinct)
 * @param {string|null} [opts.title=null]   titre (nom de l'unité par défaut)
 * @param {boolean} [opts.compact=false]    variante resserrée (ex. message de corbeau)
 * @returns {{getProgram:()=>object, setProgram:(p:object)=>void, setHighlight:(i:number|null)=>void, destroy:()=>void,
 *            validate:()=>object, setUnlocked:(u:any)=>void, setSlotsBonus:(n:number)=>void,
 *            openPalette:(ruleIndex:number, slot:string)=>void, openParam:(ruleIndex:number, slot:string, key:string)=>void,
 *            closePopover:()=>void, element:HTMLElement}}
 *   slot : 'c0' | 'c1' | 'c2' (conditions) ou 'a' (action).
 */
export function mountEditor(container, opts = {}) {
  if (!container) throw new Error('mountEditor : conteneur manquant');
  const ed = new RuneEditor(container, opts);
  return {
    getProgram: () => ed.getProgram(),
    setProgram: (p) => ed.setProgram(p),
    setHighlight: (i) => ed.setHighlight(i),
    destroy: () => ed.destroy(),
    validate: () => ed.validate(),
    setUnlocked: (u) => ed.setUnlocked(u),
    setSlotsBonus: (b) => ed.setSlotsBonus(b),
    openPalette: (ri, slot = 'a') => {
      const r = ed.program.rules[ri];
      if (ed.readOnly || !r) return;
      const ci = slot === 'a' ? -1 : Number(String(slot).slice(1));
      if (ci >= r.conds.length) { if (r.conds.length < MAX_CONDS_PER_RULE) ed.startPendingCond(ri, r.conds.length); }
      else ed.openPalette(ri, slot);
    },
    openParam: (ri, slot, key) => { if (!ed.readOnly) ed.openParam(ri, slot, key); },
    closePopover: () => ed.pop.close({ restore: false }),
    element: ed.root,
  };
}

const VIEW_CACHE = new WeakMap();

/**
 * Affiche un programme en lecture seule, dense (inspecteur de bataille, grimoire ennemi).
 * Peut être rappelée à chaque tick : si le programme n'a pas changé, seul le surlignage est mis à jour
 * (pas de reconstruction du DOM, l'animation dorée reste continue).
 * @param {HTMLElement} container
 * @param {{rules:Array}} program
 * @param {object} opts
 * @param {string} opts.unitType
 * @param {number|null} [opts.highlightRule=null]  règle surlignée ; -1 = instinct ; les autres sont atténuées
 * @param {boolean} [opts.compact=true]
 * @param {string} [opts.title]           extra : titre affiché au-dessus (avec le compteur d'emplacements)
 * @param {number} [opts.slotsBonus=0]    extra : pour le compteur
 * @param {boolean} [opts.showInstinct=true] extra : ligne « Sinon : instinct »
 * @param {Set<string>|string[]|null} [opts.unlocked=null] extra : les runes hors de cet ensemble sont marquées « à voler »
 */
export function renderProgramView(container, program, opts = {}) {
  if (!container) return;
  const { unitType, highlightRule = null, compact = true, title = null, slotsBonus = 0, showInstinct = true, unlocked = null } = opts;
  let sig;
  try { sig = `${JSON.stringify(program ?? null)}|${unitType}|${compact}|${title}|${slotsBonus}|${showInstinct}|${unlocked ? [...unlocked].join(',') : '*'}`; } catch { sig = null; }
  const cached = VIEW_CACHE.get(container);
  if (sig && cached && cached.sig === sig && cached.root.parentNode === container) {
    applyHighlightTo(cached.root, cached.root.querySelectorAll('.rn-rule'), cached.root.querySelector('[data-instinct]'), highlightRule);
    return;
  }
  const prog = normalizeProgram(program, unitType);
  const steal = toLock(unlocked);
  const ctx = { unitType, lock: null, interactive: false, pending: null, compact };
  const root = h('div', { class: `rn-view${compact ? ' rn-view--compact' : ''}`, role: 'group', 'aria-label': `Programme — ${title ?? UNITS[unitType]?.name ?? ''}` });
  const inner = h('div', { class: 'rn-vinner' });
  if (title) {
    inner.append(h('div', { class: 'rn-vhead' }, h('div', { class: 'rn-vname' }, title), buildMeter(prog, unitSlotsFor(unitType, slotsBonus), { small: true })));
  }
  const n = prog.rules.length;
  if (n) {
    const list = h('ol', { class: 'rn-rules' });
    prog.rules.forEach((rule, i) => {
      const li = buildRule(ctx, rule, i, n, { errors: [], hint: null });
      if (steal) {
        // marque les runes que le joueur ne possède pas encore (vol après victoire)
        const sticker = () => h('span', { class: 'rn-new', title: 'Rune que vous ne possédez pas : elle peut être volée' }, 'à voler');
        li.querySelectorAll('.rn-block[data-slot]').forEach((b) => {
          const it = b.dataset.slot === 'a' ? rule.action : rule.conds[Number(b.dataset.slot.slice(1))];
          if (it && !steal.has(it.id)) b.append(sticker());
        });
        const join = li.querySelector('.rn-join');
        if (join && !steal.has(rule.logic === 'OR' ? 'OR' : 'AND')) join.append(sticker());
        if (!steal.has('NOT')) { const nt = li.querySelector('.rn-not.is-on'); if (nt) nt.append(sticker()); }
      }
      list.append(li);
    });
    inner.append(list);
  } else {
    inner.append(h('p', { class: 'rn-emptynote' }, 'Aucune rune : l’unité suit son instinct.'));
  }
  if (showInstinct) inner.append(buildInstinct(compact));
  root.append(inner);
  container.replaceChildren(root);
  if (sig) VIEW_CACHE.set(container, { sig, root });
  applyHighlightTo(root, root.querySelectorAll('.rn-rule'), root.querySelector('[data-instinct]'), highlightRule);
}

/**
 * Bloc de rune isolé et statique (boutique, vol de rune, aide).
 * @param {string} runeId
 * @param {{unitType?:string, params?:object, showName?:boolean, locked?:boolean, compact?:boolean}} [opts]
 *   showName : affiche le nom de la rune plutôt que sa phrase (utile sans unité précise).
 * @returns {HTMLElement}
 */
export function runeBadge(runeId, { unitType = null, params = null, showName = false, locked = false, compact = true } = {}) {
  const rune = RUNES[runeId];
  const fam = locked ? 'locked' : famOf(runeId);
  const el = h('span', { class: `rn-badge rn-block rn-fam-${fam}${compact ? ' is-compact' : ''}`, title: rune ? `${rune.name} — ${rune.help}` : '' });
  el.append(h('span', { class: 'rn-glyph', 'aria-hidden': 'true' }, rune?.glyph ?? '?'));
  const text = h('span', { class: 'rn-text' });
  if (!rune) text.append('rune inconnue');
  else if (showName || rune.kind === 'logic') text.append(rune.name);
  else {
    const parts = textParts(runeId, resolveParams(runeId, params ?? {}, unitType), unitType);
    parts.forEach((p, k) => text.append(p.kind === 'text'
      ? tidyText(p.text, parts[k - 1]?.kind === 'param', parts[k + 1]?.kind === 'param')
      : h('span', { class: 'rn-chip is-static' }, p.label)));
  }
  el.append(text);
  if (locked) el.append(h('span', { class: 'rn-block-warn' }, icon('lock')));
  return el;
}

export const _internals = { normalizeProgram, splitErrors, carryParams, programFamilies, programCost, costPreview, ruleContext };
