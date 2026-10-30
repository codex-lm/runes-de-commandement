// js/render/scene.js — the 3D battlefield view (three.js 0.170).
//
// Look (the title cover, assets-src/scripts/cover.py): painted miniatures on a diorama island of thick hex tiles,
// seen fairly low (~40° elevation) with a very soft perspective (FOV 24°); a low golden sun behind the Goblin bank
// (long shadows toward the viewer, rim light), a cool sky fill and a faint warm bounce; AgX « Punchy » with a warm
// white balance, the colour management the models were painted under; a lowered/desaturated scenery ring that
// dissolves into a warm golden haze over a sea of mist; in quality 'high' a light bloom, a depth of field focused
// on the action and a vignette.
// During a battle the camera follows the action (box around the units that just acted and the ravens, with
// hysteresis); prep, 'R' and the end of the battle show the whole board.
//
// Public API (docs/INTERFACES.md):
//   preloadAssets({ base, onProgress }) -> Promise<AssetLib>
//   createView(container, { assets, quality }) -> Promise<View>
// AssetLib = { base, manifest, stats: { glb, fallback, failed[] }, get(key) -> { scene, info, source }, has(key), dispose() }
//   (an AssetLib can be shared by several successive views; View.dispose() never frees it).
// Extra View members (beyond the contract): projectUnit(id), setInsets({top,right,bottom,left}), setHoverOutline(bool),
//   setKeyboardEnabled(bool), setPlates(bool), setFraming('action'|'board'), getFraming(), setActive(bool), prepare(),
//   celebrate(side, { ms }) (end-of-battle shot), contextLost(), clearEffects(), isAnimating(), stats(), renderer, scene,
//   camera, controls;
//   extra events for on(): 'framing' ({ mode, live, userMoved }), 'contextlost', 'contextrestored'.

import * as THREE from '../../vendor/three/build/three.module.js';
import { OrbitControls } from '../../vendor/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '../../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { FullScreenQuad } from '../../vendor/three/examples/jsm/postprocessing/Pass.js';
import { mergeGeometries } from '../../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { ASSET_KEYS, UNITS, TILE_VARIANTS, TRAITS, RAVEN_INTERCEPT_RANGE } from '../core/data.js';
import { hexToWorld, worldToHex, facingToYaw, offsetToAxial, axialToOffset, key as hexKey } from '../core/hex.js';
import { buildFallback, FALLBACK_STAND_HEIGHT } from './fallback.js';
import { Fx } from './fx.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function hash3(a, b, c) { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }

/** Shared time uniform (water shimmer, flags) for every view. */
const SHARED = { time: { value: 0 } };

// Colour management of the art (assets-src/scripts/common.py COLOR_MGMT): every GLB was painted and previewed under
// Blender's AgX with the « Punchy » look and a 7000 K white balance. three.js ships AgX without looks, so the view
// plugs it in through three's hook for a custom curve (renderer.toneMapping = CustomToneMapping): the warm white
// balance on the scene-referred colour, three's AgX, then a Punchy CDL on the encoded value (power 1.35 like
// Blender's; saturation 1.08 instead of 1.4: three's lighting already saturates the painted greens more than EEVEE
// does, and the grass must read sage, not lemon). Same curve in both qualities (the 'low' direct render and the
// 'high' final pass).
const AGX_PUNCHY = `vec3 CustomToneMapping( vec3 color ) {
  const mat3 AgXInsetMatrix = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 AgXOutsetMatrix = mat3(
    vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
    vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
    vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
  const float AgxMinEv = - 12.47393; const float AgxMaxEv = 4.026069;
  color *= toneMappingExposure * vec3( 1.03, 1.0, 0.94 );
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = AgXInsetMatrix * color;
  color = log2( max( color, 1e-10 ) );
  color = clamp( ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv ), 0.0, 1.0 );
  color = agxDefaultContrastApprox( color );
  color = pow( max( color, vec3( 0.0 ) ), vec3( 1.35 ) );
  float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = max( vec3( 0.0 ), luma + 1.08 * ( color - luma ) );
  color = AgXOutsetMatrix * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}`;
const CUSTOM_TM = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const PUNCHY = THREE.ShaderChunk.tonemapping_pars_fragment.includes(CUSTOM_TM);
if (PUNCHY) THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(CUSTOM_TM, AGX_PUNCHY);

// =====================================================================================================
// Assets
// =====================================================================================================

function withTimeout(p, ms) {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
}
function underNamed(o, re, stop) { for (let p = o; p && p !== stop; p = p.parent) if (re.test(p.name)) return p; return null; }

/** Sample the top surface of a tile template: y at the centre and median y on a ring of radius 0.84. */
function sampleTileProfile(scene) {
  const rc = new THREE.Raycaster(), dir = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3();
  scene.updateMatrixWorld(true);
  const hitY = (x, z) => {
    o.set(x, 3, z); rc.set(o, dir);
    const hits = rc.intersectObject(scene, true).filter((h) => h.point.y > -0.3);
    return hits.length ? hits[hits.length - 1].point.y : null;
  };
  const ring = [];
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + 0.13; const y = hitY(Math.cos(a) * 0.84, Math.sin(a) * 0.84); if (y !== null) ring.push(y); }
  ring.sort((a, b) => a - b);
  return { center: hitY(0.001, 0.001), rim: ring.length ? ring[Math.floor(ring.length / 2)] : null };
}

/** Patch a water material once: moving normal ripples (sun glints) and soft caustic bands. */
function patchWater(mat) {
  if (!mat || mat.userData.rdcWater) return;
  mat.userData.rdcWater = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    injectWorldPos(sh);
    sh.uniforms.uRdcTime = SHARED.time;
    sh.fragmentShader = 'uniform float uRdcTime;\n' + sh.fragmentShader;
    if (sh.fragmentShader.includes('#include <normal_fragment_maps>')) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { float rw1 = sin(vRdcWorld.x * 4.3 + uRdcTime * 1.3 + sin(vRdcWorld.z * 3.1 + uRdcTime * 0.9));
        float rw2 = sin(vRdcWorld.z * 4.9 - uRdcTime * 1.1 + sin(vRdcWorld.x * 2.7 - uRdcTime * 0.7));
        normal = normalize(normal + (viewMatrix * vec4(rw1 * 0.09, 0.0, rw2 * 0.09, 0.0)).xyz); }`);
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <tonemapping_fragment>', `
      { float c1 = sin(vRdcWorld.x * 5.3 + uRdcTime * 1.2 + sin(vRdcWorld.z * 4.1 - uRdcTime * 0.8) * 1.4);
        float c2 = sin(vRdcWorld.z * 5.9 - uRdcTime * 1.0 + sin(vRdcWorld.x * 3.7 + uRdcTime * 0.6) * 1.6);
        gl_FragColor.rgb += vec3(0.55, 0.8, 0.85) * pow(max(0.0, c1 * c2), 4.0) * 0.12;
        float s1 = sin(vRdcWorld.x * 7.0 + sin(vRdcWorld.z * 1.1 + uRdcTime * 0.35) * 2.2) * sin(vRdcWorld.z * 1.9 - uRdcTime * 1.1 + vRdcWorld.x * 0.6);
        gl_FragColor.rgb += vec3(0.6, 0.85, 0.9) * smoothstep(0.82, 1.0, s1) * 0.07; }
      #include <tonemapping_fragment>`);
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => 'rdc-water|' + (prevKey ? prevKey() : '');
  mat.needsUpdate = true;
}

// Painted-flocking variation of the grass (every tile material but water): a low-frequency value noise in world
// space (a few hexes per patch, plus a finer mottle) pulls green albedo toward dry ochre or lush dark green and moves
// its value by about ±10 %, so the colour flows across tile borders instead of repeating one swatch per hex.
// Only green-dominant albedo is touched (earth, rock, water, wood and the teams' paint stay as painted). The noise
// is evaluated per vertex (the tile tops are finely tessellated), the fragment only mixes.
const GROUND_GLSL = `
  { float rdcGr = smoothstep(0.015, 0.07, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
    if (rdcGr > 0.0) {
      float n1 = vRdcGn.x, n2 = vRdcGn.y;
      float v = (n1 - 0.5) * 1.1 + (n2 - 0.5) * 0.45;
      vec3 g = diffuseColor.rgb;
      g = v > 0.0 ? mix(g, g * vec3(1.32, 1.04, 0.5), min(1.0, v) * 0.6) : mix(g, g * vec3(0.66, 0.84, 0.74), min(1.0, -v) * 0.75);
      g *= 0.92 + n2 * 0.16;
      diffuseColor.rgb = mix(diffuseColor.rgb, g, rdcGr);
    } }`;
const NOISE2_GLSL = `
float rdcH2(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float rdcN2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rdcH2(i), rdcH2(i + vec2(1.0, 0.0)), f.x), mix(rdcH2(i + vec2(0.0, 1.0)), rdcH2(i + vec2(1.0, 1.0)), f.x), f.y); }
`;
function groundChunk(sh) {
  if (sh.fragmentShader.includes('rdcGr')) return;
  injectWorldPos(sh);
  sh.vertexShader = 'varying vec2 vRdcGn;\n' + NOISE2_GLSL + sh.vertexShader.replace('vRdcWorld = (modelMatrix * rdcW).xyz; }',
    'vRdcWorld = (modelMatrix * rdcW).xyz; vRdcGn = vec2(rdcN2(vRdcWorld.xz * 0.15 + vec2(3.1, 7.3)), rdcN2(vRdcWorld.xz * 0.55 - vec2(7.7, 1.9))); }');
  sh.fragmentShader = 'varying vec2 vRdcGn;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_GLSL);
}
function patchGround(mat) {
  if (!mat || mat.userData.rdcGround || !mat.isMeshStandardMaterial) return;
  mat.userData.rdcGround = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { prev?.call(mat, sh, r); groundChunk(sh); };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => 'rdc-ground|' + (prevKey ? prevKey() : '');
  mat.needsUpdate = true;
}

function injectWorldPos(sh) {
  if (sh.vertexShader.includes('vRdcWorld')) return;
  sh.vertexShader = 'varying vec3 vRdcWorld;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  { vec4 rdcW = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    rdcW = batchingMatrix * rdcW;
  #endif
  #ifdef USE_INSTANCING
    rdcW = instanceMatrix * rdcW;
  #endif
    vRdcWorld = (modelMatrix * rdcW).xyz; }`);
  sh.fragmentShader = 'varying vec3 vRdcWorld;\n' + sh.fragmentShader;
}

function isWaterMaterial(mat, key) {
  if (!mat) return false;
  if (/water|eau|river|riviere/i.test(mat.name || '')) return true;
  return (key.startsWith('tile_water') || key.startsWith('tile_ford')) && mat.transparent;
}

function prepareTemplate(scene, key, kind) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      if (kind === 'tile' && isWaterMaterial(m, key)) {
        m.depthWrite = false; patchWater(m); o.castShadow = false;
        // deep saturated turquoise that veils the river bed (the cover's water), instead of a pale milky cyan
        if (/^water$/i.test(m.name) && m.color) { m.color.setRGB(0.035, 0.30, 0.36); m.opacity = Math.max(m.opacity, 0.66); }
      }
      else if (kind === 'tile') patchGround(m);
      if (m.map) m.map.anisotropy = 4;
    }
  });
  scene.updateMatrixWorld(true);
}

function kindOf(key) { return key.startsWith('tile_') ? 'tile' : UNITS[key] ? 'unit' : 'prop'; }

const ANIM_NODE = /^(Flag|Glow|Wing_?L|Wing_?R|Body)/i;
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'lightMap', 'transmissionMap'];
/**
 * Draw-call optimisation for GLB templates: inside each animation anchor (the root and every top-most
 * Flag/Glow/Wing/Body node that is a Group), merge the meshes whose material is plain (opaque, untextured,
 * non-emissive standard/physical) into one vertex-coloured mesh per class (paint / metal × side).
 * Anything else (transparent water, textures, emission, unlit, skinning, morphs) is kept untouched.
 */
function optimizeTemplate(root) {
  root.updateMatrixWorld(true);
  const anchors = new Set([root]);
  root.traverse((o) => { if (o !== root && ANIM_NODE.test(o.name) && !o.isMesh) anchors.add(o); });
  const nearest = (o) => { for (let p = o.parent; p; p = p.parent) if (anchors.has(p)) return p; return root; };
  const mergeable = (m) => m && !Array.isArray(m) && (m.isMeshStandardMaterial) && !m.transparent && m.opacity >= 1 && !m.alphaTest
    && !TEX_SLOTS.some((s) => m[s]) && !(m.transmission > 0) && !(m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) * (m.emissiveIntensity ?? 1) > 0.02);
  const buckets = new Map();   // anchor -> Map(classKey -> [{ mesh, mat }])
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.morphTargetInfluences || !mergeable(o.material) || o.children.length) return;
    if (anchors.has(o)) return;
    // never swallow an animated node: a mesh named Flag/Glow/Wing… (or below one) stays, unless it is one
    // primitive of an anchor Group that GLTFLoader split per material (named e.g. "Flag_1")
    for (let p = o; p && p !== root; p = p.parent) {
      if (ANIM_NODE.test(p.name) && !anchors.has(p) && !(p === o && anchors.has(o.parent) && o.parent !== root)) return;
    }
    const a = nearest(o), m = o.material;
    const cls = `${m.metalness >= 0.5 ? 'metal' : 'paint'}|${m.side}`;
    if (!buckets.has(a)) buckets.set(a, new Map());
    const b = buckets.get(a);
    if (!b.has(cls)) b.set(cls, []);
    b.get(cls).push(o);
  });
  const inv = new THREE.Matrix4(), rel = new THREE.Matrix4(), col = new THREE.Color();
  for (const [anchor, classes] of buckets) {
    inv.copy(anchor.matrixWorld).invert();
    for (const [cls, meshes] of classes) {
      if (meshes.length < 2) continue;
      const geoms = [];
      let rough = 0, metal = 0, wsum = 0;
      for (const mesh of meshes) {
        const m = mesh.material;
        let g = mesh.geometry.clone();
        rel.multiplyMatrices(inv, mesh.matrixWorld);
        g.applyMatrix4(rel);
        if (g.index) g = g.toNonIndexed();
        if (!g.attributes.normal) g.computeVertexNormals();
        const pos = g.attributes.position, n = pos.count, vc = m.vertexColors ? g.attributes.color : null;
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          col.copy(m.color);
          if (vc) col.multiply({ r: vc.getX(i), g: vc.getY(i), b: vc.getZ(i) });
          c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
        }
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        g.morphAttributes = {};
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        g.clearGroups();
        geoms.push(g);
        const w = n / 3;
        rough += m.roughness * w; metal += m.metalness * w; wsum += w;
      }
      const merged = mergeGeometries(geoms, false);
      for (const g of geoms) g.dispose();
      if (!merged) continue;
      merged.computeBoundingBox(); merged.computeBoundingSphere();
      const side = Number(cls.split('|')[1]);
      const mat = new THREE.MeshStandardMaterial({ name: `merged-${cls.split('|')[0]}`, vertexColors: true, roughness: rough / wsum, metalness: metal / wsum, side });
      const out = new THREE.Mesh(merged, mat);
      out.name = `${anchor.name || 'root'}_${cls.split('|')[0]}`;
      out.castShadow = true; out.receiveShadow = true;
      anchor.add(out);
      for (const mesh of meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); }
    }
  }
  root.updateMatrixWorld(true);
}

function makeEntry(key, scene, info, source) {
  const kind = info.kind ?? kindOf(key);
  prepareTemplate(scene, key, kind);
  const box = new THREE.Box3().setFromObject(scene);
  const out = { key, scene, source, info: { ...info, kind, bboxMin: box.min.toArray(), bboxMax: box.max.toArray() } };
  if (kind === 'tile') {
    const terrain = key.split('_')[1];
    out.info.terrain = terrain;
    // the manifest carries standHeight and rim (same sampling rule, precomputed by validate.py): skip the ray casts
    if (!Number.isFinite(out.info.standHeight) || !Number.isFinite(out.info.rim)) {
      const prof = sampleTileProfile(scene);
      if (!Number.isFinite(out.info.standHeight)) out.info.standHeight = prof.center ?? FALLBACK_STAND_HEIGHT[terrain] ?? 0;
      if (!Number.isFinite(out.info.rim)) out.info.rim = prof.rim ?? out.info.standHeight;
    }
  } else if (kind === 'unit') {
    if (!Number.isFinite(out.info.height)) out.info.height = Math.min(1.2, Math.max(0.4, box.max.y));
  }
  if (!Array.isArray(out.info.nodes)) out.info.nodes = [];
  return out;
}

/**
 * Load assets/manifest.json and every GLB it lists for the keys of ASSET_KEYS; anything missing or broken
 * gets a procedural fallback (fallback.js), so the returned library always covers every key.
 * A GLB fails after `stallMs` without any byte received (reset by each progress event), or after `timeoutMs` in all:
 * a slow but steady connection keeps loading, a dead one falls back quickly.
 * `manifest`: an already fetched manifest object (the shell fetches it at boot for the cover) — skips a second fetch.
 * @param {{ base?: string, onProgress?: (p: number) => void, fallbackOnly?: boolean, concurrency?: number, timeoutMs?: number,
 *           stallMs?: number, manifest?: object|null }} [opts]
 * @returns {Promise<AssetLib>}
 */
export async function preloadAssets({ base = 'assets/', onProgress = () => {}, fallbackOnly = false, concurrency = 6, timeoutMs = 90000, stallMs = 10000, manifest: given = null } = {}) {
  if (base && !base.endsWith('/')) base += '/';
  const keys = [...ASSET_KEYS.tiles, ...ASSET_KEYS.units, ...ASSET_KEYS.props];
  const progress = (p) => { try { onProgress(p); } catch (e) { /* ignore UI errors */ } };
  progress(0);
  let manifest = given && typeof given === 'object' && given.assets ? given : null;
  if (!fallbackOnly && !manifest) {
    try {
      const res = await withTimeout(fetch(base + 'manifest.json', { cache: 'no-cache' }), 8000);
      if (res.ok) manifest = await res.json();
    } catch (e) { manifest = null; }
  }
  const entries = new Map();
  const stats = { glb: 0, fallback: 0, failed: [], lod: 0 };
  const loader = new GLTFLoader();
  // Published builds ship each GLB packed as JSON ({ glb: base64 }, tools/pack-glb.mjs): the Artifact host serves
  // no binary model type. Decoded here, then parsed exactly like a .glb.
  const loadPacked = async (url) => {
    const res = await withTimeout(fetch(url), timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { glb } = await withTimeout(res.json(), timeoutMs);
    const bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(glb) : Uint8Array.from(atob(glb), (c) => c.charCodeAt(0));
    return loader.parseAsync(bytes.buffer, '');
  };
  // stall timer reset by every progress event, paused once the bytes are in (parsing sends no progress)
  const loadGlb = (url) => /\.json(\?|$)/.test(url) ? loadPacked(url) : new Promise((res, rej) => {
    let stall = 0, over = false;
    const end = (fn, v) => { if (over) return; over = true; clearTimeout(stall); clearTimeout(total); fn(v); };
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => end(rej, new Error('stall')), stallMs); };
    const total = setTimeout(() => end(rej, new Error('timeout')), timeoutMs);
    arm();
    loader.load(url, (g) => end(res, g), (e) => { if (e && e.total > 0 && e.loaded >= e.total) clearTimeout(stall); else arm(); }, (e) => end(rej, e));
  });
  let done = 0;
  // Versioned URL (file size from the manifest): a host that caches aggressively never serves a stale model after
  // an asset update, and an unchanged model keeps its cache entry.
  const urlOf = (m) => base + m.file + (Number.isFinite(m.bytes) ? `${m.file.includes('?') ? '&' : '?'}v=${m.bytes}` : '');
  // Without a manifest (assets still being produced), probe models/<key>.glb directly.
  const probe = !fallbackOnly && !manifest;
  const loadOne = async (key) => {
    let m = manifest?.assets?.[key];
    if (!m && probe) {
      try {
        const head = await withTimeout(fetch(`${base}models/${key}.glb`, { method: 'HEAD', cache: 'no-cache' }), 5000);
        if (head.ok) m = { file: `models/${key}.glb` };
      } catch (e) { m = null; }
    }
    if (m && m.file) {
      try {
        const gltf = await loadGlb(urlOf(m));
        const info = { kind: m.kind ?? kindOf(key), standHeight: m.standHeight, rim: m.rim, height: m.height, nodes: m.nodes };
        try { optimizeTemplate(gltf.scene); } catch (e) { console.warn(`[render] ${key}: optimisation ignorée (${e?.message ?? e})`); }
        entries.set(key, makeEntry(key, gltf.scene, info, 'glb'));
        stats.glb++;
      } catch (e) {
        stats.failed.push(key);
        console.warn(`[render] ${key}: GLB indisponible (${e?.message ?? e}), modèle procédural utilisé.`);
      }
    }
    if (!entries.has(key)) {
      const fb = buildFallback(key);
      entries.set(key, makeEntry(key, fb.scene, fb.info, 'fallback'));
      stats.fallback++;
    }
    done++; progress(done / keys.length);
  };
  const queue = keys.slice();
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => { while (queue.length) await loadOne(queue.shift()); }));
  // Optional decimated versions for distant scenery: manifest entry "<key>_lod" (or "lod": "models/x_lod1.glb" on
  // the key itself). Loaded after the full models; a missing or broken LOD just keeps the previous behaviour.
  const lodQueue = [];
  for (const key of keys) {
    const m = manifest?.assets?.[key];
    const lm = manifest?.assets?.[`${key}_lod`] ?? (typeof m?.lod === 'string' ? { file: m.lod } : m?.lod?.file ? m.lod : null);
    if (lm?.file && entries.get(key)?.source === 'glb') lodQueue.push([key, lm]);
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (lodQueue.length) {
      const [key, lm] = lodQueue.shift();
      try {
        const gltf = await loadGlb(urlOf(lm));
        try { optimizeTemplate(gltf.scene); } catch (e) { /* keep it as is */ }
        const full = entries.get(key).info;
        const e = makeEntry(key, gltf.scene, { kind: full.kind, standHeight: full.standHeight, rim: full.rim, height: full.height, nodes: full.nodes }, 'glb');
        e.lod = true;
        entries.set('lod:' + key, e);
        stats.lod++;
      } catch (e) { console.warn(`[render] ${key}: LOD indisponible (${e?.message ?? e}).`); }
    }
  }));
  return makeLib(base, manifest, entries, stats);
}

function makeLib(base, manifest, entries, stats) {
  return {
    base, manifest, stats, entries,
    /** @returns {{ key, scene, info, source }} — never null (unknown keys get a fallback). */
    get(key) {
      let e = entries.get(key);
      if (!e) { const fb = buildFallback(key); e = makeEntry(key, fb.scene, fb.info, 'fallback'); entries.set(key, e); }
      return e;
    },
    has(key) { return entries.has(key); },
    /** True when a decimated GLB (manifest "<key>_lod") was loaded for this key. */
    hasLod(key) { return entries.get('lod:' + key)?.lod === true; },
    /** Low-poly version of a key, used for distant scenery: the decimated GLB if loaded, else the procedural model. */
    lowDetail(key) {
      const k = 'lod:' + key;
      let e = entries.get(k);
      if (!e) { const src = entries.get(key); if (src?.source === 'fallback') return src; const fb = buildFallback(key); e = makeEntry(key, fb.scene, fb.info, 'fallback'); entries.set(k, e); }
      return e;
    },
    source(key) { return entries.get(key)?.source ?? null; },
    dispose() {
      for (const e of entries.values()) {
        if (e.source !== 'glb') continue;
        e.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry?.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (!m) continue; for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose(); }
        });
      }
      entries.clear();
    },
  };
}

// =====================================================================================================
// Shaders
// =====================================================================================================

// Backdrop (cover.py BG and MIST): a vertical ramp from deep warm shadow at the bottom to luminous gold at the top,
// a radial glow on the sun's side (uBgSun = centre u, v and radius, in screen units; x scaled by the aspect), and a
// sea of dawn mist under the floating island: up to three noisy layers (y, scale, coverage, opacity) met by the
// camera ray of the pixel, lit on their crests, warm in their troughs, sun-filled, fading out 16 to 40 units from the
// board centre and drifting slowly. The scenery ring dissolves into this same function, so it melts into the mist.
const BG_PARS = `
uniform vec3 uBg0; uniform vec3 uBg1; uniform vec3 uBg2; uniform vec3 uBg3; uniform vec3 uBgGlow; uniform vec3 uBgSun; uniform vec2 uBgRes;
uniform mat4 uBgInvProj; uniform mat4 uBgCam; uniform vec2 uBgC; uniform float uBgTime; uniform int uBgMist;
float rdcBgH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float rdcBgN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rdcBgH(i), rdcBgH(i + vec2(1.0, 0.0)), f.x), mix(rdcBgH(i + vec2(0.0, 1.0)), rdcBgH(i + vec2(1.0, 1.0)), f.x), f.y); }
vec3 rdcBg(vec2 fc) {
  vec2 uv = fc / uBgRes;
  vec3 c = mix(uBg0, uBg1, clamp(uv.y / 0.40, 0.0, 1.0));
  c = mix(c, uBg2, clamp((uv.y - 0.40) / 0.35, 0.0, 1.0));
  c = mix(c, uBg3, clamp((uv.y - 0.75) / 0.25, 0.0, 1.0));
  vec2 d = uv - uBgSun.xy; d.x *= uBgRes.x / uBgRes.y;
  float g = 1.0 - clamp(length(d) / uBgSun.z, 0.0, 1.0);
  c += uBgGlow * g * g;
  if (uBgMist > 0) {
    vec4 v = uBgInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = mat3(uBgCam) * (v.xyz / v.w), o = uBgCam[3].xyz;
    for (int i = 2; i >= 0; i--) {
      if (i >= uBgMist || dir.y > -1e-4) continue;
      vec4 L = i == 0 ? vec4(-0.95, 0.2, 0.55, 0.85) : i == 1 ? vec4(-1.7, 0.13, 0.6, 0.8) : vec4(-2.8, 0.08, 0.7, 0.9);
      vec3 p = o + dir * ((L.x - o.y) / dir.y);
      float far = 1.0 - smoothstep(16.0, 40.0, length(p.xz - uBgC));
      if (far <= 0.0) continue;
      vec2 q = (p.xz + vec2(uBgTime * 0.05, uBgTime * 0.02)) * L.y + float(i) * 23.7;
      float n = rdcBgN(q) * 0.5 + rdcBgN(q * 2.07 + 5.3) * 0.3 + rdcBgN(q * 4.11 - 2.1) * 0.2;
      float a = smoothstep(1.0 - L.z - 0.1, 1.0 - L.z + 0.22, n) * L.w * far;
      vec3 m = mix(vec3(0.55, 0.42, 0.42), vec3(1.0, 0.80, 0.60), smoothstep(0.35, 0.75, n)) * 0.3 + vec3(1.0, 0.62, 0.30) * 0.07;
      c = mix(c, m, a);
    }
  }
  return c;
}`;

// ---- post-processing (quality 'high'; see createView › pipeline): one MSAA scene target, a light bloom chain and a
// depth-of-field chain (three Kawase down-samples of the scene: 1/2, 1/4, 1/8), then ONE final pass to the canvas
// (depth of field, bloom, vignette, tone mapping and sRGB). Intermediates are single-sample and depth-less.
const FS_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
// Depth of field of a miniature shot: the blur level b (0 = sharp, 1..3 = the 1/2, 1/4, 1/8 resolution copies,
// blended) is 0 inside the focus band [uFocus - uBandLo, uFocus + uBandHi] (screen-space y), so the band is passed
// through untouched (full resolution: the miniatures in focus stay crisp), and grows to uMax beyond uFeather.
const TILT_PARS = `
uniform float uFocus; uniform float uBandLo; uniform float uBandHi; uniform float uFeather; uniform float uMax;
float rdcTilt(float y) {
  float d = y - uFocus;
  float band = d < 0.0 ? uBandLo : uBandHi;
  return smoothstep(band, band + uFeather, abs(d)) * uMax;
}`;
const FINAL_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    tDof1: { value: null }, tDof2: { value: null }, tDof3: { value: null },
    uFocus: { value: 0.5 }, uBandLo: { value: 0.3 }, uBandHi: { value: 0.3 }, uFeather: { value: 0.3 }, uMax: { value: 0 },
    uVignette: { value: 0 }, uAspect: { value: 1.6 }, uGain: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tBloom; uniform float uBloom; uniform vec2 uRes;
uniform sampler2D tDof1; uniform sampler2D tDof2; uniform sampler2D tDof3;
uniform float uVignette; uniform float uAspect; uniform vec3 uGain; ${TILT_PARS}
varying vec2 vUv;
vec3 rdcTent(sampler2D t, float scale) {
  vec2 h = scale * 0.5 / uRes;
  return 0.25 * (texture2D(t, vUv + vec2(-h.x, -h.y)).rgb + texture2D(t, vUv + vec2(h.x, -h.y)).rgb
    + texture2D(t, vUv + vec2(-h.x, h.y)).rgb + texture2D(t, vUv + vec2(h.x, h.y)).rgb);
}
void main() {
  float b = rdcTilt(vUv.y);
  vec4 c = texture2D(tDiffuse, vUv);
  if (b > 0.02) {
    vec3 c1 = rdcTent(tDof1, 2.0);
    if (b < 1.0) c.rgb = mix(c.rgb, c1, b);
    else {
      vec3 c2 = rdcTent(tDof2, 4.0);
      c.rgb = b < 2.0 ? mix(c1, c2, b - 1.0) : mix(c2, rdcTent(tDof3, 8.0), min(1.0, b - 2.0));
    }
  }
  if (uBloom > 0.0) c.rgb += texture2D(tBloom, vUv).rgb * uBloom;
  if (uVignette > 0.0) {
    vec2 q = vUv - 0.5; q.x *= uAspect * 0.78;
    c.rgb *= 1.0 - smoothstep(0.32, 0.98, length(q)) * uVignette;
  }
  gl_FragColor = vec4(c.rgb * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
};
// Bloom: bright-pass + dual-filter (Kawase) down / up chain, threshold on the linear HDR scene (> 1.0 = only
// emissive magic, fire, sparks and sun glints bloom; the lit board stays below).
const BLOOM_PRE = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 }, uKnee: { value: 0.35 } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
varying vec2 vUv;
vec3 tap(vec2 o) { return min(texture2D(tDiffuse, vUv + o * uTexel).rgb, vec3(24.0)); }
void main() {
  vec3 c = (tap(vec2(-0.5, -0.5)) + tap(vec2(0.5, -0.5)) + tap(vec2(-0.5, 0.5)) + tap(vec2(0.5, 0.5))) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  gl_FragColor = vec4(c * (max(soft, br - uThreshold) / max(br, 1e-4)), 1.0);
}`,
};
const BLOOM_DOWN = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uTexel; varying vec2 vUv;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture2D(tDiffuse, vUv).rgb * 4.0;
  c += texture2D(tDiffuse, vUv - h).rgb + texture2D(tDiffuse, vUv + h).rgb;
  c += texture2D(tDiffuse, vUv + vec2(h.x, -h.y)).rgb + texture2D(tDiffuse, vUv - vec2(h.x, -h.y)).rgb;
  gl_FragColor = vec4(c * 0.125, 1.0);
}`,
};
const BLOOM_UP = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uWeight; varying vec2 vUv;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture2D(tDiffuse, vUv + vec2(-h.x * 2.0, 0.0)).rgb + texture2D(tDiffuse, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture2D(tDiffuse, vUv + vec2(0.0, -h.y * 2.0)).rgb + texture2D(tDiffuse, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += (texture2D(tDiffuse, vUv + vec2(-h.x, h.y)).rgb + texture2D(tDiffuse, vUv + vec2(h.x, h.y)).rgb
      + texture2D(tDiffuse, vUv + vec2(h.x, -h.y)).rgb + texture2D(tDiffuse, vUv + vec2(-h.x, -h.y)).rgb) * 2.0;
  gl_FragColor = vec4(c / 12.0 * uWeight, 1.0);
}`,
};

