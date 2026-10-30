// js/core/ai.js — l'IA gobeline : doctrines (composition + déploiement + programmes), anticipation par
// simulation, rapport d'éclaireurs et politique de corbeaux. Module pur (aucun DOM).
//
// planEnemyArmy() génère plusieurs candidats (doctrine × déploiement), les simule avec sim.runBattle contre
// une estimation de l'armée du joueur (composition du roster, programmes PAR DÉFAUT — GDD §9 —, déploiement
// plausible, plus une hypothèse prudente où le joueur tient sa ligne) et garde le meilleur. Le travail est fixe
// (tous les candidats sont simulés) : à graine et roster égaux, le plan est identique sur toutes les machines.
// Si la simulation est désactivée ou échoue, l'IA choisit une doctrine sans simulation.
import { UNITS, DEFAULT_PROGRAMS, START_RAVENS, START_ROSTER, DEPLOY_COLS, MAX_TICKS, RAVEN_SPEED_HEX, ruleHelpers } from './data.js';
import { validateProgram, cloneProgram } from './program.js';
import { createRng, rngNext, rngPick, deriveSeed } from './rng.js';
import { distance } from './hex.js';
import { deployHexes, getTile, centerHex } from './maputil.js';
import * as simulator from './sim.js';

const { C, A, R } = ruleHelpers;
const P = (...rules) => ({ rules });

// ------------------------------------------------------------------ Simulateur (désactivable)
// sim.js ne dépend pas de ai.js : cet import statique ne crée pas de cycle.
let SIM = typeof simulator.createBattle === 'function' && typeof simulator.runBattle === 'function' ? simulator : null;

/**
 * Remplace le module de simulation utilisé par planEnemyArmy (tests, ou null pour désactiver l'anticipation).
 * @param {object|null} mod Module exposant createBattle, runBattle et battleValue.
 */
export function setSimulator(mod) { SIM = mod && typeof mod.runBattle === 'function' ? mod : null; }
/** @returns {boolean} vrai si l'anticipation par simulation est disponible. */
export const hasSimulator = () => !!SIM;

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
/**
 * Garde-fou d'urgence (ms de calcul cumulé) : jamais atteint en temps normal (≈ 0,1 à 0,5 s sur un ordinateur,
 * quelques fois plus sur un téléphone). S'il saute, les candidats restants ne sont pas simulés et l'IA le signale
 * dans la console : seul ce cas pathologique rend le plan dépendant de la machine.
 */
export const PLAN_EMERGENCY_MS = 8000;

// ------------------------------------------------------------------ Analyse de carte
/**
 * Résumé tactique d'une carte, du point de vue gobelin (camp est, colonnes 11–13).
 * @param {object} map
 * @returns {{ fords: {q,r,col,row}[], centerOk: boolean, eastCover: number, eastHills: number, eastForest: number,
 *            eastRuins: number, westCover: number }}
 */
export function analyzeMap(map) {
  const fords = (map.tiles ?? []).filter(t => t.terrain === 'ford').sort((a, b) => a.row - b.row)
    .map(t => ({ q: t.q, r: t.r, col: t.col, row: t.row }));
  const east = map.tiles.filter(t => t.col >= 9);
  const west = map.tiles.filter(t => t.col <= 4);
  const c = centerHex(map);
  const ct = getTile(map, c.q, c.r);
  return {
    fords,
    centerOk: !!ct && ['plain', 'forest', 'hill', 'ruins'].includes(ct.terrain),
    eastHills: east.filter(t => t.terrain === 'hill').length,
    eastForest: east.filter(t => t.terrain === 'forest').length,
    eastRuins: east.filter(t => t.terrain === 'ruins').length,
    eastCover: east.filter(t => t.terrain === 'forest' || t.terrain === 'hill').length,
    westCover: west.filter(t => t.terrain === 'forest' || t.terrain === 'hill').length,
  };
}

// ------------------------------------------------------------------ Composition
// Rôles : chief, line, guard, archer, shaman, hunter (loups), troll.
function baseComposition(tier, bi) {
  if (tier === 'boss') return { g_warchief: 1, g_troll: 1, g_shaman: 1, g_spears: 4 + (bi >= 3 ? 1 : 0), g_wolves: 2, g_archers: 2 + (bi >= 4 ? 1 : 0) };
  if (tier === 'elite') return { g_warchief: 1, g_shaman: 1, g_spears: 4 + (bi >= 2 ? 1 : 0), g_wolves: 2, g_archers: 2 };
  return { g_warchief: 1, g_spears: bi >= 1 ? 4 : 3, g_wolves: 1, g_archers: 2 };
}
const ORDER = ['g_warchief', 'g_troll', 'g_spears', 'g_archers', 'g_shaman', 'g_wolves'];

// ------------------------------------------------------------------ Doctrines
// Chaque doctrine : mods(comp, tier) ajuste la composition ; roles(type, k, n, comp) répartit les rôles ;
// program(role, type, ctx) renvoie un programme valide (slots et classes respectés, runes avancées).
// signature : type(s) emblématique(s) et leur plancher — la mise à l'échelle de la troupe les retire en dernier,
// pour que la doctrine reste lisible (et que le rapport d'éclaireurs dise vrai) même face à une petite armée.
const rich = (ctx) => ctx.tier !== 'battle' || ctx.battleIndex >= 2;
const hasTroll = (ctx) => ctx.comp.g_troll > 0;

