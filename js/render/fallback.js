// js/render/fallback.js — procedural stand-ins for every key of data.js ASSET_KEYS.
//
// Used by scene.js whenever assets/manifest.json or a .glb is missing or fails to load.
// Style: "painted miniatures" — faceted low-poly parts, per-face colour jitter (hand-painted look),
// slight darkening toward the bottom of every part (fake ambient occlusion), bevelled hex tiles with
// visible soil/rock strata, team-coloured socle rims.
//
// Conventions match docs/ASSETS.md (after glTF conversion, three.js Y-up):
//   - tiles: flat-top hex, a vertex points to +X, circumradius 0.98, top of a flat tile at y = 0,
//     body down to y = -0.35, free disc of radius 0.46 in the middle for the unit socle;
//   - figures: origin = centre of the socle's underside, front = +Z, socle radius 0.40 (0.44 colossi);
//   - named animatable nodes: `Flag` (pivot at the mast), `Glow`, raven `Body`/`Wing_L`/`Wing_R`.
//
// Geometry is merged per material (1–3 meshes per asset) so tiles can be instanced cheaply.
// Results are cached per key: callers must clone (`entry.scene.clone(true)`), never mutate.

import * as THREE from '../../vendor/three/build/three.module.js';
import { mergeGeometries } from '../../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { ASSET_KEYS, UNITS } from '../core/data.js';

/** Stand height (y of the surface a socle rests on) of each fallback terrain tile. */
export const FALLBACK_STAND_HEIGHT = { plain: 0, forest: 0, hill: 0.28, ford: -0.02, ruins: 0.025, water: -0.07, rocks: 0.05 };

/** Body height (socle included, weapons/banners excluded) used to place HP plates. */
const UNIT_HEIGHT = {
  k_commander: 0.98, k_pikemen: 0.56, k_knights: 0.78, k_archers: 0.56, k_mage: 0.66, k_golem: 1.02,
  g_warchief: 0.92, g_spears: 0.5, g_wolves: 0.68, g_archers: 0.5, g_shaman: 0.6, g_troll: 1.02,
};

// ------------------------------------------------------------------ small utils
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const C = (hex) => new THREE.Color(hex);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;

/** Smooth deterministic 2D noise in about [-1, 1] (sum of a few oriented sines). */
function makeNoise(seed) {
  const r = rng32(seed), waves = [];
  for (let i = 0; i < 5; i++) {
    const a = r() * TAU, f = 3 + i * 2.6;
    waves.push({ fx: Math.cos(a) * f, fz: Math.sin(a) * f, ph: r() * TAU, w: 1 / (i + 1) });
  }
  return (x, z) => { let s = 0; for (const w of waves) s += Math.sin(x * w.fx + z * w.fz + w.ph) * w.w; return s / 2.28; };
}

/** "Hex radius": equals R on the perimeter of a flat-top hex of circumradius R. */
const hexNorm = (x, z) => Math.max(Math.abs(0.866 * x + 0.5 * z), Math.abs(z), Math.abs(-0.866 * x + 0.5 * z)) / 0.866;

function compose(at = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
  const s = Array.isArray(scale) ? scale : [scale, scale, scale];
  return new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])), new THREE.Vector3(...s));
}

// ------------------------------------------------------------------ shared materials
const MATS = new Map();
/** Shared fallback materials (created lazily). Names follow ASSETS.md (`Team`, `Steel`, `Water`, `Glow`). */
export function fallbackMaterial(kind) {
  if (MATS.has(kind)) return MATS.get(kind);
  let m;
  switch (kind) {
    case 'metal': m = new THREE.MeshStandardMaterial({ name: 'Steel', vertexColors: true, roughness: 0.4, metalness: 0.65 }); break;
    case 'water': m = new THREE.MeshStandardMaterial({ name: 'Water', color: '#2f7f99', transparent: true, opacity: 0.8, roughness: 0.1, metalness: 0.05, depthWrite: false }); break;
    case 'glowBlue': m = new THREE.MeshStandardMaterial({ name: 'Glow', color: '#bfe6ff', emissive: '#6cc4ff', emissiveIntensity: 2.6, roughness: 0.3 }); break;
    case 'glowGreen': m = new THREE.MeshStandardMaterial({ name: 'Glow', color: '#d6ff9e', emissive: '#7dff4f', emissiveIntensity: 2.4, roughness: 0.3 }); break;
    case 'glowRune': m = new THREE.MeshStandardMaterial({ name: 'Glow', color: '#d8f0ff', emissive: '#8fd2ff', emissiveIntensity: 2.2, roughness: 0.5 }); break;
    case 'paintDS': m = new THREE.MeshStandardMaterial({ name: 'Cloth', vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }); break;
    case 'tile': m = new THREE.MeshStandardMaterial({ name: 'Ground', vertexColors: true, roughness: 0.92, metalness: 0 }); break;
    default: m = new THREE.MeshStandardMaterial({ name: 'Paint', vertexColors: true, roughness: 0.78, metalness: 0 });
  }
  MATS.set(kind, m);
  return m;
}

// ------------------------------------------------------------------ painter: accumulates coloured parts
class Painter {
  constructor(seed) { this.parts = new Map(); this.r = rng32(seed); this.stack = [new THREE.Matrix4()]; }
  rand(a = 0, b = 1) { return a + (b - a) * this.r(); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length) % arr.length]; }
  push(at, rot, scale) { this.stack.push(this.stack[this.stack.length - 1].clone().multiply(compose(at, rot, scale))); return this; }
  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }
  /**
   * Add a geometry (consumed). color: THREE.Color | (cx, cy, cz, faceIndex) => THREE.Color, in local part space after transform.
   * opts: { at, rot, scale, mat = 'paint', jitter = 0.07, shade = 0.2, smooth = false }
   */
  add(geom, color, opts = {}) {
    const m = this.stack[this.stack.length - 1].clone().multiply(compose(opts.at, opts.rot, opts.scale));
    let g = geom;
    g.applyMatrix4(m);
    if (opts.smooth) { if (!g.attributes.normal) g.computeVertexNormals(); if (g.index) g = g.toNonIndexed(); }
    else { if (g.index) g = g.toNonIndexed(); g.deleteAttribute('normal'); g.computeVertexNormals(); }
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const pos = g.attributes.position, n = pos.count, cols = new Float32Array(n * 3);
    const jitter = opts.jitter ?? 0.07, shade = opts.shade ?? 0.2;
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    const span = Math.max(1e-4, ymax - ymin);
    for (let i = 0; i + 2 < n; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const base = typeof color === 'function' ? color(cx, cy, cz, i / 3) : color;
      const j = 1 + (this.r() - 0.5) * 2 * jitter;
      for (let k = 0; k < 3; k++) {
        const t = (pos.getY(i + k) - ymin) / span;
        const s = j * (1 - shade * (1 - t));
        cols[(i + k) * 3] = base.r * s; cols[(i + k) * 3 + 1] = base.g * s; cols[(i + k) * 3 + 2] = base.b * s;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const key = opts.mat ?? 'paint';
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
    return this;
  }
  /** Merge everything into meshes (one per material) under a Group (or return the single mesh if asked). */
  build(name, { asMesh = false, cast = true, receive = true } = {}) {
    const meshes = [];
    for (const [key, geoms] of this.parts) {
      const g = mergeGeometries(geoms, false);
      for (const x of geoms) x.dispose();
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, fallbackMaterial(key));
      mesh.name = `${name}_${key}`;
      mesh.castShadow = cast && key !== 'water'; mesh.receiveShadow = receive;
      meshes.push(mesh);
    }
    this.parts.clear();
    if (asMesh && meshes.length === 1) { meshes[0].name = name; return meshes[0]; }
    const grp = new THREE.Group(); grp.name = name;
    for (const m of meshes) grp.add(m);
    return grp;
  }
}

/** Displace vertices by a position-hash noise (keeps shared positions welded, so no cracks). */
function lumpy(geom, amount, seed) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const pos = g.attributes.position, nz = makeNoise(seed);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + amount * nz(x * 1.7 + y * 0.9, z * 1.7 - y * 1.3);
    pos.setXYZ(i, x * k, y * (1 + amount * 0.6 * nz(z * 2.1, x * 2.1 + y)), z * k);
  }
  return g;
}

function lathe(profile, segments = 6, phiStart = Math.PI / 2) {
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments, phiStart);
}