// =====================================================================================================
// Highlights
// =====================================================================================================

// Deploy zones stay light on the board (the tiles must remain readable under them): a soft inner glow along the
// edge of each hex ('glow' fill, fading toward the centre) and an outline for the player's, the outline alone for
// the enemy's.
const HL_STYLE = {
  'deploy':       { fill: '#4f7bd1', fillA: 0.34, glow: true, line: '#9dbcf5', lineA: 0.75, pulse: 0, order: 1 },
  'deploy-enemy': { fill: null, fillA: 0, line: '#ee8a5f', lineA: 0.5, pulse: 0, order: 1 },
  'range':        { fill: '#e8c97e', fillA: 0.16, line: '#f0d590', lineA: 0.4, pulse: 0, order: 2 },
  'path':         { fill: '#f4ead2', fillA: 0.7, line: null, small: true, pulse: 0.15, order: 3 },
  'danger':       { fill: '#d65a43', fillA: 0.24, line: '#ff7a5c', lineA: 0.65, pulse: 0.35, order: 3 },
  'target':       { fill: '#ff6a3c', fillA: 0.2, line: '#ffa07a', lineA: 1.0, pulse: 0.5, order: 5 },
  'select':       { fill: '#d4a94f', fillA: 0.22, line: '#f6d68a', lineA: 1.0, pulse: 0.22, order: 6 },
  'hover':        { fill: '#efe4cc', fillA: 0.1, line: '#fff7e0', lineA: 0.9, pulse: 0.12, order: 7 },
};