const DOCTRINE_DEFS = {
  horde: {
    name: 'La Horde',
    desc: 'Une marée de lances déferle d’un seul bloc, le chef de guerre hurlant au milieu des siens.',
    deploys: ['ligne', 'gue'],
    signature: { g_spears: 3 },
    suit: () => 1,
    mods(c) { c.g_spears += 1; },
    program(role, type, ctx) {
      switch (type) {
        case 'g_warchief': return P(R([C('ENEMY_WITHIN', { n: 2 })], A('RETREAT')), R([], A('FOLLOW', { ally: 'ALLY_NEAREST' })));
        case 'g_spears': return P(R([], A('ATTACK', { target: 'ISOLATED' })), R([], A('ATTACK', { target: 'NEAREST' })));
        case 'g_wolves': return P(R([C('ISOLATED_ENEMY_WITHIN', { n: 5 })], A('CHARGE', { target: 'ISOLATED' })), R([], A('ATTACK', { target: 'RANGED' })));
        case 'g_archers': return P(R([C('ENEMY_CLASS_WITHIN', { cls: 'cavalry', n: 2 })], A('RETREAT')), R([], A('ATTACK', { target: 'NEAREST' })));
        case 'g_shaman': return P(R([], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })),
          R([C('ENEMY_WITHIN', { n: 3 })], A('CAST_ENEMY', { spell: 'HEX', target: 'STRONGEST' })), R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' })));
        case 'g_troll': return P(R([], A('ATTACK', { target: 'STRONGEST' })));
      }
      return null;
    },
  },
  meute: {
    name: 'La Meute',
    desc: 'Les loups rôdent sur les flancs et fondent sur les isolés, pendant que les lances tiennent la rive.',
    deploys: ['flanc', 'ligne'],
    signature: { g_wolves: 2 },
    suit: (an) => 1 + (an.fords.length >= 3 ? 0.3 : 0),
    mods(c, tier) { c.g_wolves += 1; if (tier === 'battle' && c.g_spears > 3) c.g_spears -= 1; },
    program(role, type, ctx) {
      switch (type) {
        case 'g_warchief': return P(R([C('OUTNUMBERED', { n: 3 })], A('RETREAT')), R([], A('HOLD')));
        case 'g_spears': return P(R([C('ENEMY_WITHIN', { n: rich(ctx) ? 4 : 3 })], A('ATTACK', { target: 'NEAREST' })));
        case 'g_wolves': return P(R([C('ISOLATED_ENEMY_WITHIN', { n: 6 })], A('CHARGE', { target: 'ISOLATED' })), R([], A('CHARGE', { target: 'RANGED' })));
        case 'g_archers': return P(R([C('ENEMY_CLASS_WITHIN', { cls: 'cavalry', n: 3 })], A('RETREAT')), R([], A('KITE', { n: 3 })));
        case 'g_shaman': return P(R([C('ALLY_HP_BELOW', { pct: 50, n: 3 })], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })),
          R([], A('CAST_ENEMY', { spell: 'HEX', target: 'CAVALRY' })), R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' })));
        // CHARGE ne rend plus le troll plus rapide (élan +1 seulement s'il a bougé, −1 déf) : il attaque.
        case 'g_troll': return P(R([], A('ATTACK', { target: 'NEAREST' })));
      }
      return null;
    },
  },
  marteau: {
    name: 'Marteau et enclume',
    desc: 'Les lances fixent l’ennemi sur la rive ; les loups attendent leur heure, puis frappent au flanc.',
    deploys: ['gue', 'flanc'],
    signature: { g_spears: 2, g_wolves: 1 },
    suit: (an) => 1 + (an.fords.length === 2 ? 0.3 : 0),
    mods() {},
    program(role, type, ctx) {
      switch (type) {
        case 'g_warchief': return hasTroll(ctx) && rich(ctx)
          ? P(R([C('HP_BELOW', { pct: 50 })], A('RETREAT')), R([], A('FOLLOW', { ally: 'ALLY_COLOSSUS' })))
          : P(R([C('ENEMY_WITHIN', { n: 2 })], A('RETREAT')), R([], A('HOLD')));
        case 'g_spears': return hasTroll(ctx) && role === 'guard'
          ? P(R([], A('FOLLOW', { ally: 'ALLY_COLOSSUS' })), R([], A('ATTACK', { target: 'NEAREST' })))
          : P(R([C('ENEMY_WITHIN', { n: 4 })], A('ATTACK', { target: 'WEAKEST' })));
        case 'g_wolves': return P(R([C('TICK_AT_LEAST', { t: rich(ctx) ? 8 : 10 })], A('CHARGE', { target: rich(ctx) ? 'COMMANDER' : 'RANGED' })), R([], A('HOLD')));
        case 'g_archers': return P(R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('ATTACK', { target: 'WEAKEST' })));
        // Soin dès qu'un allié est blessé (non applicable sinon), maléfice au contact, et il suit l'armée.
        case 'g_shaman': return P(R([], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })),
          R([C('ENEMY_WITHIN', { n: 3 })], A('CAST_ENEMY', { spell: 'HEX', target: 'NEAREST' })),
          R([], A('FOLLOW', { ally: hasTroll(ctx) ? 'ALLY_COLOSSUS' : 'ALLY_NEAREST' })));
        case 'g_troll': return P(R([], A('ATTACK', { target: 'NEAREST' })));
      }
      return null;
    },
    roles(type, k, n, comp) { return type === 'g_spears' && comp.g_troll > 0 && k < 2 ? 'guard' : null; },
  },
  embuscade: {
    name: 'Embuscade',
    desc: 'Tapis dans les bois et sur les hauteurs, les gobelins laissent l’ennemi s’avancer, puis fondent sur lui.',
    deploys: ['ligne', 'gue'],
    signature: { g_archers: 2 },
    suit: (an) => Math.min(1.4, 0.3 + 0.12 * an.eastCover),
    mods(c, tier) { if (tier !== 'battle') c.g_archers += 1; },
    program(role, type, ctx) {
      const an = ctx.an;
      switch (type) {
        case 'g_warchief': return P(R([C('ENEMY_WITHIN', { n: 3 })], A('RETREAT')), R([], A('HOLD')));
        case 'g_spears': return an.eastForest >= 2
          ? P(R([], A('ADVANCE', { place: 'FOREST' })), R([], A('HOLD')))
          : P(R([C('ENEMY_WITHIN', { n: 4 })], A('ATTACK', { target: 'NEAREST' })));
        case 'g_wolves': return P(R([C('ISOLATED_ENEMY_WITHIN', { n: 4 })], A('CHARGE', { target: 'ISOLATED' })), R([], A('HOLD')));
        case 'g_archers': {
          const terrain = an.eastHills > 0 ? 'hill' : an.eastForest > 0 ? 'forest' : null;
          return terrain
            ? P(R([C('ON_TERRAIN', { terrain }, true)], A('ADVANCE', { place: terrain === 'hill' ? 'HILL' : 'FOREST' })))
            : P(R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('HOLD')));
        }
        case 'g_shaman': return P(R([], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })),
          R([C('ENEMY_WITHIN', { n: 3 })], A('CAST_ENEMY', { spell: 'HEX', target: 'NEAREST' })), R([], A('FOLLOW', { ally: 'ALLY_NEAREST' })));
        case 'g_troll': return P(R([], A('ATTACK', { target: 'ISOLATED' })));
      }
      return null;
    },
  },
  garde: {
    name: 'Garde du chef',
    desc: 'Le chef de guerre se retranche au cœur d’un carré de lances ; quiconque l’approche est taillé en pièces.',
    deploys: ['ligne', 'gue'],
    signature: { g_spears: 3 },
    suit: (an, tier) => 1 + (tier === 'boss' ? 0.4 : 0),
    mods(c) { c.g_spears += 1; },
    program(role, type, ctx) {
      switch (type) {
        case 'g_warchief': return P(R([C('OUTNUMBERED', { n: 2 })], A('RETREAT')), R([], A('HOLD')));
        case 'g_spears': return role === 'guard'
          ? P(R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' })), R([], A('ATTACK', { target: 'NEAREST' })))
          : P(R([C('COMMANDER_THREATENED', { n: 6 })], A('ATTACK', { target: 'THREAT' })));
        case 'g_wolves': return P(R([C('COMMANDER_THREATENED', { n: 3 })], A('CHARGE', { target: 'THREAT' })), R([], A('ATTACK', { target: 'ISOLATED' })));
        case 'g_archers': return P(R([C('COMMANDER_THREATENED', { n: 4 })], A('ATTACK', { target: 'THREAT' })), R([], A('KITE', { n: 3 })));
        case 'g_shaman': return P(R([C('ALLY_HP_BELOW', { pct: 75, n: 3 }), C('HP_BELOW', { pct: 75 })], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' }), 'OR'));
        case 'g_troll': return P(R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' })));
      }
      return null;
    },
    roles(type, k, n) { return type === 'g_spears' && k < Math.max(2, n - 2) ? 'guard' : null; },
  },
  harcelement: {
    name: 'Les Harceleurs',
    desc: 'Flèches et crocs : on mord, on recule, on mord encore, jusqu’à ce que l’ennemi saigne.',
    deploys: ['ligne', 'flanc'],
    signature: { g_archers: 2 },
    suit: (an) => 0.9 + (an.eastHills > 0 ? 0.3 : 0),
    mods(c) { c.g_archers += 1; if (c.g_spears > 3) c.g_spears -= 1; },
    program(role, type, ctx) {
      switch (type) {
        case 'g_warchief': return P(R([C('ENEMY_WITHIN', { n: 3 })], A('RETREAT')), R([], A('HOLD')));
        case 'g_spears': return P(R([C('ALLY_HIT', { n: 2 })], A('ATTACK', { target: 'NEAREST' })));
        case 'g_wolves': return P(R([C('HP_BELOW', { pct: 50 })], A('RETREAT')), R([], A('CHARGE', { target: 'WEAKEST' })));
        case 'g_archers': return P(R([C('OUTNUMBERED', { n: 2 })], A('RETREAT')), R([], A('KITE', { n: 3 })));
        case 'g_shaman': return P(R([C('ENEMY_WITHIN', { n: 3 })], A('CAST_ENEMY', { spell: 'HEX', target: 'STRONGEST' })),
          R([], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })), R([], A('KITE', { n: 2 })));   // portée 2 : KITE 2
        case 'g_troll': return P(R([], A('ATTACK', { target: 'WEAKEST' })));
      }
      return null;
    },
  },
};

// Rôle par défaut selon le type (si la doctrine n'en impose pas).
const DEFAULT_ROLE = { g_warchief: 'chief', g_troll: 'troll', g_spears: 'line', g_archers: 'archer', g_shaman: 'shaman', g_wolves: 'hunter' };

/**
 * Doctrines de la faction gobeline. build(ctx) construit une armée complète.
 * ctx = { node: {kind, battleIndex}, map, seed, deploy?: 'ligne'|'gue'|'flanc', fordIndex?: number }
 * build renvoie { units: ArmyUnit[], ravens: number, deploy: string }.
 */
export const DOCTRINES = Object.fromEntries(Object.entries(DOCTRINE_DEFS).map(([id, d]) => [id, {
  id, name: d.name, desc: d.desc, faction: 'gobelins', deploys: d.deploys.slice(),
  build: (ctx) => buildArmy(id, ctx),
}]));

/**
 * Réglage de difficulté (modifiable pour l'équilibrage) : la troupe gobeline (lanciers, archers, loups — pas le
 * chef ni le troll) est proportionnée à la force ACTUELLE de l'armée du joueur. Sans cela, une campagne à mort
 * permanente s'effondre : chaque perte rend la bataille suivante plus déséquilibrée.
 *   ratio    = valeur du roster du joueur / valeur du roster de départ (coût des unités seulement : forger ou
 *              méditer n'enrichit jamais la horde) ;
 *   strength = tierMult × ratio (ratio^curve en dessous de 1 : une armée entamée est davantage ménagée),
 *              bornée à [min, max] et arrondie au centième.
 * Une armée très entamée (ratio < shamanBelow) affronte une élite ou un boss sans chaman.
 * passiveWeight : poids de l'hypothèse « le joueur tient sa ligne » dans le score des candidats.
 * ravens : déclencheurs optionnels de la politique de corbeaux (voir makeEnemyRavenPolicy).
 * Valeurs réglées sur des campagnes simulées (programmes par défaut, sans corbeaux du joueur).
 */
export const AI_TUNING = {
  tierMult: { battle0: 0.5, battle: 0.55, elite: 0.5, boss: 0.45 },
  curve: 1.5,
  min: 0.25, max: 1.5,
  shamanBelow: 0.8,
  passiveWeight: 1,
  ravens: { guard: true, regicide: true, archers: true, troll: true, finish: true, allIn: true },
  emergencyMs: PLAN_EMERGENCY_MS,
};
const START_VALUE = START_ROSTER.reduce((s, t) => s + (UNITS[t]?.cost ?? 0), 0);

/**
 * Valeur de l'armée du joueur rapportée à l'armée de départ (1 = intacte). Roster vide : armée de départ.
 * @param {object[]} playerRoster RosterUnit[]
 * @returns {number}
 */
export function playerRatio(playerRoster) {
  const roster = Array.isArray(playerRoster) && playerRoster.length ? playerRoster : START_ROSTER.map(type => ({ type }));
  let v = 0;
  for (const u of roster) v += UNITS[u?.type]?.faction === 'royaume' ? UNITS[u.type].cost : 0;
  return Math.round((v / (START_VALUE || 1)) * 1000) / 1000;
}

/**
 * Force relative de l'armée du joueur pour ce nœud (1 = armée de départ intacte, au niveau de difficulté nominal).
 * @param {object[]} playerRoster RosterUnit[]
 * @param {'battle'|'elite'|'boss'} tier
 * @param {number} bi index de la bataille dans la campagne
 */
export function playerStrength(playerRoster, tier, bi) {
  const key = tier === 'battle' ? (bi >= 1 ? 'battle' : 'battle0') : tier;
  const mult = AI_TUNING.tierMult[key] ?? 1;
  const r = playerRatio(playerRoster);
  const s = Math.max(AI_TUNING.min, Math.min(AI_TUNING.max, mult * (r < 1 ? r ** (AI_TUNING.curve ?? 1) : r)));
  return Math.round(s * 100) / 100;
}

function compositionFor(doctrineId, tier, bi, strength = 1, ratio = 1) {
  const c = baseComposition(tier, bi);
  for (const t of ORDER) c[t] = c[t] ?? 0;
  const def = DOCTRINE_DEFS[doctrineId];
  def.mods(c, tier, bi);
  scaleComposition(c, strength, def.signature ?? {});
  if (c.g_shaman > 0 && Number.isFinite(ratio) && ratio < AI_TUNING.shamanBelow) c.g_shaman = 0;
  return c;
}

/**
 * Ajuste la troupe (lanciers, archers, loups) à `strength` × sa valeur, au plus près (à une demi-unité).
 * On retire d'abord hors signature (le groupe le plus nombreux d'abord), puis dans la signature sans descendre
 * sous son plancher (borné par le budget). Toujours au moins un lancier, et au moins un archer ou un loup.
 * Au-dessus de 1, on ajoute des unités du type emblématique (des lanciers par défaut).
 */
function scaleComposition(c, strength, sig = {}) {
  if (!Number.isFinite(strength) || Math.abs(strength - 1) < 0.01) return;
  const TROOP = ['g_spears', 'g_archers', 'g_wolves'];
  const cost = (t) => UNITS[t].cost;
  const val = () => TROOP.reduce((s, t) => s + (c[t] ?? 0) * cost(t), 0);
  const target = val() * strength;
  if (strength < 1) {
    const floor = (t) => {
      let f = t === 'g_spears' ? 1 : 0;
      if (sig[t]) f = Math.max(f, Math.min(sig[t], Math.floor((target + cost(t) / 2) / cost(t))));
      if (t !== 'g_spears' && c.g_archers + c.g_wolves <= 1) f = Math.max(f, c[t]);
      return f;
    };
    const fits = (t) => val() - cost(t) >= target - cost(t) / 2;
    const byCount = (a, b) => (c[b] - c[a]) || (TROOP.indexOf(a) - TROOP.indexOf(b));
    for (let guard = 40; guard-- > 0 && val() > target;) {
      const open = TROOP.filter(t => c[t] > floor(t));
      const t = open.filter(x => !sig[x]).sort(byCount).find(fits) ?? open.filter(x => sig[x]).sort(byCount).find(fits);
      if (!t) break;
      c[t] -= 1;
    }
  } else {
    const add = TROOP.find(t => sig[t]) ?? 'g_spears';
    for (let guard = 12; guard-- > 0 && val() + cost(add) / 2 <= target;) c[add] += 1;
  }
}

function safeProgram(prog, type) {
  if (prog && validateProgram(prog, type, { unlocked: null }).ok) return cloneProgram(prog);
  return cloneProgram(DEFAULT_PROGRAMS[type] ?? { rules: [] });
}

function buildArmy(doctrineId, { node = {}, map, seed = 0, deploy, fordIndex = 0, strength = 1, ratio = 1, reinforcements = 0 } = {}) {
  const def = DOCTRINE_DEFS[doctrineId];
  const tier = ['battle', 'elite', 'boss'].includes(node.kind) ? node.kind : 'battle';
  const battleIndex = Number.isFinite(node.battleIndex) ? node.battleIndex : 0;
  const an = analyzeMap(map);
  const comp = compositionFor(doctrineId, tier, battleIndex, strength, ratio);
  comp.g_spears += Math.max(0, Math.min(3, Math.trunc(Number(reinforcements) || 0)));   // renforts (événement de campagne)
  const ctx = { tier, battleIndex, an, comp, map };
  const list = [];
  for (const type of ORDER) {
    const n = comp[type] ?? 0;
    for (let k = 0; k < n; k++) {
      const role = (def.roles && def.roles(type, k, n, comp)) || DEFAULT_ROLE[type];
      list.push({ type, role, program: safeProgram(def.program(role, type, ctx), type) });
    }
  }
  const scheme = deploy && ['ligne', 'gue', 'flanc'].includes(deploy) ? deploy : def.deploys[0];
  const rng = createRng(deriveSeed('deploy', seed, doctrineId, scheme, fordIndex));
  placeArmy(list, map, 'enemy', deployFrame(an, scheme, fordIndex, map), rng);
  const units = list.filter(u => u.q !== undefined).map(u => ({ type: u.type, q: u.q, r: u.r, program: u.program, role: u.role }));
  // Le Chef de guerre du boss garde un corbeau de plus (annoncé par le rapport d'éclaireurs).
  return { units, ravens: START_RAVENS.enemy + (tier === 'boss' ? 1 : 0), deploy: scheme, tier, battleIndex };
}

// ------------------------------------------------------------------ Déploiement
// depth : 0 = colonne de front, 2 = colonne arrière (miroir pour le joueur).
const DEPTH_PREF = {
  chief: [0, 2.6, 2.2], troll: [3, 1, 0], line: [3, 1.5, 0], guard: [1.2, 2.2, 1], ambush: [3, 1.5, 0],
  archer: [0.8, 3, 1.6], shaman: [0, 2, 2], hunter: [2.2, 2, 0.4],
};
const TERRAIN_PREF = {
  chief: { ruins: 3, hill: 1.5, forest: 1 }, archer: { hill: 4, forest: 1, ruins: 1.2 }, line: { forest: 0.8, ruins: 1, hill: 0.6 },
  guard: { forest: 0.5, ruins: 0.8 }, troll: { plain: 0.5 }, shaman: { forest: 1, ruins: 1 }, hunter: { plain: 0.6, forest: -1.5 },
  ambush: { forest: 3, hill: 2, ruins: 1.5 },
};
const PLACE_ORDER = ['chief', 'troll', 'guard', 'line', 'ambush', 'archer', 'shaman', 'hunter'];

function deployFrame(an, scheme, fordIndex, map) {
  const mid = Math.floor(map.h / 2);
  const ford = an.fords.length ? an.fords[((fordIndex % an.fords.length) + an.fords.length) % an.fords.length] : null;
  const focus = scheme === 'ligne' || !ford ? mid : ford.row;
  const far = focus <= mid ? map.h - 2 : 1;
  return { scheme, focus, flankRows: scheme === 'flanc' ? [far, far] : scheme === 'gue' ? [Math.max(1, Math.min(map.h - 2, focus + (focus <= mid ? 3 : -3))), far] : [1, map.h - 2] };
}

function placeArmy(list, map, side, frame, rng) {
  const cols = DEPLOY_COLS[side];
  const front = side === 'enemy' ? Math.min(...cols) : Math.max(...cols);
  const free = deployHexes(map, side).map(h => ({ ...h, tile: getTile(map, h.q, h.r) }));
  const used = new Set();
  const chiefPos = { hex: null };
  const k = { ligne: 0.35, gue: 0.9, flanc: 0.7 }[frame.scheme] ?? 0.5;
  let hunterN = 0;
  const sorted = list.map((u, i) => ({ u, i })).sort((a, b) => (PLACE_ORDER.indexOf(a.u.role) - PLACE_ORDER.indexOf(b.u.role)) || (a.i - b.i));
  for (const { u } of sorted) {
    const role = DEPTH_PREF[u.role] ? u.role : 'line';
    const flankRow = frame.flankRows[hunterN % frame.flankRows.length];
    let best = null, bestS = -Infinity;
    for (const h of free) {
      const key = `${h.q},${h.r}`;
      if (used.has(key)) continue;
      const depth = Math.abs(h.tile.col - front);
      let s = DEPTH_PREF[role][depth] ?? 0;
      s += TERRAIN_PREF[role]?.[h.tile.terrain] ?? 0;
      const row = h.tile.row;
      if (role === 'hunter') s -= 1.1 * Math.abs(row - flankRow);
      else if (role === 'chief') s -= 0.9 * Math.abs(row - frame.focus);
      else if (role === 'guard' || role === 'shaman') {
        const d = chiefPos.hex ? distance(h, chiefPos.hex) : 2;
        s += role === 'guard' ? (d === 1 ? 3 : -1.5 * d) : (d === 1 ? 2.5 : d === 2 ? 1.5 : -d);
      } else s -= (role === 'archer' ? Math.max(0.4, k) : k) * Math.abs(row - frame.focus);
      s += rngNext(rng) * 0.15;
      if (s > bestS) { bestS = s; best = h; }
    }
    if (!best) continue;
    used.add(`${best.q},${best.r}`);
    u.q = best.q; u.r = best.r;
    if (role === 'chief') chiefPos.hex = { q: best.q, r: best.r };
    if (role === 'hunter') hunterN++;
  }
  return list;
}

// ------------------------------------------------------------------ Armée du joueur estimée
const PLAYER_ROLE = { commander: 'chief', infantry: 'line', colossus: 'troll', cavalry: 'hunter', ranged: 'archer', caster: 'archer' };

// Posture « prudente » : le joueur tient sa ligne et ne frappe que ce qui s'approche (runes de départ, slots
// respectés). Elle évite que l'IA se brise sur une ligne immobile qu'elle n'aurait pas envisagée.
const PASSIVE_PROGRAMS = {
  k_pikemen: P(R([C('ENEMY_WITHIN', { n: 3 })], A('ATTACK', { target: 'NEAREST' })), R([], A('HOLD'))),
  k_knights: P(R([C('ENEMY_WITHIN', { n: 3 })], A('ATTACK', { target: 'NEAREST' })), R([], A('HOLD'))),
  k_archers: P(R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('HOLD'))),
  k_mage: P(R([C('ENEMY_WITHIN', { n: 3 })], A('CAST_ENEMY', { spell: 'FIREBALL', target: 'NEAREST' })), R([], A('HOLD'))),
  k_golem: P(R([C('ENEMY_WITHIN', { n: 2 })], A('ATTACK', { target: 'NEAREST' }))),
};
/** Programmes de la posture prudente (exposés pour les tests). */
export const PLAYER_PASSIVE_PROGRAMS = PASSIVE_PROGRAMS;