/** Subdivided flat-top hexagon surface (triangles facing +Y), heights from yFn(x, z). */
function hexSurface(R, n, yFn) {
  const out = [], corners = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i; corners.push([Math.cos(a) * R, Math.sin(a) * R]); }
  const P = (A, B, a, b) => { const x = (A[0] * a + B[0] * b) / n, z = (A[1] * a + B[1] * b) / n; return [x, yFn(x, z), z]; };
  const tri = (p0, p1, p2) => {
    const ny = (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
    if (ny >= 0) out.push(...p0, ...p1, ...p2); else out.push(...p0, ...p2, ...p1);
  };
  for (let s = 0; s < 6; s++) {
    const A = corners[s], B = corners[(s + 1) % 6];
    for (let a = 0; a < n; a++) for (let b = 0; b < n - a; b++) {
      tri(P(A, B, a, b), P(A, B, a + 1, b), P(A, B, a, b + 1));
      if (a + b < n - 1) tri(P(A, B, a + 1, b), P(A, B, a + 1, b + 1), P(A, B, a, b + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

/** Flat polygon in the XZ plane (points [x, z]), extruded `thick` upward. */
function flatPoly(points, thick = 0.01) {
  const sh = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Flat curved strip (arc of a circle centred at cx,cz) lying on y. */
function ribbon(cx, cz, R, a0, a1, w, y, n = 18) {
  const pos = [];
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (a1 - a0) * (i / n), t1 = a0 + (a1 - a0) * ((i + 1) / n);
    const w0 = w * (0.75 + 0.25 * Math.sin(i * 1.7)), w1 = w * (0.75 + 0.25 * Math.sin((i + 1) * 1.7));
    const P_ = (t, rr) => [cx + Math.cos(t) * rr, y, cz + Math.sin(t) * rr];
    const a = P_(t0, R - w0 / 2), b = P_(t0, R + w0 / 2), c = P_(t1, R + w1 / 2), d = P_(t1, R - w1 / 2);
    pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // keep only the part inside the tile (clip by hex radius): collapse outside triangles
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i); const hn = hexNorm(x, z); if (hn > 0.93) { const k = 0.93 / hn; pa.setXYZ(i, x * k, y, z * k); } }
  return g;
}

// ------------------------------------------------------------------ palettes (sRGB hex, see ASSETS.md)
const P = {
  grass: ['#76a052', '#8fb85f', '#5f8c45'], dry: ['#869a52', '#9aa05a', '#748c4b'], moss: ['#577d3d', '#668c47', '#4a6d36'],
  dirt: '#7A5A3E', dirt2: '#5A4130', rock: ['#8E8A82', '#6E6A64', '#7c7871'], sand: '#CDB88A', gravel: ['#a89a7a', '#8f8576', '#b8ab8c'],
  foliage: ['#4E7A3A', '#3E6630', '#6F9A45'], autumn: '#C08A3A', bark: '#5a4130', wood: '#7a5a3a',
  royal: '#3E63B8', royalDark: '#22345E', gold: '#C9A24A', steel: '#A8ADB5', leather: '#6B4A32', linen: '#E6DCC4',
  skin: '#e2b08a', beard: '#ece8de', horse: '#e9e3d6', horse2: '#8a6446',
  gob: '#7E9A45', gob2: '#5F7A33', rust: '#A8442A', ochre: '#C08A3A', bone: '#E2D6B5', iron: '#4A4440', dleather: '#4A3324',
  wolf: '#7b6c5b', boar: '#4f3828', troll: '#7d8c72', stone: '#8f8b84', stone2: '#77736c', raven: '#1c2230', raven2: '#2d3648',
};
const TEAM = { royaume: C('#3E63B8'), gobelins: C('#A8442A') };

// ------------------------------------------------------------------ tiles
function tileBody(p, { rimY = 0, band = P.grass[2], chamfer = 0.04 } = {}) {
  const top = rimY - chamfer;
  const prof = [[0.955, -0.35], [0.955, -0.236], [0.966, -0.23], [0.966, -0.165], [0.968, -0.16], [0.968, -0.105], [0.98, -0.099]]
    .filter(([, y]) => y < top - 0.004);
  prof.push([0.98, top]);
  if (chamfer > 0) prof.push([0.935, rimY]);
  const cRock = C(P.rock[1]), cRock2 = C('#5f5b56'), cDirt = C(P.dirt), cDirt2 = C(P.dirt2), cBand = C(band);
  p.add(lathe(prof), (x, y) => (y < -0.234 ? (y < -0.3 ? cRock2 : cRock) : y < -0.162 ? cDirt2 : y < -0.1 ? cDirt : cBand), { mat: 'tile', jitter: 0.09, shade: 0.12 });
}

function tileTop(p, { R = 0.935, n = 6, rimY = 0, amp = 0.02, seed = 1, height = null, color }) {
  const nz = makeNoise(seed);
  const yFn = (x, z) => {
    const e = 1 - smooth(0.7, 0.935, hexNorm(x, z));
    return (height ? height(x, z) : rimY) + nz(x, z) * amp * e;
  };
  p.add(hexSurface(R, n, yFn), color, { mat: 'tile', jitter: 0.022, shade: 0 });
}

const grassColor = (pal, seed, extra) => {
  const nz = makeNoise(seed * 7 + 3), nz2 = makeNoise(seed * 13 + 5), cs = pal.map(C);
  return (x, y, z) => {
    if (extra) { const c = extra(x, y, z); if (c) return c; }
    const c = cs[0].clone().lerp(cs[1], smooth(-0.35, 0.65, nz(x * 0.7, z * 0.7)));
    return c.lerp(cs[2], smooth(0.0, 0.8, nz2(x * 0.9, z * 0.9)) * 0.8);
  };
};

function tuft(p, x, z, y = 0, col = P.grass[2], h = 0.07) {
  const c = C(col);
  for (let i = 0; i < 3; i++) {
    const a = p.rand(0, TAU), lean = p.rand(0.15, 0.45);
    p.add(new THREE.ConeGeometry(0.012, h * p.rand(0.8, 1.2), 3), c, { at: [x + Math.cos(a) * 0.012, y + h * 0.45, z + Math.sin(a) * 0.012], rot: [Math.sin(a) * lean, 0, -Math.cos(a) * lean], jitter: 0.12, shade: 0.4 });
  }
}
function flower(p, x, z, y = 0, col = '#f3efe2') {
  p.add(new THREE.CylinderGeometry(0.003, 0.003, 0.05, 3), C(P.grass[2]), { at: [x, y + 0.025, z] });
  p.add(new THREE.IcosahedronGeometry(0.014, 0), C(col), { at: [x, y + 0.055, z], jitter: 0.04, shade: 0 });
}
function rock(p, x, y, z, r, seed, cols = P.rock, opts = {}) {
  const g = lumpy(new THREE.DodecahedronGeometry(r, 0), 0.22, seed);
  const cs = cols.map(C);
  p.add(g, () => p.pick(cs), { at: [x, y, z], rot: [p.rand(-0.4, 0.4), p.rand(0, TAU), p.rand(-0.4, 0.4)], scale: opts.scale ?? [1, p.rand(0.55, 0.8), 1], jitter: 0.1, shade: 0.3 });
}
function conifer(p, x, y, z, h = 0.9, tone = 0) {
  const cs = [C(P.foliage[(tone) % 3]), C(P.foliage[(tone + 1) % 3])];
  p.add(new THREE.CylinderGeometry(0.025, 0.035, h * 0.22, 5), C(P.bark), { at: [x, y + h * 0.11, z] });
  const tiers = [[0.24, 0.42, 0.18], [0.19, 0.36, 0.42], [0.13, 0.3, 0.64]];
  for (const [rr, hh, yy] of tiers) {
    p.add(new THREE.ConeGeometry(rr * h, hh * h, 7), (cx, cy) => (cy > y + (yy + 0.05) * h ? cs[1] : cs[0]), { at: [x, y + yy * h + hh * h * 0.5, z], rot: [0, p.rand(0, TAU), 0], jitter: 0.1, shade: 0.35 });
  }
}
function roundTree(p, x, y, z, h = 0.8, col = null) {
  p.add(new THREE.CylinderGeometry(0.025, 0.04, h * 0.45, 5), C(P.bark), { at: [x, y + h * 0.22, z], rot: [p.rand(-0.1, 0.1), 0, p.rand(-0.1, 0.1)] });
  const cs = col ? [C(col), C(col).multiplyScalar(0.85)] : [C(P.foliage[0]), C(P.foliage[2])];
  const blobs = [[0, 0.62, 0, 0.27], [0.14, 0.52, 0.06, 0.18], [-0.13, 0.55, -0.05, 0.19], [0.03, 0.78, -0.03, 0.17], [-0.03, 0.5, 0.15, 0.15]];
  for (const [bx, by, bz, br] of blobs) p.add(new THREE.IcosahedronGeometry(br * h, 0), () => p.pick(cs), { at: [x + bx * h, y + by * h, z + bz * h], rot: [p.rand(0, 3), p.rand(0, 3), 0], jitter: 0.1, shade: 0.4 });
}
function ringPos(p, rMin = 0.6, rMax = 0.8, a = null) {
  const ang = a ?? p.rand(0, TAU), r = p.rand(rMin, rMax);
  return [Math.cos(ang) * r, Math.sin(ang) * r];
}

function buildTile(key) {
  const [, terrain, v] = key.split('_');
  const variant = Number(v) || 0, seed = hashStr(key);
  const p = new Painter(seed);
  const stand = FALLBACK_STAND_HEIGHT[terrain] ?? 0;
  switch (terrain) {
    case 'forest': {
      tileBody(p, { band: P.moss[2] });
      tileTop(p, { seed, color: grassColor(P.moss, seed), amp: 0.016 });
      if (variant === 0) {
        const n = 7;
        for (let i = 0; i < n; i++) { const [x, z] = ringPos(p, 0.58, 0.8, i / n * TAU + p.rand(-0.25, 0.25)); conifer(p, x, 0, z, p.rand(0.8, 1.1), i); }
        { const [x, z] = ringPos(p, 0.58, 0.7, 0.5 + TAU / n * 2.5); roundTree(p, x, 0, z, 0.62); }
      } else {
        for (let i = 0; i < 5; i++) {
          const [x, z] = ringPos(p, 0.58, 0.78, i / 5 * TAU + p.rand(-0.3, 0.3));
          roundTree(p, x, 0, z, p.rand(0.8, 1.0), i === 2 ? P.autumn : null);
        }
        for (let i = 0; i < 5; i++) { const [x, z] = ringPos(p, 0.5, 0.85); p.add(new THREE.ConeGeometry(0.06, 0.05, 5), C('#5d8a3e'), { at: [x, 0.02, z], scale: [1, 0.6, 1] }); }
      }
      for (let i = 0; i < 4; i++) { const [x, z] = ringPos(p, 0.5, 0.88); tuft(p, x, z, 0, P.moss[1], 0.06); }
      break;
    }
    case 'hill': {
      const top = stand, rim = 0.05;
      const height = (x, z) => rim + (top - rim) * (1 - smooth(0.42, 0.935, hexNorm(x, z)));
      tileBody(p, { rimY: rim, band: P.grass[2] });
      tileTop(p, { seed, n: 6, height, rimY: rim, amp: 0.018, color: grassColor(['#86a85d', '#97b768', '#738f4f'], seed, (x, y, z) => (y < 0.11 && hexNorm(x, z) > 0.7 && Math.sin(x * 9 + z * 5) > 0.55 ? C(P.dirt) : null)) });
      for (let i = 0; i < 3; i++) { const a = i * 2.1 + p.rand(0, 0.6); rock(p, Math.cos(a) * 0.72, 0.08, Math.sin(a) * 0.72, p.rand(0.09, 0.14), seed + i); }
      { const a = 4.0; p.add(new THREE.BoxGeometry(0.07, 0.16, 0.05), C(P.stone), { at: [Math.cos(a) * 0.6, 0.17, Math.sin(a) * 0.6], rot: [0.05, a, 0.08] }); }
      for (let i = 0; i < 5; i++) { const [x, z] = ringPos(p, 0.5, 0.8); tuft(p, x, z, height(x, z) - 0.01, '#6f8f4b'); }
      break;
    }
    case 'water':
    case 'ford': {
      const ford = terrain === 'ford';
      const bed = ford ? -0.09 : -0.16, surf = ford ? -0.05 : -0.07;
      tileBody(p, { rimY: bed, band: P.dirt, chamfer: 0 });
      const nz = makeNoise(seed + 5);
      const sand = C(ford ? '#b8a57c' : '#8d8a6a'), g1 = C(ford ? P.gravel[0] : '#6f7a62'), g2 = C(ford ? P.gravel[1] : '#5d6656');
      p.add(hexSurface(0.98, 4, (x, z) => bed - (ford ? 0.0 : 0.03) * (1 - smooth(0.4, 0.98, hexNorm(x, z)))), (x, y, z) => (nz(x, z) > 0.2 ? g1 : nz(x, z) < -0.35 ? g2 : sand), { mat: 'tile', jitter: 0.06, shade: 0 });
      for (let i = 0; i < 7; i++) { const [x, z] = ringPos(p, 0.15, 0.85); rock(p, x, bed + 0.005, z, p.rand(0.025, 0.05), seed + 30 + i, P.gravel); }
      if (ford) {
        const gn = makeNoise(seed + 9);
        p.add(hexSurface(0.5, 4, (x, z) => { const r = Math.hypot(x, z) / 0.5; return bed + (stand - bed) * (1 - smooth(0.55, 1.0, r)) + gn(x * 2, z * 2) * 0.006; }),
          (x, y, z) => C(P.gravel[0]).lerp(C(P.gravel[1]), smooth(-0.4, 0.6, gn(x * 3, z * 3))), { mat: 'tile', jitter: 0.04, shade: 0, at: [0, 0.0005, 0], rot: [0, 0.3, 0] });
        for (const a of [0.15, Math.PI + 0.15]) for (const rr of [0.62, 0.84]) {
          p.add(new THREE.CylinderGeometry(0.075, 0.085, 0.05, 7), C(P.rock[0]), { at: [Math.cos(a) * rr, surf + 0.012, Math.sin(a) * rr], rot: [0, p.rand(0, 3), 0], jitter: 0.08 });
        }
      } else {
        rock(p, 0.55, surf + 0.02, -0.3, 0.13, seed + 2);
        for (let i = 0; i < 3; i++) {
          const [x, z] = ringPos(p, 0.35, 0.75);
          p.add(new THREE.CylinderGeometry(0.06, 0.06, 0.008, 9, 1, false, 0.3, TAU - 0.6), C('#5f8f45'), { at: [x, surf + 0.004, z], rot: [0, p.rand(0, TAU), 0], jitter: 0.05 });
          if (i === 0) p.add(new THREE.IcosahedronGeometry(0.018, 0), C('#f2e6f0'), { at: [x + 0.02, surf + 0.02, z], jitter: 0 });
        }
        for (let i = 0; i < 3; i++) { const [x, z] = ringPos(p, 0.5, 0.8); p.add(new THREE.ConeGeometry(0.01, 0.1, 3), C('#5b7d3e'), { at: [x, bed + 0.05, z], rot: [p.rand(-0.3, 0.3), 0, p.rand(-0.3, 0.3)] }); }
      }
      // water slab: reaches the six edges so neighbouring water tiles form one river
      p.add(lathe([[0.98, bed], [0.98, surf], [0, surf]]), C('#ffffff'), { mat: 'water', jitter: 0, shade: 0 });
      break;
    }
    case 'ruins': {
      tileBody(p, { band: P.grass[2] });
      tileTop(p, { seed, color: grassColor(['#7d9a58', '#8aa862', '#6c8a4c'], seed) });
      const slab = [C('#a39e92'), C('#928d83'), C('#b0ab9f')];
      const cells = [[0, 0], [0.19, 0.02], [-0.19, -0.02], [0.09, 0.18], [-0.1, 0.17], [0.1, -0.18], [-0.09, -0.17]];
      for (const [x, z] of cells) {
        if (p.r() < 0.12) continue;
        p.add(new THREE.BoxGeometry(0.17, 0.025, 0.16), () => p.pick(slab), { at: [x + p.rand(-0.01, 0.01), 0.0125, z + p.rand(-0.01, 0.01)], rot: [p.rand(-0.03, 0.03), p.rand(-0.15, 0.15), p.rand(-0.03, 0.03)], jitter: 0.06, shade: 0.3 });
      }
      const st = [C(P.stone), C(P.stone2), C('#9c978e')];
      const wall = (a, len, h) => {
        const x = Math.cos(a) * 0.72, z = Math.sin(a) * 0.72;
        for (let i = 0; i < len; i++) for (let j = 0; j < h - (i % 2); j++) {
          const off = (i - (len - 1) / 2) * 0.13;
          p.add(new THREE.BoxGeometry(0.12, 0.08, 0.09), () => p.pick(st), { at: [x - Math.sin(a) * off, 0.04 + j * 0.08, z + Math.cos(a) * off], rot: [0, -a + p.rand(-0.08, 0.08), p.rand(-0.04, 0.04)], jitter: 0.08, shade: 0.25 });
        }
      };
      wall(0.4, 4, 3); wall(3.6, 3, 2);
      p.add(new THREE.CylinderGeometry(0.07, 0.075, 0.42, 8), C('#aaa59a'), { at: [Math.cos(2.2) * 0.7, 0.21, Math.sin(2.2) * 0.7], rot: [0.03, 0, 0.04] });
      p.add(new THREE.CylinderGeometry(0.065, 0.07, 0.24, 8), C('#a09b90'), { at: [Math.cos(2.9) * 0.66, 0.065, Math.sin(2.9) * 0.66], rot: [Math.PI / 2, 0.9, 0] });
      for (let i = 0; i < 6; i++) { const a = 0.4 + p.rand(-0.3, 0.3); p.add(new THREE.IcosahedronGeometry(0.035, 0), C('#4f7a35'), { at: [Math.cos(a) * 0.74 + p.rand(-0.05, 0.05), p.rand(0.06, 0.22), Math.sin(a) * 0.74 + p.rand(-0.05, 0.05)], jitter: 0.12 }); }
      break;
    }
    case 'rocks': {
      tileBody(p, { band: '#6f6c62' });
      tileTop(p, { seed, color: grassColor(['#7d7a6c', '#6e7660', '#878274'], seed) });
      const big = [[0, 0.05, 0.36], [0.42, -0.25, 0.27], [-0.4, -0.3, 0.25], [-0.25, 0.45, 0.22], [0.35, 0.42, 0.2]];
      big.forEach(([x, z, r], i) => rock(p, x, r * 0.35, z, r, seed + i * 11, P.rock, { scale: [1, p.rand(0.75, 1.0), 1] }));
      for (let i = 0; i < 10; i++) { const [x, z] = ringPos(p, 0.3, 0.88); rock(p, x, 0.02, z, p.rand(0.03, 0.07), seed + 40 + i); }
      for (let i = 0; i < 5; i++) { const [x, , z] = [p.rand(-0.3, 0.3), 0, p.rand(-0.3, 0.3)]; p.add(new THREE.SphereGeometry(0.07, 6, 3, 0, TAU, 0, Math.PI / 2), C('#5f7f45'), { at: [x, 0.2 + p.rand(0, 0.08), z], scale: [1, 0.35, 1] }); }
      break;
    }
    default: { // plain
      const pal = variant === 2 ? P.dry : P.grass;
      tileBody(p, { band: pal[2] });
      let extra = null;
      tileTop(p, { seed, color: grassColor(pal, seed, extra) });
      if (variant === 1) p.add(ribbon(1.25, 0.75, 1.05, 3.3, 4.55, 0.11, 0.004), (x, y, z) => C('#9a7b56').lerp(C('#7d6146'), Math.abs(Math.sin(x * 13 + z * 7)) * 0.5), { mat: 'tile', jitter: 0.03, shade: 0 });
      if (variant === 0) {
        for (let i = 0; i < 7; i++) { const [x, z] = ringPos(p, 0.5, 0.85); tuft(p, x, z); }
        for (let i = 0; i < 3; i++) { const [x, z] = ringPos(p, 0.55, 0.8); flower(p, x, z, 0, i % 2 ? '#f6e27a' : '#f3efe2'); }
        p.add(new THREE.CylinderGeometry(0.09, 0.1, 0.025, 7), C(P.rock[0]), { at: [-0.62, 0.008, 0.3], rot: [0.04, 0.5, 0.02] });
      } else if (variant === 1) {
        for (let i = 0; i < 6; i++) { const a = 3.4 + i * 0.2, rr = 1.05 + (i % 2 ? 0.1 : -0.1); rock(p, 1.25 + Math.cos(a) * rr, 0.005, 0.75 + Math.sin(a) * rr, p.rand(0.018, 0.03), seed + i, P.gravel); }
        for (let i = 0; i < 5; i++) { const [x, z] = ringPos(p, 0.5, 0.85, p.rand(2.2, 5.6)); tuft(p, x, z); }
      } else {
        for (let i = 0; i < 8; i++) { const [x, z] = ringPos(p, 0.5, 0.86); tuft(p, x, z, 0, i % 3 ? '#c9b46a' : '#9a9a55', 0.11); }
        p.add(new THREE.CylinderGeometry(0.07, 0.085, 0.09, 8), C(P.bark), { at: [0.62, 0.045, -0.3] });
        p.add(new THREE.CylinderGeometry(0.068, 0.068, 0.005, 8), C('#c8a77a'), { at: [0.62, 0.092, -0.3] });
        p.add(new THREE.CylinderGeometry(0.04, 0.045, 0.3, 7), C('#6f5a42'), { at: [-0.52, 0.035, 0.42], rot: [0, 0.6, Math.PI / 2] });
        p.add(new THREE.SphereGeometry(0.035, 6, 3, 0, TAU, 0, Math.PI / 2), C(P.moss[0]), { at: [-0.5, 0.06, 0.41], scale: [1.4, 0.5, 1] });
      }
      break;
    }
  }
  const scene = p.build(key);
  return { scene, info: { kind: 'tile', standHeight: stand, terrain, nodes: [] } };
}

// ------------------------------------------------------------------ figures
function socle(p, team, r = 0.4, ground = '#6f8f4f') {
  const t = team, tDark = team.clone().multiplyScalar(0.55), gr = C(ground), gr2 = C('#7a6a4a');
  const prof = [[r - 0.025, 0], [r, 0.012], [r, 0.044], [r - 0.016, 0.06], [0, 0.06]];
  p.add(lathe(prof, 28, 0), (x, y) => (y > 0.058 ? (Math.sin(x * 23) * Math.cos(y * 3 + x * 7) > 0.6 ? gr2 : gr) : y < 0.011 ? tDark : t), { jitter: 0.05, shade: 0.05, smooth: false });
  for (let i = 0; i < 3; i++) { const a = p.rand(0, TAU), rr = p.rand(r * 0.6, r * 0.85); tuft(p, Math.cos(a) * rr, Math.sin(a) * rr, 0.06, '#5f7f42', 0.05); }
}

/**
 * A little standing humanoid (local frame: feet at y = 0, front +Z). Callbacks `extra(p)` add gear in the same frame.
 * o: { x, z, rotY, s, body, trim, skin, legs, head: 'helmet'|'hood'|'crest'|'bare'|'goblin'|'skull', headCol, hunch, arms }
 */
function human(p, o) {
  const s = o.s ?? 1;
  p.push([o.x ?? 0, o.y ?? 0.06, o.z ?? 0], [0, o.rotY ?? 0, 0], s);
  if (o.hunch) p.push([0, 0, 0], [o.hunch, 0, 0], 1);
  const body = C(o.body), legs = C(o.legs ?? P.leather), skin = C(o.skin ?? P.skin);
  if (!o.robe) {
    p.add(new THREE.BoxGeometry(0.042, 0.13, 0.05), legs, { at: [0.032, 0.065, 0] });
    p.add(new THREE.BoxGeometry(0.042, 0.13, 0.05), legs, { at: [-0.032, 0.065, 0] });
  }
  p.add(new THREE.CapsuleGeometry(0.062, 0.1, 3, 8), body, { at: [0, 0.215, 0], smooth: true, shade: 0.3 });
  if (o.trim) p.add(new THREE.BoxGeometry(0.05, 0.06, 0.012), C(o.trim), { at: [0, 0.235, 0.058] });
  p.add(new THREE.CylinderGeometry(0.066, 0.066, 0.022, 10), C(o.belt ?? P.leather), { at: [0, 0.165, 0] });
  // arms
  const armCol = C(o.arm ?? o.body);
  const arms = o.arms ?? 'forward';
  const armRot = arms === 'forward' ? [-0.9, 0, 0] : arms === 'raise' ? [-2.2, 0, 0] : [-0.15, 0, 0];
  p.add(new THREE.CapsuleGeometry(0.021, 0.1, 2, 6), armCol, { at: [0.082, 0.25, 0.03], rot: [armRot[0], 0, 0.15], smooth: true });
  p.add(new THREE.CapsuleGeometry(0.021, 0.1, 2, 6), armCol, { at: [-0.082, 0.25, 0.03], rot: [arms === 'raise' ? -0.9 : armRot[0], 0, -0.15], smooth: true });
  // head
  const hy = 0.38;
  const head = o.head ?? 'bare';
  if (head === 'goblin') {
    p.add(new THREE.SphereGeometry(0.058, 10, 8), skin, { at: [0, hy, 0.005], scale: [1.12, 0.95, 1.05], smooth: true, shade: 0.2 });
    p.add(new THREE.ConeGeometry(0.024, 0.12, 5), skin, { at: [0.085, hy + 0.012, -0.01], rot: [0, 0, -1.25], jitter: 0.05 });
    p.add(new THREE.ConeGeometry(0.024, 0.12, 5), skin, { at: [-0.085, hy + 0.012, -0.01], rot: [0, 0, 1.25], jitter: 0.05 });
    p.add(new THREE.ConeGeometry(0.014, 0.05, 5), skin, { at: [0, hy - 0.01, 0.075], rot: [Math.PI / 2 - 0.3, 0, 0] });
    p.add(new THREE.IcosahedronGeometry(0.011, 0), C('#f2d75a'), { at: [0.022, hy + 0.012, 0.052], jitter: 0, shade: 0 });
    p.add(new THREE.IcosahedronGeometry(0.011, 0), C('#f2d75a'), { at: [-0.022, hy + 0.012, 0.052], jitter: 0, shade: 0 });
    if (o.cap) p.add(new THREE.SphereGeometry(0.062, 8, 4, 0, TAU, 0, Math.PI / 2), C(o.cap), { at: [0, hy + 0.012, -0.005], smooth: false });
    if (o.hood) p.add(new THREE.ConeGeometry(0.07, 0.13, 7), C(o.hood), { at: [0, hy + 0.05, -0.015], rot: [-0.25, 0, 0] });
  } else {
    p.add(new THREE.SphereGeometry(0.055, 10, 8), skin, { at: [0, hy, 0], smooth: true, shade: 0.2 });
    if (head === 'helmet') {
      p.add(new THREE.SphereGeometry(0.063, 10, 5, 0, TAU, 0, Math.PI / 2), C(o.headCol ?? P.steel), { at: [0, hy + 0.008, 0], mat: o.headMat ?? 'paint', smooth: true });
      p.add(new THREE.CylinderGeometry(0.08, 0.08, 0.012, 12), C(o.headCol ?? P.steel), { at: [0, hy + 0.006, 0], mat: o.headMat ?? 'paint' });
    } else if (head === 'crest') {
      p.add(new THREE.CylinderGeometry(0.06, 0.064, 0.1, 10), C(o.headCol ?? P.steel), { at: [0, hy + 0.01, 0], mat: 'metal', smooth: true });
      p.add(new THREE.BoxGeometry(0.06, 0.012, 0.012), C('#20242c'), { at: [0, hy + 0.012, 0.062] });
      p.add(new THREE.BoxGeometry(0.018, 0.05, 0.11), C(o.crest ?? P.gold), { at: [0, hy + 0.08, -0.01] });
    } else if (head === 'hood') {
      p.add(new THREE.SphereGeometry(0.066, 9, 6), C(o.headCol), { at: [0, hy + 0.006, -0.012], smooth: true, shade: 0.3 });
      p.add(new THREE.ConeGeometry(0.06, 0.12, 7), C(o.headCol), { at: [0, hy + 0.07, -0.03], rot: [-0.45, 0, 0] });
      p.add(new THREE.SphereGeometry(0.05, 8, 6), skin, { at: [0, hy - 0.004, 0.018], smooth: true });
    }
    if (o.beard) p.add(new THREE.ConeGeometry(0.045, 0.13, 6), C(P.beard), { at: [0, hy - 0.07, 0.04], rot: [Math.PI - 0.25, 0, 0], jitter: 0.04 });
  }
  if (o.extra) o.extra(p);
  if (o.hunch) p.pop();
  p.pop();
}

/** Horse / wolf / boar mount. o: { x, z, rotY, kind, color, cloth, trim, s } ; returns saddle height. */
function mount(p, o) {
  const s = o.s ?? 1;
  p.push([o.x ?? 0, 0.06, o.z ?? 0], [0, o.rotY ?? 0, 0], s);
  const col = C(o.color), dark = C(o.color).multiplyScalar(0.6);
  let saddle = 0.33;
  if (o.kind === 'horse') {
    p.add(new THREE.CapsuleGeometry(0.075, 0.2, 3, 8), col, { at: [0, 0.25, 0], rot: [Math.PI / 2, 0, 0], smooth: true, shade: 0.35 });
    const legs = [[0.045, 0.1, 0.06], [-0.045, 0.1, -0.02], [0.045, 0.1, -0.1], [-0.045, 0.1, 0.12]];
    legs.forEach(([x, z, swing], i) => p.add(new THREE.CylinderGeometry(0.018, 0.014, 0.2, 5), col, { at: [x, 0.1, z], rot: [i % 2 ? -0.25 : 0.3, 0, 0] }));
    legs.forEach(([x, z], i) => p.add(new THREE.CylinderGeometry(0.02, 0.02, 0.025, 5), dark, { at: [x, 0.012, z + (i % 2 ? -0.025 : 0.03)] }));
    p.add(new THREE.BoxGeometry(0.06, 0.17, 0.08), col, { at: [0, 0.35, 0.15], rot: [0.55, 0, 0] });
    p.add(new THREE.BoxGeometry(0.058, 0.065, 0.15), col, { at: [0, 0.43, 0.22], rot: [0.35, 0, 0] });
    p.add(new THREE.BoxGeometry(0.02, 0.1, 0.07), C(o.mane ?? P.leather), { at: [0, 0.4, 0.11], rot: [0.55, 0, 0] });
    p.add(new THREE.ConeGeometry(0.012, 0.04, 4), col, { at: [0.02, 0.48, 0.2] });
    p.add(new THREE.ConeGeometry(0.012, 0.04, 4), col, { at: [-0.02, 0.48, 0.2] });
    p.add(new THREE.ConeGeometry(0.025, 0.16, 5), C(o.mane ?? P.leather), { at: [0, 0.24, -0.17], rot: [-2.5, 0, 0] });
    if (o.cloth) {
      const cl = C(o.cloth), tr = C(o.trim ?? P.gold);
      p.add(new THREE.CylinderGeometry(0.088, 0.105, 0.27, 10, 1, true), (x, y, z) => (y < 0.165 ? tr : cl), { at: [0, 0.22, 0], mat: 'paintDS', jitter: 0.05, shade: 0.25 });
      p.add(new THREE.SphereGeometry(0.084, 10, 5, 0, TAU, 0, Math.PI / 2), cl, { at: [0, 0.265, -0.01], scale: [1, 0.5, 1.75], smooth: true });
    }
    saddle = 0.31;
  } else if (o.kind === 'wolf') {
    p.add(new THREE.CapsuleGeometry(0.068, 0.19, 3, 8), col, { at: [0, 0.24, 0], rot: [Math.PI / 2, 0, 0], smooth: true, shade: 0.35, jitter: 0.12 });
    [[0.04, 0.09], [-0.04, 0.12], [0.04, -0.1], [-0.04, -0.08]].forEach(([x, z], i) => p.add(new THREE.CylinderGeometry(0.02, 0.014, 0.19, 5), col, { at: [x, 0.095, z], rot: [i % 2 ? -0.3 : 0.25, 0, 0] }));
    p.add(new THREE.BoxGeometry(0.1, 0.09, 0.11), col, { at: [0, 0.31, 0.16], rot: [-0.15, 0, 0], jitter: 0.12 });
    p.add(new THREE.BoxGeometry(0.06, 0.035, 0.09), C('#5a4c40'), { at: [0, 0.31, 0.24], rot: [-0.1, 0, 0] });
    p.add(new THREE.BoxGeometry(0.055, 0.02, 0.08), C('#3b2f28'), { at: [0, 0.275, 0.225], rot: [0.35, 0, 0] });
    p.add(new THREE.ConeGeometry(0.008, 0.02, 3), C(P.bone), { at: [0.02, 0.288, 0.27], rot: [Math.PI, 0, 0] });
    p.add(new THREE.ConeGeometry(0.008, 0.02, 3), C(P.bone), { at: [-0.02, 0.288, 0.27], rot: [Math.PI, 0, 0] });
    p.add(new THREE.ConeGeometry(0.022, 0.06, 4), col, { at: [0.033, 0.375, 0.13] });
    p.add(new THREE.ConeGeometry(0.022, 0.06, 4), col, { at: [-0.033, 0.375, 0.13] });
    p.add(new THREE.ConeGeometry(0.03, 0.17, 5), col, { at: [0, 0.27, -0.2], rot: [-2.2, 0, 0], jitter: 0.12 });
    p.add(new THREE.BoxGeometry(0.11, 0.03, 0.12), C(P.dleather), { at: [0, 0.305, -0.01] });
    saddle = 0.3;
  } else { // boar
    p.add(new THREE.SphereGeometry(0.13, 10, 8), col, { at: [0, 0.22, 0], scale: [0.9, 0.85, 1.4], smooth: true, shade: 0.4, jitter: 0.1 });
    p.add(new THREE.BoxGeometry(0.05, 0.08, 0.14), C('#2e2018'), { at: [0, 0.33, -0.02] });
    [[0.06, 0.1], [-0.06, 0.1], [0.06, -0.1], [-0.06, -0.1]].forEach(([x, z]) => p.add(new THREE.CylinderGeometry(0.024, 0.018, 0.12, 5), col, { at: [x, 0.06, z] }));
    p.add(new THREE.SphereGeometry(0.085, 8, 6), col, { at: [0, 0.22, 0.2], scale: [1, 0.95, 1.1], smooth: true });
    p.add(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 7), C('#7a5848'), { at: [0, 0.2, 0.29], rot: [Math.PI / 2, 0, 0] });
    p.add(new THREE.ConeGeometry(0.012, 0.08, 4), C(P.bone), { at: [0.05, 0.22, 0.27], rot: [-0.6, 0, -0.5] });
    p.add(new THREE.ConeGeometry(0.012, 0.08, 4), C(P.bone), { at: [-0.05, 0.22, 0.27], rot: [-0.6, 0, 0.5] });
    p.add(new THREE.ConeGeometry(0.025, 0.05, 4), col, { at: [0.05, 0.3, 0.17] });
    p.add(new THREE.ConeGeometry(0.025, 0.05, 4), col, { at: [-0.05, 0.3, 0.17] });
    p.add(new THREE.BoxGeometry(0.15, 0.03, 0.14), C(P.rust), { at: [0, 0.335, -0.03] });
    saddle = 0.33;
  }
  p.pop();
  return saddle;
}

/** A seated rider on a mount (torso, head, arms; no legs drawn below the saddle cloth). */
function rider(p, o) {
  human(p, { ...o, y: 0.06 + (o.saddle ?? 0.31) - 0.13, robe: true });
  // legs astride
  const legs = C(o.legs ?? P.leather);
  p.push([o.x ?? 0, 0.06 + (o.saddle ?? 0.31) - 0.03, o.z ?? 0], [0, o.rotY ?? 0, 0], o.s ?? 1);
  p.add(new THREE.BoxGeometry(0.035, 0.13, 0.05), legs, { at: [0.08, -0.04, 0.02], rot: [0.3, 0, 0.25] });
  p.add(new THREE.BoxGeometry(0.035, 0.13, 0.05), legs, { at: [-0.08, -0.04, 0.02], rot: [0.3, 0, -0.25] });
  p.pop();
}

// weapons (frame of the figure)
const pike = (len = 0.8, tilt = 0.42, hx = -0.09) => (p) => {
  const dir = [0, Math.cos(tilt), Math.sin(tilt)], base = [hx, 0.1, -0.04];
  p.add(new THREE.CylinderGeometry(0.008, 0.009, len, 5), C(P.wood), { at: [base[0], base[1] + dir[1] * len / 2, base[2] + dir[2] * len / 2], rot: [tilt, 0, 0] });
  p.add(new THREE.ConeGeometry(0.018, 0.075, 5), C(P.steel), { at: [base[0], base[1] + dir[1] * (len + 0.035), base[2] + dir[2] * (len + 0.035)], rot: [tilt, 0, 0], mat: 'metal' });
};
const roundShield = (col, boss = P.gold) => (p) => {
  p.add(new THREE.CylinderGeometry(0.07, 0.07, 0.016, 12), C(col), { at: [0.095, 0.22, 0.07], rot: [Math.PI / 2, 0.35, 0] });
  p.add(new THREE.SphereGeometry(0.022, 6, 4), C(boss), { at: [0.1, 0.22, 0.082], mat: 'metal' });
};
const bow = (r = 0.12, col = P.wood) => (p) => {
  const g = new THREE.TorusGeometry(r, 0.008, 4, 10, Math.PI);
  g.rotateZ(-Math.PI / 2); g.rotateY(-Math.PI / 2);
  p.add(g, C(col), { at: [0.1, 0.27, 0.07 - r * 0.6] });
  p.add(new THREE.CylinderGeometry(0.002, 0.002, r * 2, 3), C('#e8e0c8'), { at: [0.1, 0.27, 0.07 - r * 0.6] });
  p.add(new THREE.CylinderGeometry(0.028, 0.024, 0.16, 6), C(P.leather), { at: [-0.04, 0.27, -0.075], rot: [-0.25, 0, 0.3] });
  p.add(new THREE.ConeGeometry(0.03, 0.04, 6), C('#c94a3a'), { at: [-0.062, 0.36, -0.1], rot: [-0.25, 0, 0.3] });
};

function buildUnit(key) {
  const def = UNITS[key];
  const faction = def?.faction ?? (key.startsWith('g_') ? 'gobelins' : 'royaume');
  const team = TEAM[faction];
  const p = new Painter(hashStr(key));
  const flagP = new Painter(hashStr(key) + 1), glowP = new Painter(hashStr(key) + 2);
  let flagAt = null, glowMat = 'glowBlue', glowAt = [0, 0, 0];
  const big = key === 'k_golem' || key === 'g_troll';
  socle(p, team, big ? 0.44 : 0.4, faction === 'gobelins' ? '#7d7a4e' : '#6f8f4f');
  switch (key) {
    case 'k_pikemen': {
      const spots = [[-0.16, 0.08, 0.1], [0.16, 0.08, -0.1], [0, -0.15, 0]];
      for (const [x, z, r] of spots) human(p, { x, z, rotY: r, body: P.royal, trim: P.gold, head: 'helmet', headCol: '#4a6fc0', legs: P.royalDark, extra: (q) => { pike(0.82)(q); roundShield(P.royal)(q); } });
      break;
    }
    case 'k_archers': {
      const spots = [[-0.17, 0.06, 0.15], [0.17, 0.08, -0.12], [0, -0.16, 0.02]];
      spots.forEach(([x, z, r]) => human(p, { x, z, rotY: r, body: P.royal, trim: null, head: 'hood', headCol: P.royalDark, legs: P.leather, arms: 'forward', extra: bow() }));
      break;
    }
    case 'k_knights': {
      for (const [x, z, r] of [[-0.15, 0.04, 0.05], [0.15, -0.06, -0.05]]) {
        const saddle = mount(p, { x, z, rotY: r, kind: 'horse', color: '#d8d2c6', cloth: P.royal, trim: P.gold, mane: '#cfc6b4', s: 0.92 });
        rider(p, { x, z, rotY: r, s: 0.92, saddle, body: P.royal, arm: P.steel, trim: P.gold, head: 'crest', headCol: P.steel, legs: P.steel,
          extra: (q) => {
            q.add(new THREE.CylinderGeometry(0.008, 0.012, 0.72, 5), C(P.wood), { at: [-0.09, 0.42, 0.18], rot: [1.05, 0, 0] });
            q.add(new THREE.ConeGeometry(0.016, 0.06, 5), C(P.steel), { at: [-0.09, 0.6, 0.5], rot: [1.05, 0, 0], mat: 'metal' });
            q.add(new THREE.BoxGeometry(0.006, 0.05, 0.08), C(P.gold), { at: [-0.09, 0.6, 0.41], rot: [1.05, 0, 0] });
            roundShield(P.royal)(q);
          } });
      }
      break;
    }
    case 'k_mage': {
      p.add(lathe([[0.14, 0], [0.125, 0.04], [0.095, 0.17], [0.072, 0.27], [0.06, 0.33], [0, 0.34]], 10, 0), (x, y) => (y < 0.09 ? C(P.gold) : C(P.royal)), { at: [0, 0.06, 0], jitter: 0.05, shade: 0.3 });
      human(p, { body: P.royal, trim: P.gold, head: 'hood', headCol: P.royalDark, beard: true, arms: 'raise', robe: true, extra: (q) => {
        q.add(new THREE.BoxGeometry(0.06, 0.07, 0.03), C('#5a2d2a'), { at: [0.07, 0.16, 0.04], rot: [0, 0.4, 0] });
      } });
      p.add(new THREE.CylinderGeometry(0.011, 0.014, 0.8, 6), C(P.wood), { at: [-0.12, 0.06 + 0.4, 0.07] });
      for (let i = 0; i < 3; i++) { const a = i * TAU / 3; p.add(new THREE.ConeGeometry(0.008, 0.06, 3), C(P.gold), { at: [-0.12 + Math.cos(a) * 0.02, 0.06 + 0.82, 0.07 + Math.sin(a) * 0.02], rot: [Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4], mat: 'metal' }); }
      glowAt = [-0.12, 0.06 + 0.88, 0.07];
      glowP.add(new THREE.OctahedronGeometry(0.048, 0), C('#ffffff'), { scale: [1, 1.5, 1], mat: 'glowBlue', jitter: 0, shade: 0 });
      break;
    }
    case 'k_golem': {
      p.push([0, 0.06, 0], [0, 0, 0], 1.18);
      const st = [C(P.stone), C(P.stone2), C('#9a968e')];
      const sp = () => p.pick(st);
      p.add(new THREE.BoxGeometry(0.12, 0.2, 0.14), sp, { at: [0.1, 0.1, 0], jitter: 0.1 });
      p.add(new THREE.BoxGeometry(0.12, 0.2, 0.14), sp, { at: [-0.1, 0.1, 0], jitter: 0.1 });
      p.add(lumpy(new THREE.DodecahedronGeometry(0.22, 0), 0.12, 3), sp, { at: [0, 0.38, 0], scale: [1.15, 0.95, 0.85], jitter: 0.1, shade: 0.35 });
      p.add(new THREE.BoxGeometry(0.13, 0.11, 0.12), sp, { at: [0, 0.6, 0.06], rot: [0.15, 0, 0] });
      for (const sx of [1, -1]) {
        p.add(lumpy(new THREE.DodecahedronGeometry(0.1, 0), 0.15, 7 + sx), sp, { at: [sx * 0.24, 0.5, 0], jitter: 0.1 });
        p.add(new THREE.BoxGeometry(0.11, 0.26, 0.12), sp, { at: [sx * 0.27, 0.32, 0.03], rot: [-0.15, 0, sx * 0.08] });
        p.add(lumpy(new THREE.DodecahedronGeometry(0.085, 0), 0.15, 9 + sx), sp, { at: [sx * 0.28, 0.16, 0.07] });
        p.add(new THREE.SphereGeometry(0.07, 6, 3, 0, TAU, 0, Math.PI / 2), C('#5f8a3e'), { at: [sx * 0.24, 0.57, -0.01], scale: [1, 0.4, 1] });
      }
      p.pop();
      glowAt = [0, 0, 0];
      glowP.push([0, 0.06, 0], [0, 0, 0], 1.18);
      glowP.add(new THREE.BoxGeometry(0.025, 0.12, 0.012), C('#fff'), { at: [0, 0.4, 0.19], mat: 'glowRune', jitter: 0, shade: 0 });
      glowP.add(new THREE.BoxGeometry(0.08, 0.02, 0.012), C('#fff'), { at: [0, 0.44, 0.188], rot: [0, 0, 0.5], mat: 'glowRune', jitter: 0, shade: 0 });
      glowP.add(new THREE.BoxGeometry(0.025, 0.014, 0.01), C('#fff'), { at: [0.03, 0.615, 0.125], mat: 'glowRune', jitter: 0, shade: 0 });
      glowP.add(new THREE.BoxGeometry(0.025, 0.014, 0.01), C('#fff'), { at: [-0.03, 0.615, 0.125], mat: 'glowRune', jitter: 0, shade: 0 });
      for (const sx of [1, -1]) glowP.add(new THREE.BoxGeometry(0.012, 0.1, 0.012), C('#fff'), { at: [sx * 0.27, 0.33, 0.095], mat: 'glowRune', jitter: 0, shade: 0 });
      glowP.pop();
      glowMat = 'glowRune';
      break;
    }
    case 'k_commander': {
      const saddle = mount(p, { kind: 'horse', color: P.horse, cloth: P.royal, trim: P.gold, mane: '#e8e0d0' });
      rider(p, { saddle, body: P.gold, arm: P.gold, trim: P.royal, head: 'crest', headCol: P.gold, crest: P.royal, legs: P.gold, extra: (q) => {
        q.add(new THREE.BoxGeometry(0.15, 0.2, 0.012), C(P.royal), { at: [0, 0.23, -0.075], rot: [0.25, 0, 0], mat: 'paintDS' });
      } });
      // banner pole
      p.add(new THREE.CylinderGeometry(0.01, 0.01, 0.9, 6), C(P.wood), { at: [-0.12, 0.3 + 0.45, 0.04] });
      p.add(new THREE.SphereGeometry(0.02, 6, 4), C(P.gold), { at: [-0.12, 1.21, 0.04], mat: 'metal' });
      p.add(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 4), C(P.wood), { at: [-0.12, 1.15, -0.04], rot: [Math.PI / 2, 0, 0] });
      flagAt = [-0.12, 1.15, 0.03];
      flagP.add(new THREE.BoxGeometry(0.01, 0.24, 0.3, 1, 4, 10), (x, y, z) => (Math.abs(y + 0.0) < 0.05 && Math.abs(z + 0.15) < 0.05 ? C(P.gold) : y < -0.1 ? C(P.gold) : C(P.royal)), { at: [0, -0.12, -0.15], mat: 'paint', jitter: 0.04, shade: 0.1 });
      break;
    }
    case 'g_spears': {
      const spots = [[-0.17, 0.08, 0.2], [0.17, 0.05, -0.15], [0.01, -0.16, 0.05]];
      for (const [x, z, r] of spots) human(p, { x, z, rotY: r, s: 0.86, hunch: 0.18, body: P.rust, skin: P.gob, head: 'goblin', legs: P.dleather, belt: P.dleather, cap: p.r() > 0.5 ? P.iron : null,
        extra: (q) => {
          pike(0.56, 0.28)(q);
          q.add(new THREE.BoxGeometry(0.12, 0.15, 0.016), (cx, cy) => (Math.abs(cy - 0.24) < 0.02 ? C(P.ochre) : C(P.rust)), { at: [0.1, 0.22, 0.07], rot: [0.05, 0.35, 0.05] });
        } });
      break;
    }
    case 'g_archers': {
      const spots = [[-0.17, 0.07, 0.2, 1], [0.17, 0.06, -0.15, 1], [0.0, -0.16, 0, 0.78]];
      for (const [x, z, r, sy] of spots) human(p, { x, z, rotY: r, s: 0.86 * (sy < 1 ? 0.95 : 1), hunch: sy < 1 ? 0.45 : 0.15, body: P.dleather, skin: P.gob2, head: 'goblin', hood: P.rust, legs: P.dleather, extra: bow(0.095, '#6a4a2a') });
      break;
    }
    case 'g_wolves': {
      for (const [x, z, r] of [[-0.15, 0.05, 0.08], [0.15, -0.06, -0.06]]) {
        const saddle = mount(p, { x, z, rotY: r, kind: 'wolf', color: P.wolf, s: 0.95 });
        rider(p, { x, z, rotY: r, s: 0.8, saddle: saddle + 0.02, body: P.rust, skin: P.gob, head: 'goblin', legs: P.dleather, extra: pike(0.5, 0.7) });
      }
      break;
    }
    case 'g_shaman': {
      p.add(lathe([[0.13, 0], [0.12, 0.03], [0.09, 0.15], [0.07, 0.25], [0, 0.27]], 9, 0), (x, y) => (y < 0.05 ? C(P.bone) : C(P.dleather)), { at: [0, 0.06, 0], jitter: 0.12, shade: 0.3 });
      human(p, { y: 0.02, hunch: 0.32, body: P.dleather, skin: P.gob2, head: 'goblin', robe: true, arms: 'raise', extra: (q) => {
        q.add(new THREE.SphereGeometry(0.06, 8, 6), C(P.bone), { at: [0, 0.4, 0.035], scale: [1, 0.9, 1.1], smooth: true });
        q.add(new THREE.BoxGeometry(0.018, 0.016, 0.01), C('#1a1410'), { at: [0.022, 0.405, 0.1] });
        q.add(new THREE.BoxGeometry(0.018, 0.016, 0.01), C('#1a1410'), { at: [-0.022, 0.405, 0.1] });
        q.add(new THREE.ConeGeometry(0.014, 0.11, 4), C(P.bone), { at: [0.045, 0.47, 0.0], rot: [0, 0, -0.5] });
        q.add(new THREE.ConeGeometry(0.014, 0.11, 4), C(P.bone), { at: [-0.045, 0.47, 0.0], rot: [0, 0, 0.5] });
        for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI + 0.2; q.add(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 4), C(P.bone), { at: [Math.cos(a) * 0.07, 0.31, Math.sin(a) * 0.05 + 0.02], rot: [0, 0, 1.2] }); }
      } });
      p.add(new THREE.CylinderGeometry(0.01, 0.013, 0.72, 5), C('#5a4128'), { at: [-0.13, 0.06 + 0.36, 0.08], rot: [0.06, 0, -0.05] });
      p.add(new THREE.ConeGeometry(0.012, 0.12, 3), C('#c9563a'), { at: [-0.1, 0.74, 0.08], rot: [0, 0, -0.7] });
      p.add(new THREE.ConeGeometry(0.012, 0.12, 3), C('#2b2b2b'), { at: [-0.16, 0.73, 0.08], rot: [0, 0, 0.7] });
      glowAt = [-0.138, 0.84, 0.085];
      glowP.add(new THREE.SphereGeometry(0.045, 8, 6), C('#fff'), { scale: [1, 0.9, 1.15], mat: 'glowGreen', jitter: 0, shade: 0 });
      glowMat = 'glowGreen';
      break;
    }
    case 'g_troll': {
      p.push([0, 0.06, 0], [0, 0, 0], 1.12);
      const sk = [C(P.troll), C('#6f7e66'), C('#86947a')];
      const skin = () => p.pick(sk);
      p.add(new THREE.CapsuleGeometry(0.06, 0.12, 2, 6), skin, { at: [0.1, 0.1, 0], smooth: true });
      p.add(new THREE.CapsuleGeometry(0.06, 0.12, 2, 6), skin, { at: [-0.1, 0.1, 0], smooth: true });
      p.add(new THREE.SphereGeometry(0.25, 10, 8), skin, { at: [0, 0.42, 0.02], scale: [1.05, 1, 0.85], rot: [0.3, 0, 0], smooth: true, shade: 0.4, jitter: 0.06 });
      p.add(new THREE.BoxGeometry(0.3, 0.12, 0.24), C(P.dleather), { at: [0, 0.22, 0.02] });
      p.add(new THREE.SphereGeometry(0.1, 9, 7), skin, { at: [0, 0.64, 0.2], scale: [1.05, 0.9, 1], smooth: true });
      p.add(new THREE.BoxGeometry(0.13, 0.05, 0.08), skin, { at: [0, 0.58, 0.25] });
      p.add(new THREE.ConeGeometry(0.014, 0.05, 4), C(P.bone), { at: [0.045, 0.62, 0.29] });
      p.add(new THREE.ConeGeometry(0.014, 0.05, 4), C(P.bone), { at: [-0.045, 0.62, 0.29] });
      p.add(new THREE.IcosahedronGeometry(0.014, 0), C('#e8d34a'), { at: [0.035, 0.67, 0.29], jitter: 0, shade: 0 });
      p.add(new THREE.IcosahedronGeometry(0.014, 0), C('#e8d34a'), { at: [-0.035, 0.67, 0.29], jitter: 0, shade: 0 });
      p.add(new THREE.ConeGeometry(0.03, 0.08, 4), skin, { at: [0.1, 0.67, 0.17], rot: [0, 0, -1.2] });
      p.add(new THREE.ConeGeometry(0.03, 0.08, 4), skin, { at: [-0.1, 0.67, 0.17], rot: [0, 0, 1.2] });
      for (let i = 0; i < 5; i++) p.add(new THREE.IcosahedronGeometry(0.018, 0), C('#5f6b55'), { at: [p.rand(-0.18, 0.18), p.rand(0.35, 0.58), p.rand(0.0, 0.2)] });
      p.add(new THREE.CapsuleGeometry(0.055, 0.3, 2, 6), skin, { at: [0.27, 0.36, 0.08], rot: [-0.25, 0, 0.18], smooth: true });
      p.add(new THREE.CapsuleGeometry(0.055, 0.3, 2, 6), skin, { at: [-0.27, 0.36, 0.08], rot: [-0.5, 0, -0.15], smooth: true });
      p.add(new THREE.CylinderGeometry(0.075, 0.03, 0.5, 7), C('#6a4b30'), { at: [-0.31, 0.3, 0.32], rot: [1.2, 0, 0], jitter: 0.12 });
      for (let i = 0; i < 4; i++) p.add(new THREE.ConeGeometry(0.012, 0.04, 3), C(P.iron), { at: [-0.31 + p.rand(-0.05, 0.05), 0.3 + p.rand(-0.03, 0.05), 0.48 + p.rand(-0.03, 0.06)], rot: [p.rand(0, 3), 0, p.rand(0, 3)] });
      p.pop();
      break;
    }
    case 'g_warchief': {
      const saddle = mount(p, { kind: 'boar', color: P.boar });
      rider(p, { saddle, body: P.iron, arm: P.gob, trim: P.rust, skin: P.gob, head: 'goblin', cap: P.iron, legs: P.dleather, s: 0.95, extra: (q) => {
        q.add(new THREE.ConeGeometry(0.012, 0.06, 4), C(P.bone), { at: [0.07, 0.31, 0.0], rot: [0, 0, -0.9] });
        q.add(new THREE.ConeGeometry(0.012, 0.06, 4), C(P.bone), { at: [-0.07, 0.31, 0.0], rot: [0, 0, 0.9] });
        q.add(new THREE.BoxGeometry(0.02, 0.2, 0.05), C(P.iron), { at: [0.1, 0.25, 0.12], rot: [0.9, 0, 0], mat: 'metal' });
      } });
      p.add(new THREE.CylinderGeometry(0.01, 0.012, 0.85, 5), C('#5a4128'), { at: [-0.12, 0.3 + 0.42, 0.0] });
      p.add(new THREE.SphereGeometry(0.032, 7, 5), C(P.bone), { at: [-0.12, 1.16, 0.0], scale: [1, 0.9, 1.1] });
      p.add(new THREE.CylinderGeometry(0.006, 0.006, 0.18, 4), C('#5a4128'), { at: [-0.12, 1.1, -0.08], rot: [Math.PI / 2, 0, 0] });
      flagAt = [-0.12, 1.1, -0.0];
      flagP.add(new THREE.BoxGeometry(0.01, 0.26, 0.28, 1, 4, 10), (x, y, z) => (Math.hypot(y + 0.0, z + 0.14) < 0.055 ? C(P.bone) : y < -0.11 ? C('#5a2a1e') : C(P.rust)), { at: [0, -0.13, -0.14], jitter: 0.06, shade: 0.1 });
      break;
    }
    default: { // unknown unit: a plain figure
      human(p, { body: faction === 'gobelins' ? P.rust : P.royal, head: faction === 'gobelins' ? 'goblin' : 'helmet', skin: faction === 'gobelins' ? P.gob : P.skin });
    }
  }
  const scene = p.build(key);
  const nodes = [];
  if (flagAt) {
    const flag = flagP.build('Flag', { asMesh: true });
    flag.name = 'Flag'; flag.position.set(...flagAt); scene.add(flag); nodes.push('Flag');
  }
  if (glowP.parts.size) {
    const glow = glowP.build('Glow', { asMesh: true, cast: false });
    glow.name = 'Glow'; glow.position.set(...glowAt); scene.add(glow); nodes.push('Glow');
  }
  return { scene, info: { kind: 'unit', height: UNIT_HEIGHT[key] ?? 0.6, faction, nodes } };
}

