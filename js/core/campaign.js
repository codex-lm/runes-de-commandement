// js/core/campaign.js — campagne roguelite (GDD §8) : création d'une partie, carte de nœuds,
// préparation et issue des batailles, grimoire ennemi, marchand, feu de camp, événements, sauvegarde.
// Module pur (aucun DOM, aucun three) ; localStorage n'est touché que par saveRun / loadRun / clearRun.
//
// CONVENTION DE MUTATION : les fonctions qui « renvoient un Run » MODIFIENT le run reçu en place et le
// renvoient. Les deux styles fonctionnent : `run = enterNode(run, id)` comme `enterNode(run, id)`.
// Quand une opération est refusée ({ ok: false, reason }), le run n'est PAS modifié.
// Tout le hasard est dérivé de run.seed / node.seed : à graine égale et choix égaux, partie identique.
// Le run est JSON-sérialisable (aucune fonction, aucun Set) : JSON.parse(JSON.stringify(run)) suffit.
//
// Cycle d'un nœud, vu de l'interface :
//   reachableNodes(run) -> enterNode(run, id) -> selon node.kind :
//     battle|elite|boss : prepareBattle(run, node) (ou prepareBattleAsync) -> bataille -> applyBattleOutcome(run, battle)
//                         -> si run.pendingSteal : stealRune(run, id) ou skipSteal(run)
//     shop  : shopOffers(run, node) -> buyOffer(run, offer)…      (on peut repartir à tout moment)
//     camp  : applyCamp(run, { kind, uid })                        (une fois ; on peut aussi repartir)
//             campOffers(run, node) -> buyOffer(run, offer)        (le quartier-maître, en plus du repos)
//     event : rollEvent(run, node) -> resolveEvent(run, event, choiceId)
//   Tant qu'une bataille ou un événement du nœud courant n'est pas résolu, reachableNodes(run) est vide.

import { UNITS, RUNES, RUNE_KIND_INFO, CLASSES, START_ROSTER, DEFAULT_PROGRAMS, CAMPAIGN, START_RAVENS, MAX_RAVENS, STARTER_RUNES, DEPLOY_COLS } from './data.js';
import { cloneProgram, emptyProgram, unitSlotsFor, runesUsed, validateProgram, sanitizeProgram } from './program.js';
import { createRng, rngRange, rngPick, rngChance, rngShuffle, deriveSeed } from './rng.js';
import { axialToOffset, key } from './hex.js';
import { deployHexes } from './maputil.js';
import { generateMap } from './mapgen.js';
import { planEnemyArmy, planEnemyArmySteps } from './ai.js';

/**
 * @typedef {{ uid: string, type: string, name: string, program: object, bonus: { atk: number, slots: number }, kills: number, battles: number }} RosterUnit
 * @typedef {{ id: string, col: number, row: number, kind: 'battle'|'elite'|'boss'|'shop'|'camp'|'event', next: string[], title: string, seed: number, battleIndex?: number }} CampaignNode
 *   `row` = rang du nœud dans SA colonne (0 = en haut) ; les colonnes n'ont pas toutes le même nombre de nœuds :
 *   pour dessiner, y ≈ (row + 0.5) / columns[col].length.
 * @typedef {{ nodes: Object<string, CampaignNode>, columns: string[][] }} CampaignMap
 * @typedef {{ id: string, kind: 'rune'|'unit'|'raven', runeId?: string, unitType?: string, unitName?: string, price: number, label: string, desc: string, sold?: boolean }} Offer
 * @typedef {{ id: string, nodeId: string, title: string, text: string, choices: { id: string, label: string, desc: string, disabled: boolean, reason: string|null }[], ctx: object, resolved: string|null, outcome: string|null }} GameEvent
 * @typedef {object} Run
 *   Champs du contrat : version, seed, gold, ravens, roster, unlocked, map, position, visited, battlesWon, status, log.
 *   Champs ajoutés (lecture libre pour l'UI) :
 *   - nodeDone : false tant que la bataille / l'événement du nœud courant n'est pas résolu.
 *   - pendingSteal : null | { nodeId, runes: RuneId[] } — choix de rune du grimoire en attente.
 *   - lastOutcome : null | { nodeId, summary } — résumé de la dernière bataille (pour réafficher l'écran de résultat).
 *   - shop : null | { nodeId, offers } (stock du marchand courant, ou du quartier-maître d'un feu de camp) ;
 *     event : null | GameEvent (événement courant).
 *   - battlePlan : null | { nodeId, key, plan } — plan ennemi de la bataille en attente, calculé une fois par
 *     prepareBattle et réutilisé (rechargement compris) tant que l'armée n'a pas changé.
 *   - campUsed, eventsSeen, mods: { enemyRavens, enemyTroop } (effets d'événements sur la prochaine bataille), stats: { kills, unitsLost, goldEarned, goldSpent, runesLearned }, nextUid.
 */

// ------------------------------------------------------------------ Constantes
export const RUN_VERSION = 1;
export const SAVE_KEY = 'runes.run.v1';
/** Taille maximale de l'armée (recrues comprises). */
export const MAX_ROSTER = 10;
export const LOG_MAX = 60;
export const COMBAT_KINDS = ['battle', 'elite', 'boss'];
/** Remise des mercenaires de l'événement « La compagnie franche » (fraction du coût). */
const MERCENARY_DISCOUNT = 0.6;

/** Libellés et descriptions des types de nœuds (pour la carte de campagne). */
export const NODE_KINDS = {
  battle: { id: 'battle', name: 'Bataille', combat: true,
            desc: `Une bande gobeline barre la route. Victoire : ${CAMPAIGN.rewardBattle} or, et ${CAMPAIGN.rewardPerKill} par ennemi abattu.` },
  elite:  { id: 'elite', name: 'Élite', combat: true,
            desc: `Des vétérans de la horde, mieux armés et mieux programmés. Victoire : ${CAMPAIGN.rewardElite} or et une rune offerte.` },
  boss:   { id: 'boss', name: 'Chef de guerre', combat: true,
            desc: 'Le Chef de guerre gobelin et son troll. Tout se joue ici.' },
  shop:   { id: 'shop', name: 'Marchand', combat: false,
            desc: 'Des runes, des recrues, un corbeau. Contre de l’or.' },
  camp:   { id: 'camp', name: 'Feu de camp', combat: false,
            desc: 'Une nuit de répit : méditer (+1 emplacement de rune) ou forger (+1 attaque) ; un quartier-maître y loue une recrue.' },
  event:  { id: 'event', name: 'Événement', combat: false,
            desc: 'La route réserve parfois des surprises.' },
};

const NODE_TITLES = {
  battle: ['Escarmouche au gué', 'Les pillards du val', 'L’avant-garde gobeline', 'Le pont brûlé', 'La lisière des Fresnes',
           'Le hameau pillé', 'Les landes de Combefroide', 'Le chemin des bornes', 'La combe aux loups'],
  elite:  ['Les Crocs de Gorrh', 'La garde du chaman', 'Les Écorcheurs', 'La meute grise', 'Les Mange-Corbeaux'],
  boss:   ['Le camp du Chef de guerre', 'Le trône d’os', 'La horde rassemblée'],
  shop:   ['Le colporteur', 'La foire de Brumeval', 'Le comptoir du pont', 'La roulotte du runier', 'Le relais des marchands'],
  camp:   ['Bivouac sous les pins', 'Le moulin abandonné', 'La chapelle en ruine', 'Veillée au bord de l’eau', 'Le feu des sentinelles'],
  event:  ['Croisée des chemins', 'Le chemin creux', 'Brume sur la lande', 'Le vieux tertre', 'Le bois aux murmures'],
};

// Noms des unités du Royaume. Pas d'article en tête (il est ajouté par la grammaire ci-dessous).
const NAME_POOLS = {
  k_commander: ['Dame Ysolde', 'Sire Aymeric', 'Dame Aliénor', 'Sire Thibaut', 'Dame Mahaut', 'Sire Enguerrand'],
  k_pikemen:   ['Piquiers de Valmont', 'Piquiers de Hautebrume', 'Piquiers du Val-Sombre', 'Piquiers de Combefroide',
                'Piquiers de la Ronce', 'Piquiers de Saint-Aubert', 'Piquiers du Gué-Morin', 'Piquiers de Brunehaut'],
  k_knights:   ['Chevaliers de l’Aube', 'Chevaliers du Cerf blanc', 'Lances d’Argentfer', 'Chevaliers de la Tour grise',
                'Chevaliers de Montjoie', 'Lances de Maupertuis', 'Chevaliers du Lys d’or'],
  k_archers:   ['Archers de la Marche', 'Archers de Hautecombe', 'Archers du Bois-Clair', 'Archers de Sombreval',
                'Archers de Fresnaye', 'Archers des Saules'],
  k_mage:      ['Isaure la Grise', 'Maître Anselme', 'Frère Ambroise', 'Dame Mélisende', 'Maître Évrard', 'Sœur Clémence', 'Ermengarde de Brume'],
  k_golem:     ['Golem de Pierrecreuse', 'Golem de Haut-Granit', 'Golem de la Carrière', 'Golem de Roche-Grise', 'Golem du Mont-Ferrand'],
};

const RUNE_ORDER = Object.keys(RUNES);

// ------------------------------------------------------------------ Petits utilitaires
const NBSP = ' ';
/** Typographie française : espace insécable avant « : ; ! ? » et à l'intérieur des guillemets. */
export function fr(s) {
  return String(s ?? '').replace(/ ([:;!?»])/g, `${NBSP}$1`).replace(/« /g, `«${NBSP}`);
}
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isCombat = (kind) => COMBAT_KINDS.includes(kind);
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