/**
 * Estime l'armée du joueur pour la simulation : composition du roster (types et bonus), programmes PAR DÉFAUT
 * (GDD §9 : l'IA ne lit pas les programmes du joueur) ou, en posture 'passive', une ligne qui tient ;
 * déploiement plausible (ligne de mêlée devant, tireurs derrière, cavalerie sur un flanc).
 * @param {object} map
 * @param {object[]} roster RosterUnit[] (ou vide : roster de départ)
 * @param {{ scheme?: string, fordIndex?: number, seed?: any, posture?: 'default'|'passive' }} [opts]
 * @returns {{ faction: 'royaume', units: object[] }}
 */
export function estimatePlayerArmy(map, roster, { scheme = 'ligne', fordIndex = 0, seed = 0, posture = 'default' } = {}) {
  const src = Array.isArray(roster) && roster.length ? roster : START_ROSTER.map((type, i) => ({ uid: `est${i}`, type }));
  const list = [];
  for (const ru of src) {
    const unit = UNITS[ru?.type];
    if (!unit || unit.faction !== 'royaume') continue;
    const bonus = { atk: ru.bonus?.atk ?? 0, slots: ru.bonus?.slots ?? 0 };
    const program = (posture === 'passive' && PASSIVE_PROGRAMS[ru.type]) || DEFAULT_PROGRAMS[ru.type] || { rules: [] };
    list.push({ uid: ru.uid ?? null, type: ru.type, role: PLAYER_ROLE[unit.cls] ?? 'line', bonus, program: cloneProgram(program) });
  }
  const an = analyzeMap(map);
  const frame = deployFrame(an, scheme, fordIndex, map);
  frame.flankRows = [frame.focus <= 4 ? 2 : 6];
  placeArmy(list, map, 'player', frame, createRng(deriveSeed('player-est', seed, scheme, fordIndex)));
  return { faction: 'royaume', units: list.filter(u => u.q !== undefined).map(u => ({ uid: u.uid, type: u.type, q: u.q, r: u.r, program: u.program, bonus: u.bonus })) };
}