// ------------------------------------------------------------------ props
function buildProp(key) {
  const p = new Painter(hashStr(key));
  const nodes = [];
  let scene, info = { kind: 'prop', nodes };
  switch (key) {
    case 'prop_raven': {
      const body = new Painter(11), wl = new Painter(12), wr = new Painter(13);
      const k = C(P.raven), k2 = C(P.raven2), beak = C('#3a3428');
      body.add(new THREE.SphereGeometry(0.05, 9, 7), k, { scale: [0.9, 0.85, 2.1], smooth: true, shade: 0.4 });
      body.add(new THREE.SphereGeometry(0.036, 8, 6), k, { at: [0, 0.022, 0.1], smooth: true });
      body.add(new THREE.ConeGeometry(0.014, 0.05, 5), beak, { at: [0, 0.016, 0.145], rot: [Math.PI / 2, 0, 0] });
      body.add(flatPoly([[-0.012, -0.08], [0.012, -0.08], [0.045, -0.17], [-0.045, -0.17]], 0.008), k2, { at: [0, 0.0, 0] });
      body.add(new THREE.IcosahedronGeometry(0.007, 0), C('#d9c27a'), { at: [0.02, 0.03, 0.118], jitter: 0, shade: 0 });
      body.add(new THREE.IcosahedronGeometry(0.007, 0), C('#d9c27a'), { at: [-0.02, 0.03, 0.118], jitter: 0, shade: 0 });
      const wing = (sx) => [[0, 0.04], [sx * 0.07, 0.035], [sx * 0.15, -0.01], [sx * 0.17, -0.045], [sx * 0.1, -0.04], [sx * 0.05, -0.05], [0, -0.04]];
      const wcol = (x) => (Math.abs(x) > 0.11 ? k2 : k);
      wl.add(flatPoly(wing(1), 0.008), (x) => wcol(x), { jitter: 0.05, shade: 0 });
      wr.add(flatPoly(wing(-1).reverse(), 0.008), (x) => wcol(x), { jitter: 0.05, shade: 0 });
      scene = new THREE.Group(); scene.name = key;
      const b = body.build('Body', { asMesh: true }); b.name = 'Body';
      const l = wl.build('Wing_L', { asMesh: true }); l.name = 'Wing_L'; l.position.set(0.03, 0.01, 0.0);
      const r = wr.build('Wing_R', { asMesh: true }); r.name = 'Wing_R'; r.position.set(-0.03, 0.01, 0.0);
      scene.add(b, l, r); nodes.push('Body', 'Wing_L', 'Wing_R');
      return { scene, info };
    }
    case 'prop_arrow': {
      p.add(new THREE.CylinderGeometry(0.006, 0.006, 0.28, 5), C('#b08a5a'), { at: [0, 0, -0.01], rot: [Math.PI / 2, 0, 0], jitter: 0.02 });
      p.add(new THREE.ConeGeometry(0.014, 0.05, 5), C(P.steel), { at: [0, 0, 0.14], rot: [Math.PI / 2, 0, 0], mat: 'metal' });
      for (let i = 0; i < 3; i++) {
        const a = i * TAU / 3;
        p.add(new THREE.BoxGeometry(0.002, 0.024, 0.06), C(i ? '#efe8da' : '#c23b2e'), { at: [Math.cos(a) * 0.012, Math.sin(a) * 0.012, -0.125], rot: [0, 0, a - Math.PI / 2], jitter: 0 });
      }
      break;
    }
    case 'deco_tree_0': conifer(p, 0, 0, 0, 1.2, 1); p.add(new THREE.CylinderGeometry(0.12, 0.14, 0.02, 7), C(P.moss[2]), { at: [0, 0.0, 0] }); break;
    case 'deco_tree_1': roundTree(p, 0, 0, 0, 1.0); p.add(new THREE.CylinderGeometry(0.12, 0.14, 0.02, 7), C(P.moss[2]), { at: [0, 0.0, 0] }); break;
    case 'deco_rock_0': {
      rock(p, 0, 0.18, 0, 0.32, 77, P.rock, { scale: [1.1, 0.9, 0.95] });
      rock(p, 0.28, 0.05, 0.12, 0.1, 78);
      p.add(new THREE.SphereGeometry(0.16, 7, 3, 0, TAU, 0, Math.PI / 2), C('#5f7f45'), { at: [-0.05, 0.38, -0.02], scale: [1, 0.35, 0.9] });
      break;
    }
    case 'prop_tent_royaume': {
      const blue = C(P.royal), lin = C(P.linen), dark = C('#1d1c24');
      p.add(lathe([[0.44, 0], [0.43, 0.08], [0.36, 0.2], [0.12, 0.6], [0.02, 0.68]], 12, 0), (x, y, z) => {
        const a = Math.atan2(z, x); const seg = Math.floor(((a + Math.PI) / TAU) * 12 + 0.5) % 12;
        if (Math.abs(a - Math.PI / 2) < 0.25 && y < 0.28) return dark;
        return seg % 2 ? blue : lin;
      }, { jitter: 0.04, shade: 0.25, mat: 'paintDS' });
      p.add(new THREE.CylinderGeometry(0.42, 0.42, 0.015, 12), C('#7a6a4a'), { at: [0, 0.006, 0] });
      p.add(new THREE.CylinderGeometry(0.01, 0.01, 0.42, 5), C(P.wood), { at: [0, 0.82, 0] });
      p.add(new THREE.SphereGeometry(0.02, 6, 4), C(P.gold), { at: [0, 1.04, 0], mat: 'metal' });
      for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + 0.4; p.add(new THREE.CylinderGeometry(0.004, 0.004, 0.35, 3), C('#d8ccb0'), { at: [Math.cos(a) * 0.5, 0.12, Math.sin(a) * 0.5], rot: [Math.sin(a) * 1.1, 0, -Math.cos(a) * 1.1] }); }
      const flagP = new Painter(5);
      flagP.add(new THREE.BoxGeometry(0.008, 0.09, 0.2, 1, 2, 8), (x, y, z) => (z < -0.12 ? C(P.gold) : C(P.royal)), { at: [0, -0.045, -0.1] });
      scene = p.build(key);
      const flag = flagP.build('Flag', { asMesh: true }); flag.name = 'Flag'; flag.position.set(0, 1.02, 0); scene.add(flag); nodes.push('Flag');
      return { scene, info };
    }
    case 'prop_tent_gobelins': {
      const hides = ['#6b4a32', '#8a6a48', '#4a3324', '#9a7a52'].map(C);
      p.add(new THREE.SphereGeometry(0.4, 9, 5, 0, TAU, 0, Math.PI / 2), () => p.pick(hides), { scale: [1, 0.95, 1], jitter: 0.05, shade: 0.35 });
      p.add(new THREE.BoxGeometry(0.16, 0.2, 0.05), C('#1b1410'), { at: [0, 0.1, 0.37] });
      for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + 0.3; p.add(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 4), C(i % 2 ? P.bone : '#5a4128'), { at: [Math.cos(a) * 0.05, 0.44, Math.sin(a) * 0.05], rot: [Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5] }); }
      p.add(new THREE.SphereGeometry(0.045, 7, 5), C(P.bone), { at: [0, 0.4, 0.02] });
      // totem
      p.add(new THREE.CylinderGeometry(0.035, 0.04, 0.8, 6), C('#5a4128'), { at: [0.5, 0.4, 0.2] });
      p.add(new THREE.BoxGeometry(0.11, 0.12, 0.1), C(P.rust), { at: [0.5, 0.55, 0.2] });
      p.add(new THREE.BoxGeometry(0.1, 0.1, 0.1), C(P.ochre), { at: [0.5, 0.67, 0.2] });
      p.add(new THREE.SphereGeometry(0.055, 7, 5), C(P.bone), { at: [0.5, 0.83, 0.2] });
      p.add(new THREE.ConeGeometry(0.015, 0.12, 4), C(P.bone), { at: [0.56, 0.86, 0.2], rot: [0, 0, -0.9] });
      p.add(new THREE.ConeGeometry(0.015, 0.12, 4), C(P.bone), { at: [0.44, 0.86, 0.2], rot: [0, 0, 0.9] });
      break;
    }
    default: p.add(new THREE.BoxGeometry(0.3, 0.3, 0.3), C('#888'), { at: [0, 0.15, 0] });
  }
  scene = p.build(key);
  return { scene, info };
}

