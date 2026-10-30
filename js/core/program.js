// js/core/program.js — métadonnées des programmes de runes : coût, validation, paramètres, descriptions.
// Module pur, PARTAGÉ (écrit en amont). L'ÉVALUATION en bataille (chooseRule…) vit dans sim.js.
import { RUNES, UNITS, TARGETS, ALLY_TARGETS, PLACES, CLASSES, SPELLS, STANDABLE_TERRAINS, PCT_OPTIONS } from './data.js';

export const MAX_RULES = 8;
export const MAX_CONDS_PER_RULE = 3;

export const TERRAIN_PHRASE = { plain: 'la plaine', forest: 'une forêt', hill: 'une colline', ford: 'un gué', ruins: 'des ruines' };

export const emptyProgram = () => ({ rules: [] });
export const cloneProgram = (p) => JSON.parse(JSON.stringify(p ?? emptyProgram()));

// ------------------------------------------------------------------ Coût (GDD §4)
export function ruleCost(rule) {
  let c = 0;
  for (const cond of rule.conds ?? []) c += cond.not ? 2 : 1;
  if ((rule.conds ?? []).length >= 2) c += 1;
  if (rule.action) c += 1;
  return c;
}
export const programCost = (p) => (Array.isArray(p?.rules) ? p.rules : []).reduce((s, r) => s + ruleCost(r ?? {}), 0);
export const unitSlotsFor = (unitType, slotsBonus = 0) => (UNITS[unitType]?.slots ?? 0) + slotsBonus;

export function runesUsed(p) {
  const s = new Set();
  for (const rule of p?.rules ?? []) {
    for (const c of rule.conds ?? []) { s.add(c.id); if (c.not) s.add('NOT'); }
    if ((rule.conds ?? []).length >= 2) s.add(rule.logic === 'OR' ? 'OR' : 'AND');
    if (rule.action) s.add(rule.action.id);
  }
  return s;
}

// ------------------------------------------------------------------ Paramètres
// Bornes d'un paramètre entier pour ce type d'unité : param.maxByRange plafonne le maximum à la portée de base
// de l'unité (KITE : le moteur ne garde jamais plus que sa portée, une valeur au-delà serait sans effet).
export function paramBounds(param, unitType) {
  let max = param.max;
  if (param.maxByRange && Number.isFinite(UNITS[unitType]?.range)) max = Math.max(param.min, Math.min(max, UNITS[unitType].range));
  return { min: param.min, max };
}

// Options d'un paramètre pour ce type d'unité (moins les valeurs de param.exclude).
export function paramOptions(param, unitType) {
  if (param.type === 'int') {
    const out = [];
    const { min, max } = paramBounds(param, unitType);
    for (let v = min; v <= max; v++) out.push({ value: v, label: String(v) });
    return out;
  }
  const all = enumOptions(param, unitType);
  return param.exclude?.length ? all.filter(o => !param.exclude.includes(o.value)) : all;
}

function enumOptions(param, unitType) {
  const spells = UNITS[unitType]?.spells ?? [];
  switch (param.options) {
    case 'TARGETS': return Object.values(TARGETS).map(t => ({ value: t.id, label: t.name, help: t.help }));
    case 'ALLY_TARGETS': return Object.values(ALLY_TARGETS).map(t => ({ value: t.id, label: t.name, help: t.help }));
    case 'PLACES': return Object.values(PLACES).map(t => ({ value: t.id, label: t.name, help: t.help }));
    case 'TERRAINS': return STANDABLE_TERRAINS.map(t => ({ value: t, label: TERRAIN_PHRASE[t] }));
    case 'CLASSES': return Object.values(CLASSES).map(c => ({ value: c.id, label: c.plural }));
    case 'PCT': return PCT_OPTIONS.map(v => ({ value: v, label: String(v) }));
    case 'SPELLS': return spells.map(s => ({ value: s, label: SPELLS[s].name, help: SPELLS[s].help }));
    case 'ENEMY_SPELLS': return spells.filter(s => SPELLS[s].targetKind === 'enemy').map(s => ({ value: s, label: SPELLS[s].name, help: SPELLS[s].help }));
    case 'ALLY_SPELLS': return spells.filter(s => SPELLS[s].targetKind === 'ally').map(s => ({ value: s, label: SPELLS[s].name, help: SPELLS[s].help }));
    default: return [];
  }
}