// ------------------------------------------------------------------ Anticipation
function pickDoctrines(rng, an, tier, count) {
  const pool = Object.keys(DOCTRINE_DEFS).map(id => ({ id, w: DOCTRINE_DEFS[id].suit(an, tier) }));
  const out = [];
  while (out.length < count && pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let x = rngNext(rng) * total, j = 0;
    for (; j < pool.length - 1; j++) { x -= pool[j].w; if (x < 0) break; }
    out.push(pool[j].id);
    pool.splice(j, 1);
  }
  return out;
}

function simulate(map, player, enemyPlan, seed) {
  const enemy = { faction: 'gobelins', units: enemyPlan.units.map(u => ({ type: u.type, q: u.q, r: u.r, program: cloneProgram(u.program) })) };
  const battle = SIM.createBattle({ map, player, enemy, seed, ravens: { player: 0, enemy: enemyPlan.ravens }, maxTicks: MAX_TICKS });
  const res = SIM.runBattle(battle, { maxTicks: MAX_TICKS, policies: { enemy: makeEnemyRavenPolicy(enemyPlan, { lookahead: false }) } }) ?? battle.result;
  const result = res && res.winner ? res : battle.result;
  const value = (side) => (typeof SIM.battleValue === 'function' ? SIM.battleValue(battle, side) : armyValue(battle, side));
  const ve = value('enemy'), vp = value('player');
  let score = ve - vp;
  if (result?.winner === 'enemy') score += result.reason === 'time' ? 800 : 1000;
  else if (result?.winner === 'player') score -= 1000 - Math.min(result.tick ?? 0, MAX_TICKS) * 3;
  return { score, winner: result?.winner ?? null, reason: result?.reason ?? null, tick: result?.tick ?? null, ve: Math.round(ve), vp: Math.round(vp) };
}

