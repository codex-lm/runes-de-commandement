// js/core/sim.js — moteur de bataille de « Runes de Commandement ».
// Module pur (aucun DOM, aucun three.js), déterministe à graine égale, état 100 % JSON-sérialisable :
// structuredClone(battle) (ou cloneBattle) donne une copie indépendante qui rejoue à l'identique.
// Règles : docs/GDD.md §4–7. Contrat : docs/INTERFACES.md (section « js/core/sim.js »).
//
// Un instant (stepBattle) :
//   1. Décision : chaque unité vivante lit ses règles sur l'instantané du début de l'instant
//      (première règle dont les conditions sont vraies ET dont l'action est réalisable ; sinon instinct).
//   2. Mouvement : MAX_SUBSTEPS sous-pas d'un hex au plus ; un hex visé doit être libre au début du sous-pas ;
//      conflit → cavalerie prioritaire puis tirage seedé ; deux alliés qui veulent l'hex l'un de l'autre s'échangent ;
//      une unité bloquée depuis un instant contourne (détour ≤ direct + 3) ou pousse un allié immobile ;
//      zone de contrôle (entrer au contact termine le mouvement ; au contact, seuls RETREAT/KITE permettent de partir ;
//      une unité de mêlée au contact attend le 2e sous-pas : si l'ennemi s'est éloigné entre-temps, elle peut le suivre).
//      Chemins : A* multi-buts interne sur tableaux typés (coûts = maputil.moveCost), plutôt que maputil.findPath,
//      pour viser un ensemble d'hex (« à portée de la cible », « une colline ») et rester sous ~0,1 ms par instant ;
//      à coût égal, le chemin le plus proche de la droite départ → cible (trajets droits, symétriques entre camps).
//   3. Combat : attaques et sorts sur les positions après mouvement ; tous les dégâts puis les soins sont appliqués
//      ensemble (un soin ne sauve pas une unité tuée au même instant : règle retenue, le GDD §5.3 est à préciser
//      dans ce sens ; l'inverse renforçait nettement le chaman de l'IA) ; les morts frappent quand même.
//   4. Fin : régénération, recharges, statuts, corbeaux (vol, interceptions, livraisons), victoire.
//
// Interprétations documentées (là où le GDD laisse du jeu) :
//   - TICK_AT_LEAST t : vrai quand au moins t instants sont terminés (battle.tick ≥ t au moment de décider).
//   - Points de mouvement : une unité qui n'a pas encore bougé et dont les PM sont au maximum (max(2, vitesse))
//     peut toujours entrer dans un hex, même s'il coûte plus (sinon la cavalerie ne pourrait jamais entrer en forêt).
//   - ATTACK/CHARGE/HOLD/FOLLOW/KITE/instinct frappent ; ADVANCE et RETREAT ne frappent jamais (« sans chercher le combat »).
//     Une unité qui attaque frappe sa cible si elle est à portée, sinon un autre ennemi à portée (le plus proche,
//     puis le plus faible). L'instinct sans cible au moment de décider frappe quand même un ennemi venu à portée.
//   - ADVANCE n'est pas applicable au contact d'un ennemi (elle ne peut pas bouger) ; CAST_* non plus si la cible est
//     hors de portée alors que le lanceur est au contact.
//   - CENTER = hexes praticables à ≤ 1 des deux hex centraux (colonnes du milieu), symétrique pour les deux camps.
//     HILL/FOREST/RUINS/FORD = hex libre le plus proche de ce terrain. ADVANCE marche vers `intent.dest` (l'hex que
//     montre le HUD), et vers tout le lieu seulement si cet hex n'est plus libre.
//   - Tireurs/lanceurs (ATTACK, CAST_ENEMY, CAST_ALLY) : si leur cible est hors de portée, ils prennent d'abord la
//     meilleure cible à portée selon le même sélecteur (s'il y en a une qui correspond) ; à portée, ils ne bougent pas.
//   - KITE : la distance à garder est plafonnée à la portée actuelle (sinon l'unité ne pourrait jamais tirer).
//   - Les auras (inspire / rage) ne s'appliquent qu'aux alliés, pas au commandant lui-même.
//   - Boule de feu : dégâts fixes (ignore toute défense), éclaboussure sur TOUTES les unités adjacentes à la cible,
//     lanceur compris s'il est adjacent. Le bonus de charge n'existe que pour le trait `charge` (CHARGE le double : +4).
//   - CHARGE : la cavalerie (trait `charge`) gagne +1 PM pour cet instant seulement (le reste est perdu en fin de
//     mouvement ; toujours 2 sous-pas au plus : utile pour franchir colline ou gué d'un trait) ; commandant et colosse
//     ne gagnent aucun PM mais un élan +1 en mêlée s'ils ont bougé (ignoré par `heavy`, comme la charge).
//   - Corbeaux : chaque tireur antiRaven tire une seule fois par corbeau, au premier instant où la portion de vol
//     de l'instant (segment de départ → arrivée) passe à ≤ 2 hex de lui ; le corbeau abattu tombe au point le plus
//     proche du tireur.
//   - Limite de temps : on compare la PART de sa valeur de départ que chaque camp a conservée (timeoutWinner), pas la
//     valeur absolue ; égalité → défaite du joueur (« l'attaquant doit l'emporter »). Sinon, une armée plus riche
//     gagnerait au temps sans jamais combattre.
//   - Statuts (Égide, Maléfice) : actifs pendant les `duration` instants qui suivent celui du lancer.
//     Recharges : un sort de recharge 3 lancé à l'instant t redevient prêt à l'instant t + 3.
import {
  UNITS, TERRAIN, SPELLS, RUNES, TARGETS, DEPLOY_COLS, MAP_W, MAX_TICKS, MAX_SUBSTEPS, START_RAVENS,
  RAVEN_SPEED_HEX, RAVEN_INTERCEPT_RANGE, RAVEN_INTERCEPT_CHANCE, STANDABLE_TERRAINS, DEFAULT_PROGRAMS,
} from './data.js';
import { DIRS, SQRT3, hexToWorld, directionIndex, offsetToAxial } from './hex.js';
import { moveCost } from './maputil.js';
import { createRng, rngInt, rngChance } from './rng.js';
import { cloneProgram, validateProgram, paramOptions, resolveParams } from './program.js';

const SIDES = ['player', 'enemy'];
const OPP = { player: 'enemy', enemy: 'player' };
const NO = 255;                       // coût « infranchissable » dans les tableaux de coûts
const ALLY_PEN = 3;                   // pénalité de chemin pour traverser un allié (il bougera peut-être)
const ZOC_PEN = 2;                    // pénalité pour passer au contact d'un ennemi quand ce n'est pas le but
const BACK_PEN = 2;                   // pénalité pour revenir sur l'hex qu'on vient de quitter (anti-oscillation)
const DETOUR_MAX = 3;                 // un détour autour d'alliés bloquants n'est pris que s'il coûte ≤ direct + 3
const EPS = 1e-9;
const isShooter = (cls) => cls === 'ranged' || cls === 'caster';
const TERRAIN_PLACE = { HILL: 'hill', FOREST: 'forest', RUINS: 'ruins', FORD: 'ford' };

/** Libellés français des modificateurs listés dans `attack.bonuses` (pour le HUD / les infobulles). */
export const BONUS_LABELS = {
  charge: 'Charge +2', charge2: 'Charge furieuse +4', elan: 'Élan +1', antiCavalry: 'Hérisson +3', hill: 'Hauteur +1',
  horde: 'Horde +1', rage: 'Rage +1', hexed: 'Maléfice −2', heavy: 'Inébranlable',
  forest: 'Forêt +1 déf', cover: 'Couvert +1 déf', ruins: 'Ruines +2 déf', ford: 'Gué −1 déf',
  holding: 'Tient +1 déf', exposed: 'Charge −1 déf', inspire: 'Inspiration +1 déf', ward: 'Égide +2 déf',
};

// =====================================================================================================
// Grille interne (cache par objet carte ; la carte n'est jamais modifiée par le moteur)
// =====================================================================================================
const gridCache = new WeakMap();

function getGrid(map) {
  let g = gridCache.get(map);
  if (!g || g.tilesLen !== map.tiles.length) { g = buildGrid(map); gridCache.set(map, g); }
  return g;
}

function buildGrid(map) {
  const w = map.w | 0, h = map.h | 0, n = w * h;
  const q = new Int16Array(n), r = new Int16Array(n), terrain = new Array(n).fill(null);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const a = offsetToAxial(col, row); q[row * w + col] = a.q; r[row * w + col] = a.r;
  }
  for (const t of map.tiles) {
    const col = t.q, row = t.r + (t.q - (t.q & 1)) / 2;
    if (col < 0 || col >= w || row < 0 || row >= h) continue;
    terrain[row * w + col] = t.terrain;
  }
  const costInf = new Uint8Array(n).fill(NO), costCav = new Uint8Array(n).fill(NO);
  const standable = new Uint8Array(n), def = new Int8Array(n), rangedDef = new Int8Array(n);
  const rangeBonus = new Int8Array(n), meleeAtk = new Int8Array(n), wx = new Float64Array(n), wz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const T = TERRAIN[terrain[i]];
    const wpos = hexToWorld(q[i], r[i]); wx[i] = wpos.x; wz[i] = wpos.z;
    if (!T) continue;
    if (T.passable) {
      costInf[i] = Math.min(254, moveCost(map, q[i], r[i], 'infantry'));
      costCav[i] = Math.min(254, moveCost(map, q[i], r[i], 'cavalry'));
    }
    standable[i] = T.passable && STANDABLE_TERRAINS.includes(terrain[i]) ? 1 : 0;
    def[i] = T.def | 0; rangedDef[i] = T.rangedDef | 0; rangeBonus[i] = T.rangeBonus | 0; meleeAtk[i] = T.meleeAtkBonus | 0;
  }
  const g = { w, h, n, q, r, terrain, costInf, costCav, standable, def, rangedDef, rangeBonus, meleeAtk, wx, wz,
    nb: new Int16Array(n * 6).fill(-1), comp: new Int16Array(n).fill(-1), places: {}, campHf: {}, tilesLen: map.tiles.length };
  for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) g.nb[i * 6 + k] = cellIndex(g, q[i] + DIRS[k].q, r[i] + DIRS[k].r);
  // Composantes connexes du terrain praticable (pour savoir si un lieu est atteignable).
  let cid = 0;
  for (let s = 0; s < n; s++) {
    if (g.costInf[s] === NO || g.comp[s] >= 0) continue;
    const stack = [s]; g.comp[s] = cid;
    while (stack.length) {
      const c = stack.pop();
      for (let k = 0; k < 6; k++) {
        const m = g.nb[c * 6 + k];
        if (m >= 0 && g.costInf[m] !== NO && g.comp[m] < 0) { g.comp[m] = cid; stack.push(m); }
      }
    }
    cid++;
  }
  ensureScratch(n);
  return g;
}