// Complète les paramètres manquants avec les valeurs par défaut (spell null => premier sort compatible).
export function resolveParams(runeId, params = {}, unitType) {
  const rune = RUNES[runeId];
  const out = { ...params };
  for (const p of rune?.params ?? []) {
    if (out[p.key] === undefined || out[p.key] === null) {
      if (p.default !== null && p.default !== undefined) out[p.key] = p.default;
      else out[p.key] = paramOptions(p, unitType)[0]?.value ?? null;
      // défaut au-delà du plafond de cette unité (KITE 3 pour un mage de portée 2) : on le ramène au plafond
      if (p.type === 'int' && Number.isInteger(out[p.key])) { const b = paramBounds(p, unitType); out[p.key] = Math.max(b.min, Math.min(b.max, out[p.key])); }
    }
  }
  return out;
}

export function makeCond(id, params = {}, unitType) { return { id, params: resolveParams(id, params, unitType) }; }
export function makeAction(id, params = {}, unitType) { return { id, params: resolveParams(id, params, unitType) }; }

export function formatParam(runeId, key, value, unitType) {
  const p = RUNES[runeId]?.params.find(x => x.key === key);
  if (!p) return String(value);
  const opt = paramOptions(p, unitType).find(o => o.value === value);
  return opt ? opt.label : String(value ?? '?');
}

// Rune utilisable par ce type d'unité ? (classes, et sorts disponibles pour les runes de sort)
export function runeAllowedFor(runeId, unitType) {
  const rune = RUNES[runeId], unit = UNITS[unitType];
  if (!rune || !unit) return false;
  if (rune.classes && !rune.classes.includes(unit.cls)) return false;
  for (const p of rune.params) if (p.type === 'enum' && paramOptions(p, unitType).length === 0) return false;
  return true;
}

const asSet = (u) => (u == null ? null : u instanceof Set ? u : new Set(u));
export const isUnlocked = (runeId, unlocked) => { const s = asSet(unlocked); return !s || s.has(runeId); };

// ------------------------------------------------------------------ Validation
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
/** Numéro de règle en chiffres romains (1 → « I ») ; au-delà de 12, en chiffres arabes. */
export const romanNumeral = (n) => ROMAN[n - 1] ?? String(n);

export function validateProgram(program, unitType, { unlocked = null, slotsBonus = 0 } = {}) {
  const errors = [];
  const unit = UNITS[unitType];
  const slots = unitSlotsFor(unitType, slotsBonus);
  const cost = programCost(program);
  if (!unit) return { ok: false, cost, slots, errors: [`Type d’unité inconnu : ${unitType}`] };
  const rules = program?.rules;
  if (!Array.isArray(rules)) return { ok: false, cost, slots, errors: ['Programme mal formé.'] };
  if (rules.length > MAX_RULES) errors.push(`Au plus ${MAX_RULES} règles.`);
  const lock = asSet(unlocked);
  const checkParams = (rune, params, where) => {
    for (const p of rune.params) {
      const v = params?.[p.key];
      if (p.type === 'int') {
        const b = paramBounds(p, unitType);
        if (!Number.isInteger(v) || v < b.min || v > b.max) errors.push(`${where} : valeur ${p.key} invalide.`);
      } else if (!paramOptions(p, unitType).some(o => o.value === v)) errors.push(`${where} : « ${v} » n’est pas possible ici.`);
    }
  };
  rules.forEach((rule, i) => {
    const where = `Règle ${romanNumeral(i + 1)}`;   // mêmes chiffres romains que l'éditeur (I, II, III…)
    const conds = rule.conds ?? [];
    if (conds.length > MAX_CONDS_PER_RULE) errors.push(`${where} : au plus ${MAX_CONDS_PER_RULE} conditions.`);
    if (conds.length >= 2) {
      const lg = rule.logic === 'OR' ? 'OR' : 'AND';
      if (lock && !lock.has(lg)) errors.push(`${where} : la rune ${RUNES[lg].name} n’est pas encore débloquée.`);
    }
    for (const c of conds) {
      const rune = RUNES[c.id];
      if (!rune || rune.kind !== 'cond') { errors.push(`${where} : condition inconnue.`); continue; }
      if (!runeAllowedFor(c.id, unitType)) errors.push(`${where} : ${unit.name} ne peut pas utiliser « ${rune.name} ».`);
      if (lock && !lock.has(c.id)) errors.push(`${where} : « ${rune.name} » n’est pas encore débloquée.`);
      if (c.not && lock && !lock.has('NOT')) errors.push(`${where} : la rune NON n’est pas encore débloquée.`);
      checkParams(rune, c.params, where);
    }
    const a = rule.action;
    const rune = a && RUNES[a.id];
    if (!rune || rune.kind !== 'action') errors.push(`${where} : il manque une action.`);
    else {
      if (!runeAllowedFor(a.id, unitType)) errors.push(`${where} : ${unit.name} ne peut pas « ${rune.name} ».`);
      if (lock && !lock.has(a.id)) errors.push(`${where} : « ${rune.name} » n’est pas encore débloquée.`);
      checkParams(rune, a.params, where);
    }
  });
  if (cost > slots) errors.push(`Trop de runes : ${cost} pour ${slots} emplacements.`);
  return { ok: errors.length === 0, cost, slots, errors };
}

