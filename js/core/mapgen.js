// js/core/mapgen.js — génération procédurale des cartes de bataille. Module pur (aucun DOM).
//
// Carte 14 × 9, disposition rectangulaire odd-q (voir hex.js). Contenu :
//   - une rivière méandreuse (eau connexe) du bord haut au bord bas, entièrement dans les colonnes 4–9,
//     parfois élargie d'une mare ; 2 ou 3 gués, chacun étant à lui seul un vrai passage ;
//   - des bosquets (2–5 hex), 2–4 collines, 0–2 ruines, quelques rochers ;
//   - des zones de déploiement (col 0–2 et 11–13) sans eau ni rochers ;
//   - aucune poche isolée : tout hex franchissable est relié aux deux zones.
// Chaque tirage est vérifié (checkMapInvariants) ; en cas d'échec on retire avec une sous-graine,
// et en dernier recours on renvoie une carte de secours sûre. Déterministe à (seed, kind, index) égaux.
//
// Map = { w, h, seed, name, kind, index, desc, fords: [{q,r}], tiles: Tile[] }   (tiles ligne-major)
// Tile = { q, r, col, row, terrain, variant }
import { MAP_W, MAP_H, TERRAIN, TILE_VARIANTS, DEPLOY_COLS, STANDABLE_TERRAINS } from './data.js';
import { offsetToAxial, axialToOffset, DIRS, distance } from './hex.js';
import { createRng, rngNext, rngInt, rngRange, rngPick, rngChance, rngShuffle, deriveSeed } from './rng.js';

const W = MAP_W, H = MAP_H, N = W * H;
/** Colonnes (incluses) dans lesquelles la rivière doit rester. */
export const RIVER_COLS = [4, 9];
/** Nombre minimal d'hex « standables » par zone de déploiement. */
export const MIN_DEPLOY_STANDABLE = 18;
const MAX_ATTEMPTS = 60;

// ------------------------------------------------------------------ Grille indexée (pré-calculée)
const inside = (c, r) => c >= 0 && c < W && r >= 0 && r < H;
const idx = (c, r) => r * W + c;
const COL = (i) => i % W;
const ROW = (i) => (i - (i % W)) / W;
const AX = Array.from({ length: N }, (_, i) => offsetToAxial(COL(i), ROW(i)));
const NB = Array.from({ length: N }, (_, i) => {
  const out = [];
  for (const d of DIRS) {
    const o = axialToOffset(AX[i].q + d.q, AX[i].r + d.r);
    if (inside(o.col, o.row)) out.push(idx(o.col, o.row));
  }
  return out;
});
const hd = (i, j) => distance(AX[i], AX[j]);
const ZONE = {
  player: Array.from({ length: N }, (_, i) => i).filter(i => DEPLOY_COLS.player.includes(COL(i))),
  enemy: Array.from({ length: N }, (_, i) => i).filter(i => DEPLOY_COLS.enemy.includes(COL(i))),
};
const inDeploy = (i) => DEPLOY_COLS.player.includes(COL(i)) || DEPLOY_COLS.enemy.includes(COL(i));
const passable = (t) => TERRAIN[t].passable;

function weighted(rng, items, weightOf) {
  let total = 0;
  const ws = items.map(it => { const w = Math.max(0, weightOf(it)); total += w; return w; });
  if (total <= 0) return null;
  let x = rngNext(rng) * total;
  for (let i = 0; i < items.length; i++) { x -= ws[i]; if (x < 0) return items[i]; }
  return items[items.length - 1];
}