function cellIndex(g, q, r) {
  if (!Number.isInteger(q) || !Number.isInteger(r) || q < 0 || q >= g.w) return -1;
  const row = r + ((q - (q & 1)) >> 1);
  if (row < 0 || row >= g.h) return -1;
  return row * g.w + q;
}

function cdist(g, a, b) {
  const dq = g.q[a] - g.q[b], dr = g.r[a] - g.r[b], s = dq + dr;
  return ((dq < 0 ? -dq : dq) + (dr < 0 ? -dr : dr) + (s < 0 ? -s : s)) >> 1;
}

function euclid2(g, a, b) { const dx = g.wx[a] - g.wx[b], dz = g.wz[a] - g.wz[b]; return dx * dx + dz * dz; }

function facingTo(g, from, to) {
  for (let k = 0; k < 6; k++) if (g.nb[from * 6 + k] === to) return k;
  return directionIndex({ q: g.q[from], r: g.r[from] }, { q: g.q[to], r: g.r[to] });
}

// Colonnes de déploiement (miroir pour une carte de largeur différente de MAP_W).
function deployColsFor(g, side) {
  const cols = side === 'player' ? DEPLOY_COLS.player : DEPLOY_COLS.enemy.map(c => c - MAP_W + g.w);
  return cols.filter(c => c >= 0 && c < g.w);
}

/** Lieu → { mask, cells, hf } (hf = distance en hex au lieu). 'OWN_CAMP' est interne (repli). */
function getPlace(g, place, side) {
  const key = place === 'ENEMY_CAMP' || place === 'OWN_CAMP' ? `${place}:${side}` : place;
  if (key in g.places) return g.places[key];
  const cells = [];
  if (place === 'ENEMY_CAMP' || place === 'OWN_CAMP') {
    const cols = deployColsFor(g, place === 'ENEMY_CAMP' ? OPP[side] : side);
    for (let c = 0; c < g.n; c++) if (g.standable[c] && cols.includes(c % g.w)) cells.push(c);
  } else if (place === 'CENTER') {
    // Les deux hex du milieu (colonnes 6 et 7 sur 14) : zone symétrique par rotation de 180°, même trajet pour chaque camp.
    const row = Math.floor(g.h / 2), mids = [];
    for (const col of new Set([Math.floor((g.w - 1) / 2), Math.ceil((g.w - 1) / 2)])) {
      const a = offsetToAxial(col, row), c = cellIndex(g, a.q, a.r);
      if (c >= 0) mids.push(c);
    }
    for (let rad = 1; rad <= g.w + g.h && !cells.length; rad++) {
      for (let c = 0; c < g.n; c++) if (g.standable[c] && mids.some(m => cdist(g, c, m) <= rad)) cells.push(c);
    }
  } else if (TERRAIN_PLACE[place]) {
    for (let c = 0; c < g.n; c++) if (g.standable[c] && g.terrain[c] === TERRAIN_PLACE[place]) cells.push(c);
  } else { g.places[key] = null; return null; }
  const mask = new Uint8Array(g.n), hf = new Uint16Array(g.n).fill(999);
  for (const c of cells) mask[c] = 1;
  for (let c = 0; c < g.n; c++) for (const t of cells) { const d = cdist(g, c, t); if (d < hf[c]) hf[c] = d; }
  const P = { mask, cells, hf };
  g.places[key] = P;
  return P;
}

// ---------------------------------------------------------------- tampons de recherche (Dijkstra + tas binaire)
let S_N = 0, S_dist, S_prev, S_seen, S_lb, S_tb, S_heap, S_size = 0, S_stamp = 0;
function ensureScratch(n) {
  if (n <= S_N) return;
  S_N = n; S_dist = new Float64Array(n); S_prev = new Int32Array(n); S_seen = new Int32Array(n); S_lb = new Float64Array(n);
  S_tb = new Float64Array(n); S_heap = new Float64Array(n * 8 + 16);
}
function hpush(key) {
  const h = S_heap; let k = S_size++;
  while (k > 0) { const p = (k - 1) >> 1; if (h[p] <= key) break; h[k] = h[p]; k = p; }
  h[k] = key;
}
function hpop() {
  const h = S_heap, top = h[0], last = h[--S_size], n = S_size;
  let k = 0;
  for (;;) {
    let c = 2 * k + 1;
    if (c >= n) break;
    if (c + 1 < n && h[c + 1] < h[c]) c++;
    if (h[c] >= last) break;
    h[k] = h[c]; k = c;
  }
  if (n > 0) h[k] = last;
  return top;
}

// =====================================================================================================
// Contexte d'évaluation (index des positions, listes des vivants) — reconstruit à chaque instant / appel public
// =====================================================================================================
function makeCtx(battle) {
  const g = getGrid(battle.map);
  ensureScratch(g.n);
  const units = battle.units, nU = units.length;
  const occ = new Int16Array(g.n), cell = new Int16Array(nU).fill(-1);
  const alive = { player: [], enemy: [] }, commander = { player: -1, enemy: -1 }, ids = new Map();
  for (let i = 0; i < nU; i++) {
    const u = units[i];
    ids.set(u.id, i);
    if (!u.alive) continue;
    const c = cellIndex(g, u.q, u.r);
    if (c < 0) continue;                       // ne devrait jamais arriver (createBattle place tout le monde)
    cell[i] = c; occ[c] = i + 1;
    alive[u.side].push(i);
    if (u.cls === 'commander' && commander[u.side] < 0) commander[u.side] = i;
  }
  return { battle, g, units, occ, cell, alive, commander, ids, tickNow: battle.tick,
    zocP: new Uint8Array(g.n), zocE: new Uint8Array(g.n) };
}

const idxOf = (ctx, id) => (id == null ? -1 : (ctx.ids.get(id) ?? -1));

function unitIndex(ctx, unit) {
  if (!unit) return -1;
  const i = ctx.units.indexOf(unit);
  return i >= 0 ? i : idxOf(ctx, unit.id);
}

function adjacentEnemy(ctx, i) {
  const g = ctx.g, c = ctx.cell[i], side = ctx.units[i].side;
  for (let k = 0; k < 6; k++) {
    const n = g.nb[c * 6 + k];
    if (n >= 0) { const o = ctx.occ[n]; if (o && ctx.units[o - 1].side !== side) return true; }
  }
  return false;
}

function adjacentAllies(ctx, i) {
  const g = ctx.g, c = ctx.cell[i], side = ctx.units[i].side;
  let cnt = 0;
  for (let k = 0; k < 6; k++) {
    const n = g.nb[c * 6 + k];
    if (n >= 0) { const o = ctx.occ[n]; if (o && ctx.units[o - 1].side === side) cnt++; }
  }
  return cnt;
}

function minFoeDist(ctx, i, c) {
  let m = Infinity;
  for (const j of ctx.alive[OPP[ctx.units[i].side]]) { const d = cdist(ctx.g, c, ctx.cell[j]); if (d < m) m = d; }
  return m;
}