// Paramètres complétés, et toute valeur impossible ici remplacée par la valeur par défaut (ou la première option).
function repairParams(runeId, params, unitType) {
  const out = resolveParams(runeId, params, unitType);
  for (const p of RUNES[runeId]?.params ?? []) {
    const opts = paramOptions(p, unitType);
    if (opts.some(o => o.value === out[p.key])) continue;
    out[p.key] = opts.some(o => o.value === p.default) ? p.default : opts[0]?.value ?? null;
  }
  return out;
}

// Retire ce qui est invalide, répare les paramètres impossibles, puis retire les dernières règles tant que le
// coût dépasse les slots.
export function sanitizeProgram(program, unitType, { unlocked = null, slotsBonus = 0 } = {}) {
  const lock = asSet(unlocked);
  const okRune = (id) => runeAllowedFor(id, unitType) && (!lock || lock.has(id));
  const rules = [];
  for (const rule of program?.rules ?? []) {
    if (!rule?.action || !RUNES[rule.action.id] || RUNES[rule.action.id].kind !== 'action' || !okRune(rule.action.id)) continue;
    let conds = (rule.conds ?? []).filter(c => RUNES[c.id]?.kind === 'cond' && okRune(c.id)).slice(0, MAX_CONDS_PER_RULE)
      .map(c => ({ ...c, params: repairParams(c.id, c.params, unitType), ...(c.not && (!lock || lock.has('NOT')) ? { not: true } : { not: undefined }) }))
      .map(c => { if (!c.not) delete c.not; return c; });
    let logic = rule.logic === 'OR' ? 'OR' : 'AND';
    if (conds.length >= 2 && lock && !lock.has(logic)) { if (logic === 'OR' || !lock.has('AND')) conds = conds.slice(0, 1); }
    rules.push({ conds, logic, action: { id: rule.action.id, params: repairParams(rule.action.id, rule.action.params, unitType) } });
    if (rules.length >= MAX_RULES) break;
  }
  const out = { rules };
  const slots = unitSlotsFor(unitType, slotsBonus);
  while (programCost(out) > slots && out.rules.length) out.rules.pop();
  return out;
}

// ------------------------------------------------------------------ Descriptions (français)
// Découpe le gabarit `text` en morceaux { kind:'text', text } / { kind:'param', key, value, label } (pour l'éditeur).
export function textParts(runeId, params = {}, unitType) {
  const rune = RUNES[runeId];
  if (!rune) return [{ kind: 'text', text: '?' }];
  const parts = [];
  const re = /\{(\w+)\}/g;
  let last = 0, m;
  while ((m = re.exec(rune.text))) {
    if (m.index > last) parts.push({ kind: 'text', text: rune.text.slice(last, m.index) });
    const keyName = m[1];
    parts.push({ kind: 'param', key: keyName, value: params[keyName], label: formatParam(runeId, keyName, params[keyName], unitType) });
    last = re.lastIndex;
  }
  if (last < rune.text.length) parts.push({ kind: 'text', text: rune.text.slice(last) });
  return parts;
}
const partsToString = (parts) => parts.map(p => (p.kind === 'text' ? p.text : p.label)).join('');

export function describeCond(cond, unitType) {
  const txt = partsToString(textParts(cond.id, resolveParams(cond.id, cond.params, unitType), unitType));
  return cond.not ? `NON (${txt})` : txt;
}
export function describeAction(action, unitType) {
  if (!action) return '…';
  return partsToString(textParts(action.id, resolveParams(action.id, action.params, unitType), unitType));
}
export function describeRule(rule, unitType) {
  const conds = rule.conds ?? [];
  if (!conds.length) return `TOUJOURS ${describeAction(rule.action, unitType)}`;
  const joiner = rule.logic === 'OR' ? ' OU ' : ' ET ';
  return `SI ${conds.map(c => describeCond(c, unitType)).join(joiner)} ALORS ${describeAction(rule.action, unitType)}`;
}
export const describeProgram = (program, unitType) => (program?.rules ?? []).map(r => describeRule(r, unitType));