// Parcours en largeur sur les hex franchissables. `open(i)` peut surcharger le terrain.
function flood(g, starts, open = (i) => passable(g[i])) {
  const seen = new Uint8Array(N);
  const stack = [];
  for (const s of starts) if (open(s) && !seen[s]) { seen[s] = 1; stack.push(s); }
  while (stack.length) {
    const i = stack.pop();
    for (const n of NB[i]) if (!seen[n] && open(n)) { seen[n] = 1; stack.push(n); }
  }
  return seen;
}
const zonesConnected = (g, open) => { const s = flood(g, ZONE.player, open); return ZONE.enemy.some(i => s[i]); };
// Vrai si tout hex franchissable est atteignable depuis la zone du joueur (et la zone ennemie l'est aussi).
function noPockets(g) {
  const s = flood(g, ZONE.player);
  for (let i = 0; i < N; i++) if (passable(g[i]) && !s[i]) return false;
  return ZONE.enemy.some(i => s[i]);
}

// ------------------------------------------------------------------ Rivière
function carveRiver(rng, g) {
  let c = rngRange(rng, 5, 8), r = 0;
  const path = [idx(c, r)];
  let drift = rngChance(rng, 0.5) ? 1 : -1, run = 0;
  for (let guard = 0; r < H - 1 && guard < 40; guard++) {
    const a = offsetToAxial(c, r);
    const moves = [
      { d: 0, q: a.q, r: a.r + 1 },       // S
      { d: 1, q: a.q + 1, r: a.r },       // SE
      { d: -1, q: a.q - 1, r: a.r + 1 },  // SO
    ].map(m => ({ ...m, o: axialToOffset(m.q, m.r) }));
    const m = weighted(rng, moves, (mv) => {
      if (!inside(mv.o.col, mv.o.row) || mv.o.col < RIVER_COLS[0] || mv.o.col > RIVER_COLS[1]) return 0;
      if (mv.d === 0) return 1.3;
      let w = mv.d === drift ? (run < 3 ? 3.2 : 0.6) : 0.55;
      // Murs souples : on rebondit avant d'atteindre le bord de la bande centrale.
      if ((mv.o.col <= RIVER_COLS[0] && mv.d < 0) || (mv.o.col >= RIVER_COLS[1] && mv.d > 0)) w *= 0.3;
      return w;
    });
    if (m.d === 0) { run = 0; if (rngChance(rng, 0.45)) drift = -drift; }
    else if (m.d === drift) run++;
    else { drift = m.d; run = 1; }
    c = m.o.col; r = m.o.row;
    path.push(idx(c, r));
  }
  for (const i of path) g[i] = 'water';
  return path;
}

// Une mare : un ou deux hex d'eau accolés au cours, sans créer de poche fermée.
function addPool(rng, g, river, size) {
  const added = [];
  for (let k = 0; k < size; k++) {
    const base = added.length ? added : river.slice(3, river.length - 3);
    const cands = [];
    for (const b of base) for (const n of NB[b]) {
      const cc = COL(n), rr = ROW(n);
      if (g[n] === 'plain' && cc >= RIVER_COLS[0] && cc <= RIVER_COLS[1] && rr >= 1 && rr <= H - 2 && !cands.includes(n)) cands.push(n);
    }
    for (const n of rngShuffle(rng, cands)) {
      g[n] = 'water';
      if (noPockets(g)) { added.push(n); break; }
      g[n] = 'plain';
    }
  }
  return added;
}

// Gués : chaque gué choisi doit, à lui seul, relier les deux rives.
function placeFords(rng, g, river, count) {
  const isRiver = (i) => g[i] === 'water' || g[i] === 'ford';
  const crossing = (f) => zonesConnected(g, (i) => (i === f ? true : !isRiver(i) && passable(g[i])));
  const cands = river.filter(i => ROW(i) >= 1 && ROW(i) <= H - 2 && crossing(i));
  const bands = count === 3 ? [[1, 2], [3, 5], [6, 7]] : [[1, 3], [5, 7]];
  const chosen = [];
  const farEnough = (i) => chosen.every(f => hd(f, i) >= 3);
  for (const [a, b] of bands) {
    const inBand = rngShuffle(rng, cands.filter(i => ROW(i) >= a && ROW(i) <= b && farEnough(i)));
    if (inBand.length) chosen.push(inBand[0]);
  }
  for (const i of rngShuffle(rng, cands)) { if (chosen.length >= count) break; if (!chosen.includes(i) && farEnough(i)) chosen.push(i); }
  for (const f of chosen) g[f] = 'ford';
  return chosen;
}