function armyValue(battle, side) {
  let v = 0;
  for (const u of battle.units ?? []) if (u.alive && u.side === side) v += (UNITS[u.type]?.cost ?? 0) * Math.max(0, u.hp) / (u.maxHp || 1);
  return v;
}

/**
 * Planifie l'armée gobeline d'une bataille : composition, déploiement et programmes.
 * Tire 3 (bataille) ou 4 (élite, boss) doctrines pondérées par l'adéquation à la carte, chacune avec 2 déploiements
 * (6 à 8 candidats). Chaque candidat est simulé (sim.runBattle, avec la politique de corbeaux) contre 3 ou 4
 * hypothèses sur l'armée du joueur (composition réelle, programmes par défaut ; en ligne, ou massée sur le premier
 * / le dernier gué ; plus une ligne prudente qui tient) ; on garde le meilleur score moyen (issue + valeur restante).
 * Sans simulateur : tirage pondéré. Déterministe : tous les candidats sont toujours simulés (seuls meta.ms et, en
 * cas extrême, le garde-fou PLAN_EMERGENCY_MS dépendent de la machine). Environ 50 à 300 ms dans Node.
 * @param {object} args
 * @param {{kind:'battle'|'elite'|'boss', battleIndex?:number}} args.node
 * @param {object} args.map Carte (generateMap).
 * @param {number|string} args.seed
 * @param {object[]} [args.playerRoster] RosterUnit[] du joueur (seuls types et bonus comptent).
 * @param {number} [args.reinforcements] lanciers ajoutés après la mise à l'échelle (0 à 3, événements de campagne).
 * @returns {{ faction:'gobelins', doctrine:{id,name,desc}, units:object[], ravens:number, seed:any, deploy:string,
 *   meta:{ simulated:boolean, candidates:object[], ms:number, strength:number, truncated?:boolean } }}
 */