function nearestEnemy(ctx, i) {
  let best = -1, bd = Infinity;
  for (const j of ctx.alive[OPP[ctx.units[i].side]]) {
    const d = cdist(ctx.g, ctx.cell[i], ctx.cell[j]);
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

/** Portée d'attaque de l'unité i si elle se tenait sur l'hex c (bonus de colline pour tireurs/lanceurs). */
function attackRange(ctx, i, c) {
  const u = ctx.units[i];
  return (u.range | 0) + (isShooter(u.cls) ? ctx.g.rangeBonus[c] : 0);
}
function spellRange(ctx, i, spell, c) {
  const S = SPELLS[spell];
  return S ? (S.range | 0) + ctx.g.rangeBonus[c] : -1;
}
const inAttackRange = (ctx, i, j) => cdist(ctx.g, ctx.cell[i], ctx.cell[j]) <= attackRange(ctx, i, ctx.cell[i]);
const inSpellRange = (ctx, i, j, spell) => cdist(ctx.g, ctx.cell[i], ctx.cell[j]) <= spellRange(ctx, i, spell, ctx.cell[i]);

function auraNear(ctx, i, trait) {
  const u = ctx.units[i];
  for (const j of ctx.alive[u.side]) {
    if (j === i) continue;
    const a = ctx.units[j];
    if (a.traits.includes(trait) && cdist(ctx.g, ctx.cell[i], ctx.cell[j]) <= 2) return true;
  }
  return false;
}

// =====================================================================================================
// Paramètres de runes
// =====================================================================================================
function paramVal(runeId, params, key, unitType) {
  const v = params ? params[key] : undefined;
  if (v !== undefined && v !== null) return v;
  const rune = RUNES[runeId], p = rune && rune.params.find(x => x.key === key);
  if (!p) return null;
  if (p.default !== null && p.default !== undefined) return p.default;
  const opts = paramOptions(p, unitType);
  return opts.length ? opts[0].value : null;
}
function intParam(runeId, params, key, unitType) {
  const v = Number(paramVal(runeId, params, key, unitType));
  return Number.isFinite(v) ? v : 0;
}

// =====================================================================================================
// Sélecteurs de cibles (TARGETS / ALLY_TARGETS) — égalités : le plus proche, puis l'id le plus petit.
// `ok(j)` (facultatif) restreint les candidats (ex. : seulement ceux qui sont déjà à portée).
// =====================================================================================================
function selectEnemy(ctx, i, sel, ok) {
  const g = ctx.g, u = ctx.units[i], ci = ctx.cell[i];
  const T = TARGETS[sel];
  if (!T) return -1;
  let anchor = -1;
  if (sel === 'THREAT') { anchor = ctx.commander[u.side]; if (anchor < 0) return -1; }
  let best = -1, b1 = 0, b2 = 0;
  for (const j of ctx.alive[OPP[u.side]]) {
    if (ok && !ok(j)) continue;
    const t = ctx.units[j], d = cdist(g, ci, ctx.cell[j]);
    let k1;
    switch (sel) {
      case 'WEAKEST': k1 = t.hp; break;
      case 'STRONGEST': k1 = -(t.atk * t.hp); break;
      case 'COMMANDER': if (t.cls !== 'commander') continue; k1 = d; break;
      case 'THREAT': k1 = cdist(g, ctx.cell[anchor], ctx.cell[j]); break;
      case 'ISOLATED': if (adjacentAllies(ctx, j) > 0) continue; k1 = d; break;
      default:
        if (T.cls && !T.cls.includes(t.cls)) continue;
        k1 = d;
    }
    if (best < 0 || k1 < b1 || (k1 === b1 && d < b2)) { best = j; b1 = k1; b2 = d; }
  }
  return best;
}

function selectAlly(ctx, i, sel, excludeSelf, injuredOnly, ok) {
  const g = ctx.g, u = ctx.units[i], ci = ctx.cell[i];
  const hurt = (j) => ctx.units[j].hp < ctx.units[j].maxHp;
  switch (sel) {
    case 'SELF':
      return excludeSelf || (injuredOnly && !hurt(i)) || (ok && !ok(i)) ? -1 : i;
    case 'ALLY_COMMANDER': {
      const c = ctx.commander[u.side];
      if (c < 0 || (excludeSelf && c === i) || (injuredOnly && !hurt(c)) || (ok && !ok(c))) return -1;
      return c;
    }
    case 'ALLY_WEAKEST': {
      let best = -1, bh = 0, bm = 1, bd = 0;
      for (const j of ctx.alive[u.side]) {
        if ((excludeSelf && j === i) || !hurt(j) || (ok && !ok(j))) continue;
        const t = ctx.units[j], d = cdist(g, ci, ctx.cell[j]);
        // ratio t.hp/t.maxHp < bh/bm  ⇔  t.hp*bm < bh*t.maxHp (sans flottants)
        const cmp = best < 0 ? -1 : t.hp * bm - bh * t.maxHp;
        if (cmp < 0 || (cmp === 0 && d < bd)) { best = j; bh = t.hp; bm = t.maxHp; bd = d; }
      }
      return best;
    }
    case 'ALLY_NEAREST': case 'ALLY_COLOSSUS': {
      let best = -1, bd = Infinity;
      for (const j of ctx.alive[u.side]) {
        if (j === i || (injuredOnly && !hurt(j)) || (ok && !ok(j))) continue;
        if (sel === 'ALLY_COLOSSUS' && ctx.units[j].cls !== 'colossus') continue;
        const d = cdist(g, ci, ctx.cell[j]);
        if (d < bd) { bd = d; best = j; }
      }
      return best;
    }
    default: return -1;
  }
}

// =====================================================================================================
// Conditions
// =====================================================================================================
function evalCond(ctx, i, cond) {
  const rune = cond && RUNES[cond.id];
  if (!rune || rune.kind !== 'cond') return false;
  const u = ctx.units[i];
  if (rune.classes && !rune.classes.includes(u.cls)) return false;
  const v = condRaw(ctx, i, cond.id, cond.params, u);
  return cond.not ? !v : v;
}

function condRaw(ctx, i, id, pr, u) {
  const g = ctx.g, ci = ctx.cell[i], foes = ctx.alive[OPP[u.side]], friends = ctx.alive[u.side];
  switch (id) {
    case 'ENEMY_WITHIN': {
      const n = intParam(id, pr, 'n', u.type);
      for (const j of foes) if (cdist(g, ci, ctx.cell[j]) <= n) return true;
      return false;
    }
    case 'ENEMY_IN_RANGE': {
      const R = attackRange(ctx, i, ci);
      for (const j of foes) if (cdist(g, ci, ctx.cell[j]) <= R) return true;
      return false;
    }
    case 'HP_BELOW': return u.hp * 100 < intParam(id, pr, 'pct', u.type) * u.maxHp;
    case 'ALLY_HIT': {
      const n = intParam(id, pr, 'n', u.type);
      for (const j of friends) if (j !== i && ctx.units[j].hitLastTick && cdist(g, ci, ctx.cell[j]) <= n) return true;
      return false;
    }
    case 'ON_TERRAIN': return g.terrain[ci] === paramVal(id, pr, 'terrain', u.type);
    case 'CAN_CAST': {
      const s = paramVal(id, pr, 'spell', u.type);
      return !!s && u.spells.includes(s) && !((u.cooldowns[s] | 0) > 0);
    }
    case 'TICK_AT_LEAST': return ctx.tickNow >= intParam(id, pr, 't', u.type);
    case 'ENEMY_CLASS_WITHIN': {
      const cls = paramVal(id, pr, 'cls', u.type), n = intParam(id, pr, 'n', u.type);
      for (const j of foes) if (ctx.units[j].cls === cls && cdist(g, ci, ctx.cell[j]) <= n) return true;
      return false;
    }
    case 'ISOLATED_ENEMY_WITHIN': {
      const n = intParam(id, pr, 'n', u.type);
      for (const j of foes) if (cdist(g, ci, ctx.cell[j]) <= n && adjacentAllies(ctx, j) === 0) return true;
      return false;
    }
    case 'OUTNUMBERED': {
      const n = intParam(id, pr, 'n', u.type);
      let e = 0, a = 0;
      for (const j of foes) if (cdist(g, ci, ctx.cell[j]) <= n) e++;
      for (const j of friends) if (cdist(g, ci, ctx.cell[j]) <= n) a++;
      return e > a;
    }
    case 'COMMANDER_THREATENED': {
      const c = ctx.commander[u.side];
      if (c < 0) return false;
      const n = intParam(id, pr, 'n', u.type);
      for (const j of foes) if (cdist(g, ctx.cell[c], ctx.cell[j]) <= n) return true;
      return false;
    }
    case 'ALLY_HP_BELOW': {
      const pct = intParam(id, pr, 'pct', u.type), n = intParam(id, pr, 'n', u.type);
      for (const j of friends) {
        const t = ctx.units[j];
        if (j !== i && t.hp * 100 < pct * t.maxHp && cdist(g, ci, ctx.cell[j]) <= n) return true;
      }
      return false;
    }
    default: return false;
  }
}

function condsHold(ctx, i, rule) {
  const conds = Array.isArray(rule.conds) ? rule.conds : [];
  if (!conds.length) return true;
  if (rule.logic === 'OR') { for (const c of conds) if (evalCond(ctx, i, c)) return true; return false; }
  for (const c of conds) if (!evalCond(ctx, i, c)) return false;
  return true;
}

// =====================================================================================================
// Actions → intention (null = non réalisable, on passe à la règle suivante)
// =====================================================================================================
function actionIntent(ctx, i, action) {
  const rune = action && RUNES[action.id];
  if (!rune || rune.kind !== 'action') return null;
  const u = ctx.units[i], pr = action.params, id = action.id;
  if (rune.classes && !rune.classes.includes(u.cls)) return null;
  switch (id) {
    case 'ATTACK': case 'CHARGE': {
      const sel = paramVal(id, pr, 'target', u.type);
      let j = selectEnemy(ctx, i, sel);
      if (j < 0) return null;
      // Un tireur qui marche ne tire pas : si la cible est loin, il prend d'abord le meilleur ennemi à portée
      // pour ce même sélecteur (« le plus faible » parmi ceux qu'il peut toucher). Aucun ne correspond → il avance.
      if (isShooter(u.cls) && !inAttackRange(ctx, i, j)) {
        const k = selectEnemy(ctx, i, sel, (e) => inAttackRange(ctx, i, e));
        if (k >= 0) j = k;
      }
      return { kind: id === 'CHARGE' ? 'charge' : 'attack', action: id, targetId: ctx.units[j].id };
    }
    case 'ADVANCE': return advanceIntent(ctx, i, paramVal(id, pr, 'place', u.type));
    case 'HOLD': return { kind: 'hold', action: id };
    case 'RETREAT': {
      const e = nearestEnemy(ctx, i);
      if (e < 0 || fleeStep(ctx, i, Infinity, false) < 0) return null;
      return { kind: 'retreat', action: id, targetId: ctx.units[e].id };
    }
    case 'FOLLOW': {
      const j = selectAlly(ctx, i, paramVal(id, pr, 'ally', u.type), true, false);
      if (j < 0) return null;
      return { kind: 'follow', action: id, targetId: ctx.units[j].id };
    }
    case 'KITE': {
      const e = nearestEnemy(ctx, i);
      if (e < 0) return null;
      // Distance à garder plafonnée à la portée actuelle : au-delà, l'unité attendrait sans jamais tirer.
      const n = Math.max(1, Math.min(8, intParam(id, pr, 'n', u.type), attackRange(ctx, i, ctx.cell[i])));
      const d = cdist(ctx.g, ctx.cell[i], ctx.cell[e]);
      let mode;
      if (d < n && fleeStep(ctx, i, n, false) >= 0) mode = 'flee';
      else if (d <= attackRange(ctx, i, ctx.cell[i]) || d < n) mode = 'shoot';
      else mode = 'approach';
      return { kind: 'kite', action: id, targetId: ctx.units[e].id, n, mode };
    }
    case 'CAST_ENEMY': case 'CAST_ALLY': {
      const spell = paramVal(id, pr, 'spell', u.type), S = SPELLS[spell];
      const want = id === 'CAST_ENEMY' ? 'enemy' : 'ally';
      if (!S || S.targetKind !== want || !u.spells.includes(spell) || (u.cooldowns[spell] | 0) > 0) return null;
      const sel = paramVal(id, pr, want === 'enemy' ? 'target' : 'ally', u.type);
      const pick = (ok) => (want === 'enemy' ? selectEnemy(ctx, i, sel, ok) : selectAlly(ctx, i, sel, false, spell === 'HEAL', ok));
      let j = pick();
      if (j < 0) return null;
      // Comme pour les tireurs : d'abord la meilleure cible déjà à portée du sort (bonus de colline compris).
      if (!inSpellRange(ctx, i, j, spell)) {
        const k = pick((e) => inSpellRange(ctx, i, e, spell));
        if (k >= 0) j = k;
      }
      if (!inSpellRange(ctx, i, j, spell) && adjacentEnemy(ctx, i)) return null;
      return { kind: 'cast', action: id, spell, targetId: ctx.units[j].id };
    }
    default: return null;
  }
}

function advanceIntent(ctx, i, place) {
  const g = ctx.g, u = ctx.units[i], ci = ctx.cell[i];
  if (!PLACESET.has(place) || adjacentEnemy(ctx, i)) return null;
  if (place === 'MY_COMMANDER') {
    const c = ctx.commander[u.side];
    if (c < 0 || c === i || cdist(g, ci, ctx.cell[c]) <= 1) return null;
    const cu = ctx.units[c];
    return { kind: 'move', action: 'ADVANCE', place, targetId: cu.id, dest: { q: cu.q, r: cu.r } };
  }
  if (place === 'START') {
    const sc = cellIndex(g, u.startQ, u.startR);
    if (sc < 0 || sc === ci || g.comp[sc] !== g.comp[ci]) return null;
    return { kind: 'move', action: 'ADVANCE', place, dest: { q: u.startQ, r: u.startR } };
  }
  const P = getPlace(g, place, u.side);
  if (!P || P.mask[ci]) return null;
  let best = -1, bd = 0, be = 0;
  const rev = u.side === 'enemy';                            // à égalité parfaite : index croissant (joueur) / décroissant (IA)
  for (const c of P.cells) {
    if (g.comp[c] !== g.comp[ci] || ctx.occ[c]) continue;
    const d = cdist(g, ci, c), e = euclid2(g, ci, c);
    if (best < 0 || d < bd || (d === bd && (e < be - EPS || (rev && e <= be + EPS)))) { best = c; bd = d; be = e; }
  }
  if (best < 0) return null;
  // Hystérésis : on garde l'hex visé à l'instant précédent tant qu'il reste libre et aussi proche (en hex) que le
  // meilleur. Sinon, sur une colonne paire, l'égalité euclidienne entre deux lignes ferait glisser la cible d'une
  // ligne vers le nord à chaque instant (l'unité finirait loin de l'hex annoncé au départ).
  const pi = u.intent;
  if (pi && pi.kind === 'move' && pi.place === place && pi.dest) {
    const pc = cellIndex(g, pi.dest.q, pi.dest.r);
    if (pc >= 0 && pc !== best && P.mask[pc] && !ctx.occ[pc] && g.comp[pc] === g.comp[ci] && cdist(g, ci, pc) <= bd) best = pc;
  }
  return { kind: 'move', action: 'ADVANCE', place, dest: { q: g.q[best], r: g.r[best] } };
}
const PLACESET = new Set(['ENEMY_CAMP', 'CENTER', 'HILL', 'FOREST', 'RUINS', 'FORD', 'MY_COMMANDER', 'START']);

function instinct(ctx, i) {
  const e = nearestEnemy(ctx, i);
  if (e >= 0 && inAttackRange(ctx, i, e)) return { kind: 'attack', action: 'INSTINCT', targetId: ctx.units[e].id };
  return { kind: 'idle', action: 'INSTINCT' };
}

function decideIdx(ctx, i) {
  const u = ctx.units[i];
  if (!u.alive || ctx.cell[i] < 0) return { ruleIndex: -1, intent: { kind: 'idle', action: 'INSTINCT' } };
  const rules = u.program && Array.isArray(u.program.rules) ? u.program.rules : [];
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    if (!rule || !rule.action) continue;
    if (!condsHold(ctx, i, rule)) continue;
    const intent = actionIntent(ctx, i, rule.action);
    if (intent) return { ruleIndex: ri, intent };
  }
  return { ruleIndex: -1, intent: instinct(ctx, i) };
}

// =====================================================================================================
// Mouvement
// =====================================================================================================
const moveCap = (u) => Math.max(2, u.speed);
const enterCost = (g, u, c) => (u.cls === 'cavalry' ? g.costCav[c] : g.costInf[c]);
const canAfford = (u, cost) => u.mp >= cost - EPS || (!u.movedThisTick && u.mp >= moveCap(u) - EPS);
const mayMoveAtAll = (u) => u.mp >= 1 - EPS || (!u.movedThisTick && u.mp >= moveCap(u) - EPS);

// `anchor` (hex visé) sert au départage des chemins de même coût (voir pathStep).
function rangePlan(ctx, j, R, hill) {
  const g = ctx.g, Rmax = R + (hill ? MAX_RANGE_BONUS : 0);
  return {
    type: 'goal',
    isGoal: (c) => cdist(g, c, ctx.cell[j]) <= R + (hill ? g.rangeBonus[c] : 0),
    h: (c) => cdist(g, c, ctx.cell[j]),
    lb: (c) => { const d = cdist(g, c, ctx.cell[j]) - Rmax; return d > 0 ? d : 0; },
    anchor: () => ctx.cell[j],
  };
}
const MAX_RANGE_BONUS = Math.max(0, ...Object.values(TERRAIN).map(t => t.rangeBonus | 0));

function makePlan(ctx, i, it) {
  const g = ctx.g, u = ctx.units[i];
  switch (it.kind) {
    case 'attack': case 'charge': {
      if (it.action === 'INSTINCT') return null;
      const j = idxOf(ctx, it.targetId);
      if (j < 0) return null;
      if (isShooter(u.cls) && inAttackRange(ctx, i, j)) return null;   // à portée : il reste et tire
      return rangePlan(ctx, j, u.range | 0, isShooter(u.cls));
    }
    case 'cast': {
      const j = idxOf(ctx, it.targetId);
      if (j < 0 || inSpellRange(ctx, i, j, it.spell)) return null;
      return rangePlan(ctx, j, SPELLS[it.spell].range | 0, true);
    }
    case 'follow': {
      const j = idxOf(ctx, it.targetId);
      return j < 0 ? null : rangePlan(ctx, j, 1, false);
    }
    case 'move': {
      if (it.place === 'MY_COMMANDER') { const j = idxOf(ctx, it.targetId); return j < 0 ? null : rangePlan(ctx, j, 1, false); }
      if (it.place === 'START') {
        const sc = cellIndex(g, u.startQ, u.startR);
        const hs = (c) => cdist(g, c, sc);
        return { type: 'goal', isGoal: (c) => c === sc, h: hs, lb: hs, fixed: true, anchor: () => sc };
      }
      const P = getPlace(g, it.place, u.side);
      if (!P) return null;
      // On marche vers l'hex annoncé (intent.dest, surligné par le HUD) ; viser tout le lieu laisserait l'A* choisir
      // l'hex d'index le plus petit à coût égal, c.-à-d. dériver vers le bord nord.
      // Si un autre prend cet hex en cours d'instant, on revise tout le lieu (sinon l'A* chercherait un but inaccessible).
      const dc = it.dest ? cellIndex(g, it.dest.q, it.dest.r) : -1;
      const hp = (c) => P.hf[c];
      if (dc >= 0 && P.mask[dc] && !ctx.occ[dc]) {
        const taken = () => ctx.occ[dc] !== 0 && ctx.occ[dc] !== i + 1;
        const hx = (c) => (taken() ? P.hf[c] : cdist(g, c, dc));
        return { type: 'goal', isGoal: (c) => (taken() ? P.mask[c] === 1 : c === dc), h: hx, lb: hx, fixed: true, anchor: () => dc };
      }
      return { type: 'goal', isGoal: (c) => P.mask[c] === 1, h: hp, lb: hp, fixed: true };
    }
    case 'retreat': return { type: 'flee', n: Infinity };
    case 'kite':
      if (it.mode === 'flee') return { type: 'flee', n: it.n };
      if (it.mode === 'approach') {
        // Hex d'où l'on tire sans être plus près que n (n déjà plafonné à la portée actuelle ; en descendant d'une
        // colline, la portée baisse : on accepte alors la nouvelle portée comme distance à garder).
        const n = it.n, e0 = idxOf(ctx, it.targetId);
        return { type: 'goal', h: null, anchor: e0 >= 0 ? () => ctx.cell[e0] : null,
          isGoal: (c) => { const e = minFoeDist(ctx, i, c), R = attackRange(ctx, i, c); return e >= Math.min(n, R) && e <= R; } };
      }
      return null;
    default: return null;
  }
}

/**
 * Recherche de chemin (A* multi-buts sur la grille, coûts de terrain de maputil.moveCost ; borne inférieure
 * `plan.lb` cohérente — distance en hex au but — donc le premier but atteint est optimal).
 * Renvoie le premier hex du chemin (peut être occupé par un allié : l'appelant attend ou échange), ou -1.
 * Les ennemis bloquent ; les alliés coûtent ALLY_PEN (ou bloquent en mode « détour ») ; le contact ennemi
 * hors but coûte ZOC_PEN ; revenir sur ses pas coûte BACK_PEN. Si aucun but n'est atteignable, on vise l'hex
 * libre le plus proche du but (heuristique h) s'il est plus proche que la position actuelle.
 * Départage à coût égal (clé du tas, sous l'unité de coût) : distance de l'hex à la droite départ → `plan.anchor()`,
 * pour des trajets droits ; en dernier, l'index de l'hex, lu à l'envers pour l'IA (enc) afin que deux armées en
 * miroir (rotation de 180°) fassent les mêmes choix.
 */
function pathStep(ctx, i, plan, strict) {
  const g = ctx.g, u = ctx.units[i], src = ctx.cell[i], units = ctx.units, occ = ctx.occ, nb = g.nb;
  const cost = u.cls === 'cavalry' ? g.costCav : g.costInf;
  const zoc = u.side === 'player' ? ctx.zocP : ctx.zocE;
  const side = u.side, isGoal = plan.isGoal, h = plan.h, lbf = plan.lb;
  const back = u.prevTick != null && u.prevTick >= ctx.tickNow - 1 ? cellIndex(g, u.prevQ, u.prevR) : -1;
  const M = 1024 * Math.max(1, Math.ceil(g.n / 1024)), flip = side === 'enemy' ? g.n - 1 : -1;
  const enc = (m) => (flip >= 0 ? flip - m : m);           // involutif : enc(enc(m)) = m
  const an = plan.anchor ? plan.anchor() : -1;
  const ax = g.wx[src], az = g.wz[src], vx = an >= 0 ? g.wx[an] - ax : 0, vz = an >= 0 ? g.wz[an] - az : 0, vv = vx * vx + vz * vz;
  // Écart à la droite (quantifié), puis côté : à écart égal, la gauche du sens de marche. Ce départage est le même
  // pour une unité et son image par rotation de 180° (l'index de l'hex, lui, favoriserait toujours le nord).
  const tbOf = (m) => {
    if (vv < EPS) return 0;
    const px = g.wx[m] - ax, pz = g.wz[m] - az;
    let t = (px * vx + pz * vz) / vv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // (+1e-6 : un écart pile sur une graduation, ex. 1,5, tombe du même côté quel que soit l'arrondi flottant)
    const dx = px - t * vx, dz = pz - t * vz, q = Math.floor(Math.sqrt(dx * dx + dz * dz) * TB_SCALE + 1e-6);
    return (q < TB_Q / 2 - 1 ? q : TB_Q / 2 - 1) * 2 + (vx * pz - vz * px < -EPS ? 1 : 0);
  };
  const dist = S_dist, prev = S_prev, seen = S_seen, lb = S_lb, tb = S_tb, stamp = ++S_stamp;
  S_size = 0;
  dist[src] = 0; prev[src] = -1; seen[src] = stamp; lb[src] = lbf ? lbf(src) : 0; tb[src] = 0; hpush(lb[src] * TB_Q * M + enc(src));
  let found = -1, fb = -1, fbH = h ? h(src) : 0;
  const h0 = fbH;
  while (S_size > 0) {
    const key = hpop(), low = key % M, c = enc(low);
    if ((key - low) / M > (dist[c] + lb[c]) * TB_Q + tb[c]) continue;
    const d = dist[c];
    if (c !== src && occ[c] === 0) {
      if (isGoal(c)) { found = c; break; }
      if (h) { const hc = h(c); if (hc < fbH) { fb = c; fbH = hc; } }
    }
    const base = c * 6;
    for (let k = 0; k < 6; k++) {
      const m = nb[base + k];
      if (m < 0) continue;
      const tc = cost[m];
      if (tc === NO) continue;
      let w = tc;
      const o = occ[m];
      if (o) { if (units[o - 1].side !== side || strict) continue; w += ALLY_PEN; }
      if (zoc[m] && !isGoal(m)) w += ZOC_PEN;
      if (c === src && m === back) w += BACK_PEN;
      const nd = d + w;
      if (seen[m] !== stamp) { seen[m] = stamp; lb[m] = lbf ? lbf(m) : 0; tb[m] = tbOf(m); }
      else if (nd >= dist[m]) continue;
      dist[m] = nd; prev[m] = c; hpush(((nd + lb[m]) * TB_Q + tb[m]) * M + enc(m));
    }
  }
  let target = found;
  if (target < 0 && h && fb >= 0 && fbH < h0) target = fb;
  if (target < 0) { S_cost = Infinity; S_path = null; return -1; }
  S_cost = dist[target] + (found < 0 ? 1000 : 0);
  let c = target;
  const rev = plan.fixed ? [target] : null;
  while (prev[c] !== src) { c = prev[c]; if (rev) rev.push(c); }
  S_path = rev ? rev.reverse() : null;
  return c;
}
let S_cost = 0;                       // coût du dernier chemin trouvé par pathStep (but de repli : +1000)
let S_path = null;                    // dernier chemin complet (premier pas … but) pour un but fixe
const TB_Q = 512, TB_SCALE = 8;       // départage : écart à la droite au 1/8 d'unité monde × 2 côtés (coûts entiers)

/**
 * Pas de repli : meilleur voisin libre qui éloigne de l'ennemi le plus proche (puis rapproche de son camp).
 * n = Infinity pour RETREAT ; n = distance à garder pour KITE (on ne recule que tant qu'un ennemi est à < n).
 */
function fleeStep(ctx, i, n, checkMp) {
  const g = ctx.g, u = ctx.units[i], cur = ctx.cell[i];
  if (!ctx.alive[OPP[u.side]].length) return -1;
  const camp = g.campHf[u.side] || (g.campHf[u.side] = getPlace(g, 'OWN_CAMP', u.side).hf);
  const cost = u.cls === 'cavalry' ? g.costCav : g.costInf;
  const kite = n !== Infinity;
  const e0 = minFoeDist(ctx, i, cur);
  if (kite && e0 >= n) return -1;
  const cA = kite ? Math.min(e0, n) : e0, cB = camp[cur];
  let best = -1, bA = 0, bB = 0, bC = 0, bT = 0;
  const k0 = u.side === 'enemy' ? 3 : 0;                    // ordre des directions tourné de 180° pour l'IA (miroir)
  for (let kk = 0; kk < 6; kk++) {
    const c = g.nb[cur * 6 + ((kk + k0) % 6)];
    if (c < 0) continue;
    const tc = cost[c];
    if (tc === NO || ctx.occ[c] || (checkMp && !canAfford(u, tc))) continue;
    const e = minFoeDist(ctx, i, c);
    let A, B, C;
    if (kite) { A = Math.min(e, n); if (A <= cA) continue; B = e; C = camp[c]; }
    else { A = e; B = camp[c]; C = 0; if (!(A > cA || (A === cA && B < cB))) continue; }
    if (best < 0 || A > bA || (A === bA && (B < bB || (B === bB && (C < bC || (C === bC && tc < bT)))))) {
      best = c; bA = A; bB = B; bC = C; bT = tc;
    }
  }
  return best;
}

function buildZoc(ctx) {
  const g = ctx.g;
  ctx.zocP.fill(0); ctx.zocE.fill(0);
  for (const side of SIDES) {
    const z = side === 'enemy' ? ctx.zocP : ctx.zocE;   // les hex au contact d'un ennemi du joueur sont « zoc » pour le joueur
    for (const j of ctx.alive[side]) { const c = ctx.cell[j]; for (let k = 0; k < 6; k++) { const m = g.nb[c * 6 + k]; if (m >= 0) z[m] = 1; } }
  }
}

function nextStep(ctx, i, plan, sub) {
  const u = ctx.units[i];
  const leaving = plan.type === 'flee';
  if (adjacentEnemy(ctx, i)) {
    // Zone de contrôle : seuls RETREAT/KITE quittent le contact (au premier pas). La mêlée attend le sous-pas
    // suivant : si l'ennemi s'est éloigné entre-temps, elle peut le poursuivre (le GDD n'interdit que de partir).
    // Un tireur reste : immobile, il peut encore tirer sur l'ennemi qui vient de reculer.
    if (leaving ? u.movedThisTick : (u.movedThisTick || sub >= MAX_SUBSTEPS - 1 || isShooter(u.cls))) plan.done = true;
    if (!leaving || u.movedThisTick) return -1;
  }
  if (!mayMoveAtAll(u)) { plan.done = true; return -1; }
  if (leaving) {
    const s = fleeStep(ctx, i, plan.n, true);
    if (s < 0) plan.done = true;
    return s;
  }
  const cur = ctx.cell[i];
  if (plan.isGoal(cur)) { plan.done = true; plan.arrived = true; return -1; }
  // But fixe : on reprend le chemin calculé au sous-pas précédent tant que la suite et l'arrivée sont libres.
  const path = plan.path;
  if (path) {
    const k = path.indexOf(cur);
    if (k >= 0 && k + 1 < path.length && ctx.occ[path[k + 1]] === 0 && ctx.occ[path[path.length - 1]] === 0) return path[k + 1];
    plan.path = null;
  }
  let s = pathStep(ctx, i, plan, false);
  if (s < 0) { plan.done = true; plan.stuck = true; return -1; }
  let chosen = S_path;
  // Bloqué par un allié depuis au moins un instant : contourner si le détour reste raisonnable.
  if (ctx.occ[s] && u.waitTicks >= 1) {
    const direct = S_cost;
    const s2 = pathStep(ctx, i, plan, true);
    if (s2 >= 0 && S_cost <= direct + DETOUR_MAX) { s = s2; chosen = S_path; }
  }
  if (plan.fixed && chosen && ctx.occ[s] === 0) plan.path = chosen;
  return s;
}

/**
 * Un allié immobile (sans mouvement prévu, pas au contact, pas en train de tenir ni de tirer/lancer) peut être
 * poussé : il prend la place de celui qui passe. Évite qu'une escorte enferme son commandant.
 */
function displaceable(ctx, j, plans, intents, toCell) {
  const t = ctx.units[j], it = intents[j], plan = plans[j];
  if (!t.alive || !it || t.movedThisTick || (plan && !plan.done)) return false;
  if (!(it.kind === 'idle' || it.kind === 'move' || it.kind === 'follow')) return false;
  if (it.kind === 'idle' && isShooter(t.cls)) return false;           // il tirera peut-être
  if (adjacentEnemy(ctx, j) || enterCost(ctx.g, t, toCell) === NO) return false;
  if (plan && plan.type === 'goal' && !plan.isGoal(toCell)) return false;
  if (it.kind === 'follow') { const a = idxOf(ctx, it.targetId); if (a >= 0 && cdist(ctx.g, toCell, ctx.cell[a]) > 1) return false; }
  return true;
}

function movementPhase(ctx, intents, events) {
  const { battle, g, units } = ctx, nU = units.length;
  const plans = new Array(nU).fill(null), blocked = new Uint8Array(nU);
  for (let i = 0; i < nU; i++) {
    const u = units[i];
    if (!u.alive || ctx.cell[i] < 0) continue;
    u.movedThisTick = false;
    // CHARGE : +1 PM pour cet instant, seulement pour la cavalerie (trait `charge`) ; le reste est perdu plus bas.
    const charging = intents[i].kind === 'charge' && u.traits.includes('charge');
    u.mp = Math.min(u.mp + u.speed, moveCap(u)) + (charging ? 1 : 0);
    plans[i] = makePlan(ctx, i, intents[i]);
  }
  const prop = new Int16Array(nU), want = new Int16Array(nU), pcost = new Float64Array(nU);
  const involved = new Uint8Array(nU), grouped = new Uint8Array(nU);
  for (let sub = 0; sub < MAX_SUBSTEPS; sub++) {
    if (!plans.some(p => p && !p.done)) break;
    buildZoc(ctx);
    prop.fill(-1); want.fill(-1); involved.fill(0); grouped.fill(0);
    let any = false;
    for (let i = 0; i < nU; i++) {
      const plan = plans[i];
      if (!plan || plan.done) continue;
      const s = nextStep(ctx, i, plan, sub);
      if (s < 0) continue;
      const u = units[i], c = enterCost(g, u, s);
      if (!canAfford(u, c)) { plan.done = true; continue; }
      pcost[i] = c;
      if (ctx.occ[s]) { want[i] = s; blocked[i] = 1; continue; }
      prop[i] = s; any = true;
    }
    const moves = [];
    // Échanges entre alliés qui veulent chacun l'hex de l'autre (évite les blocages face à face).
    for (let i = 0; i < nU; i++) {
      if (want[i] < 0) continue;
      const j = ctx.occ[want[i]] - 1;
      if (j > i && want[j] === ctx.cell[i]) {
        moves.push([i, want[i], pcost[i]], [j, want[j], pcost[j]]);
        involved[i] = involved[j] = 1; blocked[i] = blocked[j] = 0;
      }
    }
    // Bloqué depuis un instant par un allié immobile : on le pousse à sa place (il ne paie pas de PM).
    for (let i = 0; i < nU; i++) {
      if (want[i] < 0 || involved[i] || (units[i].waitTicks | 0) < 1) continue;
      const j = ctx.occ[want[i]] - 1;
      if (j < 0 || involved[j] || !displaceable(ctx, j, plans, intents, ctx.cell[i])) continue;
      moves.push([i, want[i], pcost[i]], [j, ctx.cell[i], 0, true]);
      involved[i] = involved[j] = 1; blocked[i] = 0;
    }
    // Conflits : plusieurs unités visent le même hex libre.
    if (any) {
      for (let i = 0; i < nU; i++) {
        if (prop[i] < 0 || grouped[i]) continue;
        const group = [];
        for (let k = i; k < nU; k++) if (prop[k] === prop[i]) { group.push(k); grouped[k] = 1; }
        let win = group[0];
        if (group.length > 1) {
          const cav = group.filter(k => units[k].cls === 'cavalry');
          const pool = cav.length ? cav : group;
          win = pool.length === 1 ? pool[0] : pool[rngInt(battle.rng, pool.length)];
          for (const k of group) if (k !== win) blocked[k] = 1;
        }
        moves.push([win, prop[i], pcost[win]]);
      }
    }
    if (!moves.length) continue;
    moves.sort((a, b) => a[0] - b[0]);
    for (const [i] of moves) ctx.occ[ctx.cell[i]] = 0;
    for (const [i, to, c, pushed] of moves) {
      const u = units[i], from = ctx.cell[i];
      ctx.occ[to] = i + 1; ctx.cell[i] = to;
      u.prevQ = g.q[from]; u.prevR = g.r[from]; u.prevTick = ctx.tickNow;
      u.q = g.q[to]; u.r = g.r[to];
      u.mp = Math.max(0, u.mp - c);
      u.movedThisTick = true;
      u.facing = facingTo(g, from, to);
      blocked[i] = 0;
      const ev = { type: 'move', unitId: u.id, from: { q: g.q[from], r: g.r[from] }, to: { q: u.q, r: u.r }, sub, facing: u.facing };
      if (pushed) ev.pushed = true;
      events.push(ev);
    }
    // Zone de contrôle : entrer au contact d'un ennemi termine le mouvement de l'instant.
    for (const [i] of moves) {
      const plan = plans[i];
      if (!plan) continue;
      if (adjacentEnemy(ctx, i)) { plan.done = true; continue; }
      if (plan.type === 'goal' && plan.isGoal(ctx.cell[i])) { plan.done = true; plan.arrived = true; }
      if (plan.type === 'flee' && plan.n !== Infinity && minFoeDist(ctx, i, ctx.cell[i]) >= plan.n) plan.done = true;
    }
  }
  for (let i = 0; i < nU; i++) {
    const u = units[i], plan = plans[i];
    if (!u.alive) continue;
    if (u.mp > moveCap(u)) u.mp = moveCap(u);                // PM de charge non dépensés : perdus
    if (!plan || u.movedThisTick || plan.arrived) u.waitTicks = 0;
    else if (blocked[i] || plan.stuck) u.waitTicks = Math.min(9, (u.waitTicks | 0) + 1);
  }
}

// =====================================================================================================
// Combat
// =====================================================================================================
function computeDamage(ctx, i, j, ranged, chargeAction) {
  const g = ctx.g, a = ctx.units[i], t = ctx.units[j], ca = ctx.cell[i], ct = ctx.cell[j];
  const bonuses = [];
  const heavy = t.traits.includes('heavy');
  let atk = a.atk;
  if (a.status.hex > 0) { atk -= a.status.hexAmt | 0; bonuses.push('hexed'); }
  const cavCharge = a.traits.includes('charge');
  if (a.movedThisTick && !ranged && (cavCharge || chargeAction)) {
    if (heavy) bonuses.push('heavy');
    else if (cavCharge) { atk += chargeAction ? 4 : 2; bonuses.push(chargeAction ? 'charge2' : 'charge'); }
    else { atk += 1; bonuses.push('elan'); }                  // CHARGE d'un commandant ou d'un colosse
  }
  if (a.traits.includes('antiCavalry') && t.cls === 'cavalry') {
    if (heavy) bonuses.push('heavy'); else { atk += 3; bonuses.push('antiCavalry'); }
  }
  if (!ranged && g.meleeAtk[ca] > 0 && g.terrain[ct] !== 'hill') { atk += g.meleeAtk[ca]; bonuses.push('hill'); }
  if (a.traits.includes('horde') && adjacentAllies(ctx, i) >= 2) { atk += 1; bonuses.push('horde'); }
  if (auraNear(ctx, i, 'aura_rage')) { atk += 1; bonuses.push('rage'); }
  let def = t.def;
  const td = g.def[ct];
  if (td) { def += td; bonuses.push(g.terrain[ct]); }
  if (ranged && g.rangedDef[ct]) { def += g.rangedDef[ct]; bonuses.push('cover'); }
  if (t.status.holding) { def += 1; bonuses.push('holding'); }
  if (t.status.charging) { def -= 1; bonuses.push('exposed'); }
  if (auraNear(ctx, j, 'aura_inspire')) { def += 1; bonuses.push('inspire'); }
  if (t.status.ward > 0) { def += t.status.wardAmt | 0; bonuses.push('ward'); }
  return { dmg: Math.max(1, atk - def), bonuses };
}

function strike(ctx, i, pref, chargeAction, protect, out) {
  const g = ctx.g, u = ctx.units[i], ci = ctx.cell[i];
  if (isShooter(u.cls) && u.movedThisTick) return;
  const R = attackRange(ctx, i, ci);
  let j = -1;
  if (pref >= 0 && ctx.units[pref].alive && ctx.cell[pref] >= 0 && cdist(g, ci, ctx.cell[pref]) <= R) j = pref;
  else {
    let k1 = 0, k2 = 0, k3 = 0;
    for (const e of ctx.alive[OPP[u.side]]) {
      const d = cdist(g, ci, ctx.cell[e]);
      if (d > R) continue;
      const a1 = protect >= 0 ? cdist(g, ctx.cell[protect], ctx.cell[e]) : d, a2 = d, a3 = ctx.units[e].hp;
      if (j < 0 || a1 < k1 || (a1 === k1 && (a2 < k2 || (a2 === k2 && a3 < k3)))) { j = e; k1 = a1; k2 = a2; k3 = a3; }
    }
  }
  if (j < 0) return;
  const t = ctx.units[j];
  const kind = u.cls === 'ranged' ? 'arrow' : u.cls === 'caster' ? 'bolt' : 'melee';
  const { dmg, bonuses } = computeDamage(ctx, i, j, kind !== 'melee', chargeAction);
  u.facing = facingTo(g, ci, ctx.cell[j]);
  u.lastTargetId = t.id;
  out.events.push({ type: 'attack', unitId: u.id, targetId: t.id, dmg, kind, bonuses });
  out.dmg.push(j, dmg, i);
}

function cast(ctx, i, it, out) {
  const g = ctx.g, u = ctx.units[i], S = SPELLS[it.spell];
  if (!S || u.movedThisTick || (u.cooldowns[it.spell] | 0) > 0) return;
  const j = idxOf(ctx, it.targetId);
  if (j < 0 || !ctx.units[j].alive || !inSpellRange(ctx, i, j, it.spell)) return;
  const t = ctx.units[j], ct = ctx.cell[j], effects = [];
  switch (it.spell) {
    case 'FIREBALL':
      effects.push({ unitId: t.id, dmg: S.dmg }); out.dmg.push(j, S.dmg, i);
      for (let k = 0; k < ctx.units.length; k++) {
        if (k === j || !ctx.units[k].alive || ctx.cell[k] < 0 || cdist(g, ct, ctx.cell[k]) !== 1) continue;
        effects.push({ unitId: ctx.units[k].id, dmg: S.splash }); out.dmg.push(k, S.splash, i);
      }
      break;
    case 'HEAL': effects.push({ unitId: t.id, heal: S.amount }); out.heal.push(j, S.amount, i); break;
    case 'WARD': effects.push({ unitId: t.id, status: 'ward' }); out.status.push([j, 'ward', S.amount, S.duration]); break;
    case 'HEX': effects.push({ unitId: t.id, status: 'hex' }); out.status.push([j, 'hex', S.amount, S.duration]); break;
    default: return;
  }
  u.cooldowns[it.spell] = S.cooldown | 0;
  if (j !== i) u.facing = facingTo(g, ctx.cell[i], ct);
  u.lastTargetId = t.id;
  out.events.push({ type: 'spell', unitId: u.id, spell: it.spell, targetId: t.id, center: { q: t.q, r: t.r }, effects });
}

function combatPhase(ctx, intents, events) {
  const units = ctx.units, nU = units.length;
  const out = { events, dmg: [], heal: [], status: [] };
  for (let i = 0; i < nU; i++) {
    const u = units[i], it = intents[i];
    if (!u.alive || !it || ctx.cell[i] < 0) continue;
    switch (it.kind) {
      case 'attack': case 'charge': strike(ctx, i, idxOf(ctx, it.targetId), it.kind === 'charge', -1, out); break;
      case 'hold': case 'idle': strike(ctx, i, -1, false, -1, out); break;
      case 'follow': strike(ctx, i, -1, false, idxOf(ctx, it.targetId), out); break;
      case 'kite': if (!u.movedThisTick) strike(ctx, i, idxOf(ctx, it.targetId), false, -1, out); break;
      case 'cast': cast(ctx, i, it, out); break;
      default: break;
    }
  }
  // --- application simultanée : dégâts, puis soins (sur les survivants), puis statuts, puis morts.
  // Règle retenue (voir l'en-tête) : un soin ne sauve pas une unité tuée au même instant.
  const hit = new Uint8Array(nU), killer = new Int16Array(nU).fill(-1), fresh = new Set();
  for (let k = 0; k < out.dmg.length; k += 3) {
    const j = out.dmg[k], amt = out.dmg[k + 1], s = out.dmg[k + 2], t = units[j], src = units[s];
    const before = t.hp;
    t.hp = before - amt; hit[j] = 1;
    if (before > 0) {
      if (src.side !== t.side) src.damageDealt += Math.min(amt, before);
      if (t.hp <= 0) killer[j] = s;
    }
    events.push({ type: 'damage', unitId: t.id, amount: amt, hpAfter: Math.max(0, t.hp), sourceId: src.id });
  }
  for (let k = 0; k < out.heal.length; k += 3) {
    const t = units[out.heal[k]];
    if (t.hp <= 0) continue;                                  // un soin ne ranime pas
    const amt = Math.min(out.heal[k + 1], t.maxHp - t.hp);
    if (amt <= 0) continue;
    t.hp += amt;
    events.push({ type: 'heal', unitId: t.id, amount: amt, hpAfter: t.hp, sourceId: units[out.heal[k + 2]].id });
  }
  for (const [j, kind, amount, duration] of out.status) {
    const t = units[j];
    if (t.hp <= 0) continue;
    if (kind === 'ward') { t.status.ward = duration; t.status.wardAmt = amount; }
    else { t.status.hex = duration; t.status.hexAmt = amount; }
    fresh.add(j * 2 + (kind === 'ward' ? 0 : 1));
  }
  for (let j = 0; j < nU; j++) {
    const t = units[j];
    if (!t.alive) continue;
    t.hitLastTick = !!hit[j];
    if (t.hp <= 0) {
      t.hp = 0; t.alive = false;
      const s = killer[j] >= 0 ? units[killer[j]] : null;
      if (s && s.side !== t.side) s.kills += 1;
      events.push({ type: 'death', unitId: t.id, killerId: s ? s.id : null });
    }
  }
  return fresh;
}

// =====================================================================================================
// Fin d'instant : régénération, recharges, statuts, corbeaux, victoire
// =====================================================================================================
function endPhase(battle, fresh, events) {
  const units = battle.units;
  for (const u of units) {
    if (!u.alive) continue;
    if (u.traits.includes('regen') && u.hp < u.maxHp) { u.hp += 1; events.push({ type: 'regen', unitId: u.id, amount: 1, hpAfter: u.hp }); }
  }
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u.alive) continue;
    for (const s in u.cooldowns) if (u.cooldowns[s] > 0) u.cooldowns[s] -= 1;
    if (u.status.ward > 0 && !fresh.has(i * 2)) { u.status.ward -= 1; if (!u.status.ward) u.status.wardAmt = 0; }
    if (u.status.hex > 0 && !fresh.has(i * 2 + 1)) { u.status.hex -= 1; if (!u.status.hex) u.status.hexAmt = 0; }
  }
  ravenPhase(battle, events);
  checkVictory(battle);
}