// ------------------------------------------------------------------ Reliefs et couverts
function nearest(i, set) { let d = Infinity; for (const j of set) d = Math.min(d, hd(i, j)); return d; }

function placeHills(rng, g, count, ctx) {
  const placed = [];
  const capZone = (i) => {
    const zone = DEPLOY_COLS.player.includes(COL(i)) ? 'p' : DEPLOY_COLS.enemy.includes(COL(i)) ? 'e' : null;
    return !zone || placed.filter(h => (zone === 'p' ? DEPLOY_COLS.player : DEPLOY_COLS.enemy).includes(COL(h))).length < 1;
  };
  let guard = 0, sideTurn = ctx.westFirst ? 0 : 1;
  while (placed.length < count && guard++ < 30) {
    const ridge = placed.length > 0 && rngChance(rng, 0.3);
    let pool;
    if (ridge) {
      const last = placed[placed.length - 1];
      pool = NB[last].filter(n => g[n] === 'plain' && COL(n) >= 1 && COL(n) <= W - 2);
    } else {
      const bank = sideTurn++ % 2 === 0 ? ctx.west : ctx.east;
      pool = [];
      for (let i = 0; i < N; i++) {
        const cc = COL(i);
        if (g[i] !== 'plain' || cc < 1 || cc > W - 2 || !bank[i]) continue;
        if (nearest(i, placed) < 3) continue;
        pool.push(i);
      }
    }
    pool = pool.filter(capZone);
    const pick = weighted(rng, pool, (i) => {
      const dF = nearest(i, ctx.fords);
      let w = 1;
      if (dF >= 2 && dF <= 3) w += 2.5;          // surplombe un gué
      if (inDeploy(i)) w *= ctx.kind === 'boss' && DEPLOY_COLS.enemy.includes(COL(i)) ? 1.2 : 0.45;
      if (ROW(i) === 0 || ROW(i) === H - 1) w *= 0.6;
      return w;
    });
    if (pick == null) continue;
    g[pick] = 'hill';
    placed.push(pick);
  }
  return placed;
}

function placeRuins(rng, g, count, ctx) {
  const placed = [];
  for (let k = 0; k < count; k++) {
    const pool = [];
    for (let i = 0; i < N; i++) {
      const cc = COL(i);
      if (g[i] !== 'plain' || cc < 3 || cc > W - 4 || NB[i].some(n => g[n] === 'ruins')) continue;
      if (nearest(i, placed) < 4) continue;
      pool.push(i);
    }
    const pick = weighted(rng, pool, (i) => {
      const dF = nearest(i, ctx.fords);
      let w = 1;
      if (dF === 1 || dF === 2) w += 2;                         // vieille tour gardant le gué
      if (ctx.kind === 'boss' && k === 0) w = COL(i) >= 9 ? w * 4 : w * 0.2;  // le repaire du chef
      return w;
    });
    if (pick == null) break;
    g[pick] = 'ruins';
    placed.push(pick);
  }
  return placed;
}