export function planEnemyArmy(args = {}) {
  const it = planEnemyArmySteps(args);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/**
 * Même calcul que planEnemyArmy, découpé en étapes : le générateur rend la main (yield) après chaque candidat
 * simulé, puis renvoie le plan (valeur de retour du générateur). Permet à l'interface de laisser respirer le
 * navigateur pendant la planification (voir campaign.prepareBattleAsync) sans changer le résultat.
 * @param {object} args comme planEnemyArmy
 * @returns {Generator<{ done: number, total: number }, object>}
 */
export function* planEnemyArmySteps({ node = { kind: 'battle', battleIndex: 0 }, map, seed = 0, playerRoster = [], reinforcements = 0 } = {}) {
  let busy = 0, t = now();
  const tier = ['battle', 'elite', 'boss'].includes(node?.kind) ? node.kind : 'battle';
  const bi = Number.isFinite(node?.battleIndex) ? node.battleIndex : 0;
  const nodeN = { kind: tier, battleIndex: bi };
  const strength = playerStrength(playerRoster, tier, bi);
  const ratio = playerRatio(playerRoster);
  const an = analyzeMap(map);
  const rng = createRng(deriveSeed('ai-plan', seed, tier, bi));
  const nDoc = tier === 'battle' ? 3 : 4;
  const doctrines = pickDoctrines(rng, an, tier, nDoc);
  const fordCount = Math.max(1, an.fords.length);
  const candidates = [];
  doctrines.forEach((id, di) => {
    for (const scheme of DOCTRINE_DEFS[id].deploys) {
      const fordIndex = scheme === 'ligne' ? 0 : (di + candidates.length) % fordCount;
      candidates.push({ doctrineId: id, scheme, fordIndex });
    }
  });
  const make = (c) => {
    const army = buildArmy(c.doctrineId, { node: nodeN, map, seed, deploy: c.scheme, fordIndex: c.fordIndex, strength, ratio, reinforcements });
    const d = DOCTRINE_DEFS[c.doctrineId];
    return { faction: 'gobelins', doctrine: { id: c.doctrineId, name: d.name, desc: d.desc }, units: army.units, ravens: army.ravens, seed, deploy: army.deploy, tier, battleIndex: bi };
  };
  const plans = candidates.map(make);
  const evals = plans.map(() => null);
  let simulated = false, truncated = false;
  if (SIM) {
    try {
      // Hypothèses sur le joueur (programmes par défaut) : en ligne, massé sur le premier / le dernier gué ;
      // plus une ligne prudente qui tient sa position.
      const estimates = [
        estimatePlayerArmy(map, playerRoster, { scheme: 'ligne', seed }),
        estimatePlayerArmy(map, playerRoster, { scheme: 'gue', fordIndex: 0, seed }),
        ...(fordCount > 1 ? [estimatePlayerArmy(map, playerRoster, { scheme: 'gue', fordIndex: fordCount - 1, seed })] : []),
        estimatePlayerArmy(map, playerRoster, { scheme: 'ligne', seed, posture: 'passive' }),
      ];
      for (let i = 0; i < plans.length; i++) {
        if (busy + now() - t > (AI_TUNING.emergencyMs ?? PLAN_EMERGENCY_MS)) {     // garde-fou d'urgence : moteur anormalement lent
          truncated = true;
          if (typeof console !== 'undefined') console.warn(`[ai] planification interrompue après ${i} candidats sur ${plans.length} (moteur trop lent)`);
          break;
        }
        const runs = estimates.map((est, k) => simulate(map, est, plans[i], deriveSeed('ai-sim', seed, i, k)));
        const wOf = (k) => (k === runs.length - 1 ? AI_TUNING.passiveWeight ?? 1 : 1);
        const score = runs.reduce((s, r, k) => s + wOf(k) * r.score, 0) / runs.reduce((s, r, k) => s + wOf(k), 0);
        evals[i] = { score: Math.round(score), wins: runs.filter(r => r.winner === 'enemy').length, runs: runs.length,
          outcomes: runs.map(r => `${r.winner ?? '?'}:${r.reason ?? '?'}@${r.tick ?? '?'}`) };
        busy += now() - t;
        yield { done: i + 1, total: plans.length };
        t = now();
      }
      simulated = evals.some(Boolean);
    } catch (err) {
      simulated = false;
      for (let i = 0; i < evals.length; i++) evals[i] = null;
      if (typeof console !== 'undefined') console.warn('[ai] simulation indisponible :', err?.message ?? err);
    }
  }
  let bestIdx = 0;
  if (simulated) {
    let bestScore = -Infinity;
    evals.forEach((e, i) => { if (e && e.score > bestScore) { bestScore = e.score; bestIdx = i; } });
  } else {
    // Sans simulation : doctrine tirée au sort (pondérée par la carte), déploiement au hasard.
    bestIdx = Math.floor(rngNext(rng) * plans.length);
  }
  const plan = plans[bestIdx];
  busy += now() - t;
  plan.meta = {
    simulated, strength,
    ms: Math.round(busy),
    candidates: candidates.map((c, i) => ({ doctrine: c.doctrineId, deploy: c.scheme, fordIndex: c.fordIndex, ...(evals[i] ?? {}) })),
  };
  if (truncated) plan.meta.truncated = true;
  return plan;
}

/**
 * Construit directement l'armée d'une doctrine (sans anticipation). Utile pour les tests et le débogage.
 * @param {string} doctrineId Clé de DOCTRINES.
 * @param {{ node, map, seed, deploy?, fordIndex? }} ctx
 */
export function buildDoctrinePlan(doctrineId, ctx) {
  const d = DOCTRINE_DEFS[doctrineId];
  if (!d) throw new Error(`Doctrine inconnue : ${doctrineId}`);
  const army = buildArmy(doctrineId, ctx);
  return { faction: 'gobelins', doctrine: { id: doctrineId, name: d.name, desc: d.desc }, units: army.units, ravens: army.ravens, seed: ctx.seed ?? 0, deploy: army.deploy, tier: army.tier, battleIndex: army.battleIndex };
}

// ------------------------------------------------------------------ Rapport d'éclaireurs
const OPENINGS = {
  horde: ['Les éclaireurs reviennent pâles : une horde serrée, prête à déferler d’un seul bloc.',
    'On entend battre les tambours de guerre. La horde compte sur le nombre et ne reculera pas.'],
  meute: ['Des hurlements courent le long des flancs : leurs loups chassent en meute et guettent les isolés.',
    'Les traces de loups sont partout. Quiconque s’écarte du groupe sera dévoré.'],
  marteau: ['Leur infanterie se masse comme une enclume ; quelque part, un marteau attend son heure.',
    'Les lances gobelines tiennent la rive sans bouger. C’est trop calme pour être honnête.'],
  embuscade: ['Le camp ennemi paraît désert. Les bois et les hauteurs de leur rive pourraient cacher bien des lames.',
    'Nos éclaireurs n’ont vu que des ombres sous les arbres. Ils vous attendent : il faudra aller les chercher.'],
  garde: ['Le chef de guerre ne quitte pas sa garde : un carré de lances l’entoure à chaque pas.',
    'Leur chef s’est entouré de ses meilleurs guerriers. Pour l’atteindre, il faudra percer le mur.'],
  harcelement: ['Beaucoup d’arcs et peu de courage : ils mordront, reculeront, puis mordront encore.',
    'Des archers en nombre et des loups nerveux : ils chercheront à vous saigner à distance.'],
};
// Attitude seule, sans dénombrement : quand la troupe est trop maigre pour porter la signature de la doctrine.
const ATTITUDES = {
  horde: 'Les gobelins sont peu nombreux, mais ils comptent bien déferler d’un seul bloc.',
  meute: 'La bande est maigre, mais ses loups rôdent déjà le long des flancs.',
  marteau: 'Peu de gobelins en face, mais leur chef a un plan : ils fixeront, puis frapperont au flanc.',
  embuscade: 'La bande est maigre et ne se montre pas : ils vous attendent à couvert.',
  garde: 'Peu de gobelins en face, et tous serrés autour de leur chef.',
  harcelement: 'La bande est maigre : elle mordra de loin et reculera plutôt que de se battre.',
};

// Dénombrement volontairement approximatif au-delà de deux (les éclaireurs comptent de loin).
function fuzzy(n, one, many) {
  if (n <= 0) return null;
  if (n === 1) return one;
  const word = n === 2 ? 'deux' : n === 3 ? 'trois ou quatre' : n === 4 ? 'quatre ou cinq' : n <= 6 ? 'une demi-douzaine de' : 'une foule de';
  return `${word} ${many}`;
}

/**
 * Rapport d'éclaireurs : 2 à 4 phrases en français (indices sur la composition et l'attitude, jamais de position exacte).
 * @param {object} plan Résultat de planEnemyArmy.
 * @param {object} [map]
 * @returns {string[]}
 */
export function scoutReport(plan, map) {
  const units = plan?.units ?? [];
  const rng = createRng(deriveSeed('scout', plan?.seed ?? 0, plan?.doctrine?.id ?? '', map?.name ?? ''));
  const count = (t) => units.filter(u => u.type === t).length;
  const out = [];
  const id = plan?.doctrine?.id;
  const sig = DOCTRINE_DEFS[id]?.signature ?? {};
  const signed = Object.entries(sig).every(([t, n]) => count(t) >= n);
  out.push(OPENINGS[id] ? (signed ? rngPick(rng, OPENINGS[id]) : ATTITUDES[id]) : 'Nos éclaireurs ont repéré une bande de gobelins sur l’autre rive.');
  const parts = [
    fuzzy(count('g_spears'), 'un lancier', 'lanciers'),
    fuzzy(count('g_archers'), 'un archer', 'archers'),
    fuzzy(count('g_wolves'), 'un chevaucheur de loups', 'chevaucheurs de loups'),
  ].filter(Boolean);
  if (parts.length) {
    const last = parts.pop();
    const list = parts.length ? `${parts.join(', ')} et ${last}` : last;
    out.push(`On dénombre ${list} autour du chef de guerre.`);
  }
  const troll = count('g_troll') > 0, shaman = count('g_shaman') > 0;
  if (troll && shaman) out.push('Un troll gronde dans leurs rangs, et un chaman l’accompagne : attendez-vous à des soins et à des maléfices.');
  else if (troll) out.push('Un troll gronde dans leurs rangs : une seule rune tient dans sa tête, mais ses plaies se referment.');
  else if (shaman) out.push('Un chaman agite ses osselets près du chef : il soignera la horde et maudira vos meilleurs combattants.');
  if (out.length < 4 && count('g_archers') > 0) {
    out.push((plan?.ravens ?? 2) > 2
      ? `Leurs archers guettent le ciel, et le chef de guerre garde ${['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq'][plan.ravens] ?? plan.ravens} corbeaux sous la main.`
      : 'Leurs archers guettent le ciel : vos corbeaux devront passer loin d’eux.');
  }
  return out.slice(0, 4);
}

// ------------------------------------------------------------------ Corbeaux de l'IA
/** Délai minimal (en instants) entre deux corbeaux gobelins. */
export const ENEMY_RAVEN_MIN_GAP = 6;

const ORDERS = {
  guard: {
    g_spears: P(R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' })), R([], A('ATTACK', { target: 'THREAT' }))),
    g_wolves: P(R([C('COMMANDER_THREATENED', { n: 2 })], A('CHARGE', { target: 'THREAT' })), R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' }))),
    g_troll: P(R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' }))),
  },
  regicide: {
    g_wolves: P(R([C('HP_BELOW', { pct: 25 })], A('RETREAT')), R([], A('CHARGE', { target: 'COMMANDER' }))),
  },
  trollBack: { g_troll: P(R([], A('FOLLOW', { ally: 'ALLY_COMMANDER' }))) },
  trollNear: { g_troll: P(R([], A('FOLLOW', { ally: 'ALLY_NEAREST' }))) },
  archers: {
    g_archers: P(R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('KITE', { n: 3 }))),
    g_shaman: P(R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })), R([], A('KITE', { n: 2 }))),
  },
  allIn: {
    g_spears: P(R([], A('ATTACK', { target: 'COMMANDER' }))),
    g_wolves: P(R([], A('CHARGE', { target: 'COMMANDER' }))),
    g_troll: P(R([], A('ATTACK', { target: 'COMMANDER' }))),
  },
  press: {
    g_spears: P(R([], A('ATTACK', { target: 'WEAKEST' }))),
    g_wolves: P(R([C('HP_BELOW', { pct: 25 })], A('RETREAT')), R([], A('CHARGE', { target: 'WEAKEST' }))),
    g_troll: P(R([], A('ATTACK', { target: 'WEAKEST' }))),
  },
};
/** Programmes que les corbeaux gobelins peuvent porter (exposés pour les tests). */
export const ENEMY_RAVEN_ORDERS = ORDERS;