function ravenPhase(battle, events) {
  const step = RAVEN_SPEED_HEX * SQRT3;                      // centres voisins à √3 l'un de l'autre
  for (const rv of battle.ravens) {
    if (!rv.alive || rv.delivered) continue;
    const t = unitById(battle, rv.unitId);
    if (!t || !t.alive) {
      rv.alive = false;
      events.push({ type: 'raven_lost', ravenId: rv.id, reason: 'target_dead' });
      continue;
    }
    const dest = hexToWorld(t.q, t.r), from = { x: rv.x, z: rv.z };
    const dx = dest.x - rv.x, dz = dest.z - rv.z, d = Math.hypot(dx, dz);
    let arrived = false;
    if (d <= step + EPS) { rv.x = dest.x; rv.z = dest.z; arrived = true; }
    else { rv.x += (dx / d) * step; rv.z += (dz / d) * step; }
    // Interception sur toute la portion de vol de l'instant (segment from → arrivée), pas seulement au point d'arrivée :
    // un corbeau qui frôle un archer en vol est exposé, comme l'annonce le HUD (« tireurs près de la trajectoire »).
    // Chaque tireur n'a qu'un jet par corbeau (rv.tried), au premier instant où il est à portée.
    const vx = rv.x - from.x, vz = rv.z - from.z, vv = vx * vx + vz * vz;
    let shooter = null, sx = rv.x, sz = rv.z;
    for (const u of battle.units) {
      if (!u.alive || u.side === rv.side || !u.traits.includes('antiRaven')) continue;
      if (rv.tried && rv.tried.includes(u.id)) continue;
      const w = hexToWorld(u.q, u.r);
      let k = vv > EPS ? ((w.x - from.x) * vx + (w.z - from.z) * vz) / vv : 1;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      const px = from.x + k * vx, pz = from.z + k * vz;
      if (Math.hypot(w.x - px, w.z - pz) / SQRT3 > RAVEN_INTERCEPT_RANGE + EPS) continue;
      (rv.tried || (rv.tried = [])).push(u.id);
      if (rngChance(battle.rng, RAVEN_INTERCEPT_CHANCE)) { shooter = u; sx = px; sz = pz; break; }
    }
    if (shooter) { rv.x = sx; rv.z = sz; arrived = false; }   // il tombe là où la flèche l'a atteint
    events.push({ type: 'raven_move', ravenId: rv.id, from, to: { x: rv.x, z: rv.z } });
    if (shooter) {
      rv.alive = false; rv.shotBy = shooter.id;
      events.push({ type: 'raven_shot', ravenId: rv.id, byId: shooter.id, x: rv.x, z: rv.z });
      continue;
    }
    if (arrived) {
      rv.delivered = true; rv.alive = false; rv.deliveredAt = battle.tick;
      t.program = cloneProgram(rv.program);
      t.reprogrammedAt = battle.tick;
      t.lastRule = null;                                     // l'index surligné concernait l'ancien programme
      events.push({ type: 'raven_deliver', ravenId: rv.id, unitId: t.id });
    }
  }
}

