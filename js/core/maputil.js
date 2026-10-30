// js/core/maputil.js — accès à la carte de bataille, coûts, zones, chemins. Module pur.
//
// Map  = { w, h, seed, name, tiles: Tile[] }   (tiles en ordre ligne-major : index = row * w + col)
// Tile = { q, r, col, row, terrain, variant }
import { TERRAIN, DEPLOY_COLS, STANDABLE_TERRAINS } from './data.js';
import { key, neighbors, distance, offsetToAxial } from './hex.js';

const indexCache = new WeakMap();
function index(map) {
  let idx = indexCache.get(map);
  if (!idx || idx.size !== map.tiles.length) {
    idx = new Map();
    for (const t of map.tiles) idx.set(key(t.q, t.r), t);
    indexCache.set(map, idx);
  }
  return idx;
}

export const getTile = (map, q, r) => index(map).get(key(q, r));
export const inBounds = (map, q, r) => index(map).has(key(q, r));
export function isPassable(map, q, r) { const t = getTile(map, q, r); return !!t && TERRAIN[t.terrain].passable; }
export function isStandable(map, q, r) { const t = getTile(map, q, r); return !!t && STANDABLE_TERRAINS.includes(t.terrain); }

// Coût pour entrer dans (q, r) pour une unité de classe `cls`. Infinity si infranchissable/hors carte.
export function moveCost(map, q, r, cls) {
  const t = getTile(map, q, r);
  if (!t) return Infinity;
  const T = TERRAIN[t.terrain];
  if (!T.passable) return Infinity;
  return cls === 'cavalry' && T.cavalryCost ? T.cavalryCost : T.cost;
}

export function deployHexes(map, side) {
  const cols = DEPLOY_COLS[side];
  return map.tiles.filter(t => cols.includes(t.col) && STANDABLE_TERRAINS.includes(t.terrain)).map(t => ({ q: t.q, r: t.r }));
}

export function isDeployHex(map, side, q, r) {
  const t = getTile(map, q, r);
  return !!t && DEPLOY_COLS[side].includes(t.col) && STANDABLE_TERRAINS.includes(t.terrain);
}

export function centerHex(map) { return offsetToAxial(Math.floor(map.w / 2), Math.floor(map.h / 2)); }

// A* par coût de terrain. `blocked` : Set de clés "q,r" infranchissables (unités). `goal` peut être occupé :
// si allowGoalBlocked, on peut viser un hex occupé (le chemin s'arrête à côté). Renvoie [start, …, goal] ou null.
export function findPath(map, start, goal, { cls = 'infantry', blocked = new Set(), allowGoalBlocked = true, maxCost = 400 } = {}) {
  const gk = key(goal.q, goal.r), sk = key(start.q, start.r);
  if (sk === gk) return [start];
  const open = [{ q: start.q, r: start.r, f: distance(start, goal), g: 0 }];
  const came = new Map(), gScore = new Map([[sk, 0]]);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f || (open[i].f === open[bi].f && open[i].g > open[bi].g)) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.q, cur.r);
    if (ck === gk) {
      const path = [{ q: cur.q, r: cur.r }];
      let k = ck;
      while (came.has(k)) { const p = came.get(k); path.unshift(p); k = key(p.q, p.r); }
      return path;
    }
    if (cur.g > (gScore.get(ck) ?? Infinity)) continue;
    for (const n of neighbors(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      const c = moveCost(map, n.q, n.r, cls);
      if (!isFinite(c)) continue;
      if (blocked.has(nk) && !(allowGoalBlocked && nk === gk)) continue;
      const g = cur.g + c;
      if (g > maxCost) continue;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g); came.set(nk, { q: cur.q, r: cur.r });
        open.push({ q: n.q, r: n.r, g, f: g + distance(n, goal) });
      }
    }
  }
  return null;
}

// Hexes atteignables (Dijkstra) depuis start, coût ≤ budget. Renvoie Map clé -> coût.
export function reachable(map, start, budget, { cls = 'infantry', blocked = new Set() } = {}) {
  const dist = new Map([[key(start.q, start.r), 0]]);
  const frontier = [{ q: start.q, r: start.r, g: 0 }];
  while (frontier.length) {
    frontier.sort((a, b) => a.g - b.g);
    const cur = frontier.shift();
    for (const n of neighbors(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      if (blocked.has(nk)) continue;
      const g = cur.g + moveCost(map, n.q, n.r, cls);
      if (!isFinite(g) || g > budget) continue;
      if (g < (dist.get(nk) ?? Infinity)) { dist.set(nk, g); frontier.push({ q: n.q, r: n.r, g }); }
    }
  }
  return dist;
}
