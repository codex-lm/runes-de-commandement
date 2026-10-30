// js/core/hex.js — géométrie hexagonale FLAT-TOP, coordonnées axiales (q, r).
// Référence : redblobgames.com/grids/hexagons. Module pur.
//
// Monde 3D (three.js, Y vers le haut) : taille = rayon circonscrit = 1.
//   x = 1.5 * q            z = √3 * (r + q / 2)
// Deux centres voisins sont à √3 l'un de l'autre. Un sommet de l'hexagone pointe vers +X.
// La disposition rectangulaire de la carte est "odd-q" : col = q, row = r + (q - (q & 1)) / 2.
// row 0 est au fond (z petit), la dernière ligne est côté caméra (z grand).

export const SQRT3 = Math.sqrt(3);
export const HEX_SIZE = 1;

// Directions axiales, dans l'ordre des angles 30°, -30°… (index 0..5, utilisé pour `facing`).
// facing i => le modèle regarde vers le voisin DIRS[i].
export const DIRS = [
  { q: +1, r: 0 }, { q: +1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: +1 }, { q: 0, r: +1 },
];

export const key = (q, r) => `${q},${r}`;
export const keyOf = (h) => `${h.q},${h.r}`;
export function parseKey(k) { const [q, r] = k.split(',').map(Number); return { q, r }; }

export function neighbors(q, r) { return DIRS.map(d => ({ q: q + d.q, r: r + d.r })); }

export function distance(a, b) {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function offsetToAxial(col, row) { return { q: col, r: row - (col - (col & 1)) / 2 }; }
export function axialToOffset(q, r) { return { col: q, row: r + (q - (q & 1)) / 2 }; }

export function hexToWorld(q, r, size = HEX_SIZE) { return { x: size * 1.5 * q, z: size * SQRT3 * (r + q / 2) }; }

export function hexRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}

export function worldToHex(x, z, size = HEX_SIZE) {
  const fq = (2 / 3 * x) / size;
  const fr = (-1 / 3 * x + SQRT3 / 3 * z) / size;
  return hexRound(fq, fr);
}

// Distance « en hex » entre deux points du monde (pour les corbeaux).
export function worldDistHex(a, b) { return Math.hypot(a.x - b.x, a.z - b.z) / (SQRT3 * HEX_SIZE); }

export function lerpHex(a, b, t) { return { q: a.q + (b.q - a.q) * t, r: a.r + (b.r - a.r) * t }; }

export function line(a, b) {
  const n = distance(a, b), out = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(hexRound(a.q + (b.q - a.q) * t + 1e-6, a.r + (b.r - a.r) * t + 1e-6));
  }
  return out;
}

export function hexesInRange(center, n) {
  const out = [];
  for (let dq = -n; dq <= n; dq++) {
    for (let dr = Math.max(-n, -dq - n); dr <= Math.min(n, -dq + n); dr++) out.push({ q: center.q + dq, r: center.r + dr });
  }
  return out;
}

export function ring(center, n) {
  if (n === 0) return [{ q: center.q, r: center.r }];
  const out = [];
  let h = { q: center.q + DIRS[4].q * n, r: center.r + DIRS[4].r * n };
  for (let i = 0; i < 6; i++) for (let j = 0; j < n; j++) { out.push(h); h = { q: h.q + DIRS[i].q, r: h.r + DIRS[i].r }; }
  return out;
}

// Index de direction (0..5) le plus proche pour regarder de `from` vers `to`.
export function directionIndex(from, to) {
  const a = hexToWorld(from.q, from.r), b = hexToWorld(to.q, to.r);
  const ang = Math.atan2(b.z - a.z, b.x - a.x);
  let best = 0, bestD = Infinity;
  DIRS.forEach((d, i) => {
    const w = hexToWorld(d.q, d.r);
    const da = Math.abs(Math.atan2(Math.sin(ang - Math.atan2(w.z, w.x)), Math.cos(ang - Math.atan2(w.z, w.x))));
    if (da < bestD) { bestD = da; best = i; }
  });
  return best;
}

// Angle (radians, rotation autour de Y dans three.js) pour qu'un modèle dont l'avant est +Z regarde la direction i.
export function facingToYaw(i) {
  const w = hexToWorld(DIRS[i].q, DIRS[i].r);
  return Math.atan2(w.x, w.z);
}