/** Concentric hex bands between `radii`; with `alphas` (one per radius) a vertex alpha (RGBA colour) fades across them. */
function hexBandGeom(radii, drop, alphas = null) {
  const prof = (r) => (drop > 0 ? -drop * smooth(0.42, 0.93, r) : 0);
  const pos = [], col = [];
  const corner = (r, k) => { const a = (k % 6) * Math.PI / 3; return [Math.cos(a) * r, prof(r), Math.sin(a) * r]; };
  for (let i = 0; i + 1 < radii.length; i++) {
    const r0 = radii[i], r1 = radii[i + 1];
    const A0 = [1, 1, 1, alphas?.[i] ?? 1], A1 = [1, 1, 1, alphas?.[i + 1] ?? 1];
    for (let k = 0; k < 6; k++) {
      const a0 = corner(r0, k), a1 = corner(r0, k + 1), b0 = corner(r1, k), b1 = corner(r1, k + 1);
      if (r0 === 0) { pos.push(...a0, ...b1, ...b0); col.push(...A0, ...A1, ...A1); }
      else { pos.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1); col.push(...A0, ...A1, ...A1, ...A0, ...A0, ...A1); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (alphas) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeVertexNormals();
  return g;
}

// =====================================================================================================
// HP plates
// =====================================================================================================

// A flat plate: status icons (ward / hex / hold) and the commander's crown on the left, one continuous HP bar with
// a thin tick every 2 HP. The sprite keeps this canvas aspect; its on-screen width follows the size of a hex.
const PLATE_W = 192, PLATE_H = 40;           // canvas px (about 4x the on-screen size)
const PLATE_CSS = { min: 30, max: 56 };      // on-screen width (CSS px)
const TEAM_UI = { royaume: '#6a93e6', gobelins: '#d8653d' };

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
function drawStatusIcon(g, kind, cx, cy) {
  const col = { ward: '#8fc8ff', hex: '#c08cff', hold: '#e9e2d2', crown: '#f0cd7a' }[kind];
  const R = 17;
  g.fillStyle = 'rgba(18,15,13,0.92)'; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
  g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
  g.fillStyle = col; g.strokeStyle = col;
  const s = 1.35;
  if (kind === 'hex') {
    g.lineWidth = 3.4; g.beginPath();
    for (let i = 0; i <= 28; i++) { const a = i / 28 * TAU * 1.6, r = (1 + i * 0.27) * s; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
  } else if (kind === 'crown') {
    g.beginPath(); g.moveTo(cx - 10, cy + 7); g.lineTo(cx - 11, cy - 6); g.lineTo(cx - 5, cy - 1); g.lineTo(cx, cy - 9); g.lineTo(cx + 5, cy - 1);
    g.lineTo(cx + 11, cy - 6); g.lineTo(cx + 10, cy + 7); g.closePath(); g.fill();
  } else {
    // shield
    g.beginPath(); g.moveTo(cx, cy - 7 * s); g.lineTo(cx + 6.5 * s, cy - 4.5 * s); g.lineTo(cx + 5.5 * s, cy + 2.5 * s); g.quadraticCurveTo(cx + 3 * s, cy + 6.5 * s, cx, cy + 8 * s);
    g.quadraticCurveTo(cx - 3 * s, cy + 6.5 * s, cx - 5.5 * s, cy + 2.5 * s); g.lineTo(cx - 6.5 * s, cy - 4.5 * s); g.closePath();
    if (kind === 'ward') g.fill(); else { g.lineWidth = 3; g.stroke(); }
  }
}
function drawPlate(g, s) {
  g.clearRect(0, 0, PLATE_W, PLATE_H);
  const icons = [];
  if (s.commander) icons.push('crown');
  if (s.ward) icons.push('ward');
  if (s.hex) icons.push('hex');
  if (s.holding) icons.push('hold');
  icons.forEach((k, i) => drawStatusIcon(g, k, 20 + i * 38, PLATE_H / 2));
  const bx = icons.length ? 2 + icons.length * 38 + 2 : 3, by = 7, bw = PLATE_W - 3 - bx, bh = PLATE_H - 14;
  roundRect(g, bx, by, bw, bh, 7);
  g.fillStyle = 'rgba(16,13,11,0.86)'; g.fill();
  g.lineWidth = 2.5; g.strokeStyle = TEAM_UI[s.faction] ?? '#999'; g.stroke();
  const ix = bx + 4, iy = by + 4, iw = bw - 8, ih = bh - 8;
  const ratio = s.maxHp > 0 ? clamp01(s.hp / s.maxHp) : 0;
  const col = ratio > 0.6 ? '#8fd16a' : ratio > 0.3 ? '#efb83d' : '#ec5338';
  g.fillStyle = '#3b332c'; g.fillRect(ix, iy, iw, ih);
  if (ratio > 0) {
    g.fillStyle = col; g.fillRect(ix, iy, iw * ratio, ih);
    g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(ix, iy, iw * ratio, 3);
  }
  // a thin dark tick every 2 HP
  g.fillStyle = 'rgba(16,13,11,0.75)';
  for (let hp = 2; hp < s.maxHp; hp += 2) g.fillRect(Math.round(ix + iw * hp / s.maxHp) - 1, iy, 2, ih);
}

// =====================================================================================================
// The view
// =====================================================================================================

const PHASE = { moveEnd1: 0.42, sub0End: 0.23, sub1End: 0.46, hold: 0.22, aim: 0.44, release: 0.49, impact: 0.74, heal: 0.76, death: 0.8, raven: 0.87, regen: 0.9 };
const RAVEN_ALT = 2.45;
const UNIT_SCALE = 1.25;      // figures are scaled up a little for readability from the battle camera
const RAVEN_SCALE = 2.8;      // base scale (wingspan ≈ 1 world unit); raised further to keep ≥ RAVEN_MIN_PX on screen
const RAVEN_MIN_PX = 30;      // minimum on-screen wingspan (CSS px), so the signature bird never shrinks to a speck
const RAVEN_SPAN = 0.36;      // model wingspan at scale 1 (manifest bbox)
const SIDE_UI = { player: TEAM_UI.royaume, enemy: TEAM_UI.gobelins };
// Camera framing during a battle ("follow the action")
const ACTION = { margin: 2.3, minFrac: 0.3, keep: 0.85, shrink: 0.7, tween: 1.0, recent: 2, fight: 3 };

/**
 * Create the 3D view inside `container` (which should fill the screen; the view tracks its size).
 * @param {HTMLElement} container
 * @param {{ assets?: object|null, quality?: 'high'|'low', keyboard?: boolean }} [opts]
 *   assets: an AssetLib from preloadAssets(); undefined => preloadAssets() is called; null => procedural models only.
 * @returns {Promise<object>} View (see docs/INTERFACES.md)
 */
export async function createView(container, { assets, quality = 'high', keyboard = true } = {}) {
  let lib = assets;
  if (lib === undefined) lib = await preloadAssets();
  else if (lib === null) lib = await preloadAssets({ fallbackOnly: true });

  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  // ------------------------------------------------------------------ renderer
  // The canvas is multisampled only when we start in 'low' (direct rendering). In 'high' the scene is drawn into
  // its own MSAA target and the canvas only receives the final full-screen pass, so an MSAA back buffer would be
  // wasted memory (~70 MB at 1440×900, DPR 1.5). Switching to 'low' later goes through that target too (see render()).
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', powerPreference: 'high-performance', alpha: false });
  } catch (e) {
    throw new Error(`WebGL indisponible : le navigateur n’a pas pu créer de contexte 3D (${e?.message ?? e})`);
  }
  const canvasAA = !!renderer.getContext().getContextAttributes?.()?.antialias;
  const hdrType = (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float')) ? THREE.HalfFloatType : THREE.UnsignedByteType;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = PUNCHY ? THREE.CustomToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = PUNCHY ? 0.84 : 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;      // filter radius set per quality (applyQuality)
  renderer.shadowMap.autoUpdate = false;          // refreshed only when something that casts a shadow moves (see step())
  renderer.setClearColor('#1a1714', 1);
  renderer.info.autoReset = false;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;';
  canvas.setAttribute('aria-label', 'Champ de bataille');
  canvas.tabIndex = -1;            // focusable on click, so keyboard panning works after interacting with the board
  container.appendChild(canvas);
  const overlay = document.createElement('div');
  overlay.className = 'rdc-overlay';
  container.appendChild(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 16 / 9, 0.5, 220);

  // Environment map (soft speculars, water and armour reflections): an outdoor dawn sky, not a studio: cool blue
  // zenith (cover.py SKY), warm golden horizon, dark earth below and a hot spot on the sun's side. Rebuilt after a
  // WebGL context restore (its render target comes back empty) and when the sun turns with the camera.
  let envRT = null;
  function buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const sky = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, uniforms: { uSun: { value: sunDir() } },
      vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uSun; varying vec3 vD;
        void main() {
          vec3 d = normalize(vD);
          vec3 zen = vec3(0.40, 0.52, 0.80), hor = vec3(1.0, 0.68, 0.40), gnd = vec3(0.20, 0.13, 0.08);
          vec3 c = d.y > 0.0 ? mix(hor, zen, pow(d.y, 0.55)) : mix(hor * 0.55, gnd, pow(-d.y, 0.45));
          float s = max(dot(d, uSun), 0.0);
          c += vec3(1.0, 0.70, 0.38) * (pow(s, 6.0) * 1.2 + pow(s, 160.0) * 16.0);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    sky.add(new THREE.Mesh(geo, mat));
    const next = pmrem.fromScene(sky, 0);
    pmrem.dispose(); geo.dispose(); mat.dispose();
    envRT?.dispose();
    envRT = next;
    scene.environment = envRT.texture;
  }
  scene.environmentIntensity = 0.3;

  // ------------------------------------------------------------------ background gradient (shared with the ring fade)
  // Luminous gold at the top, deep warm shadow below, a glow on the sun's side (top right): the board reads as a
  // diorama island floating in a dawn haze (cover.py BG, scene-linear values like the cover's).
  const bgU = {
    uBg0: { value: new THREE.Color(0.16, 0.09, 0.08) }, uBg1: { value: new THREE.Color(0.42, 0.22, 0.13) },
    uBg2: { value: new THREE.Color(0.80, 0.45, 0.20) }, uBg3: { value: new THREE.Color(0.95, 0.62, 0.30) },
    uBgGlow: { value: new THREE.Color(0.95, 0.55, 0.20) }, uBgSun: { value: new THREE.Vector3(0.74, 1.05, 0.85) },
    uBgRes: { value: new THREE.Vector2(1, 1) },
    uBgInvProj: { value: new THREE.Matrix4() }, uBgCam: { value: new THREE.Matrix4() }, uBgC: { value: new THREE.Vector2(10, 7.5) }, uBgTime: SHARED.time,
    uBgMist: { value: 3 },
  };
  // Drawn after the opaque scene, at the far plane (depth test on): only the pixels the island leaves uncovered pay
  // for the gradient and the mist.
  const bgMat = new THREE.ShaderMaterial({
    uniforms: bgU, depthTest: true, depthWrite: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: `${BG_PARS}
      void main() {
        vec3 c = rdcBg(gl_FragCoord.xy);
        c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
  bgMesh.frustumCulled = false; bgMesh.renderOrder = 1e6;
  scene.add(bgMesh);
  scene.fog = new THREE.Fog(new THREE.Color(0.62, 0.40, 0.22), 30, 90);

  // ------------------------------------------------------------------ lights
  // Low golden sun behind the Goblin bank (cover.py SUN: 16° high, 118° round from the camera, to its right): long
  // shadows toward the viewer, lit Kingdom faces, rim-lit Goblins; the flat tops get little direct light, so figures,
  // trunks and tile sides stand out. A cool sky fill (bluish shadows, cover.py SKY) and a faint warm bounce from the
  // front-left (cover.py BOUNCE). Directions are relative to the camera's default azimuth (they turn with it).
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.40, 0.52, 0.80), new THREE.Color(0.32, 0.21, 0.12), 0.62);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.66, 0.36), 5.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(1.0, 0.78, 0.58), 0.5);
  scene.add(fill, fill.target);
  const SUN_DIR = new THREE.Vector3(0.849, 0.276, -0.451).normalize();
  const FILL_DIR = new THREE.Vector3(-0.797, 0.174, 0.579).normalize();
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const sunDir = (out = new THREE.Vector3()) => out.copy(SUN_DIR).applyAxisAngle(Y_AXIS, st.azimuth || 0);

  // ------------------------------------------------------------------ groups
  const boardGroup = new THREE.Group(); boardGroup.name = 'board';
  const hlGroup = new THREE.Group(); hlGroup.name = 'highlights';
  const unitGroup = new THREE.Group(); unitGroup.name = 'units';
  const ravenGroup = new THREE.Group(); ravenGroup.name = 'ravens';
  const fxGroup = new THREE.Group(); fxGroup.name = 'fx';
  const markGroup = new THREE.Group(); markGroup.name = 'marks';
  scene.add(boardGroup, markGroup, hlGroup, unitGroup, ravenGroup, fxGroup);

  const fx = new Fx({ root: fxGroup, camera, overlay, getTemplate: (k) => lib.get(k) });

  // ------------------------------------------------------------------ state
  const st = {
    quality: quality === 'low' ? 'low' : 'high',
    paused: false, disposed: false, time: 0,
    width: 1, height: 1, pixelRatio: 1,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    map: null, tiles: new Map(), board: null,
    bounds: { minX: -1, maxX: 21, minZ: -1, maxZ: 16, cx: 10, cz: 7.5 },
    D0: 30, polar: 50 * DEG, userMoved: false,
    units: new Map(), dying: [], ravens: new Map(), ghosts: [],
    selected: null, hover: null, hoverUnit: null, hoverOutline: true,
    highlights: [], hlDirty: true,
    pointer: { inside: false, x: 0, y: 0, down: null },
    listeners: { hexclick: new Set(), hexhover: new Set(), unitclick: new Set(), unithover: new Set(), framing: new Set(), contextlost: new Set(), contextrestored: new Set() },
    keys: new Set(), keyboard: !!keyboard,
    tween: null, current: null,
    reduced: false, shadowDirty: 2,
    azimuth: 0,
    // battle framing: 'action' follows the living units and ravens while ticks play (live), 'board' shows everything
    framing: 'action', live: false, action: null, reframeCheckT: 0, activity: new Map(), combat: new Map(), tickNo: 0,
    tilt: { lo: 0.3, hi: 0.3 }, contextLost: false, phone: false,
    hitStop: 0, kick: null, orbit: null,
  };
  buildEnvironment();
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  st.reduced = !!mq?.matches;
  fx.setReducedMotion(st.reduced);
  const onMq = () => { st.reduced = !!mq.matches; fx.setReducedMotion(st.reduced); };
  mq?.addEventListener?.('change', onMq);

  const disposables = [];   // geometries / materials / textures owned by this view (not by the lib)
  const own = (x) => { disposables.push(x); return x; };


  // ------------------------------------------------------------------ post-processing pipeline
  // 'high': scene → one MSAA HDR target → bloom chain (half res and below) and depth-of-field chain (1/2, 1/4, 1/8,
  //   single-sample, no depth) → one final pass to the canvas (depth of field, bloom, vignette, AgX « Punchy »
  //   tone mapping, sRGB). Exactly one MSAA target and one MSAA resolve per frame.
  // 'low': direct rendering when the canvas is multisampled; otherwise (view created in 'high') scene → MSAA target
  //   → final pass doing only tone mapping + sRGB, so the image stays antialiased.
  let pipe = null;
  const BLOOM_LEVELS = 5;
  const BLOOM_STRENGTH = 0.22;
  function fsq(shader, extra = {}) {
    const m = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(shader.uniforms), vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader, depthTest: false, depthWrite: false, ...extra });
    return new FullScreenQuad(m);
  }
  function buildPipeline(post) {
    destroyPipeline();
    const flat = { type: hdrType, depthBuffer: false };
    pipe = {
      post,
      scene: new THREE.WebGLRenderTarget(4, 4, { type: hdrType, samples: 4 }),
      dof: post ? Array.from({ length: 3 }, () => new THREE.WebGLRenderTarget(4, 4, flat)) : [],
      bloom: post ? Array.from({ length: BLOOM_LEVELS }, () => new THREE.WebGLRenderTarget(4, 4, flat)) : [],
      pre: post ? fsq(BLOOM_PRE) : null,
      down: post ? fsq(BLOOM_DOWN) : null,
      up: post ? fsq(BLOOM_UP, { blending: THREE.AdditiveBlending }) : null,
      final: fsq(FINAL_SHADER),
    };
    const fu = pipe.final.material.uniforms;
    if (post) {
      fu.uVignette.value = 0.34; fu.uBloom.value = BLOOM_STRENGTH; fu.tBloom.value = pipe.bloom[0].texture;
      [fu.tDof1.value, fu.tDof2.value, fu.tDof3.value] = pipe.dof.map((rt) => rt.texture);
    }
    else fu.uMax.value = 0;
  }
  function destroyPipeline() {
    if (!pipe) return;
    for (const rt of [pipe.scene, ...pipe.dof, ...pipe.bloom]) rt?.dispose();
    for (const q of [pipe.pre, pipe.down, pipe.up, pipe.final]) { if (!q) continue; q.material.dispose(); q.dispose(); }
    pipe = null;
  }
  function sizePipeline(w, h) {
    if (!pipe) return;
    pipe.scene.setSize(w, h);
    pipe.dof.forEach((rt, i) => rt.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    pipe.bloom.forEach((rt, i) => rt.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    pipe.final.material.uniforms.uRes.value.set(w, h);
    pipe.final.material.uniforms.uAspect.value = w / Math.max(1, h);
  }
  /** Depth-of-field chain: the scene down-sampled to 1/2, 1/4 and 1/8 (Kawase filter), blended by the final pass. */
  function renderDof(src) {
    const du = pipe.down.material.uniforms;
    let from = src, fw = pipe.scene.width, fh = pipe.scene.height;
    for (const rt of pipe.dof) {
      du.tDiffuse.value = from; du.uTexel.value.set(1 / fw, 1 / fh);
      renderer.setRenderTarget(rt); pipe.down.render(renderer);
      from = rt.texture; fw = rt.width; fh = rt.height;
    }
  }
  function renderBloom(src, w, h) {
    const L = pipe.bloom;
    const pre = pipe.pre.material.uniforms;
    pre.tDiffuse.value = src; pre.uTexel.value.set(1 / w, 1 / h);
    renderer.setRenderTarget(L[0]); pipe.pre.render(renderer);
    const du = pipe.down.material.uniforms;
    for (let i = 1; i < L.length; i++) {
      du.tDiffuse.value = L[i - 1].texture; du.uTexel.value.set(1 / L[i - 1].width, 1 / L[i - 1].height);
      renderer.setRenderTarget(L[i]); pipe.down.render(renderer);
    }
    const uu = pipe.up.material.uniforms;
    for (let i = L.length - 2; i >= 0; i--) {
      uu.tDiffuse.value = L[i + 1].texture; uu.uTexel.value.set(1 / L[i + 1].width, 1 / L[i + 1].height);
      renderer.setRenderTarget(L[i]); pipe.up.render(renderer);     // additive over the level's own downsample
    }
  }

  // =====================================================================================================
  // Materials owned by the view
  // =====================================================================================================

  const ringU = {
    uRdcBoardC: { value: new THREE.Vector2() }, uRdcBoardH: { value: new THREE.Vector2() },
    uRdcFade: { value: new THREE.Vector2(0.9, 4.4) }, uRdcDesat: { value: 0.3 },
  };
  // warm mist the scenery ring desaturates toward (cover.py HAZE: matches the golden haze it dissolves into)
  const RING_GREY = 'vec3(1.0, 0.86, 0.66)';
  const ringMatCache = new Map();
  function ringMaterial(src) {
    if (ringMatCache.has(src)) return ringMatCache.get(src);
    const m = src.clone();
    m.fog = false;
    const water = !!src.userData.rdcWater;
    const ground = !!src.userData.rdcGround;
    m.onBeforeCompile = (sh) => {
      injectWorldPos(sh);
      if (ground) groundChunk(sh);
      Object.assign(sh.uniforms, ringU, bgU);
      if (water) sh.uniforms.uRdcTime = SHARED.time;
      sh.fragmentShader = `uniform vec2 uRdcBoardC; uniform vec2 uRdcBoardH; uniform vec2 uRdcFade; uniform float uRdcDesat;\n${BG_PARS}\n` + sh.fragmentShader;
      sh.fragmentShader = sh.fragmentShader.replace('#include <tonemapping_fragment>', `
        { vec2 dd = max(abs(vRdcWorld.xz - uRdcBoardC) - uRdcBoardH, 0.0);
          float dOut = length(dd);
          float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(lum) * ${RING_GREY}, clamp(uRdcDesat * (0.35 + 0.65 * smoothstep(0.0, 3.0, dOut)), 0.0, 0.85));
          float fade = smoothstep(uRdcFade.x, uRdcFade.y, dOut);
          if (fade > 0.0) gl_FragColor.rgb = mix(gl_FragColor.rgb, rdcBg(gl_FragCoord.xy), fade);
          gl_FragColor.a *= 1.0 - fade * 0.7; }
        #include <tonemapping_fragment>`);
    };
    m.customProgramCacheKey = () => 'rdc-ring' + (water ? '-w' : '') + (ground ? '-g' : '');
    ringMatCache.set(src, m); own(m);
    return m;
  }

  // Forest tiles on the board: a figure standing in the woods keeps a clearing around its socle, and the trees
  // between it and the camera thin out, as a painter would leave a gap in the canopy. Every fragment above the forest
  // floor (y > CUT_Y) is tested against the figures near a forest (uRdcCut, at most CUT_MAX): within the socle radius,
  // or in a capsule from the figure's chest toward the camera. The core is discarded; the soft edge goes through
  // alpha-to-coverage (the scene is multisampled: no sorting, a smooth fade). Shadows keep the full trees.
  const CUT_MAX = 24, CUT_Y = 0.045;
  const cutU = { uRdcCut: { value: Array.from({ length: CUT_MAX }, () => new THREE.Vector3()) }, uRdcCutN: { value: 0 } };
  const forestMatCache = new Map();
  function forestMaterial(src) {
    if (!src || src.transparent) return src;
    if (forestMatCache.has(src)) return forestMatCache.get(src);
    const m = src.clone();
    const ground = !!src.userData.rdcGround;
    m.onBeforeCompile = (sh) => {
      injectWorldPos(sh);
      if (ground) groundChunk(sh);
      Object.assign(sh.uniforms, cutU);
      sh.fragmentShader = `uniform vec3 uRdcCut[${CUT_MAX}]; uniform int uRdcCutN;\n` + sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float rdcCutA = 1.0;
        if (vRdcWorld.y > ${CUT_Y.toFixed(3)}) {
          float rdcCut = 0.0;
          for (int i = 0; i < ${CUT_MAX}; i++) {
            if (i >= uRdcCutN) break;
            vec3 u = uRdcCut[i];
            if (abs(vRdcWorld.x - u.x) > 2.4 || abs(vRdcWorld.z - u.z) > 2.4) continue;
            float socle = 1.0 - smoothstep(0.32, 0.5, length(vRdcWorld.xz - u.xz));
            vec3 a = u + vec3(0.0, 0.34, 0.0), ab = cameraPosition - a, ap = vRdcWorld - a;
            float t = dot(ap, ab) / dot(ab, ab);
            float ray = t > 0.0 ? 1.0 - smoothstep(0.3, 0.56, length(ap - ab * min(t, 1.0))) : 0.0;
            rdcCut = max(rdcCut, max(socle, ray));
          }
          if (rdcCut > 0.96) discard;
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          rdcCutA = clamp(1.0 - rdcCut + (ign - 0.5) * 0.3, 0.0, 1.0);
        }`).replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n        diffuseColor.a *= rdcCutA;');
    };
    m.alphaToCoverage = true;
    m.customProgramCacheKey = () => 'rdc-forest' + (ground ? '-g' : '');
    forestMatCache.set(src, m); own(m);
    return m;
  }
  /** Feed the forest cut-away with the figures (living and dying) standing within two hexes of a forest, once per frame. */
  function updateForestCut() {
    if (!forestMatCache.size) return;
    const arr = cutU.uRdcCut.value;
    let n = 0;
    const add = (p) => { if (n >= CUT_MAX) return; const h = worldToHex(p.x, p.z); if (st.nearForest?.has(numKey(h.q, h.r))) arr[n++].copy(p); };
    for (const v of st.units.values()) add(v.root.position);
    for (const d of st.dying) add(d.v.root.position);
    cutU.uRdcCutN.value = n;
  }

  // Grass tufts and pebbles scattered on the plains and hills (outside the socle), instanced: the meadow keeps some
  // relief when the camera comes close. Per-instance colour (green, olive, dry) and the ground variation.
  const tuftGeo = own((() => {
    const pos = [], col = [], nrm = [];
    const blades = 7;
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * TAU + hash3(i, 3, 5) * 0.8, r = 0.012 + hash3(i, 7, 1) * 0.03;
      const bx = Math.cos(a) * r, bz = Math.sin(a) * r, w = 0.012, h = 0.055 + hash3(i, 2, 9) * 0.05, lean = 0.025 + hash3(i, 4, 4) * 0.03;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
      col.push(0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 1.1, 1.1, 1.0);
      for (let k = 0; k < 3; k++) nrm.push(Math.cos(a) * 0.35, 0.94, Math.sin(a) * 0.35);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  })());
  const tuftMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
  patchGround(tuftMat);
  const pebbleGeo = own(new THREE.IcosahedronGeometry(0.035, 0).scale(1, 0.55, 0.8));
  const pebbleMat = own(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.30, 0.28, 0.24), roughness: 0.85, metalness: 0, flatShading: true }));
  const TUFT_COLS = [[0.19, 0.33, 0.08], [0.24, 0.36, 0.09], [0.15, 0.27, 0.07], [0.40, 0.38, 0.13], [0.30, 0.40, 0.11]];
  function buildTufts(grp, seed) {
    const high = st.quality === 'high';
    const per = high ? 9 : 4;
    const tufts = [], pebbles = [];
    for (const t of st.tiles.values()) {
      if (t.terrain !== 'plain' && t.terrain !== 'hill') continue;
      const n = per + Math.floor(hash3(t.q, t.r, seed + 61) * 3);
      for (let i = 0; i < n; i++) {
        const a = hash3(t.q * 3 + i, t.r, seed + 71) * TAU, rr = 0.56 + hash3(t.q, t.r * 5 + i, seed + 73) * 0.26;
        const y = t.stand - (t.drop || Math.max(0, t.stand)) * smooth(0.42, 0.93, rr) - 0.012;
        const s = 0.8 + hash3(i, t.q, t.r + seed) * 0.7;
        const m = mk(t.x + Math.cos(a) * rr, y, t.z + Math.sin(a) * rr, hash3(t.r, i, t.q) * TAU, s);
        if (i % 6 === 5) pebbles.push(m); else tufts.push(m);
      }
    }
    const c = new THREE.Color();
    const make = (geo, mat, list, colours) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((m, i) => {
        im.setMatrixAt(i, m);
        if (colours) { const k = colours[Math.floor(hash3(i, 5, seed) * colours.length)]; c.setRGB(k[0], k[1], k[2]); im.setColorAt(i, c); }
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = false; im.receiveShadow = true;
      im.name = `board:deco:${geo === tuftGeo ? 'tufts' : 'pebbles'}`;
      grp.add(im);
    };
    make(tuftGeo, tuftMat, tufts, TUFT_COLS);
    make(pebbleGeo, pebbleMat, pebbles, null);
  }

  // Team ring just outside the socle: lit and tone-mapped like the ground it is painted on (not a flat UI decal);
  // it fades when the camera comes close, where the painted socle rim already tells the sides apart.
  const teamRingGeo = own(new THREE.RingGeometry(0.5, 0.54, 48).rotateX(-Math.PI / 2));
  const contactTex = own((() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(0,0,0,0.75)'); rg.addColorStop(0.55, 'rgba(0,0,0,0.45)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })());
  const contactGeo = own(new THREE.PlaneGeometry(1.45, 1.45).rotateX(-Math.PI / 2));
  const contactMat = own(new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.68, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const ringStd = (c) => own(new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.15, roughness: 0.75, metalness: 0, transparent: true, opacity: 1,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const teamRingMat = { royaume: ringStd('#5d8ae6'), gobelins: ringStd('#dc5f34') };
  const blobGeo = own(new THREE.CircleGeometry(0.32, 24).rotateX(-Math.PI / 2));
  const blobMat = own(new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
  // raven route: dashes on the ground from the bird to its addressee, plus a pulsing ring under the addressee
  const routeTargetGeo = own(new THREE.RingGeometry(0.62, 0.7, 40).rotateX(-Math.PI / 2));

  // selection ring
  const selRing = (() => {
    const g = new THREE.Group(); g.name = 'selection';
    const solid = own(new THREE.RingGeometry(0.6, 0.645, 48).rotateX(-Math.PI / 2));
    const arcs = [];
    for (let i = 0; i < 6; i++) arcs.push(new THREE.RingGeometry(0.68, 0.73, 6, 1, i * TAU / 6 + 0.12, TAU / 6 - 0.24).rotateX(-Math.PI / 2));
    const arcG = own(mergeSimple(arcs));
    const m1 = own(new THREE.MeshBasicMaterial({ color: '#f6d68a', transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    const m2 = own(new THREE.MeshBasicMaterial({ color: '#d4a94f', transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    const a = new THREE.Mesh(solid, m1), b = new THREE.Mesh(arcG, m2);
    a.renderOrder = b.renderOrder = 20;
    g.add(a, b); g.userData.arcs = b; g.userData.mats = [m1, m2];
    g.position.y = 0.03; g.visible = false;
    return g;
  })();
  function mergeSimple(geoms) {
    const pos = [];
    for (const g of geoms) { const ng = g.index ? g.toNonIndexed() : g; pos.push(...ng.attributes.position.array); g.dispose(); if (ng !== g) ng.dispose(); }
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return out;
  }

  // =====================================================================================================
  // Board
  // =====================================================================================================

  function tileAssetKey(terrain, variant) {
    const n = TILE_VARIANTS[terrain];
    if (!n) return 'tile_plain_0';
    const v = Number.isInteger(variant) ? ((variant % n) + n) % n : 0;
    return `tile_${terrain}_${v}`;
  }

  const CASTING_TERRAIN = /^tile_(forest|rocks|ruins|hill)_/;     // flat tiles only receive shadows (cheaper shadow pass)
  const FOREST = /^tile_forest_/;
  function addInstanced(group, key, matrices, { ring = false, low = false } = {}) {
    if (!matrices.length) return;
    const entry = low ? lib.lowDetail(key) : lib.get(key);
    entry.scene.updateMatrixWorld(true);
    const tile = key.startsWith('tile_');
    const pick = (m) => (ring ? ringMaterial(m) : !FOREST.test(key) ? m : forestMaterial(m));
    entry.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material.map(pick) : pick(o.material);
      const im = new THREE.InstancedMesh(o.geometry, mat, matrices.length);
      const tmp = new THREE.Matrix4(), c = new THREE.Color();
      matrices.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, o.matrixWorld)));
      // board tiles: each hex a few % lighter / darker, warmer / cooler, so the same model never repeats exactly
      if (tile && !ring && !(o.material?.transparent)) {
        matrices.forEach((m, i) => {
          const h = hash3(Math.round(m.elements[12] * 4), Math.round(m.elements[14] * 4), 91), h2 = hash3(Math.round(m.elements[14] * 4), Math.round(m.elements[12] * 4), 17);
          const v = 1 + (h - 0.5) * 0.08, w = (h2 - 0.5) * 0.05;
          im.setColorAt(i, c.setRGB(v * (1 + w), v, v * (1 - w)));
        });
      }
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = !ring && o.castShadow && (!key.startsWith('tile_') || CASTING_TERRAIN.test(key));
      im.receiveShadow = true;
      im.name = `${ring ? 'ring' : 'board'}:${key}:${o.name}`;
      group.add(im);
    });
  }

  function placeProp(group, key, x, y, z, yaw, scale = 1, ring = true, bag = null) {
    const entry = lib.get(key);
    const obj = entry.scene.clone(true);
    obj.position.set(x, y, z); obj.rotation.y = yaw; obj.scale.setScalar(scale);
    obj.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = !ring; o.receiveShadow = true;
        const inFlag = underNamed(o, /^Flag/, obj);
        if (Array.isArray(o.material)) o.material = o.material.map((m) => (ring ? ringMaterial(m) : m));
        else if (inFlag) { const m = o.material.clone(); patchFlagMaterial(m, o, Math.random() * 6, ring); if (bag) bag.push(m); else own(m); o.material = m; }
        else if (ring) o.material = ringMaterial(o.material);
      }
    });
    group.add(obj);
    return obj;
  }

  const LAND = (t) => t && t.terrain !== 'water' && t.terrain !== 'ford';
  /**
   * Rotation (multiple of 60°) for a ford tile: its gravel crossing runs corner to corner along local ±X and must
   * touch land at both ends. A Y rotation by k·60° puts those corners at world angles −k·60° and 180° − k·60°;
   * the two neighbours touching a corner lie at corner ± 30°. Off-board neighbours count half.
   */
  function fordRotation(t, seed) {
    let best = 0, bestScore = -1;
    const tie = hash3(t.q, t.r, seed);
    for (let k = 0; k < 6; k++) {
      let score = 0;
      for (const corner of [-k * 60, 180 - k * 60]) {
        for (const off of [-30, 30]) {
          const a = (corner + off) * DEG;
          const { x, z } = hexToWorld(t.q, t.r);
          const n = worldToHex(x + Math.cos(a) * 1.7320508, z + Math.sin(a) * 1.7320508);
          const nt = st.tiles.get(hexKey(n.q, n.r));
          score += nt ? (LAND(nt) ? 1 : 0) : 0.5;
        }
      }
      // tie-break between equally good rotations (k and k+3 always score the same: the tile is symmetric)
      score += (((k + Math.floor(tie * 6)) % 6) / 6) * 0.01;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best * Math.PI / 3;
  }

  const mk = (x, y, z, rot, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(s, s, s));
  const pushTo = (m, k, mat) => { if (!m.has(k)) m.set(k, []); m.get(k).push(mat); };

  /** Build the playable tiles for `map`, then the scenery ring around them. */
  function buildBoard(map) {
    if (st.board) disposeBoard();
    const grp = new THREE.Group(); grp.name = 'board-content';
    st.tiles.clear();
    const seed = (Number(map.seed) >>> 0) || 1;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const byKey = new Map();
    for (const t of map.tiles) {
      const { x, z } = hexToWorld(t.q, t.r);
      const key = tileAssetKey(t.terrain, t.variant);
      const info = lib.get(key).info;
      const drop = Math.max(0, (info.standHeight ?? 0) - (info.rim ?? info.standHeight ?? 0));
      st.tiles.set(hexKey(t.q, t.r), { q: t.q, r: t.r, col: t.col, row: t.row, x, z, terrain: t.terrain, key, stand: info.standHeight ?? 0, drop: drop > 0.06 ? drop : 0 });
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    tileNum.clear();
    for (const t of st.tiles.values()) tileNum.set(numKey(t.q, t.r), t);
    for (const t of st.tiles.values()) {
      const rot = t.terrain === 'ford' ? fordRotation(t, seed) : Math.floor(hash3(t.q, t.r, seed) * 6) * Math.PI / 3;
      pushTo(byKey, t.key, mk(t.x, 0, t.z, rot));
    }
    for (const [k, mats] of byKey) addInstanced(grp, k, mats);
    buildTufts(grp, seed);
    // hexes within two steps of a forest tile (see updateForestCut)
    st.nearForest = new Set();
    for (const t of st.tiles.values()) {
      if (t.terrain !== 'forest') continue;
      for (let dq = -2; dq <= 2; dq++) for (let dr = Math.max(-2, -dq - 2); dr <= Math.min(2, -dq + 2); dr++) st.nearForest.add(numKey(t.q + dq, t.r + dr));
    }

    boardGroup.add(grp);
    st.board = grp;
    const pad = 0.98;
    st.bounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - 0.87, maxZ: maxZ + 0.87 };
    st.bounds.cx = (st.bounds.minX + st.bounds.maxX) / 2; st.bounds.cz = (st.bounds.minZ + st.bounds.maxZ) / 2;
    ringU.uRdcBoardC.value.set(st.bounds.cx, st.bounds.cz);
    bgU.uBgC.value.set(st.bounds.cx, st.bounds.cz);
    ringU.uRdcBoardH.value.set((st.bounds.maxX - st.bounds.minX) / 2, (st.bounds.maxZ - st.bounds.minZ) / 2);
    buildRing();
    updateShadowCamera();
    st.hlDirty = true;
    st.shadowDirty = 2;
  }

  /**
   * Scenery ring around the board (decor, river continuation, the two camps). Nothing on the side facing the
   * camera, so the front tiles show their earth strata and the board reads as a diorama island: row ≥ H in
   * landscape (camera south of the board), col < 0 in portrait (camera on the player's side). Rebuilt when the
   * orientation or the quality changes ('low' drops the outermost, almost fully faded ring).
   */
  function buildRing() {
    disposeRing();
    const map = st.map;
    if (!map || !st.board) return;
    const grp = new THREE.Group(); grp.name = 'ring-content';
    const mats = [];
    const seed = (Number(map.seed) >>> 0) || 1;
    const portrait = (st.azimuth || 0) !== 0;
    const low = st.quality === 'low';
    const W = map.w ?? 14, H = map.h ?? 9, RINGS = low ? 2 : 3;
    ringU.uRdcFade.value.set(0.9, low ? 3.3 : 4.4);
    const tileAt = (col, row) => st.tiles.get(hexKey(offsetToAxial(col, row).q, offsetToAxial(col, row).r));
    const ringByKey = new Map(), ringLowByKey = new Map(), decoByKey = new Map(), decoLowByKey = new Map();
    const mid = Math.floor(H / 2);
    const camps = [
      ...(portrait
        ? [{ col: 1, row: -2, key: 'prop_tent_royaume', yaw: 0.5 }, { col: 2, row: H + 1, key: 'prop_tent_royaume', yaw: 2.2 }]
        : [{ col: -2, row: mid - 1, key: 'prop_tent_royaume', yaw: 0.5 }, { col: -2, row: mid + 1, key: 'prop_tent_royaume', yaw: -0.35 }]),
      { col: W + 1, row: mid - 1, key: 'prop_tent_gobelins', yaw: -0.6 },
      { col: W + 1, row: mid + 1, key: 'prop_tent_gobelins', yaw: 2.4 },
    ];
    const campAt = new Map(camps.map((c) => [`${c.col},${c.row}`, c]));
    const nz = (x, z, s) => (Math.sin(x * 0.31 + s) + Math.sin(z * 0.37 - s * 1.3) + Math.sin((x + z) * 0.19 + s * 0.7)) / 3;
    const rowMax = portrait ? H + Math.min(2, RINGS) : H;          // landscape: nothing in front of the board
    const colMin = portrait ? 0 : -RINGS;                          // portrait: nothing on the player's (near) side
    for (let col = colMin; col < W + RINGS; col++) {
      for (let row = -RINGS; row < rowMax; row++) {
        if (col >= 0 && col < W && row >= 0 && row < H) continue;
        const dc = col < 0 ? -col : col >= W ? col - W + 1 : 0, dr = row < 0 ? -row : row >= H ? row - H + 1 : 0;
        const d = Math.max(dc, dr);
        const { q, r } = offsetToAxial(col, row);
        const { x, z } = hexToWorld(q, r);
        const h = hash3(q, r, seed + 17);
        let terrain = 'plain', variant = Math.floor(hash3(q, r, seed + 3) * 3);
        const camp = campAt.get(`${col},${row}`);
        // river continuation above/below the board
        const edge = row < 0 ? tileAt(Math.min(W - 1, Math.max(0, col)), 0) : row >= H ? tileAt(Math.min(W - 1, Math.max(0, col)), H - 1) : null;
        if (camp) { terrain = 'plain'; variant = 0; }
        else if (edge && dc === 0 && (edge.terrain === 'water' || edge.terrain === 'ford')) terrain = 'water';
        else {
          const f = nz(x, z, seed % 97);
          if (f > 0.42 && h < 0.85) terrain = 'forest';
          else if (h < 0.07) terrain = 'rocks';
          else if (h < 0.17) terrain = 'hill';
        }
        const key = tileAssetKey(terrain, variant);
        const rot = Math.floor(hash3(q, r, seed + 5) * 6) * Math.PI / 3;
        const y = -0.16 - 0.13 * (d - 1);
        // the first ring touches the board: full model unless a decimated GLB exists; further out, low detail
        pushTo(d >= 2 || lib.hasLod?.(key) ? ringLowByKey : ringByKey, key, mk(x, y, z, rot));
        if (camp) {
          placeProp(grp, camp.key, x + (hash3(q, r, 9) - 0.5) * 0.2, y + (lib.get(key).info.standHeight ?? 0), z, camp.yaw, 1.05, true, mats);
          continue;
        }
        if (terrain === 'plain' || (terrain === 'hill' && h > 0.12)) {
          const nDeco = d >= 3 ? 1 : h > 0.55 ? 1 : 0;
          for (let i = 0; i < nDeco; i++) {
            const hh = hash3(q + i * 7, r - i * 3, seed + 31);
            const dk = hh < 0.45 ? 'deco_tree_0' : hh < 0.85 ? 'deco_tree_1' : 'deco_rock_0';
            const a = hash3(q, r, seed + 41 + i) * TAU, rr = 0.25 + hash3(q, r, seed + 43 + i) * 0.4;
            pushTo(lib.hasLod?.(dk) ? decoLowByKey : decoByKey, dk, mk(x + Math.cos(a) * rr, y + (terrain === 'hill' ? 0.12 : 0), z + Math.sin(a) * rr, hash3(q, r, i) * TAU, 0.8 + hash3(r, q, i + 2) * 0.5));
          }
        }
      }
    }
    for (const [k, m] of ringByKey) addInstanced(grp, k, m, { ring: true });
    for (const [k, m] of ringLowByKey) addInstanced(grp, k, m, { ring: true, low: true });
    for (const [k, m] of decoByKey) addInstanced(grp, k, m, { ring: true });
    for (const [k, m] of decoLowByKey) addInstanced(grp, k, m, { ring: true, low: true });
    boardGroup.add(grp);
    st.ring = grp; st.ringMats = mats;
    st.ringKey = `${portrait ? 'p' : 'l'}|${st.quality}`;
    st.shadowDirty = Math.max(st.shadowDirty, 1);
  }

  function disposeRing() {
    if (!st.ring) return;
    st.ring.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    boardGroup.remove(st.ring);
    for (const m of st.ringMats ?? []) m.dispose();
    st.ring = null; st.ringMats = null; st.ringKey = '';
  }

  function disposeBoard() {
    disposeRing();
    if (!st.board) return;
    st.board.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    boardGroup.remove(st.board);
    st.board = null;
  }

  const _fd = new THREE.Vector3();
  function updateShadowCamera() {
    const b = st.bounds, c = new THREE.Vector3(b.cx, 0, b.cz);
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(sunDir(), 40);
    fill.target.position.copy(c);
    fill.position.copy(c).addScaledVector(_fd.copy(FILL_DIR).applyAxisAngle(Y_AXIS, st.azimuth || 0), 40);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(sun.position, sun.target.position, new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const v = new THREE.Vector3();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const x of [b.minX - 0.5, b.maxX + 0.5]) for (const y of [-0.4, 1.6]) for (const z of [b.minZ - 0.5, b.maxZ + 0.5]) {
      v.set(x, y, z).sub(sun.position).applyMatrix4(new THREE.Matrix4().extractRotation(inv));
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
    }
    const cam = sun.shadow.camera;
    cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1; cam.near = Math.max(0.1, -z1 - 1); cam.far = -z0 + 1;
    cam.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
  }

  // numeric-keyed copy of st.tiles for the per-frame lookups (no string building, no garbage)
  const tileNum = new Map();
  const numKey = (q, r) => (q + 1024) * 4096 + (r + 1024);
  const tileOf = (q, r) => tileNum.get(numKey(q, r));
  const standAt = (q, r) => tileOf(q, r)?.stand ?? 0;
  const hexPos = (q, r, dy = 0, out = new THREE.Vector3()) => { const { x, z } = hexToWorld(q, r); return out.set(x, standAt(q, r) + dy, z); };

  // =====================================================================================================
  // Highlights
  // =====================================================================================================

  const hlGeoCache = new Map();
  function hlGeo(kind, drop, small) {
    const k = `${kind}|${drop.toFixed(2)}|${small ? 1 : 0}`;
    if (!hlGeoCache.has(k)) {
      hlGeoCache.set(k, own(kind === 'fill' ? hexBandGeom(small ? [0, 0.26] : [0, 0.3, 0.45, 0.6, 0.75, 0.88], small ? 0 : drop)
        : kind === 'glow' ? hexBandGeom([0.5, 0.62, 0.72, 0.8], drop, [0, 0.18, 0.55, 1])
        : hexBandGeom([0.8, 0.86, 0.915], drop)));
    }
    return hlGeoCache.get(k);
  }
  const hlMeshes = new Map();   // `${kind}|${drop}` -> { fill, line, xray, style }
  function hlMeshFor(kind, drop) {
    const k = `${kind}|${drop.toFixed(2)}`;
    if (hlMeshes.has(k)) return hlMeshes.get(k);
    const s = HL_STYLE[kind] ?? HL_STYLE.hover;
    const base = { transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 };
    const cap = 160;
    let fillMesh = null, line = null, xray = null;
    if (s.fill && s.fillA > 0) {
      const fillM = own(new THREE.MeshBasicMaterial({ ...base, color: s.fill, opacity: s.fillA, vertexColors: !!s.glow }));
      fillMesh = new THREE.InstancedMesh(hlGeo(s.glow ? 'glow' : 'fill', drop, s.small), fillM, cap);
      fillMesh.renderOrder = 4 + s.order; fillMesh.count = 0; fillMesh.frustumCulled = false;
      hlGroup.add(fillMesh);
    }
    if (s.line) {
      const lm = own(new THREE.MeshBasicMaterial({ ...base, color: s.line, opacity: s.lineA }));
      line = new THREE.InstancedMesh(hlGeo('line', drop, false), lm, cap); line.renderOrder = 5 + s.order; line.count = 0; line.frustumCulled = false;
      const xm = own(new THREE.MeshBasicMaterial({ ...base, color: s.line, opacity: s.lineA * 0.28, depthTest: false }));
      xray = new THREE.InstancedMesh(hlGeo('line', drop, false), xm, cap); xray.renderOrder = 30 + s.order; xray.count = 0; xray.frustumCulled = false;
      hlGroup.add(line, xray);
    }
    const rec = { fill: fillMesh, line, xray, style: s, cap, n: 0 };
    hlMeshes.set(k, rec);
    return rec;
  }
  function rebuildHighlights() {
    st.hlDirty = false;
    for (const rec of hlMeshes.values()) { rec.n = 0; for (const im of [rec.fill, rec.line, rec.xray]) if (im) im.count = 0; }
    const list = st.highlights.slice();
    if (st.hoverOutline && st.hover) list.push({ q: st.hover.q, r: st.hover.r, kind: 'hover' });
    const m = new THREE.Matrix4();
    for (const h of list) {
      if (!h || !Number.isFinite(h.q) || !Number.isFinite(h.r)) continue;
      const kind = HL_STYLE[h.kind] ? h.kind : 'hover';
      const t = tileOf(h.q, h.r);
      const drop = t?.drop ?? 0;
      const rec = hlMeshFor(kind, drop);
      if (rec.n >= rec.cap) continue;
      rec.n++;
      const { x, z } = hexToWorld(h.q, h.r);
      m.makeTranslation(x, (t?.stand ?? 0) + 0.032 + rec.style.order * 0.002, z);
      if (rec.fill) rec.fill.setMatrixAt(rec.fill.count++, m);
      if (rec.line) { rec.line.setMatrixAt(rec.line.count++, m); rec.xray.setMatrixAt(rec.xray.count++, m); }
    }
    for (const rec of hlMeshes.values()) {
      for (const im of [rec.fill, rec.line, rec.xray]) { if (!im) continue; im.instanceMatrix.needsUpdate = true; im.visible = im.count > 0; }
    }
  }
  function animateHighlights() {
    for (const rec of hlMeshes.values()) {
      const p = rec.style.pulse;
      if (!p || !rec.n) continue;
      const k = 1 - p + p * (0.5 + 0.5 * Math.sin(st.time * 4.2));
      if (rec.fill) rec.fill.material.opacity = rec.style.fillA * k;
      if (rec.line) { rec.line.material.opacity = rec.style.lineA * (0.7 + 0.3 * k); }
    }
  }

  // =====================================================================================================
  // Units
  // =====================================================================================================

  /**
   * Unit materials stay opaque. Hit flash + death dissolve: the figure crumbles top-down into blobs of a smooth 3D
   * value noise taken in the figure's own frame (uRdcRootInv = inverse world matrix of the model, updated while it
   * dies), so the pattern sticks to the miniature while it tips over and sinks; a thin ember edge glows (and blooms).
   */
  function patchUnitMaterial(mat, u) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.uniforms.uRdcFlash = u.flash; sh.uniforms.uRdcFlashColor = u.flashColor;
      sh.uniforms.uRdcDissolve = u.dissolve; sh.uniforms.uRdcRootInv = u.rootInv; sh.uniforms.uRdcH = u.h;
      sh.vertexShader = 'uniform mat4 uRdcRootInv;\nvarying vec3 vRdcObj;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vRdcObj = (uRdcRootInv * modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = `uniform float uRdcFlash; uniform vec3 uRdcFlashColor; uniform float uRdcDissolve; uniform float uRdcH;
        varying vec3 vRdcObj;
        float rdcHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float rdcNoise(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(rdcHash(i), rdcHash(i + vec3(1, 0, 0)), f.x), mix(rdcHash(i + vec3(0, 1, 0)), rdcHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(rdcHash(i + vec3(0, 0, 1)), rdcHash(i + vec3(1, 0, 1)), f.x), mix(rdcHash(i + vec3(0, 1, 1)), rdcHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }\n` + sh.fragmentShader.replace('#include <tonemapping_fragment>', `
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uRdcFlashColor, uRdcFlash);
        if (uRdcDissolve > 0.0) {
          float n = rdcNoise(vRdcObj * 9.0) * 0.65 + rdcNoise(vRdcObj * 23.0) * 0.35;
          n = mix(n, 1.0 - clamp(vRdcObj.y / max(0.05, uRdcH), 0.0, 1.0), 0.35);
          if (n < uRdcDissolve) discard;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.42, 0.1) * 1.3, smoothstep(uRdcDissolve + 0.07, uRdcDissolve, n));
        }
        #include <tonemapping_fragment>`);
    };
    const prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.customProgramCacheKey = () => 'rdc-unit2|' + (prevKey ? prevKey() : '');
  }
  /** Vertex wave for a flag mesh: thin axis = displacement, one-sided axis = distance from the mast. */
  function patchFlagMaterial(mat, mesh, phase, ring = false) {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox, size = new THREE.Vector3(), ext = [];
    bb.getSize(size);
    const sz = [size.x, size.y, size.z];
    const thin = sz.indexOf(Math.min(...sz));
    let best = -1, bestScore = -1;
    for (let i = 0; i < 3; i++) {
      if (i === thin) continue;
      const mn = bb.min.getComponent(i), mx = bb.max.getComponent(i);
      const oneSided = Math.max(Math.abs(mn), Math.abs(mx)) / Math.max(1e-4, mx - mn);
      const score = oneSided * 10 + (mx - mn);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    ext.push(thin, best);
    const len = Math.max(0.05, Math.max(Math.abs(bb.min.getComponent(best)), Math.abs(bb.max.getComponent(best))));
    mat.defines = { ...(mat.defines || {}), RDC_FN: thin, RDC_FL: best };
    const uPhase = { value: phase }, uAmp = { value: 0.16 / Math.max(0.6, len / 0.3) }, uK = { value: 3.3 / len };
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.uniforms.uRdcTime = SHARED.time; sh.uniforms.uRdcPhase = uPhase; sh.uniforms.uRdcAmp = uAmp; sh.uniforms.uRdcK = uK;
      sh.vertexShader = 'uniform float uRdcTime; uniform float uRdcPhase; uniform float uRdcAmp; uniform float uRdcK;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      { float rdcL = abs(position[RDC_FL]);
        float rdcW = sin(rdcL * uRdcK * 3.2 - uRdcTime * 4.4 + uRdcPhase) * 0.65 + sin(rdcL * uRdcK * 5.5 - uRdcTime * 6.9 + uRdcPhase * 1.7) * 0.3;
        transformed[RDC_FN] += rdcW * rdcL * uRdcAmp * 1.6; }`);
      if (ring) {
        injectWorldPos(sh);
        Object.assign(sh.uniforms, ringU, bgU);
        sh.fragmentShader = `uniform vec2 uRdcBoardC; uniform vec2 uRdcBoardH; uniform vec2 uRdcFade; uniform float uRdcDesat;\n${BG_PARS}\n` + sh.fragmentShader.replace('#include <tonemapping_fragment>', `
        { vec2 dd = max(abs(vRdcWorld.xz - uRdcBoardC) - uRdcBoardH, 0.0); float dOut = length(dd);
          float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(lum) * ${RING_GREY}, clamp(uRdcDesat * (0.35 + 0.65 * smoothstep(0.0, 3.0, dOut)), 0.0, 0.85));
          float fade = smoothstep(uRdcFade.x, uRdcFade.y, dOut);
          if (fade > 0.0) gl_FragColor.rgb = mix(gl_FragColor.rgb * 0.94, rdcBg(gl_FragCoord.xy), fade); }
        #include <tonemapping_fragment>`);
      }
    };
    const prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.customProgramCacheKey = () => `rdc-flag${thin}${best}${ring ? 'r' : ''}|` + (prevKey ? prevKey() : '');
    if (ring) mat.fog = false;
  }

  function createUnitView(u) {
    const type = u.type;
    const def = UNITS[type];
    const faction = u.faction ?? def?.faction ?? (u.side === 'enemy' ? 'gobelins' : 'royaume');
    const entry = lib.get(def?.model ?? type);
    const root = new THREE.Group(); root.name = `unit:${u.id}`;
    const motion = new THREE.Group(); const tilt = new THREE.Group(); const yawNode = new THREE.Group(); const bob = new THREE.Group();
    root.add(motion); motion.add(tilt); tilt.add(yawNode); yawNode.add(bob);
    const model = entry.scene.clone(true);
    model.scale.multiplyScalar(UNIT_SCALE);
    bob.add(model);
    const uu = { flash: { value: 0 }, flashColor: { value: new THREE.Color(1.0, 0.86, 0.74) }, dissolve: { value: 0 }, rootInv: { value: new THREE.Matrix4() }, h: { value: entry.info.height ?? 0.6 } };
    const mats = [], matMap = new Map(), glows = [], flags = [];
    model.traverse((o) => {
      if (/^Flag/.test(o.name) && !underNamed(o.parent, /^Flag/, model)) flags.push({ node: o, q0: o.quaternion.clone(), ph: Math.random() * TAU });
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const flagNode = underNamed(o, /^Flag/, model), glowNode = underNamed(o, /^Glow/, model);
      const cl = (m) => {
        if (!m) return m;
        if (flagNode) { const c = m.clone(); patchFlagMaterial(c, o, Math.random() * TAU); patchUnitMaterial(c, uu); mats.push(c); return c; }
        if (!matMap.has(m)) { const c = m.clone(); patchUnitMaterial(c, uu); matMap.set(m, c); mats.push(c); }
        return matMap.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(cl) : cl(o.material);
      if (glowNode) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m || !('emissiveIntensity' in m) || glows.some((gg) => gg.m === m)) continue;
          if (m.emissive && m.emissive.r + m.emissive.g + m.emissive.b < 0.01) { m.emissive.copy(m.color ?? new THREE.Color(1, 1, 1)); m.emissiveIntensity = 1.6; }
          glows.push({ m, base: m.emissiveIntensity || 1.6, ph: Math.random() * TAU });
        }
      }
    });
    const ring = new THREE.Mesh(teamRingGeo, teamRingMat[faction] ?? teamRingMat.royaume);
    ring.position.y = 0.022; ring.renderOrder = 3;
    const contact = new THREE.Mesh(contactGeo, contactMat);
    contact.position.y = 0.012; contact.renderOrder = 2;
    root.add(contact, ring);
    // HP plate
    const cvs = document.createElement('canvas'); cvs.width = PLATE_W; cvs.height = PLATE_H;
    const tex = new THREE.CanvasTexture(cvs); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const plateMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false, fog: false });
    const plate = new THREE.Sprite(plateMat);
    plate.center.set(0.5, 0); plate.renderOrder = 60;
    const height = (entry.info.height ?? 0.6) * UNIT_SCALE;
    plate.position.y = height + 0.1;
    root.add(plate);
    unitGroup.add(root);
    const v = {
      id: u.id, type, faction, side: u.side, data: u, root, motion, tilt, yawNode, bob, model, ring, plate, plateCtx: cvs.getContext('2d'), plateTex: tex, plateKey: '',
      mats, glows, flags, uu, height, q: u.q, r: u.r, yaw: 0, targetYaw: 0, phase: Math.random() * TAU,
      hp: u.hp, maxHp: u.maxHp, flashT: 9, glowBoost: 0, offset: new THREE.Vector3(), shake: new THREE.Vector3(), hop: 0,
      ward: null, wispT: 0, status: {}, commander: def?.cls === 'commander', plateHpKey: '', plateFlashT: 99, plateOp: 0.5,
    };
    return v;
  }

  function disposeUnitView(v) {
    v.root.removeFromParent();
    for (const m of v.mats) m.dispose();
    v.plateTex.dispose(); v.plate.material.dispose();
    if (v.ward) { v.ward.material.dispose(); }
    if (selRing.parent === v.root) { v.root.remove(selRing); selRing.visible = false; }
  }

  function placeUnit(v, q, r) {
    v.q = q; v.r = r;
    hexPos(q, r, 0, v.root.position);
  }

  function refreshPlate(v) {
    const s = v.status || {};
    const hpKey = `${v.hp}|${v.maxHp}`;
    const key = `${hpKey}|${s.ward > 0 ? 1 : 0}|${s.hex > 0 ? 1 : 0}|${s.holding ? 1 : 0}`;
    if (key === v.plateKey) return;
    // a change of HP (hit, heal) lights the plate up for a while (see updatePlates)
    if (v.plateHpKey && hpKey !== v.plateHpKey) v.plateFlashT = 0;
    v.plateHpKey = hpKey;
    v.plateKey = key;
    drawPlate(v.plateCtx, { hp: Math.max(0, v.hp ?? 0), maxHp: Math.max(1, v.maxHp ?? 1), faction: v.faction, ward: s.ward > 0, hex: s.hex > 0, holding: !!s.holding, commander: v.commander });
    v.plateTex.needsUpdate = true;
  }

  function setUnitStatus(v, status) {
    v.status = { ...(status || {}) };
    const wantWard = v.status.ward > 0;
    if (wantWard && !v.ward) {
      v.ward = fx.makeDome('#8fc8ff');
      v.ward.material.uniforms.uOpacity.value = 0.32;
      v.ward.scale.setScalar(0.95);
      v.root.add(v.ward);
    } else if (!wantWard && v.ward) { v.ward.removeFromParent(); v.ward.material.dispose(); v.ward = null; }
    refreshPlate(v);
  }

  const defaultFacing = (side) => (side === 'enemy' ? 4 : 0);

  function syncUnits(list, { instant = true } = {}) {
    st.shadowDirty = 2;
    const seen = new Set();
    for (const u of list || []) {
      if (!u || u.id == null || u.alive === false || !(u.hp > 0 || u.hp === undefined)) continue;
      seen.add(u.id);
      let v = st.units.get(u.id);
      if (v && v.type !== u.type) { disposeUnitView(v); st.units.delete(u.id); v = null; }
      const fresh = !v;
      if (!v) { v = createUnitView(u); st.units.set(u.id, v); }
      v.data = u;
      placeUnit(v, u.q, u.r);
      v.offset.set(0, 0, 0); v.shake.set(0, 0, 0); v.hop = 0;
      v.targetYaw = facingToYaw(Number.isInteger(u.facing) ? ((u.facing % 6) + 6) % 6 : defaultFacing(u.side));
      if (fresh || instant === 'all') v.yaw = v.targetYaw;
      v.hp = u.hp ?? v.hp; v.maxHp = u.maxHp ?? UNITS[u.type]?.hp ?? v.maxHp;
      setUnitStatus(v, u.status);
    }
    for (const [id, v] of st.units) {
      if (seen.has(id)) continue;
      st.units.delete(id);
      startDying(v, null, true);
    }
    if (st.selected && !st.units.has(st.selected)) setSelected(null);
  }

  function startDying(v, dir, quick = false) {
    if (selRing.parent === v.root) { v.root.remove(selRing); selRing.visible = false; }
    v.plate.visible = false;
    if (v.ward) { v.ward.removeFromParent(); v.ward.material.dispose(); v.ward = null; }
    const d = dir ? dir.clone().setY(0) : new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5);
    if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
    d.normalize();
    st.dying.push({ v, t: 0, dir: d, axis: new THREE.Vector3(d.z, 0, -d.x), quick, dusted: false, shadowOff: false, y0: v.root.position.y });
    if (!quick) addMark(v.root.position);
  }

  // Where a figure fell, a patch of trampled, scorched earth stays for the rest of the battle (cleared by setMap).
  const markTex = own((() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * TAU, r = i ? 12 + hash3(i, 3, 7) * 8 : 0, x = 32 + Math.cos(a) * r, y = 32 + Math.sin(a) * r, rad = i ? 9 + hash3(i, 5, 1) * 7 : 22;
      const rg = g.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })());
  const markGeo = own(new THREE.CircleGeometry(0.5, 20).rotateX(-Math.PI / 2));
  const markMat = own(new THREE.MeshStandardMaterial({ color: '#2b1e14', map: markTex, transparent: true, opacity: 0.85, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  function addMark(pos) {
    if (markGroup.children.length >= 40) markGroup.remove(markGroup.children[0]);
    const m = new THREE.Mesh(markGeo, markMat);
    m.position.set(pos.x, pos.y + 0.006, pos.z); m.rotation.y = Math.random() * TAU; m.scale.setScalar(0.85 + Math.random() * 0.3);
    m.renderOrder = 1; m.receiveShadow = true;
    markGroup.add(m);
  }

  function updateDying(dt, dtReal) {
    let w = 0;
    for (const dd of st.dying) {
      dd.t += dt;
      const v = dd.v;
      v.flashT += dtReal;
      v.uu.flash.value = v.flashT < 0.22 ? Math.pow(1 - v.flashT / 0.22, 2) * (st.reduced ? 0.12 : 0.22) : 0;
      const tipT = dd.quick || st.reduced ? 0 : 0.3, fadeT = dd.quick ? 0.4 : st.reduced ? 0.5 : 0.6;
      if (tipT > 0) {
        const k = clamp01(dd.t / tipT);
        // the miniature keels over a little (its socle never stands up like a disc), then crumbles and sinks
        v.tilt.quaternion.setFromAxisAngle(dd.axis, Math.pow(k, 1.7) * 0.5);
        v.motion.position.copy(dd.dir).multiplyScalar(0.08 * k);
        if (k >= 1 && !dd.dusted) { dd.dusted = true; fx.dust(v.root.position.clone().addScaledVector(dd.dir, 0.2), { count: 14, radius: 0.45, size: 0.26 }); }
      }
      const k2 = clamp01((dd.t - tipT) / fadeT);
      v.root.position.y = dd.y0 - 0.22 * easeInOut(k2);
      // dissolve (opaque materials, no sorting artefacts): the noise lives in the figure's frame
      v.model.updateWorldMatrix(true, false);
      v.uu.rootInv.value.copy(v.model.matrixWorld).invert();
      v.uu.dissolve.value = k2 > 0 ? 0.02 + k2 * 1.03 : 0;
      v.ring.visible = k2 < 0.6;
      if (k2 > 0.5 && !dd.shadowOff) { dd.shadowOff = true; v.model.traverse((o) => { if (o.isMesh) o.castShadow = false; }); st.shadowDirty = Math.max(st.shadowDirty, 1); }
      if (dd.t >= tipT + fadeT) { disposeUnitView(v); continue; }
      st.dying[w++] = dd;
    }
    st.dying.length = w;
  }

  function updateUnits(dt, dtReal) {
    const turnK = 1 - Math.exp(-dtReal * 11);
    for (const v of st.units.values()) {
      const dYaw = angleDiff(v.yaw, v.targetYaw);
      if (Math.abs(dYaw) > 0.002) st.shadowDirty = Math.max(st.shadowDirty, 1);
      v.yaw += dYaw * turnK;
      v.yawNode.rotation.y = v.yaw;
      v.motion.position.set(v.offset.x + v.shake.x, v.offset.y + v.shake.y + v.hop, v.offset.z + v.shake.z);
      const br = st.reduced ? 0 : Math.sin(st.time * 1.7 + v.phase);
      v.bob.position.y = br * 0.006; v.bob.scale.set(1 - br * 0.004, 1 + br * 0.01, 1 - br * 0.004);
      // flash
      v.flashT += dtReal;          // real time: a pause right after a hit does not freeze the figure pale
      v.uu.flash.value = v.flashT < 0.22 ? Math.pow(1 - v.flashT / 0.22, 2) * (st.reduced ? 0.12 : 0.22) : 0;
      // glow pulse
      v.glowBoost = Math.max(0, v.glowBoost - dt * 2.5);
      for (const g of v.glows) g.m.emissiveIntensity = g.base * (0.72 + 0.32 * (0.5 + 0.5 * Math.sin(st.time * 2.3 + g.ph)) + v.glowBoost * 1.6);
      // flags sway
      for (const f of v.flags) { f.node.quaternion.copy(f.q0); f.node.rotateY(Math.sin(st.time * 1.9 + f.ph) * 0.12); }
      // statuses
      if (v.ward) { v.ward.material.uniforms.uTime.value = st.time; v.ward.material.uniforms.uOpacity.value = 0.28 + 0.06 * Math.sin(st.time * 2.4 + v.phase); }
      if (v.status.hex > 0 && dt > 0) {
        v.wispT -= dt;
        if (v.wispT <= 0) { v.wispT = st.reduced ? 0.45 : 0.16; fx.wisp(v.root.position, '#b47cff', 0.34); }
      }
    }
    if (selRing.visible) {
      selRing.userData.arcs.rotation.y = st.time * 0.6;
      const p = 0.75 + 0.25 * Math.sin(st.time * 3.4);
      selRing.userData.mats[0].opacity = 0.75 + 0.25 * p;
      selRing.scale.setScalar(1 + 0.025 * Math.sin(st.time * 3.4));
    }
  }

  /**
   * HP plates stay smaller than the miniatures and quiet: a plate at full HP without status is faded; it lights
   * up when the unit is hovered, selected, wounded, carries a status, or just lost / regained HP. On a phone during
   * a battle, quiet plates are hidden altogether (a plate with a status icon never is).
   */
  function updatePlates(dtReal) {
    const fovK = 2 * Math.tan(camera.fov * DEG / 2) / Math.max(1, st.height);
    const dist = camera.position.distanceTo(controls.target);
    // Plate width follows the on-screen size of a hex (flat-to-flat = √3 world units), so plates of neighbouring
    // units do not overlap, while staying readable when zoomed out.
    const hexPx = 1.732 / Math.max(1e-6, dist * fovK);
    const wCss = THREE.MathUtils.clamp(hexPx * 0.55, PLATE_CSS.min, PLATE_CSS.max);
    const sx = wCss * fovK, sy = sx * (PLATE_H / PLATE_W);
    const show = st.platesOn !== false;
    const hideQuiet = st.phone && st.live;
    const ease = 1 - Math.exp(-dtReal * 8);
    for (const v of st.units.values()) {
      v.plate.scale.set(sx, sy, 1);
      v.plateFlashT += dtReal;
      const s = v.status || {};
      const statusOn = s.ward > 0 || s.hex > 0 || !!s.holding;
      const focus = v.id === st.hoverUnit || v.id === st.selected || v.plateFlashT < 2.5;
      const wounded = (v.hp ?? 0) < (v.maxHp ?? 0);
      const target = focus ? 1 : statusOn || wounded ? 0.9 : 0.45;
      v.plateOp += (target - v.plateOp) * ease;
      v.plate.material.opacity = v.plateOp;
      v.plate.visible = show && !(hideQuiet && !focus && !statusOn && !wounded);
    }
    // team rings: discreet (half strength) from afar, fainter up close where the painted socle rim already shows the side
    const ringA = 0.22 + 0.3 * smooth(0.6, 1.0, dist / Math.max(1, st.D0));
    teamRingMat.royaume.opacity = teamRingMat.gobelins.opacity = ringA;
  }

  function setSelected(id) {
    st.selected = id ?? null;
    selRing.removeFromParent();
    const v = id != null ? st.units.get(id) : null;
    if (v) { v.root.add(selRing); selRing.visible = true; } else selRing.visible = false;
  }

  // =====================================================================================================
  // Ravens
  // =====================================================================================================

  function createRavenView(r) {
    const entry = lib.get('prop_raven');
    const root = new THREE.Group(); root.name = `raven:${r.id}`;
    const bank = new THREE.Group(); root.add(bank);
    const model = entry.scene.clone(true);
    model.scale.setScalar(RAVEN_SCALE);
    bank.add(model);
    const wings = [];
    model.traverse((o) => {
      // no real shadow: with the sun ~16° high the bird's shadow would fall ~5 hexes away from it, and would force the
      // shadow map to refresh for as long as a raven hovers; the blob right under it reads better
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
      if (/^Wing_?[LR]/i.test(o.name) && !underNamed(o.parent, /^Wing/i, model)) {
        const box = new THREE.Box3().setFromObject(o);
        const c = box.getCenter(new THREE.Vector3());
        model.updateMatrixWorld(true);
        const localC = model.worldToLocal(c.clone());
        const sign = /_?L/i.test(o.name.replace(/^Wing/i, '')) ? 1 : -1;
        wings.push({ node: o, q0: o.quaternion.clone(), sign: Math.abs(localC.x) > 1e-3 ? Math.sign(localC.x) : sign });
      }
    });
    const blob = new THREE.Mesh(blobGeo, blobMat);
    blob.renderOrder = 2;
    const route = createRoute(r.side);
    ravenGroup.add(root, blob, route.dashes, route.ring);
    const v = { id: r.id, side: r.side, unitId: r.unitId ?? null, root, bank, model, wings, blob, route, yaw: 0, prevYaw: 0, bankA: 0, ph: Math.random() * TAU, flap: 1, x: r.x, z: r.z, y: RAVEN_ALT, anim: null };
    root.position.set(r.x, RAVEN_ALT, r.z);
    return v;
  }
  function disposeRavenView(v) {
    v.root.removeFromParent(); v.blob.removeFromParent();
    v.route.dashes.removeFromParent(); v.route.ring.removeFromParent(); v.route.dashes.geometry.dispose();
  }
  /** Ground height under a world point (-0.12 off the board); allocation-free hex rounding (same as hex.js). */
  function ravenGroundY(x, z) {
    const fq = (2 / 3) * x, fr = (-1 / 3) * x + (1.7320508075688772 / 3) * z, fs = -fq - fr;
    let q = Math.round(fq), r = Math.round(fr);
    const s3 = Math.round(fs), dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s3 - fs);
    if (dq > dr && dq > ds) q = -r - s3; else if (dr > ds) r = -q - s3;
    const t = tileNum.get(numKey(q, r));
    return t ? t.stand : -0.12;
  }

  // ---- raven route: dashes on the ground from the bird to its addressee (scrolling toward it), in the side's colour,
  // red where the path passes within interception range of an enemy « Œil de faucon » shooter; a ring pulses under
  // the addressee. Links the bird to the HUD chip « Corbeau → … » without repeating its text.
  const ROUTE_MAX = 48, DASH = 0.3, PERIOD = 0.52, DASH_W = 0.065;
  const routeMat = own(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  const routeRingMat = {
    player: own(new THREE.MeshBasicMaterial({ color: SIDE_UI.player, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })),
    enemy: own(new THREE.MeshBasicMaterial({ color: SIDE_UI.enemy, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })),
  };
  const DANGER = new THREE.Color('#ff3f2e');
  function createRoute(side) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ROUTE_MAX * 12), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ROUTE_MAX * 12), 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < ROUTE_MAX; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);   // facing up
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    const dashes = new THREE.Mesh(g, routeMat);
    dashes.frustumCulled = false; dashes.renderOrder = 2; dashes.visible = false;
    const ring = new THREE.Mesh(routeTargetGeo, routeRingMat[side === 'enemy' ? 'enemy' : 'player']);
    ring.renderOrder = 3; ring.visible = false;
    return { dashes, ring, color: new THREE.Color(SIDE_UI[side === 'enemy' ? 'enemy' : 'player']) };
  }
  function shootersAgainst(side) {
    const out = [];
    for (const u of st.units.values()) {
      if (u.side === side) continue;
      const traits = u.data?.traits ?? UNITS[u.type]?.traits ?? [];
      if (traits.includes('antiRaven')) out.push(u.root.position);
    }
    return out;
  }
  function updateRoute(v, shooters) {
    const R = v.route;
    const tu = v.unitId != null ? st.units.get(v.unitId) : null;
    if (!tu || st.platesOn === false) { R.dashes.visible = false; R.ring.visible = false; return; }
    const ax = v.root.position.x, az = v.root.position.z, bx = tu.root.position.x, bz = tu.root.position.z;
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    R.ring.visible = true;
    R.ring.position.set(bx, tu.root.position.y + 0.035, bz);
    R.ring.scale.setScalar(1 + 0.07 * Math.sin(st.time * 4.2 + v.ph));
    const end = len - 0.74;
    if (end < 0.2) { R.dashes.visible = false; return; }
    const ux = dx / len, uz = dz / len, px = -uz * DASH_W, pz = ux * DASH_W;
    const pos = R.dashes.geometry.attributes.position, col = R.dashes.geometry.attributes.color;
    const P = pos.array, C = col.array;
    const scroll = st.reduced ? 0 : (st.time * 0.9) % PERIOD;
    let n = 0;
    for (let s = scroll - PERIOD; s < end && n < ROUTE_MAX; s += PERIOD) {
      const s0 = Math.max(0.15, s), s1 = Math.min(end, s + DASH);
      if (s1 - s0 < 0.04) continue;
      const mx = ax + ux * (s0 + s1) / 2, mz = az + uz * (s0 + s1) / 2;
      const y = ravenGroundY(mx, mz) + 0.05;
      let danger = false;
      for (const p of shooters) if (Math.hypot(p.x - mx, p.z - mz) / 1.7320508 <= RAVEN_INTERCEPT_RANGE + 0.05) { danger = true; break; }
      const c = danger ? DANGER : R.color;
      const x0 = ax + ux * s0, z0 = az + uz * s0, x1 = ax + ux * s1, z1 = az + uz * s1;
      const o = n * 12;
      P[o] = x0 - px; P[o + 1] = y; P[o + 2] = z0 - pz;
      P[o + 3] = x0 + px; P[o + 4] = y; P[o + 5] = z0 + pz;
      P[o + 6] = x1 - px; P[o + 7] = y; P[o + 8] = z1 - pz;
      P[o + 9] = x1 + px; P[o + 10] = y; P[o + 11] = z1 + pz;
      for (let k = 0; k < 4; k++) { C[o + k * 3] = c.r; C[o + k * 3 + 1] = c.g; C[o + k * 3 + 2] = c.b; }
      n++;
    }
    R.dashes.geometry.setDrawRange(0, n * 6);
    pos.needsUpdate = true; col.needsUpdate = true;
    R.dashes.visible = n > 0;
  }
  function hideRoute(v) { v.route.dashes.visible = false; v.route.ring.visible = false; }
  /** Keep a minimum on-screen wingspan (phones see the board from twice as far). */
  function ravenScale(v) {
    const fovK = 2 * Math.tan(camera.fov * DEG / 2) / Math.max(1, st.height);
    const d = camera.position.distanceTo(v.root.position);
    v.model.scale.setScalar(THREE.MathUtils.clamp((RAVEN_MIN_PX * fovK * d) / RAVEN_SPAN, RAVEN_SCALE, 5));
  }

  function animateRaven(v, dtReal, flapRate = 1) {
    const dyaw = angleDiff(v.prevYaw, v.yaw);
    v.prevYaw = v.yaw;
    v.bankA = lerp(v.bankA, THREE.MathUtils.clamp(-dyaw * 9, -0.65, 0.65), 1 - Math.exp(-dtReal * 6));
    v.root.rotation.set(0, v.yaw, 0);
    v.bank.rotation.z = v.bankA;
    const w = Math.sin(st.time * 13 * flapRate + v.ph);
    for (const wg of v.wings) {
      wg.node.quaternion.copy(wg.q0);
      tmpQ.setFromAxisAngle(Z_AXIS, wg.sign * (w * 0.7 + 0.1));
      wg.node.quaternion.premultiply(tmpQ);
    }
    v.bank.position.y = Math.sin(st.time * 13 * flapRate + v.ph - 1.2) * 0.03;
    const gy = ravenGroundY(v.root.position.x, v.root.position.z);
    v.blob.position.set(v.root.position.x, gy + 0.03, v.root.position.z);
    const hgt = Math.max(0.2, v.root.position.y - gy);
    v.blob.scale.setScalar(THREE.MathUtils.clamp(1.6 - hgt * 0.25, 0.7, 1.4));
    ravenScale(v);
  }
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const tmpQ = new THREE.Quaternion();

  function syncRavens(list) {
    const seen = new Set();
    for (const r of list || []) {
      if (!r || r.alive === false || r.delivered) continue;
      seen.add(r.id);
      let v = st.ravens.get(r.id);
      if (!v) { v = createRavenView(r); st.ravens.set(r.id, v); }
      if (r.unitId != null) v.unitId = r.unitId;
      v.anim = null;
      v.root.position.set(r.x, RAVEN_ALT, r.z);
      v.root.scale.setScalar(1);
      v.x = r.x; v.z = r.z;
    }
    for (const [id, v] of st.ravens) if (!seen.has(id)) { st.ravens.delete(id); disposeRavenView(v); }
  }

  function updateRavens(dt, dtReal) {
    const shooters = { player: null, enemy: null };
    for (const v of st.ravens.values()) {
      if (!v.anim) {
        // idle hover: slow circle around its position (amplitude ramps in to avoid a jump after a flight)
        v.idleK = Math.min(1, (v.idleK ?? 0) + dtReal * 1.5);
        const a = st.time * 0.9 + v.ph, rad = 0.18 * v.idleK;
        v.root.position.set(v.x + Math.cos(a) * rad, RAVEN_ALT + Math.sin(st.time * 1.3 + v.ph) * 0.05 * v.idleK, v.z + Math.sin(a) * rad);
        if (v.idleK > 0.3) v.yaw = Math.atan2(-Math.sin(a), Math.cos(a));
      } else v.idleK = 0;
      animateRaven(v, dtReal, v.anim ? 1 : 0.85);
      const sk = v.side === 'enemy' ? 'enemy' : 'player';
      shooters[sk] ??= shootersAgainst(v.side);
      updateRoute(v, shooters[sk]);
    }
    let w = 0;
    for (const g of st.ghosts) {
      g.t += dt;
      const v = g.v;
      let alive = true;
      if (g.mode === 'shot') {
        g.vel.y -= 9 * dt;
        v.root.position.addScaledVector(g.vel, dt);
        v.model.rotation.x += dt * 9; v.model.rotation.z += dt * 6;
        const gy = ravenGroundY(v.root.position.x, v.root.position.z);
        if (v.root.position.y <= gy + 0.05) {
          v.root.position.y = gy + 0.05;
          if (!g.landed) { g.landed = true; fx.dust(v.root.position, { count: 6, radius: 0.2, size: 0.15 }); fx.feathers(v.root.position, { count: 4 }); }
          g.vel.set(0, 0, 0);
          g.fadeT = (g.fadeT ?? 0) + dt;
          v.root.scale.setScalar(Math.max(0.001, 1 - g.fadeT / 0.4));
          if (g.fadeT > 0.4) alive = false;
        }
        v.blob.position.set(v.root.position.x, gy + 0.03, v.root.position.z);
        if (g.t > 2.5) alive = false;
      } else if (g.mode === 'deliver') {
        const u = st.units.get(g.unitId);
        if (u) g.center.copy(u.root.position);
        const total = st.reduced ? 0.8 : 1.3;
        const k = g.t / total;
        const a = g.a0 + g.t * 4.2;
        const rad = 0.88 * (1 - 0.25 * k);
        const y = lerp(RAVEN_ALT, g.center.y + 1.55, Math.min(1, g.t * 3)) + (k > 0.75 ? (k - 0.75) * 6 : 0);
        v.root.position.set(g.center.x + Math.cos(a) * rad, y, g.center.z + Math.sin(a) * rad);
        v.yaw = Math.atan2(-Math.sin(a), Math.cos(a));
        if (k > 0.75) v.root.scale.setScalar(Math.max(0.001, 1 - (k - 0.75) / 0.25));
        animateRaven(v, dtReal, 1.1);
        if (k >= 1) alive = false;
      } else { // lost: climb away
        v.root.position.y += dt * 1.6;
        v.root.position.x += Math.sin(v.yaw) * dt * 2; v.root.position.z += Math.cos(v.yaw) * dt * 2;
        v.root.scale.setScalar(Math.max(0.001, 1 - g.t / 0.9));
        animateRaven(v, dtReal, 1.2);
        if (g.t > 0.9) alive = false;
      }
      if (!alive) { disposeRavenView(v); continue; }
      st.ghosts[w++] = g;
    }
    st.ghosts.length = w;
  }

  function ghostRaven(id, mode, extra = {}) {
    const v = st.ravens.get(id);
    if (!v) return;
    st.ravens.delete(id);
    v.anim = null;
    hideRoute(v);
    const g = { v, mode, t: 0, ...extra };
    if (mode === 'shot') {
      g.vel = new THREE.Vector3(Math.sin(v.yaw) * 0.8, 0.8, Math.cos(v.yaw) * 0.8);
      fx.feathers(v.root.position, { count: 14 });
      fx.sparks(v.root.position, { count: 6, color: '#ffffff', speed: 1.5 });
    }
    if (mode === 'deliver') {
      g.center = new THREE.Vector3(extra.cx ?? v.root.position.x, v.root.position.y - 1.55, extra.cz ?? v.root.position.z); g.a0 = Math.atan2(v.root.position.z - (extra.cz ?? v.root.position.z), v.root.position.x - (extra.cx ?? v.root.position.x));
    }
    st.ghosts.push(g);
  }

  // =====================================================================================================
  // Camera & controls
  // =====================================================================================================

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.screenSpacePanning = false;
  controls.minPolarAngle = 35 * DEG;
  controls.maxPolarAngle = 64 * DEG;
  controls.minAzimuthAngle = -35 * DEG;
  controls.maxAzimuthAngle = 35 * DEG;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 1.0;
  controls.zoomToCursor = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.addEventListener('start', () => { st.userMoved = true; st.tween = null; st.orbit = null; notifyFraming(); });

  const boardCentre = (out = new THREE.Vector3()) => out.set(st.bounds.cx, 0, st.bounds.cz);
  /** Camera position looking at `target` from `dist` along the default angles (FOV 24°, 40° elevation: the cover's). */
  function camPosFor(target, dist, out = new THREE.Vector3()) {
    const p = st.polar, a = st.azimuth || 0;
    return out.set(target.x + Math.sin(a) * Math.sin(p) * dist, target.y + Math.cos(p) * dist, target.z + Math.cos(a) * Math.sin(p) * dist);
  }
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
  function defaultCamPos(dist, out = new THREE.Vector3()) { return camPosFor(boardCentre(_v2), dist, out); }
  /**
   * Portrait screens (phones held upright): the board is 14 hexes wide for 9 high, so we look at it from the
   * player's camp (azimuth −90°): the player's columns sit at the bottom, the enemy's at the top, and the board
   * fills the tall screen instead of a thin strip. Returns true if the orientation changed.
   */
  function updateOrientation() {
    const portrait = st.width / Math.max(1, st.height) < 0.85;
    const a = portrait ? -Math.PI / 2 : 0;
    if (a === (st.azimuth || 0)) return false;
    st.azimuth = a;
    controls.minAzimuthAngle = a - 35 * DEG;
    controls.maxAzimuthAngle = a + 35 * DEG;
    st.userMoved = false; st.tween = null;
    if (st.map) { buildRing(); updateShadowCamera(); }   // the open (camera-facing) side and the sun follow the orientation
    try { buildEnvironment(); } catch (e) { console.warn('[render] environnement non reconstruit', e); }
    return true;
  }
  /** Free area (container minus HUD insets) in NDC. */
  function freeNdc() {
    const w = st.width, h = st.height, ins = st.insets;
    return { x0: -1 + (2 * ins.left) / w, x1: 1 - (2 * ins.right) / w, y0: -1 + (2 * ins.bottom) / h, y1: 1 - (2 * ins.top) / h };
  }
  /** Smallest camera distance (default angles) at which the box {minX..maxZ} × [y0, y1] fits the free area around `target`. */
  function fitBox(b, target, y0 = -0.35, y1 = 0.9) {
    const corners = [];
    for (const x of [b.minX, b.maxX]) for (const y of [y0, y1]) for (const z of [b.minZ, b.maxZ]) corners.push(new THREE.Vector3(x, y, z));
    const f = freeNdc();
    const mx = 0.035 * (f.x1 - f.x0), my = 0.04 * (f.y1 - f.y0);
    const savePos = camera.position.clone(), saveQ = camera.quaternion.clone();
    const p = new THREE.Vector3();
    const fits = (d) => {
      camPosFor(target, d, camera.position); camera.lookAt(target); camera.updateMatrixWorld(true);
      for (const c of corners) { p.copy(c).project(camera); if (p.x < f.x0 + mx || p.x > f.x1 - mx || p.y < f.y0 + my || p.y > f.y1 - my) return false; }
      return true;
    };
    let lo = 3, hi = 200;
    for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    camera.position.copy(savePos); camera.quaternion.copy(saveQ); camera.updateMatrixWorld(true);
    return hi;
  }
  /** Distance at which the whole board fits inside the free area (container minus insets). */
  function fitDistance() { return fitBox(st.bounds, boardCentre()); }
  function applyViewOffset() {
    const w = st.width, h = st.height, ins = st.insets;
    const cx = (ins.left + (w - ins.right)) / 2, cy = (ins.top + (h - ins.bottom)) / 2;
    if (Math.abs(cx - w / 2) < 0.5 && Math.abs(cy - h / 2) < 0.5) camera.clearViewOffset();
    else camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    camera.updateProjectionMatrix();
    st.focusY = 1 - cy / h;
  }

  // ---------------------------------------------------------------- battle framing ("follow the action")
  // While a battle plays (live) and the player has not moved the camera, frame the living units, the ravens in
  // flight and their addressees (+ a margin, clamped to the board, between 0.3·D0 and D0), at the default angles.
  // Hysteresis: re-frame only when something leaves ~85 % of the frame or the box shrinks by ~30 %, with a ~1 s
  // tween in real time (whatever the 1×/2×/4× speed); reduced motion jumps. Prep, 'R' and the end show the board.
  const effectiveFraming = () => (st.live && st.framing === 'action' ? 'action' : 'board');
  let lastFramingKey = '';
  function notifyFraming() {
    const k = `${st.framing}|${st.live}|${st.userMoved}`;
    if (k === lastFramingKey) return;
    lastFramingKey = k;
    emit('framing', { mode: st.framing, live: st.live, userMoved: st.userMoved });
  }
  /**
   * Points the action framing must show: [{ x, y, z }] (y = highest point to keep in view). The units that fought
   * in the last ACTION.fight ticks (struck, were hit, cast, received a raven), every raven in flight and its
   * addressee: the camera closes in on the fight and lets the marching columns elsewhere leave the frame. With
   * fewer than two of those, the units that took part in the last ACTION.recent ticks (moves included); with fewer
   * than two again, every living unit. A commander holding at the back does not keep the camera on the whole board.
   */
  function actionPoints(afterUnits = null) {
    const recentIn = (m, n) => (id) => (st.tickNo ?? 0) - (m.get(id) ?? -99) <= n;
    const fought = recentIn(st.combat, ACTION.fight), recent = recentIn(st.activity, ACTION.recent);
    const list = [];
    if (afterUnits) {
      for (const u of afterUnits) {
        if (!u || u.alive === false || !(u.hp > 0 || u.hp === undefined)) continue;
        const { x, z } = hexToWorld(u.q, u.r);
        list.push({ id: u.id, x, y: standAt(u.q, u.r) + 0.6, z });
      }
    } else for (const v of st.units.values()) list.push({ id: v.id, x: v.root.position.x, y: v.root.position.y + 0.6, z: v.root.position.z });
    const wanted = new Set();
    for (const r of st.ravens.values()) if (r.unitId != null) wanted.add(r.unitId);
    let pts = list.filter((p) => fought(p.id) || wanted.has(p.id));
    if (pts.length < 2) pts = list.filter((p) => recent(p.id) || wanted.has(p.id));
    if (pts.length < 2) pts = list;
    for (const r of st.ravens.values()) pts.push({ x: r.root.position.x, y: r.root.position.y, z: r.root.position.z });
    return pts;
  }
  /** Remember which units took part in a tick (see actionPoints). */
  function noteActivity(evs) {
    st.tickNo = (st.tickNo ?? 0) + 1;
    const mark = (id) => { if (id != null) st.activity.set(id, st.tickNo); };
    const fight = (id) => { if (id != null) { st.activity.set(id, st.tickNo); st.combat.set(id, st.tickNo); } };
    for (const e of evs) {
      switch (e.type) {
        case 'move': case 'regen': mark(e.unitId); break;
        case 'attack': fight(e.unitId); fight(e.targetId); break;
        case 'damage': case 'heal': fight(e.unitId); fight(e.sourceId); break;
        case 'spell': fight(e.unitId); fight(e.targetId); for (const ef of e.effects ?? []) fight(ef.unitId); break;
        case 'death': fight(e.killerId); break;
        case 'raven_launch': mark(e.unitId); break;
        case 'raven_deliver': fight(e.unitId); break;
        default: break;
      }
    }
  }
  function computeActionFit(pts) {
    if (!pts.length) return null;
    const b = st.bounds;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, yTop = 0.9;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); yTop = Math.max(yTop, p.y + 0.3); }
    // margin round the fighters; a portrait phone (world z across its narrow width) gets a slimmer one sideways
    const portrait = (st.azimuth || 0) !== 0;
    const mx = ACTION.margin, mz = portrait ? 1.5 : ACTION.margin;
    x0 -= mx; x1 += mx; z0 -= mz; z1 += mz;
    // minimum extent across the screen and in depth: never closer than ~5 hexes across (≈ 4.5 on a portrait phone)
    const grow = (a, c, min) => { const d = min - (c - a); return d > 0 ? [a - d / 2, c + d / 2] : [a, c]; };
    [x0, x1] = grow(x0, x1, portrait ? 6 : 8);
    [z0, z1] = grow(z0, z1, portrait ? 7.5 : 6);
    const fitIn = (a, c, lo, hi) => {
      if (c - a >= hi - lo) return [lo, hi];
      if (a < lo) return [lo, lo + (c - a)];
      if (c > hi) return [hi - (c - a), hi];
      return [a, c];
    };
    [x0, x1] = fitIn(x0, x1, b.minX, b.maxX);
    [z0, z1] = fitIn(z0, z1, b.minZ, b.maxZ);
    const box = { minX: x0, maxX: x1, minZ: z0, maxZ: z1 };
    const target = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const dist = THREE.MathUtils.clamp(fitBox(box, target, -0.3, yTop), ACTION.minFrac * st.D0, st.D0);
    // close to the whole board: glide back to its centre so the action framing and the overview meet
    target.lerp(boardCentre(_v2), smooth(0.82, 1.0, dist / st.D0));
    return { target, dist, box };
  }
  /** True when one of the points lies outside the central `keep` fraction of the free area. */
  function pointsOutside(pts, keep = ACTION.keep) {
    if (!pts.length) return false;
    camera.updateMatrixWorld(true);
    const f = freeNdc();
    const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2, hx = (f.x1 - f.x0) / 2 * keep, hy = (f.y1 - f.y0) / 2 * keep;
    for (const p of pts) {
      _v1.set(p.x, p.y, p.z).project(camera);
      if (_v1.z > 1 || Math.abs(_v1.x - cx) > hx || Math.abs(_v1.y - cy) > hy) return true;
    }
    return false;
  }
  /** Framing goal for the current mode: { target, dist }. */
  function framingGoal(pts = null) {
    if (effectiveFraming() === 'action') {
      const fit = computeActionFit(pts ?? actionPoints());
      if (fit) { st.action = fit; return fit; }
    }
    st.action = null;
    return { target: boardCentre(), dist: st.D0 };
  }
  /** Move the camera to the current framing (animated unless reduced motion or `jump`). */
  function goFraming({ jump = false, dur = ACTION.tween, pts = null } = {}) {
    const g = framingGoal(pts);
    const pos = camPosFor(g.target, g.dist);
    if (jump || st.reduced) { st.tween = null; controls.target.copy(g.target); camera.position.copy(pos); camera.lookAt(controls.target); controls.update(); }
    else tweenCamera(g.target, pos, dur);
  }
  /** Follow the action: called at each playTick (positions after the tick) and every ~0.25 s while live. */
  function maybeReframe(pts) {
    if (effectiveFraming() !== 'action' || st.userMoved || st.tween || st.time < (st.holdUntil ?? 0)) return;
    const fit = computeActionFit(pts);
    if (!fit) return;
    const cur = camera.position.distanceTo(controls.target);
    if (!pointsOutside(pts) && fit.dist > cur * ACTION.shrink) return;
    goFraming({ pts });
  }
  function setLive(b) {
    if (b) st.orbit = null;
    if (st.live === b) return;
    st.live = b;
    if (!b) st.userMoved = false;          // end of the battle: back to the whole board
    if (!st.userMoved) goFraming();        // first tick: from the overview to the action
    notifyFraming();
  }

  function frameCamera(force = false) {
    applyViewOffset();
    st.D0 = fitDistance();
    controls.minDistance = Math.min(st.D0 * 0.26, 10);
    controls.maxDistance = st.D0 * 1.25;
    scene.fog.near = st.D0 * 1.1; scene.fog.far = st.D0 * 3.4;
    if ((force || !st.userMoved) && !st.orbit) {
      const g = framingGoal();
      const pos = camPosFor(g.target, g.dist);
      if (st.tween) {
        // a camera move is in progress (resetCamera, focusHex, follow): retarget it to the new framing instead of
        // letting it land on the old one
        st.tween.t1.copy(g.target); st.tween.p1.copy(pos);
      } else {
        controls.target.copy(g.target);
        camera.position.copy(pos);
        camera.lookAt(controls.target);
        controls.update();
      }
    }
  }
  function clampTarget() {
    const b = st.bounds, t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, b.minX + 1, b.maxX - 1), cz = THREE.MathUtils.clamp(t.z, b.minZ + 1, b.maxZ - 1);
    const cy = THREE.MathUtils.clamp(t.y, -0.2, 0.6);
    const dx = cx - t.x, dy = cy - t.y, dz = cz - t.z;
    if (dx || dy || dz) { t.set(cx, cy, cz); camera.position.x += dx; camera.position.y += dy; camera.position.z += dz; }
  }
  function tweenCamera(toTarget, toPos, dur = 0.55) {
    // No frame for a while (background tab, throttled preview, headless capture): jump instead of waiting for
    // frames that may never come, so the next rendered frame already shows the requested framing.
    if (!manual && performance.now() - lastFrameAt > 400) {
      st.tween = null;
      controls.target.copy(toTarget); camera.position.copy(toPos); camera.lookAt(controls.target); controls.update();
      return;
    }
    st.tween = { t: 0, dur, t0: controls.target.clone(), p0: camera.position.clone(), t1: toTarget.clone(), p1: toPos.clone() };
  }
  function updateTween(dtReal) {
    const tw = st.tween;
    if (!tw) return;
    tw.t += dtReal;
    const k = easeInOut(clamp01(tw.t / tw.dur));
    controls.target.lerpVectors(tw.t0, tw.t1, k);
    camera.position.lerpVectors(tw.p0, tw.p1, k);
    if (k >= 1) st.tween = null;
  }
  function keyboardPan(dtReal) {
    if (!st.keyboard || !st.keys.size) return;
    let fx_ = 0, fz = 0;
    if (st.keys.has('KeyW') || st.keys.has('ArrowUp')) fz -= 1;
    if (st.keys.has('KeyS') || st.keys.has('ArrowDown')) fz += 1;
    if (st.keys.has('KeyA') || st.keys.has('ArrowLeft')) fx_ -= 1;
    if (st.keys.has('KeyD') || st.keys.has('ArrowRight')) fx_ += 1;
    if (!fx_ && !fz) return;
    const fwd = _v1.subVectors(controls.target, camera.position).setY(0).normalize();
    const speed = camera.position.distanceTo(controls.target) * 0.75 * dtReal;
    const dx = -fwd.x * fz * speed - fwd.z * fx_ * speed, dz = -fwd.z * fz * speed + fwd.x * fx_ * speed;
    controls.target.x += dx; controls.target.z += dz; camera.position.x += dx; camera.position.z += dz;
    st.tween = null; st.userMoved = true;
    notifyFraming();
  }
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  const PAN_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  // Keys are taken only when focus is on the page itself or on the board (never inside HUD widgets / the editor).
  const boardFocused = (t) => !t || t === document.body || t === document.documentElement || t === canvas || t === container;
  const onKeyDown = (e) => {
    if (!st.keyboard || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    const onBoard = boardFocused(e.target);
    if (PAN_KEYS.has(e.code)) {
      if (e.code.startsWith('Arrow') ? !onBoard : (!onBoard && e.target?.closest?.('[role="listbox"],[role="menu"],[role="grid"],[role="tree"],[role="dialog"]'))) return;
      st.keys.add(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    } else if (e.code === 'KeyR' && !e.repeat && onBoard) {
      // during a battle, R toggles « vue d’ensemble » / « suivre l’action » (from a manual camera: the overview)
      if (st.live) view.setFraming(!st.userMoved && st.framing === 'board' ? 'action' : 'board');
      else view.resetCamera();
    }
  };
  const onKeyUp = (e) => { st.keys.delete(e.code); };
  const onBlur = () => st.keys.clear();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // =====================================================================================================
  // Picking
  // =====================================================================================================

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // canvas rect cached (refreshed on resize / scroll / pointer entry): no forced layout in the per-frame hover pick
  // (at most 2 Hz otherwise, in case the shell animates #view with a CSS transform)
  let canvasRect = null, canvasRectT = -1;
  const onScroll = () => { canvasRect = null; };
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  function pick(clientX, clientY) {
    if (!canvasRect || st.time - canvasRectT > 0.5) { canvasRect = canvas.getBoundingClientRect(); canvasRectT = st.time; }
    const rect = canvasRect;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    // units: vertical cylinders
    let bestU = null, bestUT = Infinity;
    for (const v of st.units.values()) {
      const p = v.root.position, rad = 0.5, y0 = p.y, y1 = p.y + v.height * 0.92;
      const ox = o.x - p.x, oz = o.z - p.z;
      const a = d.x * d.x + d.z * d.z, b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - rad * rad;
      const disc = b * b - 4 * a * c;
      if (disc >= 0 && a > 1e-9) {
        const t = (-b - Math.sqrt(disc)) / (2 * a), y = o.y + d.y * t;
        if (t > 0 && y >= y0 && y <= y1 && t < bestUT) { bestUT = t; bestU = v; }
      }
      if (Math.abs(d.y) > 1e-6) {
        const t = (y1 - o.y) / d.y;
        const x = o.x + d.x * t - p.x, z = o.z + d.z * t - p.z;
        if (t > 0 && x * x + z * z <= rad * rad && t < bestUT) { bestUT = t; bestU = v; }
      }
    }
    // tiles: top faces at stand height
    let bestT = null, bestTT = Infinity;
    if (Math.abs(d.y) > 1e-6) {
      for (const t of st.tiles.values()) {
        const tt = (t.stand - o.y) / d.y;
        if (tt <= 0 || tt >= bestTT) continue;
        const h = worldToHex(o.x + d.x * tt, o.z + d.z * tt);
        if (h.q === t.q && h.r === t.r) { bestTT = tt; bestT = t; }
      }
    }
    if (bestU && bestUT <= bestTT + 0.5) return { q: bestU.q, r: bestU.r, unitId: bestU.id };
    if (!bestT) return null;
    let unitId = null;
    for (const v of st.units.values()) if (v.q === bestT.q && v.r === bestT.r) { unitId = v.id; break; }
    return { q: bestT.q, r: bestT.r, unitId };
  }
  function emit(name, payload) {
    for (const cb of st.listeners[name] ?? []) { try { cb(payload); } catch (e) { console.error(e); } }
  }
  function updateHover(event) {
    const h = st.pointer.inside ? pick(st.pointer.x, st.pointer.y) : null;
    const prev = st.hover;
    const changed = (h?.q ?? null) !== (prev?.q ?? null) || (h?.r ?? null) !== (prev?.r ?? null);
    const prevUnit = st.hoverUnit;
    st.hover = h ? { q: h.q, r: h.r } : null;
    st.hoverUnit = h?.unitId ?? null;
    if (changed) { st.hlDirty = true; emit('hexhover', { q: h?.q ?? null, r: h?.r ?? null, unitId: h?.unitId ?? null, event }); }
    if (prevUnit !== st.hoverUnit) {
      emit('unithover', { q: h?.q ?? null, r: h?.r ?? null, unitId: st.hoverUnit, event });
      canvas.style.cursor = st.hoverUnit ? 'pointer' : '';
    }
  }
  let lastMoveEvent = null, hoverDirty = false;
  const onPointerMove = (e) => { st.pointer.inside = true; st.pointer.x = e.clientX; st.pointer.y = e.clientY; lastMoveEvent = e; hoverDirty = true; };
  const onPointerLeave = (e) => { st.pointer.inside = false; lastMoveEvent = e; hoverDirty = true; canvasRect = null; };
  const onPointerDown = (e) => { canvasRect = null; if (document.activeElement !== canvas) canvas.focus({ preventScroll: true }); st.pointer.down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, id: e.pointerId }; };
  const onPointerUp = (e) => {
    const d = st.pointer.down;
    st.pointer.down = null;
    if (!d || d.button !== 0 || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 7 || performance.now() - d.t > 700) return;
    const h = pick(e.clientX, e.clientY);
    if (!h) return;
    if (h.unitId) emit('unitclick', { q: h.q, r: h.r, unitId: h.unitId, event: e });
    emit('hexclick', { q: h.q, r: h.r, unitId: h.unitId, event: e });
  };
  const onContext = (e) => e.preventDefault();
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', onContext);
  // WebGL context loss (GPU reset, memory pressure, mobile tab switch): ask for a restore, tell the shell (it
  // pauses the battle), and on restore rebuild what three.js cannot re-upload by itself: the PMREM environment
  // (its render target comes back empty: the board would stay ~20 % darker) and the static shadow map.
  const onLost = (e) => { e.preventDefault(); st.contextLost = true; emit('contextlost', {}); };
  const onRestored = () => {
    st.contextLost = false;
    try { buildEnvironment(); } catch (e) { console.warn('[render] environnement non reconstruit', e); }
    st.shadowDirty = 3;
    emit('contextrestored', {});
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // =====================================================================================================
  // Tick playback
  // =====================================================================================================

  class Timeline {
    constructor(D) { this.D = D; this.t = 0; this.events = []; this.spans = []; this.ei = 0; this.sorted = false; }
    at(f, fn) { this.events.push({ t: f * this.D, fn }); }
    span(f0, f1, fn) { this.spans.push({ t0: f0 * this.D, t1: Math.max(f0 * this.D + 1e-4, f1 * this.D), fn, done: false }); }
    /** Advance in small sub-steps so events and spans stay in time order even after a long frame. */
    advance(dt) {
      if (!this.sorted) { this.events.sort((a, b) => a.t - b.t); this.sorted = true; }
      let left = dt;
      do {
        const h = Math.min(left, 0.012);
        left -= h;
        this.t += h;
        while (this.ei < this.events.length && this.events[this.ei].t <= this.t) { const ev = this.events[this.ei++]; safe(ev.fn); }
        for (const s of this.spans) {
          if (s.done || this.t < s.t0) continue;
          const k = clamp01((this.t - s.t0) / (s.t1 - s.t0));
          safe(() => s.fn(k));
          if (k >= 1) s.done = true;
        }
      } while (left > 1e-9);
    }
    finish() { this.advance(Math.max(0, this.D - this.t) + 1e-3); for (const s of this.spans) if (!s.done) { safe(() => s.fn(1)); s.done = true; } }
  }
  function safe(fn) { try { fn(); } catch (e) { console.error('[render] tick animation:', e); } }

  const bonusLabel = (b) => {
    // offensive modifiers only (keys of sim.js BONUS_LABELS); defensive ones would clutter the battlefield
    const map = { charge: 'Charge', charge2: 'Charge furieuse', elan: 'Élan', antiCavalry: TRAITS.antiCavalry.name, horde: TRAITS.horde.name, rage: TRAITS.aura_rage.name,
      aura_rage: TRAITS.aura_rage.name, hill: 'Hauteur' };
    return map[b] ?? null;
  };

  function buildTick(report, battleAfter, D) {
    const tl = new Timeline(D);
    const evs = Array.isArray(report?.events) ? report.events : [];
    noteActivity(evs);
    const afterUnits = new Map((battleAfter?.units ?? []).map((u) => [u.id, u]));
    const reduced = st.reduced;
    // ---- moves
    const moves = new Map();
    let maxSub = 0;
    for (const e of evs) if (e.type === 'move' && e.unitId != null && e.to) { if (!moves.has(e.unitId)) moves.set(e.unitId, []); moves.get(e.unitId).push(e); maxSub = Math.max(maxSub, e.sub ?? 0); }
    const endHex = (id) => { const m = moves.get(id); if (m && m.length) return m[m.length - 1].to; const v = st.units.get(id); if (v) return { q: v.q, r: v.r }; const a = afterUnits.get(id); return a ? { q: a.q, r: a.r } : null; };
    const endPos = (id, dy = 0) => { const h = endHex(id); return h ? hexPos(h.q, h.r, dy) : null; };
    const heightOf = (id) => st.units.get(id)?.height ?? 0.6;
    for (const [id, list] of moves) {
      const v = st.units.get(id);
      if (!v) continue;
      list.sort((a, b) => (a.sub ?? 0) - (b.sub ?? 0));
      list.forEach((m, i) => {
        const slot = maxSub >= 1 ? Math.min(1, m.sub ?? i) : 0;
        const f0 = maxSub >= 1 ? (slot === 0 ? 0 : PHASE.sub0End) : 0;
        const f1 = maxSub >= 1 ? (slot === 0 ? PHASE.sub0End : PHASE.sub1End) : PHASE.moveEnd1;
        const from = hexPos(m.from?.q ?? v.q, m.from?.r ?? v.r), to = hexPos(m.to.q, m.to.r);
        const yawTo = Number.isInteger(m.facing) ? facingToYaw(((m.facing % 6) + 6) % 6) : Math.atan2(to.x - from.x, to.z - from.z);
        const hop = reduced ? 0 : 0.11;
        let started = false;
        tl.span(f0, f1, (k) => {
          if (!started) { started = true; v.targetYaw = yawTo; fx.dust(from, { count: 4, radius: 0.22, size: 0.16, life: 0.5 }); }
          const e = easeInOut(k);
          v.root.position.lerpVectors(from, to, e);
          v.hop = Math.sin(Math.PI * k) * hop;
          if (k >= 1) { v.q = m.to.q; v.r = m.to.r; v.hop = 0; fx.dust(to, { count: 5, radius: 0.25, size: 0.17, life: 0.55 }); }
        });
      });
    }
    // ---- holds
    for (const e of evs) if (e.type === 'hold') {
      const v = st.units.get(e.unitId);
      if (!v || v.status?.holding) continue;      // glint only when the unit starts holding (the plate icon shows the rest)
      tl.at(PHASE.hold, () => {
        const fwd = new THREE.Vector3(Math.sin(v.yaw), 0, Math.cos(v.yaw));
        fx.glint(v.root.position.clone().addScaledVector(fwd, 0.32).setY(v.root.position.y + v.height * 0.5), { size: 0.5 });
        fx.ring(v.root.position, { color: '#e9e2d2', from: 0.45, to: 0.62, life: 0.45, opacity: 0.6 });
      });
    }
    // ---- attacks
    const attackBy = new Map();
    for (const e of evs) if (e.type === 'attack') attackBy.set(`${e.unitId}>${e.targetId}`, e);
    let arrowIdx = 0;
    for (const e of evs) {
      if (e.type !== 'attack') continue;
      const a = st.units.get(e.unitId);
      const fromP = endPos(e.unitId), toP = endPos(e.targetId);
      if (!a || !fromP || !toP) continue;
      const dir = new THREE.Vector3().subVectors(toP, fromP).setY(0);
      const dist = dir.length(); dir.normalize();
      tl.at(PHASE.aim, () => { if (dist > 1e-3) a.targetYaw = Math.atan2(dir.x, dir.z); });
      const kind = e.kind ?? (UNITS[a.type]?.range > 1 ? 'arrow' : 'melee');
      if (kind === 'melee') {
        const reach = Math.min(0.42, Math.max(0.18, dist * 0.24)) * (reduced ? 0.55 : 1);
        const kI = (PHASE.impact - 0.52) / (0.94 - 0.52);
        tl.span(0.52, 0.94, (k) => {
          let s;
          if (k < kI * 0.45) s = -0.12 * Math.sin((k / (kI * 0.45)) * Math.PI / 2);
          else if (k < kI) { const u = (k - kI * 0.45) / (kI * 0.55); s = -0.12 + 1.12 * u * u; }
          else s = 1 - easeOut((k - kI) / (1 - kI));
          a.offset.copy(dir).multiplyScalar(s * reach);
          if (k >= 1) a.offset.set(0, 0, 0);
        });
        // a hit of 4 or more, or a charge, lands with weight: brief freeze frame, camera punch, shock ring and dust
        let dealt = 0;
        for (const d of evs) if (d.type === 'damage' && d.sourceId === e.unitId && d.unitId === e.targetId) dealt += d.amount ?? 0;
        const heavy = dealt >= 4 || (e.bonuses ?? []).some((b) => /^charge/.test(b));
        tl.at(PHASE.impact, () => {
          const hit = fromP.clone().lerp(toP, 0.55); hit.y += 0.32;
          fx.sparks(hit, { count: heavy ? 20 : 12, dir: dir, color: '#ffe3b0', size: heavy ? 0.11 : 0.08, speed: heavy ? 3.2 : 2.4 });
          fx.flash(hit, '#ffc58a', heavy ? 10 : 6, heavy ? 0.3 : 0.22);
          if (heavy) {
            fx.ring(toP, { color: '#ffd9a0', from: 0.25, to: 1.15, life: 0.42, opacity: 0.75 });
            fx.dust(toP, { count: 12, radius: 0.5, size: 0.24, life: 0.8 });
            impactBeat(dealt >= 6 ? 1 : 0.7, D);
          }
        });
      } else if (kind === 'arrow') {
        const n = /archers/.test(a.type) ? (a.faction === 'gobelins' ? 2 : 3) : 1;
        const flight = Math.max(0.08, (PHASE.impact - PHASE.release) * D);
        for (let i = 0; i < n; i++) {
          const idx = arrowIdx++;
          tl.at(PHASE.release + i * 0.015, () => {
            const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((i - (n - 1) / 2) * 0.16);
            const f = fromP.clone().add(side).setY(fromP.y + a.height * 0.7);
            const t = toP.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.35, 0, (Math.random() - 0.5) * 0.35)).setY(toP.y + heightOf(e.targetId) * (0.25 + Math.random() * 0.3));
            fx.arrow(f, t, { flight: flight - i * 0.015 * D, stick: st.reduced ? 0.25 : 0.5, onHit: idx % 2 ? null : (p) => fx.dust(p.clone().setY(toP.y), { count: 2, radius: 0.1, size: 0.1 }) });
          });
        }
      } else { // bolt
        const col = a.faction === 'gobelins' ? '#b8ff7a' : '#9fd8ff';
        tl.at(PHASE.aim, () => { a.glowBoost = 1; });
        tl.at(PHASE.release, () => {
          const f = fromP.clone().setY(fromP.y + a.height * 0.85), t = toP.clone().setY(toP.y + heightOf(e.targetId) * 0.5);
          fx.orb(f, t, { flight: Math.max(0.08, (PHASE.impact - PHASE.release) * D), color: col, size: 0.06, kind: 'bolt', onHit: (p) => { fx.sparks(p, { color: col, count: 10, speed: 1.8 }); fx.flash(p, col, 5, 0.2); } });
        });
      }
    }
    // ---- spells
    for (const e of evs) {
      if (e.type !== 'spell') continue;
      const a = st.units.get(e.unitId);
      const fromP = endPos(e.unitId);
      if (!a || !fromP) continue;
      const targetId = e.targetId ?? e.effects?.[0]?.unitId ?? null;
      const centerP = e.center ? hexPos(e.center.q, e.center.r) : targetId != null ? endPos(targetId) : null;
      if (!centerP) continue;
      const dir = new THREE.Vector3().subVectors(centerP, fromP).setY(0);
      tl.at(PHASE.aim, () => { if (dir.lengthSq() > 1e-4) a.targetYaw = Math.atan2(dir.x, dir.z); a.glowBoost = 1.4; });
      const casterTop = () => fromP.clone().setY(fromP.y + a.height * 0.95);
      const flight = Math.max(0.08, (PHASE.impact - PHASE.release) * D);
      const spell = e.spell;
      if (spell === 'FIREBALL') {
        tl.at(PHASE.release, () => {
          fx.orb(casterTop(), centerP.clone().setY(centerP.y + 0.25), { flight, color: '#ff8a2a', size: 0.12, kind: 'fireball', onHit: (p) => {
            const g = centerP.clone();
            fx.flash(p, '#ff9a40', 16, 0.45);
            fx.fireBurst(p, { size: 1.6 });
            fx.ring(g, { color: '#ffb257', from: 0.3, to: 2.0, life: 0.55, opacity: 0.6 });
            fx.ring(g, { color: '#ff7a2a', from: 0.2, to: 1.3, life: 0.4, opacity: 0.45 });
            fx.embers(p, { count: 30 });
            fx.sparks(p, { count: 14, color: '#fff0c0', speed: 3.2 });
            fx.smoke(g, { count: 8 });
            fx.scorch(g, { radius: 0.85 });
            fx.dust(g, { count: 10, radius: 0.6, color: '#8a7458' });
          } });
        });
      } else {
        const col = spell === 'HEAL' ? '#c8ff8a' : spell === 'WARD' ? '#9fd0ff' : spell === 'HEX' ? '#c48cff' : '#ffe08a';
        tl.at(PHASE.release, () => fx.stream(casterTop(), centerP.clone().setY(centerP.y + 0.4), { flight: flight * 0.92, color: col }));
        tl.at(PHASE.impact - 0.02, () => {
          const tv = targetId != null ? st.units.get(targetId) : null;
          const base = tv ? tv.root.position.clone() : centerP.clone();
          if (spell === 'HEAL') { fx.sparkles(base, { color: '#d6ff9a', count: 22, radius: 0.36, height: 1.0 }); fx.sparkles(base, { color: '#ffe9a0', count: 8, radius: 0.3 }); fx.ring(base, { color: '#c8ff8a', from: 0.3, to: 0.8, life: 0.6, opacity: 0.7 }); }
          else if (spell === 'WARD') { fx.dome(base, { color: '#9fd0ff', life: 1.15 }); fx.sparkles(base, { color: '#bfe3ff', count: 12, radius: 0.5 }); fx.ring(base, { color: '#9fd0ff', from: 0.4, to: 0.9, life: 0.6, opacity: 0.7 }); }
          else if (spell === 'HEX') { fx.swirl(base, { color: '#b26bff' }); fx.flash(base.clone().setY(base.y + 0.5), '#9a5cff', 6, 0.35); }
          else fx.sparkles(base, { color: col, count: 16 });
        });
      }
      // statuses delivered by the spell become visible at impact
      tl.at(PHASE.impact, () => {
        for (const ef of e.effects ?? []) {
          const tv = st.units.get(ef.unitId);
          const au = afterUnits.get(ef.unitId);
          if (tv && au?.status) setUnitStatus(tv, au.status);
        }
      });
    }
    // ---- damage / heal / regen numbers & reactions
    // Hits are grouped per target: one number (the sum, "×n" when several hits) and at most one bonus label per
    // unit and per tick, so simultaneous hits never print on top of each other; fx.updateNumbers then pushes apart
    // the labels of neighbouring units.
    const byTarget = new Map();
    for (const e of evs) {
      if (e.type !== 'damage' || !st.units.has(e.unitId)) continue;
      let g = byTarget.get(e.unitId);
      if (!g) { g = { id: e.unitId, sum: 0, hits: 0, hpAfter: null, sources: [], bonuses: [] }; byTarget.set(e.unitId, g); }
      g.sum += e.amount ?? 0; g.hits++;
      if (e.hpAfter != null) g.hpAfter = e.hpAfter;
      if (e.sourceId != null) g.sources.push(e.sourceId);
      for (const b of attackBy.get(`${e.sourceId}>${e.unitId}`)?.bonuses ?? []) { const l = bonusLabel(b); if (l && !g.bonuses.includes(l)) g.bonuses.push(l); }
    }
    let dmgIdx = 0;
    for (const g of byTarget.values()) {
      const v = st.units.get(g.id);
      const f = Math.min(PHASE.impact + dmgIdx++ * 0.012, PHASE.death - 0.02);
      tl.at(f, () => {
        const head = v.root.position.clone(); head.y += v.height + 0.12;
        fx.number(head, `−${g.sum}`, { kind: g.sum >= 5 ? 'big' : 'dmg', sub: g.hits > 1 ? `×${g.hits}` : '' });
        if (g.bonuses.length) fx.number(head, g.bonuses.join(' · '), { kind: 'label', delay: 0.05, life: 1.15, dy: -30 });
        v.hp = g.hpAfter ?? Math.max(0, (v.hp ?? 0) - g.sum);
        refreshPlate(v);
        v.flashT = 0;
        fx.dust(v.root.position, { count: 3, radius: 0.2, size: 0.14, life: 0.45 });
      });
      if (!reduced) {
        // one knock-back per target, away from the average direction of its attackers
        const knock = new THREE.Vector3();
        const me = endPos(g.id) ?? v.root.position;
        for (const sid of g.sources) { const sp = endPos(sid); if (sp) knock.add(_v1.subVectors(me, sp).setY(0).normalize()); }
        if (knock.lengthSq() > 1e-6) knock.normalize();
        tl.span(f, Math.min(1, f + 0.2), (k) => {
          const amp = (1 - k) * 0.055;
          v.shake.set(knock.x * amp * Math.sin(k * 30) + (Math.random() - 0.5) * amp * 0.6, 0, knock.z * amp * Math.sin(k * 30) + (Math.random() - 0.5) * amp * 0.6);
          if (k >= 1) v.shake.set(0, 0, 0);
        });
      }
    }
    for (const e of evs) {
      if (e.type === 'damage') continue;
      if (e.type === 'heal' || e.type === 'regen') {
        const v = st.units.get(e.unitId);
        if (!v) continue;
        const regen = e.type === 'regen';
        tl.at(regen ? PHASE.regen : PHASE.heal, () => {
          const head = v.root.position.clone(); head.y += v.height + 0.12;
          fx.number(head, `+${e.amount}`, { kind: regen ? 'regen' : 'heal', dx: regen ? 26 : 0 });
          v.hp = e.hpAfter ?? Math.min(v.maxHp ?? 99, (v.hp ?? 0) + (e.amount ?? 0));
          refreshPlate(v);
          if (regen) fx.sparkles(v.root.position, { color: '#a8e070', count: 5, radius: 0.3, height: 0.5, size: 0.06 });
        });
      } else if (e.type === 'death') {
        const v = st.units.get(e.unitId);
        if (!v) continue;
        const kp = e.killerId != null ? endPos(e.killerId) : null;
        tl.at(PHASE.death, () => {
          if (!st.units.has(e.unitId)) return;
          st.units.delete(e.unitId);
          const dir = kp ? new THREE.Vector3().subVectors(v.root.position, kp) : null;
          startDying(v, dir, false);
        });
      }
    }
    // ---- ravens
    const launched = new Set();
    for (const e of evs) {
      if (e.type === 'raven_launch') {
        launched.add(e.ravenId);
        tl.at(0, () => {
          if (st.ravens.has(e.ravenId)) return;
          const v = createRavenView({ id: e.ravenId, side: e.side, unitId: e.unitId, x: e.x, z: e.z });
          st.ravens.set(e.ravenId, v);
          v.anim = { launch: true };
          v.root.scale.setScalar(0.4);
          v.root.position.set(e.x, standAt(worldToHex(e.x, e.z).q, worldToHex(e.x, e.z).r) + 0.9, e.z);
          fx.sparkles(v.root.position, { color: '#e8e0d0', count: 6, radius: 0.2, height: 0.4 });
        });
        tl.span(0, 0.26, (k) => {
          const v = st.ravens.get(e.ravenId); if (!v || !v.anim?.launch) return;
          v.root.scale.setScalar(lerp(0.4, 1, easeOut(k)));
          const gy = standAt(worldToHex(e.x, e.z).q, worldToHex(e.x, e.z).r) + 0.9;
          v.root.position.y = lerp(gy, RAVEN_ALT, easeOut(k));
          if (k >= 1) v.anim = null;
        });
      }
    }
    for (const e of evs) {
      if (e.type !== 'raven_move') continue;
      const f0 = launched.has(e.ravenId) ? 0.2 : 0;
      tl.span(f0, PHASE.raven, (k) => {
        const v = st.ravens.get(e.ravenId); if (!v) return;
        v.anim = v.anim ?? {};
        const x = lerp(e.from.x, e.to.x, k), z = lerp(e.from.z, e.to.z, k);
        if (Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z) > 1e-3) v.yaw = Math.atan2(e.to.x - e.from.x, e.to.z - e.from.z);
        v.root.position.x = x; v.root.position.z = z;
        if (!v.anim.launch) v.root.position.y = RAVEN_ALT + Math.sin(k * Math.PI) * 0.08;
        v.x = e.to.x; v.z = e.to.z;
        if (k >= 1) v.anim = null;
      });
    }
    for (const e of evs) {
      if (e.type === 'raven_shot') {
        const shooter = e.byId != null ? st.units.get(e.byId) : null;
        if (shooter) {
          tl.at(PHASE.raven - 0.17, () => {
            const sp = endPos(e.byId) ?? shooter.root.position;
            fx.arrow(sp.clone().setY(sp.y + shooter.height * 0.7), new THREE.Vector3(e.x, RAVEN_ALT, e.z), { flight: Math.max(0.06, 0.17 * D), apex: 0.4, stick: 0.05 });
            if (sp) { const d = new THREE.Vector3(e.x - sp.x, 0, e.z - sp.z); if (d.lengthSq() > 1e-4) shooter.targetYaw = Math.atan2(d.x, d.z); }
          });
        }
        tl.at(PHASE.raven, () => {
          const v = st.ravens.get(e.ravenId);
          if (v && Number.isFinite(e.x)) { v.root.position.x = e.x; v.root.position.z = e.z; }
          ghostRaven(e.ravenId, 'shot');
        });
      } else if (e.type === 'raven_lost') {
        tl.at(PHASE.raven, () => { const v = st.ravens.get(e.ravenId); if (v) fx.number(v.root.position, 'Perdu', { kind: 'info' }); ghostRaven(e.ravenId, 'lost'); });
      } else if (e.type === 'raven_deliver') {
        tl.at(PHASE.raven, () => {
          const u = st.units.get(e.unitId);
          const v = st.ravens.get(e.ravenId);
          ghostRaven(e.ravenId, 'deliver', { unitId: e.unitId, cx: u?.root.position.x, cz: u?.root.position.z });
          if (u) {
            fx.runeRing(u.root, { life: st.reduced ? 1.0 : 1.7 });
            u.glowBoost = 1.2;
            const head = u.root.position.clone(); head.y += u.height + 0.3;
            fx.number(head, 'Nouveaux ordres', { kind: 'label', delay: 0.15, life: 1.4 });
          }
        });
      }
    }
    return tl;
  }

  function finishCurrent() {
    const cur = st.current;
    if (!cur) return;
    st.current = null;
    clearTimeout(cur.watchdog);
    cur.tl.finish();
    for (const v of st.units.values()) { v.offset.set(0, 0, 0); v.shake.set(0, 0, 0); v.hop = 0; }
    safe(() => syncUnits(cur.after?.units ?? [], { instant: false }));
    safe(() => syncRavens(cur.after?.ravens ?? []));
    // the last tick of the battle: back to the whole board for the result
    if (cur.report?.result || cur.after?.result) safe(() => setLive(false));
    cur.resolve();
  }

  // =====================================================================================================
  // Frame loop
  // =====================================================================================================

  const clock = new THREE.Clock();
  let raf = 0, lastFrameAt = performance.now(), manual = false, active = true;
  function frame() {
    if (st.disposed || manual || !active) return;
    raf = requestAnimationFrame(frame);
    step(Math.min(clock.getDelta(), 0.1));
  }
  /**
   * Tilt-shift focus band (screen-space y, below / above the focus line): what matters stays sharp, the rest
   * softens like a miniature shot at a wide aperture. Prep / overview: the playable board; during a battle with
   * the action framing: the fight (see actionPoints), so the foreground rows and everything beyond it blur;
   * otherwise every living unit and raven.
   */
  const tiltPts = [];
  function updateTilt(dtReal) {
    if (!pipe?.post) return;
    tiltPts.length = 0;
    if (st.live && st.units.size && effectiveFraming() === 'action' && !st.userMoved) {
      for (const p of actionPoints()) tiltPts.push(p.x, p.y + 0.1, p.z, p.x, p.y - 0.75, p.z);
    } else if (st.live && st.units.size) {
      for (const v of st.units.values()) { const p = v.root.position; tiltPts.push(p.x, p.y, p.z, p.x, p.y + v.height + 0.35, p.z); }
      for (const r of st.ravens.values()) { const p = r.root.position; tiltPts.push(p.x, p.y, p.z); }
    } else {
      const b = st.bounds;
      for (const x of [b.minX + 0.5, b.maxX - 0.5]) for (const z of [b.minZ + 0.4, b.maxZ - 0.4]) tiltPts.push(x, 0, z, x, 0.9, z);
    }
    camera.updateMatrixWorld(true);
    const focus = st.focusY ?? 0.5;
    let lo = 0, hi = 0;
    for (let i = 0; i < tiltPts.length; i += 3) {
      _v1.set(tiltPts[i], tiltPts[i + 1], tiltPts[i + 2]).project(camera);
      const y = clamp01(_v1.y * 0.5 + 0.5);
      lo = Math.max(lo, focus - y); hi = Math.max(hi, y - focus);
    }
    const k = st.tilt.init ? 1 - Math.exp(-dtReal * 3) : 1;
    st.tilt.init = true;
    st.tilt.lo += (THREE.MathUtils.clamp(lo + 0.03, 0.1, 0.5) - st.tilt.lo) * k;
    st.tilt.hi += (THREE.MathUtils.clamp(hi + 0.03, 0.1, 0.5) - st.tilt.hi) * k;
    // strongest blur: between the 1/4 and 1/8 copies (same size in CSS pixels whatever the DPR): soft, figures still legible
    const u = pipe.final.material.uniforms;
    u.uFocus.value = focus; u.uBandLo.value = st.tilt.lo; u.uBandHi.value = st.tilt.hi; u.uFeather.value = 0.18;
    u.uMax.value = THREE.MathUtils.clamp(2.1 + Math.log2(st.pixelRatio), 1.4, 2.6);
  }
  /** One frame of simulation + rendering with an explicit time step (seconds). */
  function step(dtReal, draw = true) {
    lastFrameAt = performance.now();
    renderer.info.reset();
    const dt = st.paused ? 0 : dtReal;
    st.time += dtReal;
    SHARED.time.value = st.time;

    keyboardPan(dtReal);
    updateTween(dtReal);
    updateOrbit(dtReal);
    controls.update();
    clampTarget();

    // freeze frame after a heavy blow: the battle clock (timeline, figures, effects) holds for a few dozen ms
    // (a slow frame only spends the rest of the freeze, it never costs an extra frame)
    let dtA = dt;
    if (st.hitStop > 0 && dt > 0) { const fz = Math.min(st.hitStop, dt); st.hitStop -= fz; dtA = dt - fz; }
    if (st.current) {
      const cur = st.current;
      safe(() => cur.tl.advance(dtA));
      if (cur.tl.t >= cur.tl.D) finishCurrent();
    }
    updateUnits(dtA, dtReal);
    updateDying(dtA, dtReal);
    updateRavens(dtA, dtReal);
    fx.update(dtA);
    if (st.pointer.inside || hoverDirty) { updateHover(lastMoveEvent); hoverDirty = false; }
    if (st.hlDirty) rebuildHighlights();
    animateHighlights();
    updatePlates(dtReal);
    // follow the action: something left the frame / the fight got tighter (checked 4×/s, see maybeReframe)
    if (st.live && st.framing === 'action' && !st.userMoved) {
      st.reframeCheckT -= dtReal;
      if (st.reframeCheckT <= 0) { st.reframeCheckT = 0.25; safe(() => maybeReframe(actionPoints())); }
    }
    if (!draw || st.contextLost) return;
    // shadows: static board => refresh only while a figure moves (30 Hz); nothing while paused (all frozen; a
    // pause and the turn of a unit force one refresh through shadowDirty)
    st.frameNo = (st.frameNo ?? 0) + 1;
    const animating = !st.paused && (st.current || st.dying.length || st.ghosts.length);
    if (st.shadowDirty > 0 || (animating && st.frameNo % 2 === 0)) {
      renderer.shadowMap.needsUpdate = true;
      st.shadowDirty = Math.max(0, st.shadowDirty - 1);
    }
    updateTilt(dtReal);
    updateForestCut();
    const kick = cameraKick(dtReal);
    if (kick) camera.position.add(kick);
    render();
    if (kick) camera.position.sub(kick);
  }
  /**
   * Heavy melee blow: freeze frame and a short camera punch along the view axis (none with reduced motion). The
   * freeze stays a small share of the tick (`D` s), so the 2×/4× speeds keep their pace.
   */
  function impactBeat(k, D = 0.7) {
    st.hitStop = Math.max(st.hitStop, Math.min(0.055 + 0.035 * k, D * 0.12));
    if (!st.reduced) st.kick = { t: 0, dur: 0.25, amp: 0.1 + 0.1 * k };
  }
  const _kick = new THREE.Vector3();
  function cameraKick(dtReal) {
    const kk = st.kick;
    if (!kk) return null;
    kk.t += dtReal;
    const u = kk.t / kk.dur;
    if (u >= 1) { st.kick = null; return null; }
    return _kick.subVectors(controls.target, camera.position).normalize().multiplyScalar(kk.amp * Math.sin(Math.PI * Math.min(1, u * 1.6)) * (1 - u));
  }
  /** Victory shot (view.celebrate): glide from the current camera onto a low orbit round the winner, then hold. */
  const _op = new THREE.Vector3();
  function updateOrbit(dtReal) {
    const o = st.orbit;
    if (!o) return;
    o.t = Math.min(o.dur, o.t + dtReal);
    const k = o.t / o.dur, az = lerp(o.az0, o.az1, easeInOut(k)), p = o.polar;
    _op.set(o.c.x + Math.sin(az) * Math.sin(p) * o.dist, o.c.y + Math.cos(p) * o.dist, o.c.z + Math.cos(az) * Math.sin(p) * o.dist);
    const b = easeInOut(smooth(0, 0.5, k));
    camera.position.lerpVectors(o.p0, _op, b);
    controls.target.lerpVectors(o.t0, o.c, b);
    if (k >= 1) { st.orbit = null; st.userMoved = true; notifyFraming(); }
  }
  function render() {
    camera.updateMatrixWorld();
    bgU.uBgInvProj.value.copy(camera.projectionMatrixInverse); bgU.uBgCam.value.copy(camera.matrixWorld);
    if (!pipe) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
    renderer.setRenderTarget(pipe.scene);
    renderer.render(scene, camera);
    const ac = renderer.autoClear;
    renderer.autoClear = false;          // every post pass covers its whole target
    let src = pipe.scene.texture;
    if (pipe.post) {
      renderBloom(src, pipe.scene.width, pipe.scene.height);
      renderDof(src);
    }
    pipe.final.material.uniforms.tDiffuse.value = src;
    renderer.setRenderTarget(null); pipe.final.render(renderer);
    renderer.autoClear = ac;
  }

  // =====================================================================================================
  // Size & quality
  // =====================================================================================================

  function resize(force = false) {
    // Layout size (clientWidth/Height), NOT getBoundingClientRect: the shell animates #view with CSS transforms
    // (title drift), and a transformed rect would leave the camera with a wrong aspect / projection for good,
    // since a ResizeObserver does not fire when only the transform changes.
    let w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) { const r = container.getBoundingClientRect(); w = r.width; h = r.height; }
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    canvasRect = null;
    // Drawing buffer capped by pixel count (~2.2 Mpx: a 4K screen or a large tablet does not render 3× the pixels
    // of a laptop), never below CSS resolution.
    const dpr = window.devicePixelRatio || 1;
    const pr = Math.max(Math.min(dpr, 1), Math.min(dpr, st.quality === 'high' ? 1.5 : 1, Math.sqrt(2.2e6 / (w * h))));
    if (!force && st.sized && w === st.width && h === st.height && st.pixelRatio === pr) { frameCamera(false); return; }
    st.sized = true;
    st.width = w; st.height = h; st.pixelRatio = pr;
    st.phone = Math.min(w, h) <= 560;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    bgU.uBgRes.value.copy(buf);
    sizePipeline(buf.x, buf.y);
    fx.resize(buf.y, w, h);
    const turned = updateOrientation();
    frameCamera(turned);
    // a paused loop (menus over the board) still shows a correct frame: setSize just cleared the canvas
    if (!active && !manual && !st.disposed) safe(() => step(0));
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  const onWinResize = () => resize();
  window.addEventListener('resize', onWinResize);

  function applyQuality() {
    const high = st.quality === 'high';
    if (high) { if (!pipe?.post) buildPipeline(true); }
    else if (canvasAA) destroyPipeline();
    else if (!pipe || pipe.post) buildPipeline(false);
    bgU.uBgMist.value = high ? 3 : 1;
    sun.shadow.radius = high ? 3 : 1.5;
    const size = high ? 2048 : 1024;
    if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.set(size, size); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    st.shadowDirty = 2;
    st.tilt.init = false;
    fx.setQuality(st.quality);
    if (st.map && st.ringKey && st.ringKey !== `${(st.azimuth || 0) !== 0 ? 'p' : 'l'}|${st.quality}`) buildRing();
    resize(true);
  }

  /** Battle over (setUnits after an instant resolution): a side lost its commander or has nobody left. */
  function battleLooksOver(units) {
    if (!Array.isArray(units) || !units.length) return false;
    const isCmd = (u) => (u.cls ?? UNITS[u.type]?.cls) === 'commander';
    for (const side of ['player', 'enemy']) {
      const all = units.filter((u) => u && u.side === side);
      if (!all.length) continue;
      const alive = all.filter((u) => u.alive !== false && (u.hp > 0 || u.hp === undefined));
      if (!alive.length) return true;
      if (all.some(isCmd) && !alive.some(isCmd)) return true;
    }
    return false;
  }

  // =====================================================================================================
  // Public view
  // =====================================================================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = {
    renderer, scene, camera, controls,
    /** Build the board (tiles, scenery ring, camps) for a Map. Existing units are re-seated on the new heights. */
    setMap(map) {
      if (!map || !Array.isArray(map.tiles)) return;
      st.map = map;
      st.live = false; st.action = null; st.activity.clear(); st.combat.clear();
      // a new board starts clean: no effect, number, dying figure or falling raven left over from a battle that
      // was left while paused (they only advance with the battle clock), and not paused itself
      st.paused = false;
      fx.clear();
      for (const d of st.dying) disposeUnitView(d.v);
      for (const g of st.ghosts) disposeRavenView(g.v);
      st.dying.length = 0; st.ghosts.length = 0;
      for (const m of [...markGroup.children]) markGroup.remove(m);
      st.orbit = null; st.kick = null; st.hitStop = 0;
      buildBoard(map);
      frameCamera(!st.userMoved);
      for (const v of st.units.values()) placeUnit(v, v.q, v.r);
      notifyFraming();
    },
    /** Instant sync with a list of BUnit-like objects ({ id, type, side, q, r, hp, maxHp, alive, facing, status? }). */
    setUnits(units) {
      if (st.current) finishCurrent();
      syncUnits(units, { instant: false });
      if (st.live && battleLooksOver(units)) setLive(false);
    },
    /** Instant sync of ravens in flight (alive && !delivered are shown). */
    setRavens(ravens) { syncRavens(ravens); },
    /**
     * Animate one TickReport over `duration` ms, then sync exactly with battleAfter.
     * The first tick of a battle switches the camera to its battle framing (see setFraming).
     * @returns {Promise<void>} resolves when the view matches battleAfter
     */
    playTick(report, battleAfter, { duration = 700 } = {}) {
      if (st.current) finishCurrent();
      if (st.disposed) return Promise.resolve();
      const D = Math.max(0.06, (Number(duration) || 700) / 1000);
      let tl;
      try { tl = buildTick(report, battleAfter, D); } catch (e) { console.error('[render] playTick:', e); tl = new Timeline(D); }
      if (!st.live && !report?.result) safe(() => setLive(true));
      else if (Array.isArray(battleAfter?.units)) safe(() => maybeReframe(actionPoints(battleAfter.units)));
      return new Promise((resolve) => {
        const cur = { tl, report, after: battleAfter, resolve, watchdog: 0 };
        const arm = () => {
          cur.watchdog = setTimeout(() => {
            if (st.current !== cur) return;
            // no frames for a while although the page is visible (e.g. throttled rAF): finish so the battle loop goes on.
            // Never while paused: the player may pause mid-tick for as long as they like.
            if (!manual && !st.paused && performance.now() - lastFrameAt > 1000 && document.visibilityState === 'visible') finishCurrent();
            else arm();
          }, D * 1000 + 1500);
        };
        arm();
        st.current = cur;
      });
    },
    /** Highlights: [{ q, r, kind: 'deploy'|'deploy-enemy'|'hover'|'select'|'range'|'path'|'danger'|'target' }] (replaces the previous list). */
    setHighlights(list) { st.highlights = Array.isArray(list) ? list.slice() : []; st.hlDirty = true; },
    setSelected(unitId) { setSelected(unitId); },
    /**
     * Subscribe to 'hexclick' | 'hexhover' | 'unitclick' | 'unithover' (payload { q, r, unitId, event }; q/r null when
     * the pointer leaves the board, hover only), 'framing' ({ mode, live, userMoved }), 'contextlost', 'contextrestored'.
     * Returns an unsubscribe function.
     */
    on(name, cb) {
      const set = st.listeners[name];
      if (!set || typeof cb !== 'function') return () => {};
      set.add(cb);
      return () => set.delete(cb);
    },
    /** Smoothly centre the camera on a hex (keeps zoom and angle). During a battle, following the action pauses 4 s. */
    focusHex(q, r) {
      const p = hexPos(q, r);
      p.x = THREE.MathUtils.clamp(p.x, st.bounds.minX + 1, st.bounds.maxX - 1); p.z = THREE.MathUtils.clamp(p.z, st.bounds.minZ + 1, st.bounds.maxZ - 1); p.y = 0;
      const delta = new THREE.Vector3().subVectors(p, controls.target);
      if (st.live) st.holdUntil = st.time + 4;
      tweenCamera(p, camera.position.clone().add(delta));
    },
    /** Back to the automatic framing: the whole board (prep, end of battle, 'board' mode) or the action during a battle. */
    resetCamera() {
      st.orbit = null;
      st.userMoved = false; st.holdUntil = 0;
      applyViewOffset();
      st.D0 = fitDistance();
      goFraming({ dur: 0.6 });
      notifyFraming();
    },
    /**
     * Battle framing: 'action' (default) follows the living units and the ravens while a battle plays; 'board' keeps
     * the whole board (« Vue d’ensemble »). Clears a manual camera move. Outside a battle the board is always shown.
     */
    setFraming(mode) {
      st.framing = mode === 'board' ? 'board' : 'action';
      view.resetCamera();
    },
    /** { mode: 'action'|'board', live, userMoved, effective: what is shown now when !userMoved } */
    getFraming() { return { mode: st.framing, live: st.live, userMoved: st.userMoved, effective: effectiveFraming() }; },
    /**
     * End-of-battle shot: the camera glides down onto a low orbit round the winning side's commander (or one of its
     * figures) for `ms`, then holds there. Returns the duration used: 0 with reduced motion or nobody to show.
     * Any touch of the camera, resetCamera() or a new board ends it.
     */
    celebrate(side, { ms = 1500 } = {}) {
      if (st.reduced || st.disposed || st.contextLost) return 0;
      let best = null;
      for (const v of st.units.values()) if (v.side === side && (!best || (v.commander && !best.commander))) best = v;
      if (!best) return 0;
      const c = best.root.position.clone(); c.y += best.height * 0.4;
      const a = st.azimuth || 0;
      st.tween = null;
      st.orbit = { t: 0, dur: ms / 1000, c, dist: Math.max(controls.minDistance, st.D0 * 0.2), polar: 62 * DEG, az0: a - 0.38, az1: a + 0.12,
        p0: camera.position.clone(), t0: controls.target.clone() };
      return ms;
    },
    /** Screen position (CSS px in the container) of a hex centre. */
    projectHex(q, r) {
      const p = hexPos(q, r).project(camera);
      return { x: (p.x * 0.5 + 0.5) * st.width, y: (-p.y * 0.5 + 0.5) * st.height, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
    },
    /** Screen position (CSS px) just above a unit's head, or null. */
    projectUnit(unitId) {
      const v = st.units.get(unitId);
      if (!v) return null;
      const p = v.root.position.clone(); p.y += v.height + 0.15;
      p.project(camera);
      return { x: (p.x * 0.5 + 0.5) * st.width, y: (-p.y * 0.5 + 0.5) * st.height, visible: p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
    },
    /** Reserve screen space (CSS px) taken by the HUD so the board is framed in the free area. */
    setInsets({ top = 0, right = 0, bottom = 0, left = 0 } = {}) { st.insets = { top, right, bottom, left }; frameCamera(!st.userMoved); },
    setHoverOutline(b) { st.hoverOutline = !!b; st.hlDirty = true; },
    /** Show / hide the HP plates (and raven routes) above the figures (hidden on the title-screen diorama). */
    setPlates(b) { st.platesOn = !!b; },
    setKeyboardEnabled(b) { st.keyboard = !!b; if (!b) st.keys.clear(); },
    setQuality(q) { const n = q === 'low' ? 'low' : 'high'; if (n === st.quality) return; st.quality = n; applyQuality(); },
    /** Freeze battle animations and effects (idle life and the camera keep running). */
    setPaused(b) { st.paused = !!b; if (st.paused) st.shadowDirty = Math.max(st.shadowDirty, 1); },
    isAnimating() { return !!st.current; },
    /**
     * Stop (false) / restart (true) the render loop, e.g. while an opaque cover or a menu hides the board: the
     * canvas keeps its last frame (redrawn once after a resize or a quality change). Playing ticks still resolve.
     */
    setActive(b) {
      const want = !!b;
      if (want === active) return;
      active = want;
      if (!want) { cancelAnimationFrame(raf); if (!manual && !st.disposed) safe(() => step(0)); }
      else if (!manual && !st.disposed) { clock.getDelta(); frame(); }
    },
    isActive() { return active; },
    /**
     * Compile every shader the current scene needs (board, units, effects) in the render target they are drawn
     * into, then draw one hidden warm-up frame (shadow programs, GPU pipelines). Call it while a waiting screen is
     * up, after setMap/setUnits: it removes the freeze on the first frame of the board and of the first effects.
     */
    async prepare({ timeoutMs = 8000 } = {}) {
      if (st.disposed || st.contextLost) return;
      const undo = fx.warmup(boardCentre(new THREE.Vector3()));
      try {
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(pipe ? pipe.scene : null);
        // program cache keys depend on the bound target (tone mapping / colour space), hence the setRenderTarget;
        // without KHR_parallel_shader_compile, compileAsync would only warn and compile synchronously anyway
        let p = null;
        try {
          if (renderer.extensions.has('KHR_parallel_shader_compile')) p = renderer.compileAsync(scene, camera);
          else renderer.compile(scene, camera);
        } finally { renderer.setRenderTarget(prev); }
        if (p) await Promise.race([p, sleep(timeoutMs)]);
        if (st.disposed) return;
        renderer.shadowMap.needsUpdate = true;
        updateTilt(0);
        render();
      } catch (e) { console.warn('[render] préparation des shaders', e); } finally { undo(); }
    },
    /** True between a 'contextlost' and the matching 'contextrestored'. */
    contextLost() { return st.contextLost; },
    /** Remove every running effect and floating number (e.g. when leaving the battle screen). */
    clearEffects() { fx.clear(); },
    /** Testing aid: stop the internal requestAnimationFrame loop and drive frames yourself with step(dt). */
    setManualClock(b) {
      const want = !!b;
      if (want === manual) return;
      manual = want;
      if (manual) cancelAnimationFrame(raf); else if (active) { clock.getDelta(); frame(); }
    },
    /** Testing aid (manual clock): advance one frame of `dt` seconds; render it unless `draw` is false. */
    step(dt = 1 / 60, draw = true) { if (!st.disposed) step(Math.max(0, Math.min(0.1, dt)), draw); },
    /** Progress (0..1) of the tick being played, or null when idle. */
    tickProgress() { return st.current ? Math.min(1, st.current.tl.t / st.current.tl.D) : null; },
    resize() { resize(); },
    stats() {
      const i = renderer.info;
      return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0,
        units: st.units.size, ravens: st.ravens.size, assets: lib.stats, active, framing: effectiveFraming(), live: st.live,
        camera: { distance: camera.position.distanceTo(controls.target), fitted: st.D0, width: st.width, height: st.height, aspect: camera.aspect } };
    },
    dispose() {
      if (st.disposed) return;
      if (st.current) finishCurrent();
      st.disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', onWinResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('scroll', onScroll, { capture: true });
      mq?.removeEventListener?.('change', onMq);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      controls.dispose();
      for (const v of st.units.values()) disposeUnitView(v);
      for (const d of st.dying) disposeUnitView(d.v);
      for (const v of st.ravens.values()) disposeRavenView(v);
      for (const g of st.ghosts) disposeRavenView(g.v);
      st.units.clear(); st.dying.length = 0; st.ravens.clear(); st.ghosts.length = 0;
      disposeBoard();
      for (const rec of hlMeshes.values()) for (const im of [rec.fill, rec.line, rec.xray]) im?.dispose();
      fx.dispose();
      for (const x of disposables) x.dispose?.();
      bgMesh.geometry.dispose(); bgMat.dispose();
      envRT?.dispose();
      sun.shadow.map?.dispose();
      destroyPipeline();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove(); overlay.remove();
      for (const s of Object.values(st.listeners)) s.clear();
    },
  };

  applyQuality();
  resize(true);
  frame();
  return view;
}