// Grammaire minimale pour accorder les phrases avec un nom d'unité.
const PLURAL_HEADS = ['Piquiers', 'Chevaliers', 'Archers', 'Lances', 'Volontaires'];
const MASC_HEADS = ['Golem'];
const FEM_HEADS = ['Milice'];
function grammar(name) {
  const head = String(name).split(/[\s’']/)[0];
  if (PLURAL_HEADS.includes(head)) return { art: 'les', pl: true };
  if (MASC_HEADS.includes(head)) return { art: 'le', pl: false };
  if (FEM_HEADS.includes(head)) return { art: 'la', pl: false };
  return { art: '', pl: false };
}
const nameOf = (u) => (typeof u === 'string' ? u : u?.name ?? '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** « les Piquiers de Valmont », « le Golem de Pierrecreuse », « Isaure la Grise ». */
const the = (u) => { const n = nameOf(u), g = grammar(n); return g.art ? `${g.art} ${n}` : n; };
const The = (u) => cap(the(u));
/** « des Piquiers… », « du Golem… », « de la Milice… », « d’Isaure… », « de Maître Anselme ». */
const of = (u) => {
  const n = nameOf(u), g = grammar(n);
  if (g.art === 'les') return `des ${n}`;
  if (g.art === 'le') return `du ${n}`;
  if (g.art === 'la') return `de la ${n}`;
  return /^[aeiouyàâéèêëîïôœùû]/i.test(n) ? `d’${n}` : `de ${n}`;
};
/** Accord du verbe : vb(u, 'médite', 'méditent'). */
const vb = (u, sing, plur) => (grammar(nameOf(u)).pl ? plur : sing);

function unitStats(type) {
  const d = UNITS[type];
  if (!d) return '';
  return `${d.hp} PV · ${d.atk} atq · ${d.def} déf · portée ${d.range} · ${d.slots} emplacements`;
}

function addLog(run, msg) {
  if (!Array.isArray(run.log)) run.log = [];
  run.log.push(fr(msg));
  if (run.log.length > LOG_MAX) run.log.splice(0, run.log.length - LOG_MAX);
}
function gainGold(run, n) {
  const x = Math.max(0, Math.round(n));
  run.gold += x;
  run.stats.goldEarned += x;
  return x;
}
/** Retire jusqu'à n pièces (jamais en dessous de 0). Renvoie la somme réellement retirée. */
function spendGold(run, n) {
  const x = Math.min(run.gold, Math.max(0, Math.round(n)));
  run.gold -= x;
  run.stats.goldSpent += x;
  return x;
}
function unlockRune(run, id) {
  if (!RUNES[id] || run.unlocked.includes(id)) return false;
  run.unlocked.push(id);
  run.stats.runesLearned += 1;
  return true;
}
const lockedRunes = (run) => RUNE_ORDER.filter(id => !run.unlocked.includes(id));
const recruitableTypes = () => Object.values(UNITS).filter(u => u.recruitable && u.faction === 'royaume').map(u => u.id);
const canGainSlot = (u) => (u.bonus?.slots ?? 0) < CAMPAIGN.maxSlotBonus;
const canGainAtk = (u) => (u.bonus?.atk ?? 0) < CAMPAIGN.maxAtkBonus;
const findUnit = (run, uid) => run.roster.find(u => u.uid === uid) ?? null;
const isDead = (b) => b?.alive === false || (typeof b?.hp === 'number' && b.hp <= 0);

/** Attaque effective d'une unité de l'armée (bonus de forge compris). */
export function unitAtk(rosterUnit) {
  return (UNITS[rosterUnit?.type]?.atk ?? 0) + (rosterUnit?.bonus?.atk ?? 0);
}

/**
 * Nombre d'emplacements de runes d'une unité de l'armée (base + méditations).
 * @param {RosterUnit} rosterUnit
 * @returns {number}
 */
export function unitSlots(rosterUnit) {
  return unitSlotsFor(rosterUnit?.type, rosterUnit?.bonus?.slots ?? 0);
}

// ------------------------------------------------------------------ Noms et recrues
function pickName(run, type, rng, reserved = []) {
  const used = new Set([...run.roster.map(u => u.name), ...reserved]);
  const pool = NAME_POOLS[type] ?? [UNITS[type]?.name ?? 'Recrues'];
  for (const n of rngShuffle(rng, pool)) if (!used.has(n)) return n;
  const base = rngPick(rng, pool);
  for (let i = 2; ; i++) {
    const n = `${base} ${ROMAN[i] ?? i}`;
    if (!used.has(n)) return n;
  }
}

function makeRosterUnit(run, type, name) {
  const uid = `u${run.nextUid++}`;
  const finalName = name && !run.roster.some(u => u.name === name)
    ? name
    : pickName(run, type, createRng(deriveSeed(run.seed, 'nom', uid)), name ? [name] : []);
  return {
    uid, type, name: finalName,
    program: cloneProgram(DEFAULT_PROGRAMS[type] ?? emptyProgram()),
    bonus: { atk: 0, slots: 0 }, kills: 0, battles: 0,
  };
}

function addRecruit(run, type, name) {
  const u = makeRosterUnit(run, type, name);
  run.roster.push(u);
  return u;
}

// ------------------------------------------------------------------ Carte de campagne
function linkColumns(rng, n, m) {
  // Positions normalisées des nœuds dans leur colonne : on relie de préférence des nœuds « en face ».
  const pa = (i) => (i + 0.5) / n, pb = (j) => (j + 0.5) / m;
  const out = Array.from({ length: n }, () => new Set());
  const inc = new Array(m).fill(0);
  const link = (i, j) => { if (!out[i].has(j)) { out[i].add(j); inc[j]++; } };
  const nearest = (cands, dist) => {
    let best = [], bd = Infinity;
    for (const c of cands) {
      const d = dist(c);
      if (d < bd - 1e-9) { bd = d; best = [c]; } else if (Math.abs(d - bd) <= 1e-9) best.push(c);
    }
    return best.length ? rngPick(rng, best) : null;
  };
  const allB = [...Array(m).keys()];
  // 1. chaque nœud vers le nœud d'en face
  for (let i = 0; i < n; i++) link(i, nearest(allB, (j) => Math.abs(pa(i) - pb(j))));
  // 2. chaque nœud suivant doit avoir au moins un prédécesseur
  for (let j = 0; j < m; j++) {
    if (inc[j]) continue;
    const free = [...Array(n).keys()].filter(i => out[i].size < 2);
    const i = nearest(free.length ? free : [...Array(n).keys()], (x) => Math.abs(pa(x) - pb(j)));
    link(i, j);
  }
  // 3. embranchements supplémentaires vers un voisin direct : les chemins se croisent et se rejoignent
  if (m >= 2) {
    const branchOptions = (i) => {
      const j0 = [...out[i]][0];
      return [j0 - 1, j0 + 1].filter(j => j >= 0 && j < m && !out[i].has(j) && Math.abs(pa(i) - pb(j)) <= 0.5 + 1e-9);
    };
    for (let i = 0; i < n; i++) {
      if (out[i].size !== 1 || !rngChance(rng, 0.45)) continue;
      const opts = branchOptions(i);
      if (opts.length) link(i, rngPick(rng, opts));
    }
    if (!out.some(s => s.size >= 2)) {
      const cands = [...Array(n).keys()].filter(i => out[i].size === 1 && branchOptions(i).length);
      if (cands.length) { const i = rngPick(rng, cands); link(i, rngPick(rng, branchOptions(i))); }
    }
  }
  return out.map(s => [...s].sort((a, b) => a - b));
}

function buildMapAttempt(rng, seed) {
  const colsDef = CAMPAIGN.columns;
  const titles = {};
  const titleOf = (kind) => {
    if (!titles[kind]) titles[kind] = { list: rngShuffle(rng, NODE_TITLES[kind] ?? [NODE_KINDS[kind]?.name ?? kind]), i: 0 };
    const t = titles[kind];
    const base = t.list[t.i % t.list.length];
    const lap = Math.floor(t.i / t.list.length);
    t.i++;
    return lap ? `${base} ${ROMAN[lap + 1] ?? lap + 1}` : base;
  };
  const nodes = {}, columns = [];
  let combatCol = 0;
  colsDef.forEach((kinds, c) => {
    // Une colonne d'un seul type (la première bataille, le boss) n'a qu'un nœud : y proposer 2 ou 3 nœuds
    // identiques ne serait qu'un faux choix. Le premier nœud mène alors à toute la colonne suivante.
    const single = c === colsDef.length - 1 || kinds.length === 1;
    const count = single ? 1 : clamp(Math.max(Math.min(kinds.length, 3), rngRange(rng, 2, 3)), 1, 3);
    let list;
    if (count >= kinds.length) {
      list = kinds.slice();
      const extras = kinds.filter(k => k !== 'elite' && k !== 'boss');
      while (list.length < count) list.push(rngPick(rng, extras.length ? extras : kinds));
    } else list = rngShuffle(rng, kinds).slice(0, count);
    list = rngShuffle(rng, list);
    const hasCombat = list.some(isCombat);
    const ids = list.map((kind, row) => {
      const id = `n${c}-${row}`;
      const node = { id, col: c, row, kind, next: [], title: titleOf(kind), seed: deriveSeed(seed, 'nœud', id) };
      if (isCombat(kind)) node.battleIndex = combatCol;
      nodes[id] = node;
      return id;
    });
    if (hasCombat) combatCol++;
    columns.push(ids);
  });
  for (let c = 0; c + 1 < columns.length; c++) {
    const links = linkColumns(rng, columns[c].length, columns[c + 1].length);
    columns[c].forEach((id, i) => { nodes[id].next = links[i].map(j => columns[c + 1][j]); });
  }
  // Dernière halte avant le boss : chaque nœud qui y mène doit pouvoir rejoindre un marchand (l'or gagné
  // à l'élite ou à la bataille n'est jamais perdu d'office ; le feu de camp reste un choix).
  if (columns.length >= 3) ensureShopAhead(nodes, columns[columns.length - 3], columns[columns.length - 2]);
  return { nodes, columns };
}

function ensureShopAhead(nodes, fromIds, toIds) {
  const shops = toIds.filter(id => nodes[id].kind === 'shop');
  if (!shops.length) return;
  const indeg = {};
  for (const id of fromIds) for (const t of nodes[id].next) indeg[t] = (indeg[t] ?? 0) + 1;
  const pos = (ids, id) => (ids.indexOf(id) + 0.5) / ids.length;
  for (const id of fromIds) {
    const n = nodes[id];
    if (n.next.some(t => nodes[t].kind === 'shop')) continue;
    const shop = shops.slice().sort((a, b) => Math.abs(pos(fromIds, id) - pos(toIds, a)) - Math.abs(pos(fromIds, id) - pos(toIds, b)))[0];
    if (n.next.length >= 2) {
      // on remplace un lien vers un nœud qui garde un autre prédécesseur ; sinon la carte est rejetée
      const drop = n.next.find(t => indeg[t] >= 2);
      if (!drop) continue;
      n.next = n.next.filter(t => t !== drop);
      indeg[drop]--;
    }
    n.next.push(shop);
    indeg[shop] = (indeg[shop] ?? 0) + 1;
    n.next.sort((a, b) => toIds.indexOf(a) - toIds.indexOf(b));
  }
}

function shopAhead(map) {
  const { nodes, columns } = map;
  if (columns.length < 3) return true;
  return columns[columns.length - 3].every(id => nodes[id].next.some(t => nodes[t].kind === 'shop'));
}

function mapInterleaves(map) {
  const { nodes, columns } = map;
  const indeg = {};
  for (const n of Object.values(nodes)) for (const t of n.next) indeg[t] = (indeg[t] ?? 0) + 1;
  const inner = columns.slice(1, -1).flat();
  const split = columns.slice(0, -1).flat().some(id => nodes[id].next.length >= 2);
  const merge = inner.some(id => (indeg[id] ?? 0) >= 2);
  return split && merge;
}

/**
 * Génère la carte de campagne (déterministe à graine égale), une colonne par entrée de CAMPAIGN.columns :
 * 1 nœud pour une colonne d'un seul type (première bataille, boss), 2–3 sinon ; chaque nœud relié à 1–2 nœuds
 * de la colonne suivante (le nœud de départ, à toute la colonne suivante), tous les nœuds atteignables, des chemins
 * qui se séparent et se rejoignent, et un marchand toujours accessible juste avant le boss.
 * @param {number|string} seed
 * @returns {CampaignMap}
 */
export function generateCampaignMap(seed) {
  const rng = createRng(deriveSeed(seed, 'carte'));
  let map = null;
  for (let attempt = 0; attempt < 32; attempt++) {
    map = buildMapAttempt(rng, seed);
    if (mapInterleaves(map) && shopAhead(map)) break;
  }
  for (const n of Object.values(map.nodes)) n.title = fr(n.title);
  return map;
}

// ------------------------------------------------------------------ Création d'une partie
function randomSeed() {
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0];
  } catch { return Math.floor(Math.random() * 0x100000000) >>> 0; }
}

function blankStats() { return { kills: 0, unitsLost: 0, goldEarned: 0, goldSpent: 0, runesLearned: 0 }; }

/**
 * Nouvelle campagne : armée de départ (START_ROSTER, DEFAULT_PROGRAMS), 60 or, 3 corbeaux, runes de départ.
 * @param {number|string} [seed] graine ; tirée au hasard si absente.
 * @returns {Run}
 */
export function newRun(seed) {
  if (seed === undefined || seed === null || seed === '') seed = randomSeed();
  const run = {
    version: RUN_VERSION,
    seed,
    gold: CAMPAIGN.startGold,
    ravens: START_RAVENS.player,
    roster: [],
    unlocked: [...STARTER_RUNES],
    map: generateCampaignMap(seed),
    position: null,
    visited: [],
    battlesWon: 0,
    status: 'active',
    log: [],
    // --- extensions
    nextUid: 1,
    nodeDone: true,
    campUsed: false,
    shop: null,
    event: null,
    pendingSteal: null,
    lastOutcome: null,
    battlePlan: null,
    eventsSeen: [],
    mods: { enemyRavens: 0, enemyTroop: 0 },
    stats: blankStats(),
  };
  for (const type of START_ROSTER) addRecruit(run, type);
  const cmd = run.roster.find(u => UNITS[u.type]?.cls === 'commander');
  addLog(run, `${cmd ? cmd.name : 'Le commandant'} prend la tête de l’armée du Royaume. Au bout de la route : le Chef de guerre gobelin.`);
  return run;
}

// ------------------------------------------------------------------ Navigation
/** Nœud où se trouve l'armée, ou null avant le premier pas. */
export function currentNode(run) {
  return run?.position ? run.map?.nodes?.[run.position] ?? null : null;
}

/** Nœud de combat dont la bataille reste à livrer (reprise après rechargement), sinon null. */
export function pendingBattle(run) {
  const node = currentNode(run);
  return node && run.status === 'active' && isCombat(node.kind) && run.nodeDone === false ? node : null;
}

/**
 * Nœuds où l'armée peut se rendre maintenant. Vide si la campagne est finie, ou si la bataille /
 * l'événement du nœud courant n'est pas encore résolu.
 * @param {Run} run
 * @returns {CampaignNode[]}
 */
export function reachableNodes(run) {
  if (!run || run.status !== 'active' || !run.map) return [];
  const { nodes, columns } = run.map;
  if (run.position == null) return (columns[0] ?? []).map(id => nodes[id]).filter(Boolean);
  if (run.nodeDone === false) return [];
  return (nodes[run.position]?.next ?? []).map(id => nodes[id]).filter(Boolean);
}

/** Vrai si enterNode(run, nodeId) serait accepté. */
export function canEnterNode(run, nodeId) {
  return reachableNodes(run).some(n => n.id === nodeId);
}

/**
 * Entre dans un nœud atteignable. Prépare le stock du marchand (ou du quartier-maître d'un feu de camp)
 * ou tire l'événement. Un choix de rune encore en attente (pendingSteal) est soldé en or (comme skipSteal).
 * Nœud non atteignable : le run est renvoyé inchangé.
 * @param {Run} run
 * @param {string} nodeId
 * @returns {Run}
 */
export function enterNode(run, nodeId) {
  if (!canEnterNode(run, nodeId)) return run;
  if (run.pendingSteal) skipSteal(run);
  const node = run.map.nodes[nodeId];
  run.position = nodeId;
  run.visited.push(nodeId);
  run.nodeDone = !(isCombat(node.kind) || node.kind === 'event');
  run.campUsed = false;
  run.shop = null;
  run.event = null;
  run.lastOutcome = null;
  run.battlePlan = null;
  if (node.kind === 'shop') run.shop = { nodeId, offers: computeShopOffers(run, node) };
  if (node.kind === 'camp') run.shop = { nodeId, offers: computeCampOffers(run, node) };
  if (node.kind === 'event') run.event = buildEvent(run, node);
  return run;
}

function resolveNodeArg(run, node) {
  if (typeof node === 'string') return run.map?.nodes?.[node] ?? null;
  if (node && typeof node === 'object') return run.map?.nodes?.[node.id] ?? node;
  return currentNode(run);
}

// ------------------------------------------------------------------ Batailles
// Ce dont dépend le plan ennemi côté joueur : la composition de l'armée et ses bonus (pas ses programmes).
const rosterKey = (run) => `${run.roster.map(u => `${u.uid}:${u.type}:${u.bonus?.atk ?? 0}:${u.bonus?.slots ?? 0}`).join('|')}#${toInt(run.mods?.enemyTroop)}`;

function battleContext(run, node) {
  node = resolveNodeArg(run, node);
  if (!node || !isCombat(node.kind)) throw new Error(`prepareBattle : « ${node?.id ?? node} » n’est pas un nœud de bataille.`);
  const base = node.seed ?? deriveSeed(run.seed, 'nœud', node.id);
  const index = node.battleIndex ?? 0;
  const map = generateMap({ seed: deriveSeed(base, 'carte'), kind: node.kind, index });
  const planArgs = {
    node: { id: node.id, kind: node.kind, battleIndex: index, title: node.title },
    map,
    seed: deriveSeed(base, 'ia'),
    playerRoster: clone(run.roster),
    reinforcements: clamp(toInt(run.mods?.enemyTroop), 0, 3),
  };
  // Seule la bataille en attente du nœud courant est mémorisée (un aperçu d'un autre nœud ne touche pas au run).
  const cacheable = run.position === node.id && run.nodeDone === false && run.status === 'active';
  return { node, base, map, planArgs, cacheable, key: rosterKey(run) };
}

function cachedPlan(run, ctx) {
  const c = run.battlePlan;
  return ctx.cacheable && c && c.nodeId === ctx.node.id && c.key === ctx.key && c.plan ? clone(c.plan) : null;
}

function finishPrep(run, ctx, plan) {
  if (ctx.cacheable) run.battlePlan = { nodeId: ctx.node.id, key: ctx.key, plan: clone(plan) };
  const enemyPlan = { ...plan };
  const notes = [];
  const mod = toInt(run.mods?.enemyRavens);
  if (mod) {
    const before = Number.isFinite(plan?.ravens) ? plan.ravens : START_RAVENS.enemy;
    enemyPlan.ravens = clamp(before + mod, 0, MAX_RAVENS);
    notes.push(fr(mod > 0
      ? 'Prévenue par un fuyard, la horde a lâché un corbeau de plus.'
      : 'Grâce aux renseignements du baron, l’ennemi a un corbeau de moins.'));
  }
  if (ctx.planArgs.reinforcements > 0) notes.push(fr('Le fuyard a ramené des renforts : une bande de lanciers de plus garde le camp ennemi.'));
  return { map: ctx.map, enemyPlan, seed: deriveSeed(ctx.base, 'bataille'), playerRavens: run.ravens, notes };
}

/**
 * Prépare une bataille : carte (mapgen.generateMap) et armée ennemie (ai.planEnemyArmy), déterministes
 * selon node.seed et la composition de l'armée. Pour la bataille en attente du nœud courant, le plan ennemi
 * est mémorisé dans run.battlePlan (seul champ modifié) et réutilisé aux appels suivants, rechargement compris :
 * le rapport d'éclaireurs ne change jamais une fois lu. Les effets d'événements en attente (corbeaux ennemis
 * ±1) sont appliqués à enemyPlan.ravens et expliqués dans `notes`.
 * @param {Run} run
 * @param {CampaignNode|string} [node] nœud de combat (par défaut : le nœud courant)
 * @returns {{ map: object, enemyPlan: object, seed: number, playerRavens: number, notes: string[] }}
 *   `seed` est la graine à passer à sim.createBattle ; `playerRavens` = run.ravens.
 */
export function prepareBattle(run, node) {
  const ctx = battleContext(run, node);
  return finishPrep(run, ctx, cachedPlan(run, ctx) ?? planEnemyArmy(ctx.planArgs));
}

/**
 * Comme prepareBattle (même résultat), mais rend la main au navigateur entre deux candidats simulés par l'IA :
 * l'interface reste fluide pendant la planification, même sur un téléphone lent.
 * @param {Run} run
 * @param {CampaignNode|string} [node]
 * @param {{ yieldFn?: (progress: { done: number, total: number }) => Promise<void>|void }} [opts]
 *   par défaut, une pause setTimeout(0) entre deux candidats.
 * @returns {Promise<ReturnType<typeof prepareBattle>>}
 */
export async function prepareBattleAsync(run, node, { yieldFn } = {}) {
  const ctx = battleContext(run, node);
  let plan = cachedPlan(run, ctx);
  if (!plan) {
    const it = planEnemyArmySteps(ctx.planArgs);
    for (;;) {
      const r = it.next();
      if (r.done) { plan = r.value; break; }
      await (yieldFn ? yieldFn(r.value) : new Promise(res => setTimeout(res, 0)));
    }
  }
  return finishPrep(run, ctx, plan);
}

/**
 * Placement automatique de l'armée dans la zone de déploiement du joueur : ligne de front (infanterie,
 * colosses), cavalerie sur les ailes, tireurs et mages au milieu, commandant à l'arrière.
 * @param {Run} run
 * @param {object} map carte de bataille
 * @param {RosterUnit[]} [roster]
 * @returns {{ uid: string, q: number, r: number }[]}
 */
export function autoDeploy(run, map, roster = run.roster) {
  const cols = DEPLOY_COLS.player.slice().sort((a, b) => a - b);
  const back = cols[0], mid = cols[Math.floor(cols.length / 2)], front = cols[cols.length - 1];
  const wantCol = { commander: back, ranged: mid, caster: mid, infantry: front, colossus: front, cavalry: front };
  const order = { infantry: 0, colossus: 1, cavalry: 2, ranged: 3, caster: 4, commander: 5 };
  const free = deployHexes(map, 'player').map(h => ({ q: h.q, r: h.r, ...axialToOffset(h.q, h.r) }));
  const taken = new Set();
  const midRow = Math.floor((map.h ?? 9) / 2);
  const perCol = {};
  let cavalry = 0;
  const units = roster.map((u, i) => ({ u, i, cls: UNITS[u.type]?.cls ?? 'infantry' }))
    .sort((a, b) => (order[a.cls] ?? 9) - (order[b.cls] ?? 9) || a.i - b.i);
  const out = [];
  for (const { u, cls } of units) {
    const col = wantCol[cls] ?? mid;
    let row;
    if (cls === 'cavalry') {
      cavalry++;
      row = midRow + (cavalry % 2 ? -1 : 1) * (2 + Math.floor((cavalry - 1) / 2));
    } else {
      const j = perCol[col] = (perCol[col] ?? -1) + 1;
      row = midRow + (j % 2 ? 1 : -1) * Math.ceil(j / 2);
    }
    let best = null, bestScore = Infinity;
    for (const h of free) {
      if (taken.has(key(h.q, h.r))) continue;
      const s = Math.abs(h.col - col) * 3 + Math.abs(h.row - row);
      if (s < bestScore || (s === bestScore && (h.row < best.row || (h.row === best.row && h.col < best.col)))) { best = h; bestScore = s; }
    }
    if (!best) continue;
    taken.add(key(best.q, best.r));
    out.push({ uid: u.uid, q: best.q, r: best.r });
  }
  return out;
}

/**
 * Construit l'Army du joueur (pour sim.createBattle) à partir des placements { uid, q, r }.
 * Les placements dont l'uid n'est pas dans l'armée sont ignorés.
 * @returns {{ faction: 'royaume', units: { uid: string, type: string, q: number, r: number, program: object, bonus: { atk: number, slots: number } }[] }}
 */
export function rosterToArmy(run, placements) {
  const units = [];
  for (const p of placements ?? []) {
    const u = findUnit(run, p.uid);
    if (!u) continue;
    units.push({ uid: u.uid, type: u.type, q: p.q, r: p.r, program: cloneProgram(u.program), bonus: { ...u.bonus } });
  }
  return { faction: 'royaume', units };
}

// Associe chaque unité de bataille du joueur à une unité de l'armée (par uid, sinon par type).
function matchRoster(roster, pUnits) {
  const matched = new Map();
  const uids = new Set(roster.map(u => u.uid));
  const rest = [];
  for (const b of pUnits) {
    if (b.uid != null && uids.has(b.uid) && !matched.has(b.uid)) matched.set(b.uid, b);
    else rest.push(b);
  }
  for (const b of rest) {
    const r = roster.find(u => u.type === b.type && !matched.has(u.uid));
    if (r) matched.set(r.uid, b);
  }
  return matched;
}

function readGrimoire(eUnits) {
  const out = [], seen = new Map();
  for (const u of eUnits) {
    if (!u?.type) continue;
    const program = cloneProgram(u.program ?? emptyProgram());
    const k = `${u.type}|${JSON.stringify(program)}`;
    if (seen.has(k)) { seen.get(k).count++; continue; }
    const entry = { type: u.type, program, count: 1, name: UNITS[u.type]?.name ?? u.type };
    seen.set(k, entry);
    out.push(entry);
  }
  return out;
}

/**
 * Applique l'issue d'une bataille terminée au run (nœud courant de combat) :
 * mort permanente des unités tuées, victoires et frags, or (bataille 50 / élite 80 + 5 par ennemi tué),
 * rune offerte d'élite, grimoire ennemi (runes volables), défaite -> status 'lost', boss vaincu -> 'won'.
 * Après une victoire (hors boss), run.pendingSteal = { nodeId, runes } attend stealRune(run, id) ou
 * skipSteal(run) (+25 or) ; `runes` peut être vide (grimoire sans nouveauté : seul l'or est possible).
 * Si l'interface n'appelle ni l'un ni l'autre, enterNode verse les 25 or au nœud suivant.
 * `summary.gold` n'inclut pas ces 25 or ; `summary.fallbackGold` = or versé d'office à la place de la rune
 * offerte d'élite quand toutes les runes sont déjà connues.
 * Idempotent : un second appel pour le même nœud renvoie le même résumé sans rien réappliquer.
 * @param {Run} run
 * @param {object} battle Battle de sim.js (lit result, units[].side/uid/type/alive/hp/kills/program)
 * @returns {{ run: Run, summary: { won: boolean, reason: string|null, applied: boolean, nodeId: string|null, nodeKind: string|null,
 *   gold: number, goldBreakdown: { label: string, amount: number }[], lost: RosterUnit[], kills: number, stealable: string[],
 *   enemyPrograms: { type: string, program: object, count: number, name: string }[], freeRune: string|null,
 *   fallbackGold: number, status: string } }}
 */
export function applyBattleOutcome(run, battle) {
  const node = currentNode(run);
  if (node && run.lastOutcome?.nodeId === node.id) return { run, summary: clone(run.lastOutcome.summary) };
  const applicable = run.status === 'active' && !!node && isCombat(node.kind);
  const result = battle?.result ?? null;
  const units = Array.isArray(battle?.units) ? battle.units : [];
  const pUnits = units.filter(u => u?.side === 'player');
  const eUnits = units.filter(u => u?.side === 'enemy');
  const matched = matchRoster(run.roster, pUnits);
  const dead = new Set([...matched].filter(([, b]) => isDead(b)).map(([uid]) => uid));
  const commander = run.roster.find(u => UNITS[u.type]?.cls === 'commander');
  const commanderDead = !commander || dead.has(commander.uid);
  const won = result?.winner === 'player' && !commanderDead;
  const kills = eUnits.filter(isDead).length;
  const enemyPrograms = readGrimoire(eUnits);
  const used = new Set();
  for (const e of enemyPrograms) for (const id of runesUsed(e.program)) used.add(id);
  let stealable = RUNE_ORDER.filter(id => used.has(id) && !run.unlocked.includes(id));
  const summary = {
    won, applied: applicable,
    reason: result ? (result.winner === 'player' && commanderDead ? 'commander' : result.reason ?? null) : 'abandon',
    nodeId: node?.id ?? null, nodeKind: node?.kind ?? null,
    gold: 0, goldBreakdown: [], lost: [], kills, stealable, enemyPrograms,
    freeRune: null, fallbackGold: 0, status: run.status,
  };
  if (!applicable) return { run, summary };

  const earn = (label, amount) => {
    const x = gainGold(run, amount);
    if (x > 0) { summary.gold += x; summary.goldBreakdown.push({ label: fr(label), amount: x }); }
  };

  for (const u of run.roster) {
    const b = matched.get(u.uid);
    if (!b) continue;
    u.battles += 1;
    u.kills += Math.max(0, toInt(b.kills));
  }
  const lost = run.roster.filter(u => dead.has(u.uid));
  run.roster = run.roster.filter(u => !dead.has(u.uid));
  summary.lost = clone(lost);
  run.stats.kills += kills;
  run.stats.unitsLost += lost.length;
  run.mods = { enemyRavens: 0, enemyTroop: 0 };
  run.nodeDone = true;
  run.pendingSteal = null;
  run.battlePlan = null;

  const title = node.title;
  if (won) {
    run.battlesWon += 1;
    earn(node.kind === 'elite' ? 'Victoire sur l’élite' : node.kind === 'boss' ? 'Victoire finale' : 'Victoire',
      node.kind === 'elite' ? CAMPAIGN.rewardElite : CAMPAIGN.rewardBattle);
    if (kills) earn(`Ennemis abattus (${kills})`, kills * CAMPAIGN.rewardPerKill);
    if (node.kind === 'elite') {
      const locked = lockedRunes(run);
      const pool = locked.filter(id => !stealable.includes(id));
      const choice = pool.length ? pool : locked;
      if (choice.length) {
        const id = rngPick(createRng(deriveSeed(node.seed, 'rune-offerte')), choice);
        unlockRune(run, id);
        summary.freeRune = id;
        stealable = stealable.filter(x => x !== id);
        summary.stealable = stealable;
        addLog(run, `Butin de l’élite : la rune « ${RUNES[id].name} ».`);
      } else {
        earn('Rune offerte (vous les connaissez toutes)', CAMPAIGN.stealFallbackGold);
        summary.fallbackGold = CAMPAIGN.stealFallbackGold;
      }
    }
    if (node.kind === 'boss') {
      run.status = 'won';
      addLog(run, summary.reason === 'time'
        ? `Victoire — ${title} : le Chef de guerre bat en retraite, sa horde en lambeaux. Le Royaume est sauf.`
        : `Victoire — ${title} : le Chef de guerre est tombé, la horde se disperse. Le Royaume est sauf.`);
    } else {
      run.pendingSteal = { nodeId: node.id, runes: stealable.slice() };
      addLog(run, `Victoire — ${title} : +${summary.gold} or${lost.length ? `, ${lost.length} unité${lost.length > 1 ? 's' : ''} perdue${lost.length > 1 ? 's' : ''}` : ''}.`);
    }
  } else {
    run.status = 'lost';
    addLog(run, commanderDead
      ? `Défaite — ${title} : ${commander ? `${commander.name} ne reviendra pas` : 'votre commandant est tombé'}. La campagne s’achève.`
      : `Défaite — ${title}. L’armée se replie ; la campagne s’achève.`);
  }
  for (const u of lost) {
    if (UNITS[u.type]?.cls !== 'commander') addLog(run, `${The(u)} ${vb(u, 'ne reviendra pas', 'ne reviendront pas')}.`);
  }
  summary.status = run.status;
  run.lastOutcome = { nodeId: node.id, summary: clone(summary) };
  return { run, summary };
}

/**
 * Débloque une rune du grimoire ennemi (choix en attente après une victoire). Sans effet si la rune
 * n'est pas proposée ou s'il n'y a pas de choix en attente.
 * @param {Run} run
 * @param {string} runeId
 * @returns {Run}
 */
export function stealRune(run, runeId) {
  const p = run.pendingSteal;
  if (!p || !Array.isArray(p.runes) || !p.runes.includes(runeId) || !RUNES[runeId]) return run;
  unlockRune(run, runeId);
  run.pendingSteal = null;
  if (run.lastOutcome?.summary) run.lastOutcome.summary.stolen = runeId;
  addLog(run, `Rune volée au grimoire ennemi : « ${RUNES[runeId].name} ».`);
  return run;
}

/**
 * Prend l'or plutôt qu'une rune (ou parce que le grimoire n'a rien de neuf) : +25 or.
 * Sans effet s'il n'y a pas de choix en attente (pas de double paiement).
 * @param {Run} run
 * @returns {Run}
 */
export function skipSteal(run) {
  const p = run.pendingSteal;
  if (!p) return run;
  run.pendingSteal = null;
  const x = gainGold(run, CAMPAIGN.stealFallbackGold);
  if (run.lastOutcome?.summary) run.lastOutcome.summary.stolen = null;
  addLog(run, p.runes?.length ? `Le grimoire ennemi est revendu : +${x} or.` : `Rien de neuf dans le grimoire ennemi : +${x} or.`);
  return run;
}

// ------------------------------------------------------------------ Marchand
const listFr = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`);
/** « Perception · Vrai si… Réservée aux tireurs et lanceurs de sorts. » */
function runeOfferDesc(id) {
  const r = RUNES[id];
  const family = RUNE_KIND_INFO[r.kind]?.name;
  let s = `${family ? `${family} · ` : ''}${r.help ?? ''}`;
  if (r.classes?.length) s += ` Réservée aux ${listFr(r.classes.map(c => CLASSES[c]?.plural ?? c))}.`;
  return s;
}

function recruitOffers(run, node, types, salt) {
  const reserved = [];
  return types.map((type, i) => {
    const name = pickName(run, type, createRng(deriveSeed(node.seed, salt, i)), reserved);
    reserved.push(name);
    return {
      id: `${node.id}:unit:${i}:${type}`, kind: 'unit', unitType: type, unitName: name,
      price: UNITS[type].cost,
      label: fr(name), desc: fr(`${UNITS[type].name} — ${unitStats(type)}. ${UNITS[type].desc}`), sold: false,
    };
  });
}

function computeShopOffers(run, node) {
  const rng = createRng(deriveSeed(node.seed, 'marchand'));
  const offers = [];
  // Ordre de toutes les runes verrouillables fixé par la graine du nœud, puis on saute celles déjà connues.
  const lockable = RUNE_ORDER.filter(id => !STARTER_RUNES.includes(id));
  const runes = rngShuffle(rng, lockable).filter(id => !run.unlocked.includes(id)).slice(0, 3);
  for (const id of runes) {
    const r = RUNES[id];
    offers.push({
      id: `${node.id}:rune:${id}`, kind: 'rune', runeId: id, glyph: r.glyph,
      price: Number.isFinite(r.price) ? r.price : 50,
      label: fr(`Rune « ${r.name} »`), desc: fr(runeOfferDesc(id)), sold: false,
    });
  }
  offers.push(...recruitOffers(run, node, rngShuffle(rng, recruitableTypes()).slice(0, 2), 'recrue'));
  if (run.ravens < MAX_RAVENS) {
    offers.push({
      id: `${node.id}:raven`, kind: 'raven', price: CAMPAIGN.ravenPrice,
      label: fr('Un corbeau de plus'),
      desc: fr(`Porte un nouvel ordre en pleine bataille. ${run.ravens} → ${run.ravens + 1} corbeaux par bataille (au plus ${MAX_RAVENS}).`),
      sold: false,
    });
  }
  return offers;
}

/**
 * Marchandises d'un marchand : 3 runes verrouillées (prix RUNES[id].price), 2 recrues (coût de l'unité),
 * +1 corbeau (60 or) si l'on en a moins de MAX_RAVENS. Déterministe selon node.seed ; pour le marchand
 * courant, renvoie le stock figé à l'entrée avec les articles vendus marqués `sold: true`.
 * @param {Run} run
 * @param {CampaignNode|string} [node] (par défaut : nœud courant)
 * @returns {Offer[]} copies (les modifier n'affecte pas le run)
 */
export function shopOffers(run, node) {
  node = resolveNodeArg(run, node);
  if (!node || node.kind !== 'shop') return [];
  if (run.shop && run.shop.nodeId === node.id) return clone(run.shop.offers);
  return computeShopOffers(run, node);
}

/** Textes du quartier-maître du feu de camp (pour l'écran du feu de camp). */
export const QUARTERMASTER = {
  name: 'Le quartier-maître',
  desc: fr('Une compagnie attend preneur au bivouac : elle se loue au prix du marché, en plus de votre nuit de repos.'),
};

// Quartier-maître du feu de camp : une compagnie à louer au prix du marché (en plus du repos, qui reste gratuit).
function computeCampOffers(run, node) {
  const rng = createRng(deriveSeed(node.seed, 'quartier-maître'));
  return recruitOffers(run, node, [rngPick(rng, recruitableTypes())], 'quartier-maître');
}

/**
 * Recrue du quartier-maître d'un feu de camp : 1 unité recrutable au coût de l'unité, achetée avec buyOffer
 * (indépendamment de méditer / forger). Déterministe selon node.seed ; pour le feu courant, renvoie le stock figé
 * à l'entrée avec les recrues engagées marquées `sold: true`.
 * @param {Run} run
 * @param {CampaignNode|string} [node] (par défaut : nœud courant)
 * @returns {Offer[]} copies
 */
export function campOffers(run, node) {
  node = resolveNodeArg(run, node);
  if (!node || node.kind !== 'camp') return [];
  if (run.shop && run.shop.nodeId === node.id) return clone(run.shop.offers);
  return computeCampOffers(run, node);
}

/**
 * Achète une marchandise du marchand courant, ou engage une recrue du quartier-maître du feu de camp courant
 * (objet Offer ou son id). Recrue : nouvelle unité avec le programme par défaut de son type.
 * Marque aussi `offer.sold = true`.
 * @param {Run} run
 * @param {Offer|string} offer
 * @returns {{ ok: boolean, reason?: string, run: Run, text?: string, unit?: RosterUnit }}
 */
export function buyOffer(run, offer) {
  const fail = (reason) => ({ ok: false, reason: fr(reason), run });
  if (run.status !== 'active') return fail('La campagne est terminée.');
  const node = currentNode(run);
  if (!node || (node.kind !== 'shop' && node.kind !== 'camp')) return fail('Il n’y a pas de marchand ici.');
  const offerId = typeof offer === 'string' ? offer : offer?.id;
  const offers = run.shop && run.shop.nodeId === node.id ? run.shop.offers
    : node.kind === 'shop' ? computeShopOffers(run, node) : computeCampOffers(run, node);
  const stock = offers.find(o => o.id === offerId);
  if (!stock) return fail('Ce marchand ne vend pas cela.');
  if (stock.sold) return fail('Déjà vendu.');
  if (run.gold < stock.price) return fail(`Pas assez d’or : il en faut ${stock.price}, vous en avez ${run.gold}.`);
  if (stock.kind === 'rune' && run.unlocked.includes(stock.runeId)) return fail('Vous connaissez déjà cette rune.');
  if (stock.kind === 'unit' && run.roster.length >= MAX_ROSTER) return fail(`Votre armée est au complet (${MAX_ROSTER} unités).`);
  if (stock.kind === 'unit' && !UNITS[stock.unitType]) return fail('Recrue inconnue.');
  if (stock.kind === 'raven' && run.ravens >= MAX_RAVENS) return fail(`Vous avez déjà ${MAX_RAVENS} corbeaux, le maximum.`);

  if (!run.shop || run.shop.nodeId !== node.id) run.shop = { nodeId: node.id, offers };
  spendGold(run, stock.price);
  stock.sold = true;
  if (offer && typeof offer === 'object') offer.sold = true;
  let text, unit;
  if (stock.kind === 'rune') {
    unlockRune(run, stock.runeId);
    text = `Vous apprenez la rune « ${RUNES[stock.runeId].name} ».`;
    addLog(run, `Marchand : rune « ${RUNES[stock.runeId].name} » pour ${stock.price} or.`);
  } else if (stock.kind === 'unit') {
    unit = addRecruit(run, stock.unitType, stock.unitName);
    text = `${The(unit)} ${vb(unit, 'rejoint', 'rejoignent')} l’armée.`;
    addLog(run, `Recrue : ${unit.name}, pour ${stock.price} or.`);
  } else {
    run.ravens += 1;
    text = `Un corbeau de plus : ${run.ravens} par bataille.`;
    addLog(run, `Marchand : un corbeau pour ${stock.price} or.`);
  }
  const res = { ok: true, run, text: fr(text) };
  if (unit) res.unit = clone(unit);
  return res;
}

// ------------------------------------------------------------------ Feu de camp
/**
 * Vérifie qu'une action de feu de camp est possible.
 * @param {Run} run
 * @param {{ kind: 'meditate'|'forge', uid: string }} choice
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canCamp(run, { kind, uid } = {}) {
  const fail = (reason) => ({ ok: false, reason: fr(reason) });
  if (run.status !== 'active') return fail('La campagne est terminée.');
  const node = currentNode(run);
  if (!node || node.kind !== 'camp') return fail('Il n’y a pas de feu de camp ici.');
  if (run.campUsed) return fail('La nuit est passée : il faut reprendre la route.');
  if (kind !== 'meditate' && kind !== 'forge') return fail('Choisissez de méditer ou de forger.');
  const u = findUnit(run, uid);
  if (!u) return fail('Unité introuvable.');
  if (kind === 'meditate' && !canGainSlot(u)) return fail(`${The(u)} ${vb(u, 'a', 'ont')} déjà gagné ${CAMPAIGN.maxSlotBonus} emplacements : c’est le maximum.`);
  if (kind === 'forge' && !canGainAtk(u)) return fail(`Les armes ${of(u)} ont déjà été reforgées.`);
  return { ok: true };
}

/**
 * Feu de camp (une seule fois par feu) : « meditate » = +1 emplacement permanent (max +2 par unité),
 * « forge » = +1 attaque permanente (max +1 par unité).
 * @param {Run} run
 * @param {{ kind: 'meditate'|'forge', uid: string }} choice
 * @returns {{ ok: boolean, reason?: string, run: Run, text?: string }}
 */
export function applyCamp(run, choice = {}) {
  const check = canCamp(run, choice);
  if (!check.ok) return { ok: false, reason: check.reason, run };
  const u = findUnit(run, choice.uid);
  let text;
  if (choice.kind === 'meditate') {
    u.bonus.slots += 1;
    text = `${The(u)} ${vb(u, 'médite', 'méditent')} au coin du feu jusqu’à l’aube : ${unitSlots(u)} emplacements de runes.`;
  } else {
    u.bonus.atk += 1;
    text = `Toute la nuit, le marteau sonne sur l’enclume. Les armes ${of(u)} sont reforgées : ${unitAtk(u)} en attaque.`;
  }
  run.campUsed = true;
  addLog(run, text);
  return { ok: true, run, text: fr(text) };
}

// ------------------------------------------------------------------ Événements
// Chaque définition : setup(run, rng) -> ctx (données figées au tirage), text(run, ctx),
// choices[] : { id, label, desc, check?(run, ctx) -> raison|null, apply(run, ctx, rng) -> texte }.
// label/desc/text peuvent être des chaînes ou des fonctions (run, ctx).
const pickUid = (run, rng, pred) => { const c = run.roster.filter(pred); return c.length ? rngPick(rng, c).uid : null; };
const pickLocked = (run, rng) => { const l = lockedRunes(run); return l.length ? rngPick(rng, l) : null; };
const runeName = (id) => RUNES[id]?.name ?? id;

const EVENT_DEFS = [
  {
    id: 'corbeau_blesse',
    title: 'Un corbeau blessé',
    eligible: (run) => run.ravens < MAX_RAVENS,
    text: 'Au bord du chemin, un corbeau à l’aile brisée se débat dans les ronces. Un anneau de cuivre gobelin serre un billet roulé autour de sa patte.',
    choices: [
      { id: 'soigner', label: 'Le soigner',
        desc: (run) => `Une attelle, quelques jours de patience, et il volera pour vous. +1 corbeau (${run.ravens} → ${run.ravens + 1}).`,
        check: (run) => (run.ravens >= MAX_RAVENS ? `Vous avez déjà ${MAX_RAVENS} corbeaux.` : null),
        apply: (run) => { run.ravens += 1; return `Il mord la main qui le soigne, puis finit par manger dans la vôtre. Vous disposez désormais de ${run.ravens} corbeaux par bataille.`; } },
      { id: 'billet', label: 'Lire le billet et le laisser filer',
        desc: 'Les gobelins écrivent mal, mais ils comptent bien. +40 or.',
        apply: (run) => { gainGold(run, 40); return 'Le billet indique une cache de butin sous le vieux pont. Vous y trouvez 40 pièces ; le corbeau, lui, s’est envolé vers l’est.'; } },
    ],
  },
  {
    id: 'sanctuaire',
    title: 'Le sanctuaire des runes',
    setup: (run, rng) => ({ rune: pickLocked(run, rng), uid: pickUid(run, rng, canGainSlot) }),
    text: 'Une pierre levée, mangée de mousse, porte des runes que personne n’a tracées depuis des siècles. Elles luisent faiblement à votre approche, comme si elles attendaient quelqu’un.',
    choices: [
      { id: 'offrande', label: 'Déposer une offrande (30 or)',
        desc: (run, ctx) => (ctx.rune ? `La pierre enseigne à qui la paie : vous apprendrez la rune « ${runeName(ctx.rune)} ».` : 'La pierre n’a plus rien à vous apprendre.'),
        check: (run, ctx) => (!ctx.rune || run.unlocked.includes(ctx.rune) ? 'Vous connaissez déjà toutes ces runes.' : run.gold < 30 ? 'Il vous faut 30 or.' : null),
        apply: (run, ctx) => { spendGold(run, 30); unlockRune(run, ctx.rune); return `Les pièces s’enfoncent dans la mousse. Quand vous relevez les yeux, la rune « ${runeName(ctx.rune)} » est gravée dans votre mémoire aussi nettement que dans la pierre.`; } },
      { id: 'mediter',
        label: (run, ctx) => { const u = findUnit(run, ctx.uid); return u ? `Laisser ${the(u)} méditer` : 'Méditer devant la pierre'; },
        desc: (run, ctx) => { const u = findUnit(run, ctx.uid); return u ? `Une nuit devant la pierre : +1 emplacement de rune pour ${the(u)}, pour toujours.` : 'Une nuit devant la pierre.'; },
        check: (run, ctx) => { const u = findUnit(run, ctx.uid); return !u || !canGainSlot(u) ? 'Aucune de vos unités ne peut contenir davantage de runes.' : null; },
        apply: (run, ctx) => { const u = findUnit(run, ctx.uid); u.bonus.slots += 1; return `${The(u)} ${vb(u, 'veille', 'veillent')} devant la pierre jusqu’à l’aube. +1 emplacement de rune : ${unitSlots(u)} au total.`; } },
    ],
  },
  {
    id: 'deserteurs',
    title: 'Déserteurs gobelins',
    setup: (run, rng) => ({ rune: pickLocked(run, rng), escape: rngChance(rng, 0.5) }),
    text: 'Trois gobelins agitent un chiffon blanc au bout d’une lance. Ils jurent avoir quitté la horde et offrent ce qu’ils savent en échange de leur vie.',
    choices: [
      { id: 'ecouter', label: 'Les épargner et les écouter',
        desc: (run, ctx) => (ctx.rune && !run.unlocked.includes(ctx.rune)
          ? `Ils connaissent les runes du Chef de guerre : vous apprendrez « ${runeName(ctx.rune)} ».`
          : 'Ils connaissent une cache où la horde garde son butin. +30 or.'),
        apply: (run, ctx) => {
          if (ctx.rune && unlockRune(run, ctx.rune)) return `Le plus vieux trace la rune « ${runeName(ctx.rune)} » dans la boue avec une griffe, puis les trois disparaissent dans les fougères.`;
          gainGold(run, 30); return 'Ils vous mènent à une souche creuse pleine de pièces volées : +30 or. Puis ils disparaissent dans les fougères.';
        } },
      { id: 'depouiller', label: 'Les dépouiller',
        desc: 'Leurs bourses sont lourdes : +45 or. Mais si l’un d’eux s’échappe, la horde sera prévenue (à la prochaine bataille, un corbeau ennemi et une bande de lanciers de plus).',
        apply: (run, ctx) => {
          gainGold(run, 45);
          if (ctx.escape) { run.mods.enemyRavens += 1; run.mods.enemyTroop = (run.mods.enemyTroop ?? 0) + 1; return 'Vous comptez 45 pièces volées sur les routes du Royaume. Pendant ce temps, le plus petit a filé : à la prochaine bataille, l’ennemi aura un corbeau et une bande de lanciers de plus.'; }
          return 'Vous comptez 45 pièces volées sur les routes du Royaume. Aucun ne s’est échappé.';
        } },
    ],
  },
  {
    id: 'compagnie_franche',
    title: 'La compagnie franche',
    setup: (run, rng) => {
      const type = rngPick(rng, recruitableTypes());
      return { type, name: pickName(run, type, rng), price: Math.max(5, Math.round(UNITS[type].cost * MERCENARY_DISCOUNT / 5) * 5), uid: pickUid(run, rng, canGainAtk) };
    },
    text: 'Au carrefour, une compagnie de mercenaires attend preneur, assise sur ses boucliers. Leur sergent vous jauge d’un œil las : « La horde paie mal. Le Royaume paie-t-il mieux ? »',
    choices: [
      { id: 'engager', label: (run, ctx) => `Engager ${the(ctx.name)} (${ctx.price} or)`,
        desc: (run, ctx) => `${UNITS[ctx.type].name} — ${unitStats(ctx.type)}. Bien moins cher qu’au marché (${UNITS[ctx.type].cost} or).`,
        check: (run, ctx) => (run.roster.length >= MAX_ROSTER ? `Votre armée est au complet (${MAX_ROSTER} unités).` : run.gold < ctx.price ? `Il vous faut ${ctx.price} or.` : null),
        apply: (run, ctx) => { spendGold(run, ctx.price); const u = addRecruit(run, ctx.type, ctx.name); return `${The(u)} ${vb(u, 'rejoint', 'rejoignent')} vos rangs. Le sergent compte les pièces deux fois, puis crache par terre en signe de contrat.`; } },
      { id: 'entrainer', label: 'Échanger des passes d’armes',
        desc: (run, ctx) => { const u = findUnit(run, ctx.uid); return u ? `Leur sergent entraîne ${the(u)} : +1 attaque, pour toujours.` : 'Leur sergent a l’œil, mais vos troupes n’ont plus rien à apprendre.'; },
        check: (run, ctx) => { const u = findUnit(run, ctx.uid); return !u || !canGainAtk(u) ? 'Vos troupes n’ont plus rien à apprendre d’eux.' : null; },
        apply: (run, ctx) => { const u = findUnit(run, ctx.uid); u.bonus.atk += 1; return `Une journée de coups, de bleus et de jurons. ${The(u)} ${vb(u, 'frappe', 'frappent')} désormais plus fort : ${unitAtk(u)} en attaque.`; } },
    ],
  },
  {
    id: 'forge_abandonnee',
    title: 'La forge abandonnée',
    setup: (run, rng) => ({ uid: pickUid(run, rng, canGainAtk), lucky: rngChance(rng, 0.6) }),
    text: 'Une forge à flanc de colline, quittée à la hâte. Sous la cendre, les braises sont encore tièdes ; l’enclume porte le sceau du Royaume.',
    choices: [
      { id: 'reforger',
        label: (run, ctx) => { const u = findUnit(run, ctx.uid); return u ? `Reforger les armes ${of(u)} (20 or)` : 'Reforger des armes (20 or)'; },
        desc: '+1 attaque, pour toujours.',
        check: (run, ctx) => { const u = findUnit(run, ctx.uid); return !u || !canGainAtk(u) ? 'Toutes vos armes ont déjà été reforgées.' : run.gold < 20 ? 'Il vous faut 20 or.' : null; },
        apply: (run, ctx) => { const u = findUnit(run, ctx.uid); spendGold(run, 20); u.bonus.atk += 1; return `Le métal chante sous le marteau jusqu’à la nuit. ${The(u)} ${vb(u, 'frappe', 'frappent')} désormais plus fort : ${unitAtk(u)} en attaque.`; } },
      { id: 'fouiller', label: 'Fouiller l’atelier',
        desc: 'Un trésor dort peut-être sous l’établi : +50 or. Mais ceux qui ont pillé la forge rôdent peut-être encore (jusqu’à 25 or perdus).',
        apply: (run, ctx) => {
          if (ctx.lucky) { gainGold(run, 50); return 'Sous une dalle descellée, un coffret de pièces royales : +50 or.'; }
          const lost = spendGold(run, 25);
          return lost > 0
            ? `Les pillards gobelins reviennent chercher leur butin. Vous rompez le combat en abandonnant ${lost} or.`
            : 'Les pillards gobelins reviennent chercher leur butin. Vous rompez le combat sans rien perdre : vos bourses étaient déjà vides.';
        } },
    ],
  },
  {
    id: 'peage',
    title: 'Le péage du baron',
    setup: (run, rng) => ({ seen: rngChance(rng, 0.5) }),
    text: 'Une chaîne barre le pont de Vergesac. Le baron réclame un tribut à quiconque traverse ses terres, et ses arbalétriers vous observent depuis la tour.',
    choices: [
      { id: 'payer', label: 'Payer le tribut (30 or)',
        desc: 'Le baron vend aussi des nouvelles : il sait où perchent les corbeaux gobelins. L’ennemi aura un corbeau de moins à la prochaine bataille.',
        check: (run) => (run.gold < 30 ? 'Il vous faut 30 or.' : null),
        apply: (run) => { spendGold(run, 30); run.mods.enemyRavens -= 1; return 'Le baron empoche l’or et vous indique les perchoirs des corbeaux gobelins. Vos archers s’en chargent : à la prochaine bataille, l’ennemi aura un corbeau de moins.'; } },
      { id: 'forcer', label: 'Passer le gué de nuit',
        desc: 'Gratuit, si personne ne vous voit. Sinon, les arbalétriers viseront vos corbeaux.',
        apply: (run, ctx) => {
          if (!ctx.seen) return 'La lune reste cachée. Vous passez sans un bruit, les pieds gelés et la bourse intacte.';
          if (run.ravens > 1) { run.ravens -= 1; return `Un carreau siffle dans l’obscurité. L’un de vos corbeaux ne se relève pas : il vous en reste ${run.ravens}.`; }
          const lost = spendGold(run, 20);
          return lost > 0
            ? `Les arbalétriers vous repèrent. Vous ne passez qu’en abandonnant ${lost} or au péage.`
            : 'Les arbalétriers vous repèrent, mais vous n’avez rien qui vaille un carreau. Ils vous laissent passer en riant.';
        } },
    ],
  },
  {
    id: 'pelerin',
    title: 'Le pèlerin aveugle',
    setup: (run, rng) => ({ rune: pickLocked(run, rng) }),
    text: 'Un vieillard aux yeux laiteux se tient au milieu de la route. « Je sens le poids des runes sur vous, capitaine. Une pièce, et je vous en apprendrai une autre. »',
    choices: [
      { id: 'aumone', label: 'Lui donner 20 or',
        desc: 'Il prétend connaître une rune qui vous manque.',
        check: (run, ctx) => (!ctx.rune || run.unlocked.includes(ctx.rune) ? 'Vous connaissez déjà toutes les runes qu’il pourrait vous apprendre.' : run.gold < 20 ? 'Il vous faut 20 or.' : null),
        apply: (run, ctx) => { spendGold(run, 20); unlockRune(run, ctx.rune); return `Il trace du doigt, dans la poussière, une rune que vous n’aviez jamais vue : « ${runeName(ctx.rune)} ». Quand vous relevez la tête, il est déjà loin.`; } },
      { id: 'escorter', label: 'L’escorter jusqu’au hameau',
        desc: 'Une journée de détour. Les villageois savent se montrer reconnaissants : +30 or.',
        apply: (run) => { gainGold(run, 30); return 'Au hameau, on le reconnaît et on l’embrasse. Les anciens insistent pour vous payer le détour : +30 or.'; } },
    ],
  },
  {
    id: 'cairn',
    title: 'Le cairn des rois',
    setup: (run, rng) => {
      const cmd = run.roster.find(u => UNITS[u.type]?.cls === 'commander' && canGainSlot(u));
      return { uid: cmd ? cmd.uid : pickUid(run, rng, canGainSlot), curse: rngChance(rng, 0.5) };
    },
    text: 'Sous un tertre éventré dorment des rois dont nul ne sait plus les noms. L’or luit entre les pierres, et le vent qui sort de la brèche est glacé.',
    choices: [
      { id: 'piller', label: 'Piller les tombes',
        desc: '+60 or. On dit que les rois morts n’aiment pas qu’on les dépouille : vous pourriez y perdre un corbeau.',
        apply: (run, ctx) => {
          gainGold(run, 60);
          if (ctx.curse && run.ravens > 1) { run.ravens -= 1; return `Vous emportez 60 pièces d’or ancien. Au moment de repartir, l’un de vos corbeaux s’envole vers le tertre et n’en revient pas : il vous en reste ${run.ravens}.`; }
          return 'Vous emportez 60 pièces d’or ancien. Le vent glacé vous suit jusqu’au camp, puis se tait.';
        } },
      { id: 'honorer', label: 'Honorer les morts',
        desc: (run, ctx) => { const u = findUnit(run, ctx.uid); return u ? `Un chant pour les rois oubliés. Cette nuit, ${the(u)} ${vb(u, 'rêvera', 'rêveront')} de batailles anciennes : +1 emplacement de rune.` : 'Un chant pour les rois oubliés.'; },
        check: (run, ctx) => { const u = findUnit(run, ctx.uid); return !u || !canGainSlot(u) ? 'Vos unités ne peuvent contenir davantage de runes.' : null; },
        apply: (run, ctx) => { const u = findUnit(run, ctx.uid); u.bonus.slots += 1; return `Vous refermez la brèche et chantez pour les rois oubliés. Cette nuit-là, ${the(u)} ${vb(u, 'rêve', 'rêvent')} de batailles anciennes : ${unitSlots(u)} emplacements de runes au réveil.`; } },
    ],
  },
  {
    id: 'village_brule',
    title: 'Le village brûlé',
    setup: (run, rng) => {
      const village = rngPick(rng, ['Fresnaye', 'Morteau', 'Clairbois', 'Saint-Ours', 'Brumeval']);
      return { village, name: run.roster.some(u => u.name === `Milice de ${village}`) ? null : `Milice de ${village}` };
    },
    text: (run, ctx) => `Des fumées montent encore des toits de chaume de ${ctx.village}. Les pillards sont partis ; quelques jeunes gens armés de fourches veulent venger leurs morts.`,
    choices: [
      { id: 'enroler', label: 'Enrôler les volontaires',
        desc: (run, ctx) => `Des fourches et du courage : ${ctx.name ? the(ctx.name) : 'une milice'} rejoindra l’armée comme piquiers, sans solde.`,
        check: (run) => (run.roster.length >= MAX_ROSTER ? `Votre armée est au complet (${MAX_ROSTER} unités).` : null),
        apply: (run, ctx) => { const u = addRecruit(run, 'k_pikemen', ctx.name ?? undefined); return `${The(u)} prête serment devant les cendres. Vos piquiers comptent une bannière de plus.`; } },
      { id: 'aider', label: 'Aider les survivants',
        desc: (run) => (run.ravens < MAX_RAVENS
          ? 'Une journée à éteindre les braises et à enterrer les morts. Le pigeonnier a survécu : +1 corbeau.'
          : 'Une journée à éteindre les braises et à enterrer les morts. On vous remerciera comme on peut : +20 or.'),
        apply: (run) => {
          if (run.ravens < MAX_RAVENS) { run.ravens += 1; return `En partant, une vieille femme vous tend une cage d’osier. Le corbeau qu’elle contient a connu des jours meilleurs, mais il vole : ${run.ravens} corbeaux par bataille.`; }
          gainGold(run, 20); return 'En partant, les survivants vous tendent une bourse qu’ils n’ont pas les moyens de donner. Vous la prenez pour ne pas les offenser : +20 or.';
        } },
    ],
  },
  {
    id: 'charrette',
    title: 'La charrette renversée',
    setup: (run, rng) => ({ rich: rngChance(rng, 0.5) }),
    text: 'Une charrette gît dans le fossé, une roue brisée. Son conducteur, coincé sous le timon, vous appelle à l’aide ; la cargaison est bâchée et soigneusement ficelée.',
    choices: [
      { id: 'aider', label: 'Dégager le marchand',
        desc: 'Il saura se montrer reconnaissant : +25 or.',
        apply: (run) => { gainGold(run, 25); return 'Il faut quatre hommes pour soulever le timon. Le marchand, la jambe en attelle, vous paie 25 or et vous bénit sur sept générations.'; } },
      { id: 'cargaison', label: 'Inspecter la cargaison',
        desc: 'Personne ne vous en empêchera. Mais une bâche cache parfois peu de chose : entre 10 et 60 or.',
        apply: (run, ctx) => {
          if (ctx.rich) { gainGold(run, 60); return 'Des lingots d’étain et une bourse cousue dans la bâche : +60 or. Le marchand vous maudit jusqu’à ce que vous soyez hors de vue.'; }
          gainGold(run, 10); return 'Du mauvais vin et des sabots. Vous en tirez 10 or au prochain village, et un peu de honte.';
        } },
    ],
  },
];

/** Identifiants des événements disponibles. */
export const EVENT_IDS = EVENT_DEFS.map(e => e.id);

const val = (x, run, ctx) => (typeof x === 'function' ? x(run, ctx) : x);

function materializeEvent(def, run, node, ctx) {
  return {
    id: def.id,
    nodeId: node.id,
    title: fr(def.title),
    text: fr(val(def.text, run, ctx)),
    choices: def.choices.map(c => {
      const reason = c.check ? c.check(run, ctx) : null;
      return { id: c.id, label: fr(val(c.label, run, ctx)), desc: fr(val(c.desc, run, ctx)), disabled: !!reason, reason: reason ? fr(reason) : null };
    }),
    ctx,
    resolved: null,
    outcome: null,
  };
}

function buildEvent(run, node, forcedId = null) {
  const order = rngShuffle(createRng(deriveSeed(node.seed, 'événement')), EVENT_DEFS);
  const seen = new Set(run.eventsSeen ?? []);
  const candidates = forcedId
    ? EVENT_DEFS.filter(d => d.id === forcedId)
    : [...order.filter(d => !seen.has(d.id)), ...order.filter(d => seen.has(d.id))];
  for (const def of candidates) {
    if (def.eligible && !def.eligible(run)) continue;
    const ctx = def.setup ? def.setup(run, createRng(deriveSeed(node.seed, 'événement', def.id))) : {};
    const ev = materializeEvent(def, run, node, clone(ctx) ?? {});
    if (ev.choices.some(c => !c.disabled)) return ev;
  }
  if (forcedId) return null;
  // Filet de sécurité (ne devrait jamais servir : « La charrette renversée » est toujours possible).
  return materializeEvent(EVENT_DEFS.find(d => d.id === 'charrette'), run, node, { rich: false });
}

/**
 * Événement d'un nœud « event » : { id, title, text, choices: [{ id, label, desc, disabled, reason }] }.
 * Déterministe selon node.seed ; pour le nœud courant, renvoie l'événement tiré à l'entrée.
 * Un choix `disabled` (or insuffisant…) affiche `reason` et ne peut pas être choisi.
 * @param {Run} run
 * @param {CampaignNode|string} [node] (par défaut : nœud courant)
 * @returns {GameEvent|null} copie
 */
export function rollEvent(run, node) {
  node = resolveNodeArg(run, node);
  if (!node || node.kind !== 'event') return null;
  if (run.event && run.event.nodeId === node.id) return clone(run.event);
  return buildEvent(run, node);
}

/**
 * Construit un événement précis (tests, outils de mise au point). null s'il n'est pas possible ici.
 * @returns {GameEvent|null}
 */
export function makeEvent(run, node, eventId) {
  node = resolveNodeArg(run, node);
  return node ? buildEvent(run, node, eventId) : null;
}

/**
 * Résout l'événement du nœud courant avec le choix donné. Renvoie le texte du dénouement.
 * Choix impossible : { ok: false, text: raison } et le run n'est pas modifié.
 * @param {Run} run
 * @param {GameEvent} event l'événement affiché (celui de rollEvent)
 * @param {string} choiceId
 * @returns {{ ok: boolean, run: Run, text: string }}
 */
export function resolveEvent(run, event, choiceId) {
  const node = currentNode(run);
  if (run.status !== 'active' || !node || node.kind !== 'event') return { ok: false, run, text: fr('Il n’y a pas d’événement ici.') };
  let ev = run.event && run.event.nodeId === node.id ? run.event : null;
  if (!ev) {
    ev = event && event.nodeId === node.id && EVENT_IDS.includes(event.id) ? clone(event) : buildEvent(run, node);
    run.event = ev;
  }
  if (ev.resolved) return { ok: false, run, text: ev.outcome ?? '' };
  const def = EVENT_DEFS.find(d => d.id === ev.id);
  const choice = def?.choices.find(c => c.id === choiceId);
  if (!choice) return { ok: false, run, text: fr('Ce choix n’existe pas.') };
  const reason = choice.check ? choice.check(run, ev.ctx) : null;
  if (reason) return { ok: false, run, text: fr(reason) };
  const text = fr(choice.apply(run, ev.ctx, createRng(deriveSeed(node.seed, 'dénouement', ev.id, choiceId))));
  ev.resolved = choiceId;
  ev.outcome = text;
  run.nodeDone = true;
  if (!run.eventsSeen.includes(ev.id)) run.eventsSeen.push(ev.id);
  addLog(run, `${ev.title} — ${text}`);
  return { ok: true, run, text };
}

// ------------------------------------------------------------------ Programmes de l'armée
/**
 * Remplace le programme d'une unité de l'armée après validation (slots, classes, runes débloquées).
 * @param {Run} run
 * @param {string} uid
 * @param {object} program
 * @returns {{ ok: boolean, reason?: string, errors?: string[], run: Run }}
 */
export function setUnitProgram(run, uid, program) {
  const u = findUnit(run, uid);
  if (!u) return { ok: false, reason: fr('Unité introuvable.'), errors: ['Unité introuvable.'], run };
  const v = validateProgram(program, u.type, { unlocked: run.unlocked, slotsBonus: u.bonus.slots });
  if (!v.ok) return { ok: false, reason: v.errors[0], errors: v.errors, run };
  u.program = cloneProgram(program);
  return { ok: true, run };
}

// ------------------------------------------------------------------ Sauvegarde
function storage() {
  try {
    const ls = globalThis.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch { return null; }
}

// Carte de campagne d'une sauvegarde : colonnes et nœuds cohérents (sinon la partie se bloquerait).
function validCampaignMap(map) {
  if (!map || typeof map.nodes !== 'object' || map.nodes === null || !Array.isArray(map.columns) || map.columns.length < 2) return false;
  const listed = new Set();
  for (const col of map.columns) {
    if (!Array.isArray(col) || !col.length) return false;
    for (const id of col) { if (typeof id !== 'string' || !map.nodes[id] || listed.has(id)) return false; listed.add(id); }
  }
  for (const [id, n] of Object.entries(map.nodes)) {
    if (!n || typeof n !== 'object' || n.id !== id || !listed.has(id) || !NODE_KINDS[n.kind]) return false;
    if (!Number.isInteger(n.col) || n.col < 0 || n.col >= map.columns.length || !map.columns[n.col].includes(id)) return false;
    if (!Array.isArray(n.next) || n.next.some(t => !map.nodes[t] || map.nodes[t].col !== n.col + 1)) return false;
    if (n.col < map.columns.length - 1 && !n.next.length) return false;
  }
  return true;
}

// Plan ennemi mémorisé d'une sauvegarde : gardé seulement s'il est bien formé (sinon l'IA le recalcule).
function validBattlePlan(bp, run) {
  if (!bp || typeof bp !== 'object' || bp.nodeId !== run.position || run.nodeDone !== false || typeof bp.key !== 'string') return false;
  const p = bp.plan;
  if (!p || typeof p !== 'object' || p.faction !== 'gobelins' || typeof p.doctrine?.id !== 'string' || !Number.isInteger(p.ravens)) return false;
  if (!Array.isArray(p.units) || !p.units.length || p.units.length > 24) return false;
  try {
    return p.units.every(u => UNITS[u?.type]?.faction === 'gobelins' && Number.isInteger(u.q) && Number.isInteger(u.r)
      && validateProgram(u.program, u.type, { unlocked: null }).ok);
  } catch { return false; }
}

/**
 * Normalise un run lu depuis une sauvegarde (champs manquants, valeurs hors bornes, programmes
 * invalides). null si ce n'est pas un run de la version courante, ou si la sauvegarde est trop abîmée pour
 * être jouée (carte incohérente, armée sans commandant).
 * @param {any} raw
 * @returns {Run|null}
 */
export function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== RUN_VERSION) return null;
  const map = raw.map;
  if (!validCampaignMap(map) || !Array.isArray(raw.roster)) return null;
  const outcomeOk = raw.lastOutcome && typeof raw.lastOutcome === 'object' && typeof raw.lastOutcome.nodeId === 'string'
    && raw.lastOutcome.summary && typeof raw.lastOutcome.summary === 'object' && typeof raw.lastOutcome.summary.won === 'boolean';
  const run = {
    version: RUN_VERSION,
    seed: raw.seed ?? 0,
    gold: Math.max(0, toInt(raw.gold)),
    ravens: clamp(toInt(raw.ravens, START_RAVENS.player), 1, MAX_RAVENS),
    roster: [],
    unlocked: [...new Set([...STARTER_RUNES, ...(Array.isArray(raw.unlocked) ? raw.unlocked : []).filter(id => RUNES[id])])],
    map,
    position: typeof raw.position === 'string' && map.nodes[raw.position] ? raw.position : null,
    visited: (Array.isArray(raw.visited) ? raw.visited : []).filter(id => map.nodes[id]),
    battlesWon: Math.max(0, toInt(raw.battlesWon)),
    status: ['active', 'won', 'lost'].includes(raw.status) ? raw.status : 'active',
    log: (Array.isArray(raw.log) ? raw.log : []).filter(s => typeof s === 'string').slice(-LOG_MAX),
    nextUid: 1,
    nodeDone: raw.nodeDone !== false,
    campUsed: !!raw.campUsed,
    shop: raw.shop && typeof raw.shop === 'object' && Array.isArray(raw.shop.offers) ? raw.shop : null,
    event: raw.event && typeof raw.event === 'object' && EVENT_IDS.includes(raw.event.id) ? raw.event : null,
    pendingSteal: outcomeOk && raw.pendingSteal && Array.isArray(raw.pendingSteal.runes)
      ? { ...raw.pendingSteal, runes: raw.pendingSteal.runes.filter(id => RUNES[id]) } : null,
    lastOutcome: outcomeOk ? raw.lastOutcome : null,
    battlePlan: null,
    eventsSeen: (Array.isArray(raw.eventsSeen) ? raw.eventsSeen : []).filter(id => EVENT_IDS.includes(id)),
    mods: { enemyRavens: clamp(toInt(raw.mods?.enemyRavens), -MAX_RAVENS, MAX_RAVENS), enemyTroop: clamp(toInt(raw.mods?.enemyTroop), 0, 3) },
    stats: { ...blankStats(), ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) },
  };
  const uids = new Set();
  let maxUid = 0;
  for (const u of raw.roster) {
    if (!u || !UNITS[u.type] || uids.has(String(u.uid))) continue;
    const uid = String(u.uid);
    uids.add(uid);
    const m = /^u(\d+)$/.exec(uid);
    if (m) maxUid = Math.max(maxUid, Number(m[1]));
    const bonus = { atk: clamp(toInt(u.bonus?.atk), 0, CAMPAIGN.maxAtkBonus), slots: clamp(toInt(u.bonus?.slots), 0, CAMPAIGN.maxSlotBonus) };
    let program = u.program && Array.isArray(u.program.rules) ? u.program : cloneProgram(DEFAULT_PROGRAMS[u.type] ?? emptyProgram());
    if (!validateProgram(program, u.type, { unlocked: run.unlocked, slotsBonus: bonus.slots }).ok) {
      program = sanitizeProgram(program, u.type, { unlocked: run.unlocked, slotsBonus: bonus.slots });
    }
    run.roster.push({ uid, type: u.type, name: String(u.name || UNITS[u.type].name), program, bonus,
                      kills: Math.max(0, toInt(u.kills)), battles: Math.max(0, toInt(u.battles)) });
  }
  // Campagne en cours sans commandant : aucune bataille ne serait possible (une campagne perdue peut l'avoir perdu).
  if (run.status === 'active' && !run.roster.some(u => UNITS[u.type].cls === 'commander')) return null;
  run.nextUid = Math.max(toInt(raw.nextUid, 1), maxUid + 1);
  if (run.position && run.visited[run.visited.length - 1] !== run.position) run.visited.push(run.position);
  if (!run.position) run.nodeDone = true;
  if (validBattlePlan(raw.battlePlan, run)) run.battlePlan = raw.battlePlan;
  return run;
}

/**
 * Sauvegarde le run dans localStorage (clé 'runes.run.v1'). Ne lève jamais d'exception.
 * @returns {boolean} vrai si la sauvegarde a réussi
 */
export function saveRun(run) {
  try {
    const ls = storage();
    if (!ls || !run) return false;
    ls.setItem(SAVE_KEY, JSON.stringify(run));
    return true;
  } catch { return false; }
}

/**
 * Recharge la partie sauvegardée. null si absente, illisible, ou d'une autre version.
 * Fonctionne sans localStorage (Node, navigation privée) : renvoie null.
 * @returns {Run|null}
 */
export function loadRun() {
  try {
    const ls = storage();
    if (!ls) return null;
    const txt = ls.getItem(SAVE_KEY);
    if (!txt) return null;
    return normalizeRun(JSON.parse(txt));
  } catch { return null; }
}

/**
 * État de la sauvegarde, pour prévenir le joueur : 'none' (aucune ou stockage indisponible), 'ok' (lisible),
 * 'corrupt' (présente mais illisible, abîmée ou d'une autre version : loadRun renvoie null). Ne lève jamais.
 * @returns {'none'|'ok'|'corrupt'}
 */
export function savedRunStatus() {
  try {
    const ls = storage();
    const txt = ls ? ls.getItem(SAVE_KEY) : null;
    if (!txt) return 'none';
    return normalizeRun(JSON.parse(txt)) ? 'ok' : 'corrupt';
  } catch { return 'corrupt'; }
}

/** Efface la sauvegarde. Ne lève jamais d'exception. */
export function clearRun() {
  try { storage()?.removeItem(SAVE_KEY); } catch { /* stockage indisponible */ }
}

/** Vrai s'il existe une campagne en cours sauvegardée (pour le bouton « Reprendre »). */
export function hasSavedRun() {
  const r = loadRun();
  return !!r && r.status === 'active';
}