function commanderState(battle, side) {
  let has = false;
  for (const u of battle.units) if (u.side === side && u.cls === 'commander') { if (u.alive) return 'alive'; has = true; }
  return has ? 'dead' : 'none';
}

function checkVictory(battle) {
  if (battle.result) return battle.result;
  const pc = commanderState(battle, 'player'), ec = commanderState(battle, 'enemy');
  let winner = null, reason = null;
  if (pc === 'dead') { winner = 'enemy'; reason = 'commander'; }       // les deux commandants tombés : défaite
  else if (ec === 'dead') { winner = 'player'; reason = 'commander'; }
  else {
    const pa = battle.units.some(u => u.side === 'player' && u.alive), ea = battle.units.some(u => u.side === 'enemy' && u.alive);
    if (!pa) { winner = 'enemy'; reason = 'annihilation'; }
    else if (!ea) { winner = 'player'; reason = 'annihilation'; }
    else if (battle.tick >= battle.maxTicks) { winner = timeoutWinner(battle); reason = 'time'; }
  }
  if (winner) {
    battle.result = { winner, reason, tick: battle.tick,
      values: { player: round2(battleValue(battle, 'player')), enemy: round2(battleValue(battle, 'enemy')) } };
  }
  return battle.result;
}
const round2 = (x) => Math.round(x * 100) / 100;