function placeGroves(rng, g, count, ctx) {
  const groves = [];
  const zoneForest = (cols) => { let n = 0; for (let i = 0; i < N; i++) if (g[i] === 'forest' && cols.includes(COL(i))) n++; return n; };
  const zoneOk = (i) => {
    if (DEPLOY_COLS.player.includes(COL(i))) return zoneForest(DEPLOY_COLS.player) < 4;
    if (DEPLOY_COLS.enemy.includes(COL(i))) return zoneForest(DEPLOY_COLS.enemy) < 4;
    return true;
  };
  const all = () => groves.flat();
  for (let k = 0; k < count; k++) {
    const bank = (k + (ctx.westFirst ? 1 : 0)) % 2 === 0 ? ctx.west : ctx.east;
    const pool = [];
    for (let i = 0; i < N; i++) {
      if (g[i] !== 'plain' || !zoneOk(i) || !bank[i]) continue;
      if (nearest(i, all()) < 3) continue;
      pool.push(i);
    }
    const seed = weighted(rng, pool, (i) => {
      let w = 1;
      if (inDeploy(i)) w *= 0.5;
      const dR = nearest(i, ctx.river);
      if (dR <= 2) w += 1;                              // bois de berge
      return w;
    });
    if (seed == null) continue;
    const size = rngRange(rng, 2, 5);
    const grove = [seed];
    g[seed] = 'forest';
    // Un bosquet ne touche jamais un autre bosquet : chaque massif reste un groupe de 2 à 5 hex.
    const others = new Set(all());
    const touchesOther = (n) => NB[n].some(m => others.has(m));
    for (let guard = 0; grove.length < size && guard < 20; guard++) {
      const front = [];
      for (const t of grove) for (const n of NB[t]) if (g[n] === 'plain' && !front.includes(n) && zoneOk(n) && !touchesOther(n)) front.push(n);
      if (!front.length) break;
      const n = rngPick(rng, front);
      g[n] = 'forest';
      grove.push(n);
    }
    if (grove.length < 2) { g[seed] = 'plain'; continue; }
    groves.push(grove);
  }
  return groves;
}

function placeRocks(rng, g, count, ctx) {
  const placed = [];
  const fordMouth = new Set(ctx.fords.flatMap(f => NB[f]));
  for (let guard = 0; placed.length < count && guard < 40; guard++) {
    const pair = placed.length > 0 && rngChance(rng, 0.3);
    let pool = [];
    if (pair) pool = NB[placed[placed.length - 1]].filter(n => g[n] === 'plain');
    else for (let i = 0; i < N; i++) if (g[i] === 'plain') pool.push(i);
    pool = pool.filter(i => COL(i) >= 3 && COL(i) <= W - 4 && !fordMouth.has(i) && (pair || nearest(i, placed) >= 3));
    const pick = weighted(rng, pool, (i) => {
      let w = 1;
      if (nearest(i, ctx.river) === 1) w += 0.8;    // éboulis de berge
      if (ROW(i) === 0 || ROW(i) === H - 1) w += 0.5;
      return w;
    });
    if (pick == null) continue;
    g[pick] = 'rocks';
    if (!noPockets(g) || !ctx.fords.every(f => fordStillCrosses(g, f))) { g[pick] = 'plain'; continue; }
    placed.push(pick);
  }
  return placed;
}

function fordStillCrosses(g, f) {
  return zonesConnected(g, (i) => (i === f ? true : passable(g[i]) && g[i] !== 'ford'));
}

// ------------------------------------------------------------------ Variantes de tuiles
function assignVariants(rng, g, groves) {
  const variant = new Array(N).fill(0);
  // Herbes sèches par plaques, petits chemins épars.
  const dry = [];
  const nDry = rngRange(rng, 2, 4);
  for (let k = 0; k < nDry; k++) dry.push(rngInt(rng, N));
  for (let i = 0; i < N; i++) {
    if (g[i] !== 'plain') continue;
    const dD = nearest(i, dry);
    if (dD === 0 || (dD === 1 && rngChance(rng, 0.7)) || (dD === 2 && rngChance(rng, 0.2))) variant[i] = 2;
    else if (rngChance(rng, 0.14)) variant[i] = 1;
    else variant[i] = 0;
  }
  // Chaque bosquet a son essence dominante.
  const fv = TILE_VARIANTS.forest;
  for (const grove of groves) {
    const main = rngInt(rng, fv);
    for (const t of grove) variant[t] = rngChance(rng, 0.85) ? main : rngInt(rng, fv);
  }
  for (let i = 0; i < N; i++) {
    const n = TILE_VARIANTS[g[i]] ?? 1;
    if (g[i] !== 'plain' && g[i] !== 'forest') variant[i] = n > 1 ? rngInt(rng, n) : 0;
    variant[i] = Math.min(variant[i], n - 1);
  }
  return variant;
}