// ------------------------------------------------------------------ public API
const CACHE = new Map();

/**
 * Procedural template for an asset key (cached). Do not mutate: clone it (`scene.clone(true)`).
 * @param {string} key e.g. 'tile_plain_0', 'k_pikemen', 'prop_raven'
 * @returns {{ scene: THREE.Object3D, info: { kind: 'tile'|'unit'|'prop', standHeight?: number, height?: number, nodes: string[] } }}
 */
export function buildFallback(key) {
  if (CACHE.has(key)) return CACHE.get(key);
  let out;
  if (key.startsWith('tile_')) out = buildTile(key);
  else if (UNITS[key] || ASSET_KEYS.units.includes(key)) out = buildUnit(key);
  else out = buildProp(key);
  out.scene.updateMatrixWorld(true);
  CACHE.set(key, out);
  return out;
}

/** Every key that has a dedicated procedural model. */
export function fallbackKeys() { return [...ASSET_KEYS.tiles, ...ASSET_KEYS.units, ...ASSET_KEYS.props]; }

/** Free all cached fallback geometries and materials (only when no view uses them anymore). */
export function disposeFallbacks() {
  for (const { scene } of CACHE.values()) scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  CACHE.clear();
  for (const m of MATS.values()) m.dispose();
  MATS.clear();
}