// =====================================================================================================
// API publique
// =====================================================================================================

/**
 * Crée une bataille prête à jouer (tick 0). Les unités sont placées en (q, r) ; une position hors carte,
 * infranchissable ou déjà prise est déplacée sur l'hex libre praticable le plus proche.
 * @param {object} o
 * @param {object} o.map   Map (voir INTERFACES) — jamais modifiée.
 * @param {{faction:string, units:Array<{uid?:string,type:string,q:number,r:number,program?:object,bonus?:{atk?:number,slots?:number},name?:string,hp?:number}>}} o.player
 * @param {{faction:string, units:Array}} o.enemy
 * @param {number|string} [o.seed=1]
 * @param {{player?:number, enemy?:number}|number} [o.ravens=START_RAVENS]  nombre de corbeaux (un nombre = pour les deux camps)
 * @param {number} [o.maxTicks=MAX_TICKS]
 * @returns {object} Battle (JSON-sérialisable)
 */
export function createBattle({ map, player, enemy, seed = 1, ravens = START_RAVENS, maxTicks = MAX_TICKS } = {}) {
  if (!map || !Array.isArray(map.tiles)) throw new Error('createBattle : carte manquante ou mal formée.');
  const g = getGrid(map);
  const rv = typeof ravens === 'number' ? { player: ravens, enemy: ravens } : { ...START_RAVENS, ...(ravens || {}) };
  const battle = {
    tick: 0, seed, rng: createRng(seed), map, maxTicks: maxTicks ?? MAX_TICKS, result: null,
    units: [], ravens: [], ravensLeft: { player: Math.max(0, rv.player | 0), enemy: Math.max(0, rv.enemy | 0) }, nextId: 0,
    factions: { player: player?.faction ?? 'royaume', enemy: enemy?.faction ?? 'gobelins' },
    pending: [],
    startValue: { player: 0, enemy: 0 },   // valeur de chaque camp au départ (score au temps : part conservée)
  };
  const occ = new Uint8Array(g.n);
  for (const side of SIDES) {
    const list = (side === 'player' ? player : enemy)?.units ?? [];
    let n = 0;
    for (const au of list) {
      const T = UNITS[au?.type];
      if (!T) throw new Error(`createBattle : type d’unité inconnu « ${au?.type} ».`);
      let c = cellIndex(g, au.q, au.r);
      if (c < 0 || !g.standable[c] || occ[c]) c = nearestFreeCell(g, occ, au.q, au.r, side);
      if (c < 0) continue;                                    // carte pleine
      occ[c] = 1;
      const bonus = au.bonus || {};
      const hp = Number.isFinite(au.hp) ? Math.max(1, Math.min(T.hp, Math.round(au.hp))) : T.hp;
      battle.units.push({
        id: (side === 'player' ? 'p' : 'e') + n++, uid: au.uid ?? null, side, type: T.id, cls: T.cls, faction: T.faction,
        name: au.name ?? T.name,
        q: g.q[c], r: g.r[c], startQ: g.q[c], startR: g.r[c], facing: side === 'player' ? 0 : 4,
        hp, maxHp: T.hp, atk: T.atk + (bonus.atk | 0), def: T.def, range: T.range, speed: T.speed,
        slots: T.slots + (bonus.slots | 0), traits: [...T.traits], spells: [...T.spells],
        program: cloneProgram(au.program ?? DEFAULT_PROGRAMS[T.id] ?? { rules: [] }), mp: 0, alive: true,
        status: { holding: false, charging: false, ward: 0, wardAmt: 0, hex: 0, hexAmt: 0 },
        cooldowns: Object.fromEntries(T.spells.map(s => [s, 0])),
        lastRule: null, lastAction: null, lastTargetId: null, hitLastTick: false, movedThisTick: false, kills: 0, damageDealt: 0,
        // champs supplémentaires (UI / moteur)
        intent: null, waitTicks: 0, prevQ: null, prevR: null, prevTick: null, reprogrammedAt: null,
      });
    }
  }
  for (const side of SIDES) battle.startValue[side] = battleValue(battle, side);
  return battle;
}