// ------------------------------------------------------------------ Noms et description
const TAILS = ['des Corneilles', 'de Brumerive', 'aux Loups', 'du Pendu', 'des Saules', 'de Valcendre', 'du Héron Gris',
  'des Trois Pierres', 'de Morteau', 'aux Ronces', 'de Fendebise', 'des Chardons', 'de l’Orme Creux', 'des Brumes',
  'de Grisval', 'du Vieux Bac', 'de Sombrecombe', 'des Lavandières', 'du Meunier', 'de Hautbourg', 'aux Hiboux',
  'de Clairefont', 'des Sept Chênes', 'de Pierrefendue', 'de la Dame Grise', 'des Tourbières', 'du Roi Mort'];
const ELITE_TAILS = ['des Crocs', 'des Os Blanchis', 'du Hurlement', 'des Lances Brisées', 'de la Male Heure',
  'des Charognards', 'du Sang Noir', 'des Pendus', 'aux Corbeaux Gras', 'des Écorcheurs'];
const BOSS_TAILS = ['du Chef de guerre', 'de Noirecroc', 'du Dernier Hurlement', 'des Mille Crocs', 'du Roi Gobelin',
  'de Grimmegueule', 'de la Horde Noire'];
const HEADS = {
  ford: ['Gué', 'Passage', 'Gué'],
  river: ['Rive', 'Berges'],
  forest: ['Bois', 'Sylve', 'Taillis', 'Futaie'],
  hill: ['Hauts', 'Butte', 'Coteaux', 'Tertre'],
  ruins: ['Ruines', 'Tour', 'Vieilles Pierres'],
  open: ['Lande', 'Val', 'Combe', 'Marche', 'Prés'],
};
const BOSS_HEADS = ['Fosse', 'Repaire', 'Antre', 'Gué'];
const NUM = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six'];