const sameProgram = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Politique de corbeaux de l'IA, appelée une fois par instant AVANT stepBattle. Bon marché (< 2 ms).
 * Déclencheurs, par priorité : chef menacé (un garde du corps vient l'escorter), commandant ennemi exposé
 * (un loup le charge, s'il l'atteindra avant d'être pris), archers au contact (repli et harcèlement), troll isolé
 * (il revient vers le chef), coup de grâce (l'ennemi n'a plus que son commandant et une unité au plus : on
 * l'achève au lieu d'attendre le temps limite), fin de bataille en retard au temps limite (tout pour tuer le
 * commandant). Au plus plan.ravens corbeaux, pas avant l'instant 3, et au moins ENEMY_RAVEN_MIN_GAP instants
 * entre deux corbeaux. Les déclencheurs optionnels se règlent dans AI_TUNING.ravens.
 * Prévoyance (par défaut, en vraie bataille) : le chef de guerre joue les LOOKAHEAD_TICKS instants suivants
 * sur des copies de la bataille, sans ordre et avec chacun des (au plus 3) ordres candidats — déclencheurs
 * ci-dessus, plus, un instant sur quatre, des occasions (le plus fort presse l'ennemi le plus faible ou fonce sur
 * son commandant) — et n'envoie que le meilleur, s'il y gagne ; sinon il attend 3 instants avant de réexaminer.
 * Sans sim.js (ou sur une bataille factice), le premier déclencheur part directement. Coût : de l'ordre de 5 à
 * 20 ms, seulement les instants où un candidat se présente.
 * @param {object} plan Résultat de planEnemyArmy (utilise plan.ravens).
 * @param {{ lookahead?: boolean }} [opts] lookahead : false dans les simulations de planification.
 * @returns {(battle: object) => (null | { unitId: string, program: object })}
 */
export function makeEnemyRavenPolicy(plan, { lookahead = true } = {}) {
  const maxRavens = Number.isFinite(plan?.ravens) ? plan.ravens : START_RAVENS.enemy;
  // Première bataille : pas de raid de loups sur le commandant (le joueur découvre le jeu).
  const bold = !(plan?.tier === 'battle' && !(plan?.battleIndex >= 1));
  let sent = 0, lastSent = -Infinity, lastSeenTick = -1, vetoUntil = -Infinity;
  return function enemyRavenPolicy(battle) {
    try {
      if (!battle || battle.result || !Array.isArray(battle.units)) return null;
      const tick = battle.tick ?? 0;
      if (tick < lastSeenTick) { sent = 0; lastSent = -Infinity; vetoUntil = -Infinity; }   // bataille rejouée depuis le début
      lastSeenTick = tick;
      if (sent >= maxRavens || (battle.ravensLeft && !(battle.ravensLeft.enemy > 0))) return null;
      const ravens = Array.isArray(battle.ravens) ? battle.ravens.filter(r => r.side === 'enemy') : [];
      let last = lastSent;
      for (const r of ravens) if (Number.isFinite(r.launchedAt) && r.launchedAt > last) last = r.launchedAt;
      if (tick < 3 || tick - last < ENEMY_RAVEN_MIN_GAP || tick < vetoUntil) return null;
      const smart = lookahead && canForesee(battle);
      const cands = orderCandidates(battle, ravens, bold, smart && bold && tick % 4 === 0);
      if (!cands.length) return null;
      const order = smart ? bestOrder(battle, cands.slice(0, 3)) : cands[0];
      if (!order) { vetoUntil = tick + 3; return null; }
      sent++; lastSent = tick;
      return order;
    } catch { return null; }
  };
}

/** Horizon (en instants) de la prévoyance des corbeaux gobelins. */
export const LOOKAHEAD_TICKS = 12;

// La prévoyance demande le vrai moteur et une vraie bataille (une bataille factice de test n'a ni carte ni graine).
const canForesee = (battle) => !!(SIM && typeof SIM.cloneBattle === 'function' && typeof SIM.stepBattle === 'function'
  && typeof SIM.sendRaven === 'function' && battle.map && battle.rng);

// Meilleur ordre parmi les candidats : celui qui améliore le plus la situation des gobelins dans LOOKAHEAD_TICKS
// instants (copies de la bataille, même graine : déterministe), s'il y gagne quelque chose ; sinon null.
// En cas d'erreur du moteur, le premier candidat part tel quel.
function bestOrder(battle, cands) {
  try {
    const outlook = (order) => {
      const b = SIM.cloneBattle(battle);
      if (order && !SIM.sendRaven(b, 'enemy', order.unitId, order.program)?.ok) return null;
      for (let i = 0; i < LOOKAHEAD_TICKS && !b.result; i++) SIM.stepBattle(b);
      let s = armyValue(b, 'enemy') - armyValue(b, 'player');
      if (b.result?.winner === 'enemy') s += 1000;
      else if (b.result?.winner === 'player') s -= 1000;
      return s;
    };
    let best = null, bestS = outlook(null) + 2;
    for (const o of cands) { const s = outlook(o); if (s !== null && s > bestS) { best = o; bestS = s; } }
    return best;
  } catch { return cands[0] ?? null; }
}

// Ordres candidats, par priorité (au plus un par déclencheur). opportunity : ajoute des ordres d'occasion
// (le plus fort presse l'ennemi le plus faible, ou fonce sur son commandant) que seule la prévoyance sait trier.
function orderCandidates(battle, ravens, bold, opportunity = false) {
  const out = [];
  const mine = [], foes = [];
  for (const u of battle.units) if (u.alive) (u.side === 'enemy' ? mine : foes).push(u);
  const chief = mine.find(u => u.cls === 'commander' || UNITS[u.type]?.cls === 'commander');
  if (!chief || !foes.length) return out;
  const inFlight = new Set(ravens.filter(r => r.alive !== false && !r.delivered).map(r => r.unitId));
  const ratio = (u) => u.hp / (u.maxHp || UNITS[u.type]?.hp || 1);
  const nearestFoe = (u) => { let d = Infinity; for (const f of foes) d = Math.min(d, distance(u, f)); return d; };
  const issue = (u, prog) => (prog && !inFlight.has(u.id) && !sameProgram(u.program, prog) && !out.some(o => o.unitId === u.id)
    ? { unitId: u.id, program: cloneProgram(prog) } : null);
  const first = (units, progOf) => { for (const u of units) { const o = issue(u, progOf(u)); if (o) { out.push(o); return; } } };
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  const RV = AI_TUNING.ravens;

  // 1. Chef menacé : le garde du corps libre le plus proche (pas déjà collé à lui, ni au contact) vient l'escorter.
  const threats = foes.filter(f => distance(f, chief) <= 2);
  if (RV.guard !== false && threats.length && mine.filter(u => u !== chief && distance(u, chief) === 1).length < 2) {
    first(mine.filter(u => ORDERS.guard[u.type] && ratio(u) >= 0.4 && nearestFoe(u) > 1 && distance(u, chief) >= 2 && distance(u, chief) <= 7)
      .sort((a, b) => distance(a, chief) - distance(b, chief) || byId(a, b)), u => ORDERS.guard[u.type]);
  }
  // 2. Commandant ennemi exposé : sans allié adjacent, un loup en bonne santé à ≤ 7 hex le charge — seulement si
  //    le corbeau l'atteint vite (≤ 4 instants de vol) et qu'aucun ennemi ne peut l'accrocher d'ici là.
  const theirCmd = foes.find(u => u.cls === 'commander' || UNITS[u.type]?.cls === 'commander');
  if (bold && RV.regicide !== false && theirCmd && !foes.some(f => f !== theirCmd && distance(f, theirCmd) <= 1)) {
    const eta = (u) => Math.ceil(distance(chief, u) / (RAVEN_SPEED_HEX || 3));
    first(mine.filter(u => u.type === 'g_wolves' && ratio(u) >= 0.5 && eta(u) <= 4 && nearestFoe(u) > eta(u) + 1 && distance(u, theirCmd) <= 7)
      .sort((a, b) => distance(a, theirCmd) - distance(b, theirCmd) || byId(a, b)), () => ORDERS.regicide.g_wolves);
  }
  // 3. Archers (ou chaman) au contact : repli et harcèlement.
  if (RV.archers !== false) {
    first(mine.filter(u => ORDERS.archers[u.type] && (nearestFoe(u) <= 1 || (ratio(u) < 0.6 && nearestFoe(u) <= 2)))
      .sort((a, b) => ratio(a) - ratio(b) || byId(a, b)), u => ORDERS.archers[u.type]);
  }
  // 4. Troll isolé : plus aucun allié à 2 hex, encerclé ou blessé.
  const troll = mine.find(u => u.type === 'g_troll');
  if (RV.troll !== false && troll && !mine.some(u => u !== troll && distance(u, troll) <= 2)) {
    const close = foes.filter(f => distance(f, troll) <= 2).length;
    if (close >= 2 || (close >= 1 && ratio(troll) < 0.5)) first([troll], () => (distance(troll, chief) <= 10 ? ORDERS.trollBack.g_troll : ORDERS.trollNear.g_troll));
  }
  const tick = battle.tick ?? 0, maxT = battle.maxTicks ?? MAX_TICKS;
  const ve = armyValue(battle, 'enemy'), vp = armyValue(battle, 'player');
  const strongest = (table) => mine.filter(u => table[u.type] && ratio(u) >= 0.35)
    .sort((a, b) => (UNITS[b.type].atk * b.hp) - (UNITS[a.type].atk * a.hp) || byId(a, b));
  // 5. Coup de grâce : l'ennemi n'a plus que son commandant et une unité au plus, et nous valons bien plus.
  if (RV.finish !== false && theirCmd && tick >= 15 && foes.length <= 2 && ve >= 1.5 * vp) first(strongest(ORDERS.allIn), u => ORDERS.allIn[u.type]);
  // 6. Fin de bataille et perdants au temps limite : tout pour le commandant ennemi.
  if (RV.allIn !== false && theirCmd && tick >= maxT - 28 && timeLeader(battle, ve, vp) !== 'enemy') first(strongest(ORDERS.allIn), u => ORDERS.allIn[u.type]);
  // 7. Occasions (prévoyance seulement).
  if (opportunity && tick >= 8) {
    first(strongest(ORDERS.press).filter(u => nearestFoe(u) > 1), u => ORDERS.press[u.type]);
    if (theirCmd) first(strongest(ORDERS.allIn).filter(u => nearestFoe(u) > 1), u => ORDERS.allIn[u.type]);
  }
  return out;
}

// Camp qui l'emporterait si la bataille s'arrêtait au temps limite maintenant (règle du moteur si elle est exposée).
function timeLeader(battle, ve, vp) {
  if (typeof SIM?.timeoutWinner === 'function') { try { const w = SIM.timeoutWinner(battle); if (w === 'player' || w === 'enemy') return w; } catch { /* règle par défaut */ } }
  return vp > ve ? 'player' : 'enemy';
}