function nearestFreeCell(g, occ, q, r, side) {
  let c0 = cellIndex(g, q, r);
  if (c0 < 0) {
    const col = Math.max(0, Math.min(g.w - 1, Number.isFinite(q) ? Math.round(q) : (side === 'player' ? 0 : g.w - 1)));
    const row0 = Number.isFinite(r) ? Math.round(r) + ((col - (col & 1)) >> 1) : Math.floor(g.h / 2);
    c0 = Math.max(0, Math.min(g.h - 1, row0)) * g.w + col;
  }
  let best = -1, bd = Infinity;
  for (let c = 0; c < g.n; c++) {
    if (!g.standable[c] || occ[c]) continue;
    const d = cdist(g, c0, c);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/**
 * Évalue le programme d'une unité sur l'état actuel (sans rien modifier).
 * @param {object} battle
 * @param {object} unit  BUnit de battle.units
 * @returns {{ruleIndex:number, intent:{kind:string, action:string, targetId?:string, dest?:{q:number,r:number}, spell?:string, place?:string, n?:number, mode?:string}}}
 *   ruleIndex = -1 pour l'instinct (intent.action = 'INSTINCT').
 */
export function chooseRule(battle, unit) {
  const ctx = makeCtx(battle);
  const i = unitIndex(ctx, unit);
  if (i < 0) return { ruleIndex: -1, intent: { kind: 'idle', action: 'INSTINCT' } };
  return decideIdx(ctx, i);
}

/**
 * Valeur de vérité d'une condition (rune de perception, NON compris) pour l'unité, sur l'état actuel.
 * @returns {boolean}
 */
export function evaluateCondition(battle, unit, cond) {
  const ctx = makeCtx(battle);
  const i = unitIndex(ctx, unit);
  if (i < 0 || ctx.cell[i] < 0) return false;
  return evalCond(ctx, i, cond);
}

/**
 * Intention que l'unité choisirait au prochain instant (pur, pour l'UI : règle surlignée, cible…).
 * @returns {{ruleIndex:number, intent:object}}
 */
export function previewIntent(battle, unitId) {
  const ctx = makeCtx(battle);
  const i = idxOf(ctx, unitId);
  if (i < 0) return { ruleIndex: -1, intent: { kind: 'idle', action: 'INSTINCT' } };
  return decideIdx(ctx, i);
}

/**
 * Avance la bataille d'un instant (mute `battle`). Sans effet si la bataille est finie.
 * @returns {{tick:number, events:object[], result:null|{winner:'player'|'enemy', reason:'commander'|'annihilation'|'time', tick:number, values:{player:number, enemy:number}}}}
 */
export function stepBattle(battle) {
  if (battle.result) return { tick: battle.tick, events: [], result: battle.result };
  const events = battle.pending && battle.pending.length ? battle.pending.splice(0, battle.pending.length) : [];
  if (!battle.pending) battle.pending = [];
  const ctx = makeCtx(battle), units = battle.units, nU = units.length;
  // 1. Décisions sur l'instantané
  const intents = new Array(nU).fill(null), rules = new Array(nU).fill(-1);
  for (let i = 0; i < nU; i++) {
    if (!units[i].alive || ctx.cell[i] < 0) continue;
    const d = decideIdx(ctx, i);
    intents[i] = d.intent; rules[i] = d.ruleIndex;
  }
  for (let i = 0; i < nU; i++) {
    const u = units[i], it = intents[i];
    if (!it) continue;
    u.lastRule = rules[i]; u.lastAction = it.action; u.lastTargetId = it.targetId ?? null; u.intent = it;
    u.status.holding = it.kind === 'hold';
    u.status.charging = it.kind === 'charge';
    events.push({ type: 'decide', unitId: u.id, ruleIndex: rules[i], action: it.action, kind: it.kind, targetId: it.targetId ?? null });
  }
  for (let i = 0; i < nU; i++) if (intents[i] && intents[i].kind === 'hold') events.push({ type: 'hold', unitId: units[i].id });
  battle.tick += 1;
  ctx.tickNow = battle.tick;
  // 2. Mouvement
  movementPhase(ctx, intents, events);
  // 3. Combat
  const fresh = combatPhase(ctx, intents, events);
  // 4. Fin d'instant
  endPhase(battle, fresh, events);
  if (battle.result) events.push({ type: 'end', result: battle.result });
  return { tick: battle.tick, events, result: battle.result };
}

/**
 * Envoie un corbeau portant un nouveau programme à une unité de `side`. Il part du commandant, vole
 * RAVEN_SPEED_HEX hex par instant vers la position actuelle du destinataire et livre à la fin de l'instant
 * d'arrivée (effectif à l'instant suivant). L'événement 'raven_launch' apparaît en tête du prochain TickReport.
 * @returns {{ok:true, ravenId:string}|{ok:false, reason:string}}
 */
export function sendRaven(battle, side, unitId, program) {
  if (battle.result) return { ok: false, reason: 'La bataille est terminée.' };
  if (side !== 'player' && side !== 'enemy') return { ok: false, reason: 'Camp inconnu.' };
  if ((battle.ravensLeft?.[side] | 0) <= 0) return { ok: false, reason: 'Plus aucun corbeau disponible.' };
  const cmd = battle.units.find(u => u.side === side && u.cls === 'commander' && u.alive);
  if (!cmd) return { ok: false, reason: 'Le commandant est tombé : aucun corbeau ne peut partir.' };
  const u = unitById(battle, unitId);
  if (!u || u.side !== side) return { ok: false, reason: 'Destinataire inconnu.' };
  if (!u.alive) return { ok: false, reason: 'Ce destinataire est tombé.' };
  if (battle.ravens.some(r => r.alive && !r.delivered && r.unitId === unitId)) return { ok: false, reason: 'Un corbeau vole déjà vers cette unité.' };
  const prog = normalizeProgram(program, u.type);
  const v = validateProgram(prog, u.type, { unlocked: null, slotsBonus: u.slots - (UNITS[u.type]?.slots ?? u.slots) });
  if (!v.ok) return { ok: false, reason: v.errors[0] || 'Programme invalide.' };
  const w = hexToWorld(cmd.q, cmd.r);
  const id = 'r' + battle.nextId++;
  // tried : ids des tireurs qui ont déjà eu leur jet d'interception contre ce corbeau.
  battle.ravens.push({ id, side, unitId, program: prog, x: w.x, z: w.z, alive: true, delivered: false, launchedAt: battle.tick, tried: [] });
  battle.ravensLeft[side] -= 1;
  if (!battle.pending) battle.pending = [];
  battle.pending.push({ type: 'raven_launch', ravenId: id, side, unitId, x: w.x, z: w.z });
  return { ok: true, ravenId: id };
}

// Copie du programme avec les paramètres manquants complétés (valeurs par défaut, sort null → premier compatible).
function normalizeProgram(program, unitType) {
  const p = cloneProgram(program);
  if (!p || !Array.isArray(p.rules)) return p;
  for (const rule of p.rules) {
    if (!rule) continue;
    for (const c of rule.conds ?? []) if (c && RUNES[c.id]) c.params = resolveParams(c.id, c.params, unitType);
    if (rule.action && RUNES[rule.action.id]) rule.action.params = resolveParams(rule.action.id, rule.action.params, unitType);
  }
  return p;
}

/**
 * Joue la bataille jusqu'au résultat. `maxTicks` (facultatif) remplace la limite de temps de la bataille
 * (score au temps à cette limite). `policies.enemy` / `policies.player` : fn(battle, side) → {unitId, program} | null,
 * appelée avant chaque instant (envoi de corbeau). Une politique qui lève une exception est ignorée pour cet instant.
 * @returns {{winner:'player'|'enemy', reason:string, tick:number, values:{player:number, enemy:number}}}
 */
export function runBattle(battle, { maxTicks, policies = {} } = {}) {
  if (Number.isFinite(maxTicks)) battle.maxTicks = maxTicks;
  let guard = 0;
  while (!battle.result && guard++ < 100000) {
    for (const side of SIDES) {
      const fn = policies && policies[side];
      if (typeof fn !== 'function') continue;
      let order = null;
      try { order = fn(battle, side); } catch { order = null; }
      if (order && order.unitId && order.program) sendRaven(battle, side, order.unitId, order.program);
    }
    stepBattle(battle);
  }
  return battle.result;
}

/** Valeur d'un camp : somme de cost × PV/PV max des unités vivantes. */
export function battleValue(battle, side) {
  let v = 0;
  for (const u of battle.units) if (u.side === side && u.alive && u.maxHp > 0) v += (UNITS[u.type]?.cost ?? 0) * (u.hp / u.maxHp);
  return v;
}

/**
 * Vainqueur si le temps s'arrêtait maintenant : le camp qui a conservé la plus grande part de sa valeur de départ
 * (battle.startValue) ; égalité → 'enemy'. Bataille sans startValue (ancienne sauvegarde) : valeur absolue.
 * @returns {'player'|'enemy'}
 */
export function timeoutWinner(battle) {
  const vp = battleValue(battle, 'player'), ve = battleValue(battle, 'enemy');
  const sp = battle.startValue?.player, se = battle.startValue?.enemy;
  if (sp > 0 && se > 0) return vp / sp > ve / se + EPS ? 'player' : 'enemy';
  return vp > ve ? 'player' : 'enemy';
}

/** Unité par id (null si inconnue). */
export function unitById(battle, id) {
  for (const u of battle.units) if (u.id === id) return u;
  return null;
}

/**
 * Copie indépendante et rejouable de la bataille. La carte (immuable pendant la bataille) est partagée
 * pour profiter des caches ; tout le reste est copié profondément.
 */
export function cloneBattle(battle) {
  const map = battle.map;
  const copy = structuredClone({ ...battle, map: null });
  copy.map = map;
  return copy;
}