function makeName(rng, kind, f) {
  if (kind === 'boss') {
    const heads = f.ruins > 0 ? [...BOSS_HEADS, 'Trône', 'Ruines'] : BOSS_HEADS;
    return `${rngPick(rng, heads)} ${rngPick(rng, BOSS_TAILS)}`;
  }
  if (kind === 'battle' && f.fords === 3 && rngChance(rng, 0.25)) return `Les Trois Gués ${rngPick(rng, ['du Nord', 'de l’Aube', 'de Brumerive', 'aux Saules'])}`;
  const choices = [
    { k: 'ford', w: 2.2 }, { k: 'river', w: 0.8 },
    { k: 'forest', w: f.forest >= 12 ? 3 : f.forest >= 8 ? 1 : 0 },
    { k: 'hill', w: f.hills >= 3 ? 2 : 0.4 },
    { k: 'ruins', w: f.ruins > 0 ? 2 : 0 },
    { k: 'open', w: f.forest <= 8 ? 2.2 : 0.8 },
  ];
  const head = rngPick(rng, HEADS[weighted(rng, choices, c => c.w).k]);
  const headWords = head.toLowerCase().split(' ');
  // Évite « Vieilles Pierres des Trois Pierres » : la queue ne répète aucun mot de la tête.
  const tails = (kind === 'elite' ? ELITE_TAILS : TAILS).filter(t => !t.toLowerCase().split(/[\s’']/).some(w => headWords.includes(w)));
  return `${head} ${rngPick(rng, tails)}`;
}

function makeDesc(rng, kind, f) {
  const river = rngPick(rng, f.pool ? ['Une rivière qui s’élargit en mare', 'Une rivière lente, grossie d’une mare'] :
    ['Une rivière sinueuse', 'Une rivière vive', 'Un cours d’eau froid et tortueux']);
  const parts = [`${river}, franchissable à ${NUM[f.fords]} gués`];
  const extras = [];
  if (f.forest >= 12) extras.push('des bois épais');
  else if (f.forest >= 7) extras.push('des bosquets');
  else extras.push('quelques arbres épars');
  if (f.hills) extras.push(f.hills === 1 ? 'une butte' : `${NUM[f.hills]} hauteurs`);
  if (f.ruins) extras.push(f.ruins === 1 ? 'une vieille ruine' : 'de vieilles ruines');
  if (f.rocks >= 4) extras.push('des éboulis');
  const last = extras.pop();
  const tail = extras.length ? `${extras.join(', ')} et ${last}` : last;
  const mood = kind === 'boss' ? ' Le repaire de la horde est tout proche.' : kind === 'elite' ? ' L’endroit sent la charogne.' : '';
  return `${parts[0]} ; ${tail}.${mood}`;
}

// ------------------------------------------------------------------ Vérifications (exportées pour les tests)
/**
 * Vérifie les invariants d'une carte générée. Pur.
 * @param {object} map Carte au format Map.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkMapInvariants(map) {
  const errors = [];
  if (!map || map.w !== W || map.h !== H || !Array.isArray(map.tiles) || map.tiles.length !== N) return { ok: false, errors: ['dimensions'] };
  const g = new Array(N);
  map.tiles.forEach((t, i) => {
    if (t.col !== COL(i) || t.row !== ROW(i)) errors.push(`ordre des tuiles ${i}`);
    const a = offsetToAxial(t.col, t.row);
    if (a.q !== t.q || a.r !== t.r) errors.push(`axial ${i}`);
    if (!TERRAIN[t.terrain]) errors.push(`terrain inconnu ${t.terrain}`);
    if (!Number.isInteger(t.variant) || t.variant < 0 || t.variant >= (TILE_VARIANTS[t.terrain] ?? 1)) errors.push(`variante ${i}`);
    g[i] = t.terrain;
  });
  if (errors.length) return { ok: false, errors };
  const riverIdx = [];
  for (let i = 0; i < N; i++) if (g[i] === 'water' || g[i] === 'ford') riverIdx.push(i);
  if (riverIdx.some(i => COL(i) < RIVER_COLS[0] || COL(i) > RIVER_COLS[1])) errors.push('rivière hors des colonnes 4–9');
  const rs = flood(g, riverIdx.slice(0, 1), (i) => g[i] === 'water' || g[i] === 'ford');
  if (riverIdx.some(i => !rs[i])) errors.push('rivière non connexe');
  if (!riverIdx.some(i => ROW(i) === 0) || !riverIdx.some(i => ROW(i) === H - 1)) errors.push('la rivière ne traverse pas la carte');
  const fords = riverIdx.filter(i => g[i] === 'ford');
  if (fords.length < 2 || fords.length > 3) errors.push(`gués : ${fords.length}`);
  if (zonesConnected(g, (i) => passable(g[i]) && g[i] !== 'ford')) errors.push('la rivière ne sépare pas les deux camps');
  for (const f of fords) if (!fordStillCrosses(g, f)) errors.push(`gué ${COL(f)},${ROW(f)} sans passage`);
  if (!noPockets(g)) errors.push('poche isolée ou camps non reliés');
  for (const side of ['player', 'enemy']) {
    const z = ZONE[side];
    if (z.some(i => g[i] === 'water' || g[i] === 'rocks')) errors.push(`eau ou rochers dans la zone ${side}`);
    if (z.filter(i => STANDABLE_TERRAINS.includes(g[i])).length < MIN_DEPLOY_STANDABLE) errors.push(`zone ${side} trop petite`);
  }
  const count = (t) => g.filter(x => x === t).length;
  if (count('hill') < 2 || count('hill') > 4) errors.push(`collines : ${count('hill')}`);
  if (count('ruins') > 2) errors.push(`ruines : ${count('ruins')}`);
  if (count('rocks') < 1) errors.push('aucun rocher');
  if (count('forest') < 4) errors.push('trop peu de forêt');
  const seenF = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (g[i] !== 'forest' || seenF[i]) continue;
    const comp = flood(g, [i], (j) => g[j] === 'forest');
    let size = 0;
    for (let j = 0; j < N; j++) if (comp[j]) { seenF[j] = 1; size++; }
    if (size < 2 || size > 5) errors.push(`bosquet de ${size} hex`);
  }
  return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------ Génération
const KIND_PARAMS = {
  battle: { fords: [2, 3, 3], pool: 0.25, poolSize: 1, hills: [2, 4], ruins: [0, 1, 1, 2], groves: [3, 5], rocks: [2, 3] },
  elite:  { fords: [2, 2, 3], pool: 0.6,  poolSize: 2, hills: [3, 4], ruins: [1, 1, 2],    groves: [3, 4], rocks: [3, 5] },
  boss:   { fords: [2],       pool: 0.7,  poolSize: 2, hills: [3, 4], ruins: [1, 2, 2],    groves: [3, 4], rocks: [4, 6] },
};

function attempt(rng, kind) {
  const P = KIND_PARAMS[kind] ?? KIND_PARAMS.battle;
  const g = new Array(N).fill('plain');
  const river = carveRiver(rng, g);
  const cols = river.map(COL);
  const riverMinCol = Math.min(...cols), riverMaxCol = Math.max(...cols);
  if (riverMaxCol - riverMinCol < 2) return null;                           // pas assez de méandres
  const pool = rngChance(rng, P.pool) ? addPool(rng, g, river, P.poolSize) : [];
  const fordCount = rngPick(rng, P.fords);
  const fords = placeFords(rng, g, river, fordCount);
  if (fords.length !== fordCount) return null;
  const dry = (i) => passable(g[i]) && g[i] !== 'ford';
  const ctx = {
    kind, river: [...river, ...pool], fords, riverMinCol, riverMaxCol, westFirst: rngChance(rng, 0.5),
    west: flood(g, ZONE.player, dry), east: flood(g, ZONE.enemy, dry),
  };
  const ruins = placeRuins(rng, g, rngPick(rng, P.ruins), ctx);
  const hills = placeHills(rng, g, rngRange(rng, ...P.hills), ctx);
  const groves = placeGroves(rng, g, rngRange(rng, ...P.groves), ctx);
  const rocks = placeRocks(rng, g, rngRange(rng, ...P.rocks), ctx);
  if (hills.length < 2) return null;
  return { g, river, pool, fords, ruins, hills, groves, rocks };
}

function fallbackLayout() {
  // Carte de secours (sûre) : rivière en S, deux gués, reliefs symétriques.
  const g = new Array(N).fill('plain');
  const river = [[6, 0], [6, 1], [7, 1], [7, 2], [7, 3], [6, 3], [6, 4], [6, 5], [7, 5], [7, 6], [7, 7], [6, 7], [6, 8]];
  // Assure la connexité en reliant chaque paire par un chemin hex.
  const cells = [];
  for (let k = 0; k < river.length; k++) {
    const i = idx(...river[k]);
    if (k > 0) {
      const p = cells[cells.length - 1];
      if (!NB[p].includes(i)) {
        const bridge = NB[p].find(n => NB[n].includes(i) && COL(n) >= 4 && COL(n) <= 9);
        if (bridge != null) cells.push(bridge);
      }
    }
    cells.push(i);
  }
  for (const i of cells) g[i] = 'water';
  const fords = [cells.find(i => ROW(i) === 2), cells.find(i => ROW(i) === 6)].filter(i => i != null);
  for (const f of fords) g[f] = 'ford';
  const put = (t, list) => list.forEach(([c, r]) => { if (g[idx(c, r)] === 'plain') g[idx(c, r)] = t; });
  put('hill', [[4, 2], [9, 6], [3, 6]]);
  put('forest', [[3, 0], [3, 1], [2, 1], [10, 7], [11, 7], [10, 8], [9, 2], [10, 2]]);
  put('rocks', [[5, 7], [8, 1]]);
  put('ruins', [[9, 4]]);
  const groves = [[idx(3, 0), idx(3, 1), idx(2, 1)], [idx(10, 7), idx(11, 7), idx(10, 8)], [idx(9, 2), idx(10, 2)]];
  return { g, river: cells, pool: [], fords, ruins: [idx(9, 4)], hills: [], groves, rocks: [] };
}

/**
 * Génère une carte de bataille 14×9 (odd-q). Déterministe : mêmes paramètres => même carte.
 * @param {object} opts
 * @param {number|string} opts.seed Graine (nombre ou texte).
 * @param {'battle'|'elite'|'boss'} [opts.kind='battle'] Type de nœud : élite et boss sont plus dramatiques
 *   (mares, plus de rochers, moins de gués, ruines du repaire côté ennemi pour le boss).
 * @param {number} [opts.index=0] Indice de la bataille dans la campagne (fait varier la carte).
 * @returns {{ w:number, h:number, seed:(number|string), name:string, kind:string, index:number, desc:string,
 *   fords:{q:number,r:number}[], tiles:{q:number,r:number,col:number,row:number,terrain:string,variant:number}[] }}
 */
export function generateMap({ seed = 1, kind = 'battle', index = 0 } = {}) {
  if (!KIND_PARAMS[kind]) kind = 'battle';
  let layout = null, rng = null;
  for (let a = 0; a < MAX_ATTEMPTS && !layout; a++) {
    rng = createRng(deriveSeed('map', seed, kind, index, a));
    const L = attempt(rng, kind);
    if (!L) continue;
    const probe = buildMap(L, rng, seed, kind, index);
    if (checkMapInvariants(probe).ok) return probe;
  }
  rng = createRng(deriveSeed('map-fallback', seed, kind, index));
  return buildMap(fallbackLayout(), rng, seed, kind, index);
}

function buildMap(L, rng, seed, kind, index) {
  const { g } = L;
  const variant = assignVariants(rng, g, L.groves);
  const features = {
    fords: L.fords.length,
    pool: L.pool.length > 0,
    forest: g.filter(t => t === 'forest').length,
    hills: g.filter(t => t === 'hill').length,
    ruins: g.filter(t => t === 'ruins').length,
    rocks: g.filter(t => t === 'rocks').length,
  };
  const tiles = [];
  for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
    const i = idx(col, row);
    tiles.push({ q: AX[i].q, r: AX[i].r, col, row, terrain: g[i], variant: variant[i] });
  }
  return {
    w: W, h: H, seed, kind, index,
    name: makeName(rng, kind, features),
    desc: makeDesc(rng, kind, features),
    fords: L.fords.slice().sort((a, b) => ROW(a) - ROW(b)).map(i => ({ q: AX[i].q, r: AX[i].r })),
    tiles,
  };
}

/**
 * Rendu texte d'une carte (débogage, tests) : une ligne par rangée, décalage d'un demi-hex pour les colonnes impaires.
 * @param {object} map
 * @returns {string}
 */
export function mapToAscii(map) {
  const ch = { plain: '.', forest: 'T', hill: 'h', ford: '=', ruins: 'R', water: '~', rocks: '#' };
  const lines = [];
  for (let row = 0; row < map.h; row++) {
    let top = '', bot = '';
    for (let col = 0; col < map.w; col++) {
      const t = map.tiles[row * map.w + col];
      if (col % 2 === 0) { top += ch[t.terrain] + ' '; bot += '  '; } else { top += '  '; bot += ch[t.terrain] + ' '; }
    }
    lines.push(top.trimEnd(), bot.trimEnd());
  }
  return lines.join('\n');
}
