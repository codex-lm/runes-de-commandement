// js/render/fx.js — battle effects for the 3D view: particles, projectiles, magic shapes, floating numbers.
//
// Everything is cosmetic and self-timed (seconds). scene.js schedules *when* effects start so that they
// line up with a TickReport; this module only animates them. All effects share a few GPU pools:
//   - two THREE.Points pools (soft "dust/smoke" with normal blending, glowing "sparks/magic" additive),
//   - one InstancedMesh pool of tumbling debris (raven feathers),
//   - small per-effect meshes built on shared geometries (rings, domes, orbs, rune circle, glints),
//   - one PointLight for impact flashes (always present, so adding it never recompiles materials),
//   - DOM spans for damage / heal numbers (crisp at any zoom), positioned in an overlay div; numbers and labels
//     that would overlap on screen are pushed apart (damage up, labels down).
//
// Usage (scene.js): const fx = new Fx({ root, camera, overlay, getTemplate }); each frame fx.update(dt).
// Magic is HDR (colours > 1): in quality 'high' the view blooms it; in 'low' the halo sprites are drawn larger.

import * as THREE from '../../vendor/three/build/three.module.js';

const TAU = Math.PI * 2;
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(), tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ------------------------------------------------------------------ CSS for the DOM overlay (injected once)
const STYLE_ID = 'rdc-fx-style';
function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
.rdc-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;contain:strict}
.rdc-num{position:absolute;left:0;top:0;font:700 23px/1 'Alegreya Sans','Segoe UI',system-ui,sans-serif;color:#fff;white-space:nowrap;
 will-change:transform,opacity;font-variant-numeric:tabular-nums;letter-spacing:.01em;
 text-shadow:1px 1px 0 #120f0d,-1px 1px 0 #120f0d,1px -1px 0 #120f0d,-1px -1px 0 #120f0d,0 1px 0 #120f0d,0 -1px 0 #120f0d,1px 0 0 #120f0d,-1px 0 0 #120f0d,0 3px 6px rgba(0,0,0,.55)}
.rdc-num.dmg{color:#ff7d5e}.rdc-num.big{font-size:30px;color:#ff5a3c}.rdc-num.heal{color:#a6ec84}.rdc-num.regen{color:#c3e8a4;font-size:17px}
.rdc-num.label{font:700 12px/1 'Alegreya Sans','Segoe UI',system-ui,sans-serif;color:#f0cd7a;letter-spacing:.09em;text-transform:uppercase}
.rdc-num.info{font:600 14px/1 'Alegreya Sans','Segoe UI',system-ui,sans-serif;color:#efe4cc;letter-spacing:.03em}
.rdc-num .rdc-sub{font-size:.52em;margin-left:2px;vertical-align:.45em;opacity:.9}
`;
  document.head.appendChild(st);
}

// ------------------------------------------------------------------ canvas textures
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function starTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.18, 'rgba(255,250,230,0.8)'); rg.addColorStop(0.5, 'rgba(255,240,200,0.12)'); rg.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.95)';
    for (const [rx, ry] of [[w * 0.48, 3.2], [3.2, h * 0.48]]) { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.fill(); }
    g.globalAlpha = 0.45;
    for (const a of [Math.PI / 4, -Math.PI / 4]) { g.save(); g.translate(cx, cy); g.rotate(a); g.beginPath(); g.ellipse(0, 0, w * 0.26, 2, 0, 0, TAU); g.fill(); g.restore(); }
  });
}
/** Soft round glow (orb halos, fire burst core). */
function glowTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.22, 'rgba(255,255,255,0.75)'); rg.addColorStop(0.55, 'rgba(255,255,255,0.18)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
  });
}
/** Ragged fire ball: hot core, licks of flame around (fireball impact). */
function fireTexture() {
  return canvasTex(128, 128, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    let seed = 11;
    const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 18; i++) {
      const a = r() * TAU, d = r() * w * 0.2, rad = w * (0.12 + r() * 0.16);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const rg = g.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, 'rgba(255,170,70,0.5)'); rg.addColorStop(0.6, 'rgba(240,90,20,0.24)'); rg.addColorStop(1, 'rgba(180,40,10,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    }
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.26);
    core.addColorStop(0, 'rgba(255,250,225,1)'); core.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = core; g.fillRect(0, 0, w, h);
  });
}
/** A golden circle of rune-like glyphs, drawn with strokes (no font dependency). */
function runeRingTexture() {
  return canvasTex(512, 512, (g, w) => {
    const c = w / 2;
    g.strokeStyle = 'rgba(255,214,120,1)'; g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowColor = 'rgba(255,190,80,0.9)'; g.shadowBlur = 14;
    g.lineWidth = 6; g.beginPath(); g.arc(c, c, w * 0.46, 0, TAU); g.stroke();
    g.lineWidth = 3; g.beginPath(); g.arc(c, c, w * 0.335, 0, TAU); g.stroke();
    const n = 14; let seed = 7;
    const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    g.lineWidth = 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      g.save(); g.translate(c + Math.cos(a) * w * 0.4, c + Math.sin(a) * w * 0.4); g.rotate(a + Math.PI / 2);
      const hh = 22, ww = 11;
      g.beginPath(); g.moveTo(0, -hh); g.lineTo(0, hh);            // stave
      const kind = Math.floor(r() * 5);
      if (kind === 0) { g.moveTo(0, -hh); g.lineTo(ww, -hh + 10); g.moveTo(0, -4); g.lineTo(ww, -hh + 18); }
      else if (kind === 1) { g.moveTo(0, -hh + 4); g.lineTo(ww, -4); g.lineTo(0, 8); }
      else if (kind === 2) { g.moveTo(-ww, -hh + 6); g.lineTo(ww, hh - 6); }
      else if (kind === 3) { g.moveTo(0, -6); g.lineTo(-ww, -hh + 2); g.moveTo(0, -6); g.lineTo(ww, -hh + 2); }
      else { g.moveTo(0, -hh); g.lineTo(ww, -hh + 9); g.lineTo(0, -hh + 18); g.moveTo(0, 0); g.lineTo(ww, 12); }
      g.stroke(); g.restore();
    }
  });
}

// ------------------------------------------------------------------ point pools
const POINT_VS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, aSize * uScale / max(0.1, -mv.z));
  vColor = aColor; vAlpha = aAlpha;
}`;
const POINT_FS = `
uniform float uGlow;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float soft = 1.0 - smoothstep(0.35, 1.0, d);
  float core = exp(-d * d * 7.0);
  float a = mix(soft, core * 0.9 + soft * 0.25, uGlow) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * (1.0 + core * uGlow * 1.5), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class PointPool {
  constructor(cap, { additive = false, glow = 0, renderOrder = 10 } = {}) {
    this.cap = cap; this.n = 0;
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3);
    this.alpha = new Float32Array(cap); this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3); this.age = new Float32Array(cap); this.life = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap); this.a0 = new Float32Array(cap);
    this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    const mk = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('position', mk(this.pos, 3)); g.setAttribute('aColor', mk(this.col, 3));
    g.setAttribute('aAlpha', mk(this.alpha, 1)); g.setAttribute('aSize', mk(this.size, 1));
    g.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 600 }, uGlow: { value: glow } };
    const m = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false; this.points.renderOrder = renderOrder;
  }
  /** Spawn one particle. c: THREE.Color (linear). */
  spawn(x, y, z, vx, vy, vz, life, size0, size1, c, alpha = 1, drag = 1.5, grav = 0) {
    let i = this.n;
    if (i >= this.cap) { i = Math.floor(Math.random() * this.cap); } else this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.age[i] = 0; this.life[i] = Math.max(0.05, life); this.s0[i] = size0; this.s1[i] = size1; this.a0[i] = alpha;
    this.drag[i] = drag; this.grav[i] = grav; this.alpha[i] = 0; this.size[i] = size0;
  }
  copy(from, to) {
    for (const arr of [this.pos, this.vel, this.col]) { arr[to * 3] = arr[from * 3]; arr[to * 3 + 1] = arr[from * 3 + 1]; arr[to * 3 + 2] = arr[from * 3 + 2]; }
    for (const arr of [this.alpha, this.size, this.age, this.life, this.s0, this.s1, this.a0, this.drag, this.grav]) arr[to] = arr[from];
  }
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.n--; if (i !== this.n) this.copy(this.n, i); continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.age[i] / this.life[i];
      this.alpha[i] = this.a0[i] * Math.min(1, t * 8) * Math.pow(1 - t, 1.3);
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * easeOut(t);
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    if (this.n > 0) {
      // upload only the live particles, not the whole pool
      for (const k of ['position', 'aColor', 'aAlpha', 'aSize']) {
        const a = g.attributes[k];
        a.clearUpdateRanges(); a.addUpdateRange(0, this.n * a.itemSize); a.needsUpdate = true;
      }
    }
  }
  clear() { this.n = 0; this.points.geometry.setDrawRange(0, 0); }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); }
}

// ------------------------------------------------------------------ debris (feathers)
class DebrisPool {
  constructor(cap = 64) {
    this.cap = cap; this.items = [];
    const shape = new THREE.Shape([new THREE.Vector2(0, -0.045), new THREE.Vector2(0.014, -0.005), new THREE.Vector2(0, 0.045), new THREE.Vector2(-0.012, 0)]);
    const g = new THREE.ShapeGeometry(shape);
    const m = new THREE.MeshStandardMaterial({ color: '#1f2534', roughness: 0.75, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(g, m, cap);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.castShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }
  spawn(pos, vel, life = 1.6, scale = 1.4) {
    if (this.items.length >= this.cap) this.items.shift();
    this.items.push({ p: pos.clone(), v: vel.clone(), age: 0, life, s: scale * rnd(0.8, 1.2), rot: new THREE.Euler(rnd(0, TAU), rnd(0, TAU), rnd(0, TAU)), spin: new THREE.Vector3(rnd(-6, 6), rnd(-4, 4), rnd(-6, 6)), ph: rnd(0, TAU) });
  }
  update(dt) {
    let w = 0;
    for (const it of this.items) {
      it.age += dt;
      if (it.age >= it.life) continue;
      const k = Math.exp(-2.6 * dt);
      it.v.x *= k; it.v.z *= k; it.v.y = it.v.y * k - 1.2 * dt;
      it.p.addScaledVector(it.v, dt);
      it.p.x += Math.sin(it.age * 5 + it.ph) * 0.25 * dt;
      it.rot.x += it.spin.x * dt; it.rot.y += it.spin.y * dt; it.rot.z += it.spin.z * dt;
      const t = it.age / it.life, s = it.s * (t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1);
      tmpQ.setFromEuler(it.rot); tmpS.set(s, s, s);
      tmpM.compose(it.p, tmpQ, tmpS);
      this.mesh.setMatrixAt(w, tmpM);
      this.items[w++] = it;
    }
    this.items.length = w;
    this.mesh.count = w;
    if (w) this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.items.length = 0; this.mesh.count = 0; }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
}

// ------------------------------------------------------------------ ward dome shader
const DOME_VS = `
varying vec3 vN; varying vec3 vV; varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vY = position.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const DOME_FS = `
uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
varying vec3 vN; varying vec3 vV; varying float vY;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float fres = pow(f, 2.2);
  float band = 0.5 + 0.5 * sin(vY * 38.0 - uTime * 5.0);
  float shimmer = 0.55 + 0.45 * sin(uTime * 3.0 + vY * 9.0);
  float a = (fres * 0.85 + band * 0.12 * shimmer + 0.04) * uOpacity;
  gl_FragColor = vec4(uColor * (0.8 + fres), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ the FX system
export class Fx {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root     group the effects are added to (in the scene)
   * @param {THREE.Camera} o.camera
   * @param {HTMLElement} o.overlay     absolutely positioned div over the canvas (floating numbers)
   * @param {(key: string) => ({ scene: THREE.Object3D, info: object })} o.getTemplate  asset templates (prop_arrow…)
   */
  constructor({ root, camera, overlay, getTemplate }) {
    injectStyle();
    this.root = root; this.camera = camera; this.overlay = overlay; this.getTemplate = getTemplate;
    this.reduced = false; this.density = 1; this.time = 0;
    this.viewW = 1; this.viewH = 1;
    this.effects = [];            // { update(dt) -> bool, dispose() }
    this.numbers = [];
    this.soft = new PointPool(900, { additive: false, glow: 0, renderOrder: 11 });
    this.bright = new PointPool(1400, { additive: true, glow: 1, renderOrder: 12 });
    this.debris = new DebrisPool(72);
    root.add(this.soft.points, this.bright.points, this.debris.mesh);
    this.light = new THREE.PointLight('#ffb060', 0, 7, 1.6);
    this.light.position.set(0, -50, 0);
    root.add(this.light);
    this.lightT = 0; this.lightLife = 1; this.lightPeak = 0;
    // shared geometries / textures
    this.geo = {
      ring: new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2),
      disc: new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2),
      dome: new THREE.SphereGeometry(0.62, 28, 12, 0, TAU, 0, Math.PI / 2),
      orb: new THREE.IcosahedronGeometry(1, 1),
      plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    };
    this.tex = { star: starTexture(), runes: runeRingTexture(), glow: glowTexture(), fire: fireTexture() };
    this.quality = 'high';
    this.colors = {};
  }

  col(hex) { return this.colors[hex] ?? (this.colors[hex] = new THREE.Color(hex)); }

  /** Particle density multiplier (quality / reduced motion). */
  setQuality(q) { this.quality = q === 'low' ? 'low' : 'high'; this.density = q === 'low' ? 0.55 : 1; }
  /** Halo size factor: without bloom ('low') the sprites carry the whole glow. */
  get haloK() { return this.quality === 'low' ? 1.35 : 1; }
  setReducedMotion(b) { this.reduced = !!b; }
  /** Call on resize: drawing-buffer height in px and CSS size of the overlay. */
  resize(bufferH, cssW, cssH) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov ?? 28);
    const s = bufferH / (2 * Math.tan(fov / 2));
    this.soft.uniforms.uScale.value = s; this.bright.uniforms.uScale.value = s;
    this.viewW = cssW; this.viewH = cssH;
  }
  n(count) { return Math.max(1, Math.round(count * this.density * (this.reduced ? 0.45 : 1))); }

  // ---------------------------------------------------------------- particles
  /** Earthy dust puff at ground position. */
  dust(pos, { count = 8, color = '#b7a07a', radius = 0.3, size = 0.22, life = 0.7, up = 0.35 } = {}) {
    const c = this.col(color);
    for (let i = 0, n = this.n(count); i < n; i++) {
      const a = rnd(0, TAU), r = rnd(0.2, 1) * radius, sp = rnd(0.4, 1.0);
      this.soft.spawn(pos.x + Math.cos(a) * r * 0.4, pos.y + 0.04, pos.z + Math.sin(a) * r * 0.4, Math.cos(a) * sp * radius * 2.2, rnd(0.1, 1) * up, Math.sin(a) * sp * radius * 2.2,
        life * rnd(0.7, 1.2), size * rnd(0.6, 1), size * rnd(1.6, 2.4), c, 0.55, 3.2, -0.05);
    }
  }
  /** Rising sparkles (heal, delivery, magic). */
  sparkles(pos, { count = 16, color = '#ffe08a', radius = 0.35, height = 0.9, life = 0.9, size = 0.09 } = {}) {
    const c = this.col(color);
    for (let i = 0, n = this.n(count); i < n; i++) {
      const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * radius;
      this.bright.spawn(pos.x + Math.cos(a) * r, pos.y + rnd(0, 0.3), pos.z + Math.sin(a) * r, rnd(-0.05, 0.05), rnd(0.5, 1.2) * height, rnd(-0.05, 0.05),
        life * rnd(0.6, 1.2), size * rnd(0.7, 1.3), size * 0.3, c, rnd(0.6, 1), 1.8, 0);
    }
  }
  /** Fast impact sparks. dir: optional THREE.Vector3 bias. */
  sparks(pos, { count = 10, color = '#ffd9a0', speed = 2.4, life = 0.32, size = 0.07, dir = null } = {}) {
    const c = this.col(color);
    for (let i = 0, n = this.n(count); i < n; i++) {
      tmpV.set(rnd(-1, 1), rnd(0.1, 1), rnd(-1, 1)).normalize();
      if (dir) tmpV.addScaledVector(dir, 0.9).normalize();
      const sp = speed * rnd(0.5, 1);
      this.bright.spawn(pos.x, pos.y, pos.z, tmpV.x * sp, tmpV.y * sp, tmpV.z * sp, life * rnd(0.6, 1.2), size, size * 0.4, c, 1, 3.5, 4);
    }
  }
  embers(pos, { count = 26, color = '#ffa040', speed = 2.2, life = 0.9, size = 0.08 } = {}) {
    const c = this.col(color), c2 = this.col('#ffe0a0');
    for (let i = 0, n = this.n(count); i < n; i++) {
      const a = rnd(0, TAU), up = rnd(0.3, 1.2), sp = speed * rnd(0.3, 1);
      this.bright.spawn(pos.x, pos.y + 0.1, pos.z, Math.cos(a) * sp, up * speed, Math.sin(a) * sp, life * rnd(0.5, 1.3), size * rnd(0.7, 1.4), size * 0.3, i % 3 ? c : c2, 1, 2.2, 3.2);
    }
  }
  smoke(pos, { count = 7, color = '#3a3632', radius = 0.4, life = 1.4, size = 0.45 } = {}) {
    const c = this.col(color);
    for (let i = 0, n = this.n(count); i < n; i++) {
      const a = rnd(0, TAU), r = rnd(0, radius);
      this.soft.spawn(pos.x + Math.cos(a) * r, pos.y + rnd(0.1, 0.4), pos.z + Math.sin(a) * r, Math.cos(a) * 0.15, rnd(0.25, 0.6), Math.sin(a) * 0.15,
        life * rnd(0.7, 1.2), size * rnd(0.6, 1), size * rnd(1.8, 2.6), c, 0.42, 0.9, -0.08);
    }
  }
  /** One trail particle (used by projectiles every frame). */
  trail(pos, color, size = 0.12, life = 0.25, soft = false) {
    const c = this.col(color);
    (soft ? this.soft : this.bright).spawn(pos.x + rnd(-0.01, 0.01), pos.y + rnd(-0.01, 0.01), pos.z + rnd(-0.01, 0.01), rnd(-0.08, 0.08), rnd(0, 0.15), rnd(-0.08, 0.08), life, size, size * 0.2, c, soft ? 0.35 : 0.9, 2, 0);
  }
  feathers(pos, { count = 12 } = {}) {
    for (let i = 0, n = this.n(count); i < n; i++) this.debris.spawn(pos, tmpV.set(rnd(-1.4, 1.4), rnd(0.2, 1.6), rnd(-1.4, 1.4)), rnd(1.2, 2.0));
  }
  /** Slow drifting wisps (persistent statuses). */
  wisp(pos, color = '#b07aff', radius = 0.35) {
    const a = rnd(0, TAU);
    this.bright.spawn(pos.x + Math.cos(a) * radius, pos.y + rnd(0.05, 0.4), pos.z + Math.sin(a) * radius, -Math.sin(a) * 0.25, rnd(0.2, 0.45), Math.cos(a) * 0.25, rnd(0.7, 1.1), 0.07, 0.02, this.col(color), 0.7, 1, 0);
  }

  // ---------------------------------------------------------------- light flash
  flash(pos, color = '#ffb060', peak = 20, life = 0.35) {
    if (this.lightT < this.lightLife && this.light.intensity > peak) return;
    this.light.position.copy(pos); this.light.color.set(color);
    this.lightPeak = peak; this.lightLife = life; this.lightT = 0;
  }

  // ---------------------------------------------------------------- shapes
  _add(obj, update) {
    this.root.add(obj);
    const fx = { obj, update, dispose: () => { this.root.remove(obj); obj.traverse((o) => { if (o.material && !o.userData.sharedMat) o.material.dispose(); }); } };
    this.effects.push(fx);
    return fx;
  }
  /** Flat expanding ring on the ground. */
  ring(pos, { color = '#ffd27a', from = 0.3, to = 1.2, life = 0.6, opacity = 0.85, width = 1, additive = true, y = 0.04 } = {}) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(this.geo.ring, m);
    mesh.position.set(pos.x, pos.y + y, pos.z); mesh.renderOrder = 9;
    let t = 0;
    this._add(mesh, (dt) => {
      t += dt; const k = clamp01(t / life);
      const s = from + (to - from) * easeOut(k);
      mesh.scale.set(s, 1 + (width - 1) * k, s);
      m.opacity = opacity * (1 - k) * (k < 0.1 ? k * 10 : 1);
      return t < life;
    });
  }
  /** Soft dark scorch disc that fades out (fireball). */
  scorch(pos, { radius = 0.9, life = 2.2 } = {}) {
    const m = new THREE.MeshBasicMaterial({ color: '#1c130c', transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(this.geo.disc, m);
    mesh.position.set(pos.x, pos.y + 0.025, pos.z); mesh.scale.setScalar(radius); mesh.renderOrder = 8;
    let t = 0;
    this._add(mesh, (dt) => { t += dt; m.opacity = 0.4 * (1 - clamp01(t / life)); return t < life; });
  }
  /** Ward shimmer dome. Returns nothing; for a persistent dome use makeDome(). */
  dome(pos, { color = '#8fc8ff', life = 1.1, scale = 1 } = {}) {
    const mesh = this.makeDome(color);
    mesh.position.copy(pos);
    let t = 0;
    this._add(mesh, (dt) => {
      t += dt; const k = clamp01(t / life);
      const grow = k < 0.35 ? easeOut(k / 0.35) : 1;
      const s = scale * (0.55 + 0.45 * grow + (k < 0.5 ? Math.sin(k / 0.5 * Math.PI) * 0.06 : 0));
      mesh.scale.set(s, s * (0.9 + 0.1 * grow), s);
      mesh.material.uniforms.uOpacity.value = (k < 0.15 ? k / 0.15 : 1) * (1 - clamp01((k - 0.55) / 0.45)) * 1.25;
      mesh.material.uniforms.uTime.value = this.time;
      return t < life;
    });
  }
  /** A dome mesh with its own material (uniforms.uOpacity / uTime / uColor), for persistent status display. */
  makeDome(color = '#8fc8ff') {
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.5 }, uTime: { value: 0 } },
      vertexShader: DOME_VS, fragmentShader: DOME_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.geo.dome, m);
    mesh.renderOrder = 13;
    return mesh;
  }
  /** Purple spiral of motes converging on the target (hex / maléfice). */
  swirl(pos, { color = '#b26bff', life = 0.9, height = 0.9 } = {}) {
    const c = this.col(color), c2 = this.col('#e3c4ff');
    this.ring(pos, { color, from: 1.1, to: 0.25, life: life * 0.8, opacity: 0.7 });
    const n = this.n(30);
    let t = 0, emitted = 0;
    const holder = new THREE.Object3D();
    this._add(holder, (dt) => {
      t += dt;
      const want = Math.min(n, Math.floor((t / (life * 0.7)) * n));
      for (; emitted < want; emitted++) {
        const a = emitted * 0.55 + t * 4, r = 0.55 * (1 - emitted / n) + 0.15;
        const y = pos.y + 0.1 + (emitted / n) * height;
        this.bright.spawn(pos.x + Math.cos(a) * r, y, pos.z + Math.sin(a) * r, -Math.sin(a) * 1.4 - Math.cos(a) * 0.6, 0.25, Math.cos(a) * 1.4 - Math.sin(a) * 0.6, 0.55, 0.1, 0.03, emitted % 3 ? c : c2, 0.95, 1.2, 0);
      }
      return t < life;
    });
  }
  /** Shield glint: a star that pops at a point (hold). */
  glint(pos, { color = '#ffffff', size = 0.42, life = 0.42 } = {}) {
    const m = new THREE.SpriteMaterial({ map: this.tex.star, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const sp = new THREE.Sprite(m);
    sp.position.copy(pos); sp.renderOrder = 14;
    let t = 0;
    this._add(sp, (dt) => {
      t += dt; const k = clamp01(t / life);
      const s = size * Math.sin(k * Math.PI) * (1 + 0.2 * k);
      sp.scale.set(s, s, 1); m.rotation = k * 0.9; m.opacity = Math.sin(k * Math.PI);
      return t < life;
    });
  }
  /** Golden rune circle pulsing on the ground, attached to `parent` (a unit root) so it follows it. */
  runeRing(parent, { color = '#ffcf6a', life = 1.6, radius = 0.86, y = 0.04 } = {}) {
    const m = new THREE.MeshBasicMaterial({ map: this.tex.runes, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const mesh = new THREE.Mesh(this.geo.plane, m);
    mesh.position.set(0, y, 0); mesh.renderOrder = 15;
    parent.add(mesh);
    let t = 0;
    const fx = { obj: mesh, update: (dt) => {
      t += dt; const k = clamp01(t / life);
      const pulse = 1 + Math.sin(k * Math.PI * 3) * 0.06;
      const s = radius * 2 * (0.7 + 0.3 * easeOut(Math.min(1, k * 2.5))) * pulse;
      mesh.scale.set(s, 1, s); mesh.rotation.y = k * 1.4;
      m.opacity = (k < 0.12 ? k / 0.12 : 1) * (1 - clamp01((k - 0.6) / 0.4)) * 1.4;
      return t < life;
    }, dispose: () => { mesh.removeFromParent(); m.dispose(); } };
    this.effects.push(fx);
    const wp = parent.getWorldPosition(new THREE.Vector3());
    this.sparkles(wp, { color: '#ffd77a', count: 14, radius: radius * 0.9, height: 0.8 });
  }

  // ---------------------------------------------------------------- projectiles
  /**
   * Arrow on a parabolic arc that sticks briefly where it lands.
   * @param {THREE.Vector3} from @param {THREE.Vector3} to
   * @param {{ flight?: number, apex?: number, delay?: number, stick?: number, onHit?: Function }} o  seconds
   */
  arrow(from, to, { flight = 0.25, apex = null, delay = 0, stick = 0.45, onHit = null, scale = 1.5 } = {}) {
    const tpl = this.getTemplate?.('prop_arrow');
    const obj = tpl ? tpl.scene.clone(true) : new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.3).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#b08a5a' }));
    obj.traverse((o) => { o.castShadow = true; if (o.material) o.userData.sharedMat = true; });
    obj.scale.setScalar(scale); obj.visible = false;
    const a = from.clone(), b = to.clone();
    const dist = a.distanceTo(b);
    const h = apex ?? Math.min(1.15, 0.3 + dist * 0.12);
    let t = -delay, landed = false;
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    const at = (k, out) => out.lerpVectors(a, b, k).addScaledVector(UP, h * 4 * k * (1 - k));
    this._add(obj, (dt) => {
      t += dt;
      if (t < 0) return true;
      obj.visible = true;
      if (t < flight) {
        const k = t / flight;
        at(k, p); at(Math.min(1, k + 0.02), q);
        obj.position.copy(p);
        if (q.distanceToSquared(p) > 1e-8) obj.lookAt(q);
        return true;
      }
      if (!landed) {
        landed = true;
        at(1, p); at(0.98, q);
        obj.position.copy(p).addScaledVector(tmpV2.subVectors(p, q).normalize(), 0.03);
        tmpV.subVectors(p, q); obj.lookAt(tmpV.add(p));
        onHit?.(p);
      }
      const k = (t - flight) / stick;
      if (k > 0.7) obj.scale.setScalar(scale * (1 - (k - 0.7) / 0.3));
      return k < 1;
    });
  }
  /**
   * Glowing orb (magic bolt or fireball) with a particle trail.
   * o: { flight, delay, color, size, apex, kind: 'bolt'|'fireball', onHit(pos) }
   */
  orb(from, to, { flight = 0.25, delay = 0, color = '#8fd0ff', size = 0.07, apex = null, kind = 'bolt', onHit = null } = {}) {
    // HDR core (blooms in 'high') kept moderate so the fireball reads orange, not a white dot; the additive halo
    // sprite carries the hot centre and the coloured glow
    const fire = kind === 'fireball';
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(fire ? '#ffb45a' : color).multiplyScalar(fire ? 1.9 : 1.7) });
    const mesh = new THREE.Mesh(this.geo.orb, m);
    mesh.scale.setScalar(size); mesh.visible = false;
    const hm = new THREE.SpriteMaterial({ map: fire ? this.tex.glow : this.tex.star, color: new THREE.Color(fire ? '#ff9a3a' : color).multiplyScalar(fire ? 2.2 : 1.6),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const halo = new THREE.Sprite(hm);
    const hs = (fire ? 7 : 6) * this.haloK;          // child of the core (scaled by `size`)
    halo.scale.set(hs, hs, 1); halo.renderOrder = 14;
    mesh.add(halo);
    const a = from.clone(), b = to.clone();
    const h = apex ?? (kind === 'fireball' ? 0.6 + a.distanceTo(b) * 0.18 : 0.12);
    let t = -delay, acc = 0, done = false;
    const p = new THREE.Vector3();
    this._add(mesh, (dt) => {
      t += dt;
      if (t < 0) return true;
      if (done) return false;
      mesh.visible = true;
      const k = Math.min(1, t / flight);
      p.lerpVectors(a, b, k).addScaledVector(UP, h * 4 * k * (1 - k));
      mesh.position.copy(p);
      mesh.rotation.x += dt * 6; mesh.rotation.y += dt * 4;
      hm.rotation += dt * 3;
      acc += dt;
      const step = kind === 'fireball' ? 0.012 : 0.018;
      while (acc > step) {
        acc -= step;
        if (kind === 'fireball') { this.trail(p, '#ff8a30', size * 3.4, 0.3); this.trail(p, '#ffd070', size * 1.8, 0.18); if (Math.random() < 0.3) this.trail(p, '#4a3a30', size * 3, 0.6, true); }
        else this.trail(p, color, size * 2.6, 0.22);
      }
      if (k >= 1) { done = true; onHit?.(p.clone()); return false; }
      return true;
    });
  }
  /** Stream of sparkles flying from caster to target (support spells). */
  stream(from, to, { flight = 0.25, delay = 0, color = '#ffe08a' } = {}) {
    const a = from.clone(), b = to.clone();
    let t = -delay, acc = 0;
    const p = new THREE.Vector3(), holder = new THREE.Object3D();
    this._add(holder, (dt) => {
      t += dt;
      if (t < 0) return true;
      acc += dt;
      while (acc > 0.01) {
        acc -= 0.01;
        const k = clamp01(t / flight - Math.random() * 0.3);
        p.lerpVectors(a, b, k).addScaledVector(UP, 0.35 * 4 * k * (1 - k));
        p.x += rnd(-0.06, 0.06); p.z += rnd(-0.06, 0.06);
        this.trail(p, color, 0.09, 0.3);
      }
      return t < flight;
    });
  }

  /** Short ball of fire at an impact point (fireball): pops to `size` world units, then burns out (~0.35 s). */
  fireBurst(pos, { size = 1.6, life = 0.36, color = '#ffb060' } = {}) {
    const m = new THREE.SpriteMaterial({ map: this.tex.fire, color: new THREE.Color(color).multiplyScalar(1.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const sp = new THREE.Sprite(m);
    sp.position.copy(pos); sp.renderOrder = 14;
    const full = size * this.haloK;
    let t = 0;
    this._add(sp, (dt) => {
      t += dt; const k = clamp01(t / life);
      const grow = easeOut(Math.min(1, k / 0.4));
      sp.scale.setScalar(Math.max(0.001, full * (0.25 + 0.75 * grow) * (1 + 0.15 * k)));
      sp.position.y = pos.y + k * 0.25;
      m.rotation = k * 0.8;
      m.opacity = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      return t < life;
    });
  }

  // ---------------------------------------------------------------- floating numbers (DOM)
  /**
   * Floating text anchored at a world position.
   * @param {THREE.Vector3} pos  @param {string} text
   * @param {{ kind?: 'dmg'|'big'|'heal'|'regen'|'label'|'info', delay?: number, life?: number, dx?: number, dy?: number, sub?: string }} o
   *   dx / dy: screen offset in CSS px (dy < 0 = higher); sub: small suffix (e.g. "×2" when several hits are summed).
   */
  number(pos, text, { kind = 'dmg', delay = 0, life = 1.05, dx = 0, dy = 0, sub = '' } = {}) {
    if (!this.overlay) return;
    const el = document.createElement('div');
    el.className = `rdc-num ${kind}`; el.textContent = text; el.style.opacity = '0';
    if (sub) { const s = document.createElement('span'); s.className = 'rdc-sub'; s.textContent = sub; el.appendChild(s); }
    this.overlay.appendChild(el);
    this.numbers.push({ el, p: pos.clone(), t: -delay, life, dx, dy, rise: this.reduced ? 10 : kind === 'label' ? 24 : 40, kind, w: 0, h: 0, push: 0, pushInit: false });
  }

  // ---------------------------------------------------------------- frame
  /** Advance all effects by dt seconds (pass 0 while paused; numbers keep their place). */
  update(dt) {
    this.time += dt;
    this.soft.update(dt); this.bright.update(dt); this.debris.update(dt);
    let w = 0;
    for (const fx of this.effects) { if (fx.update(dt)) this.effects[w++] = fx; else fx.dispose(); }
    this.effects.length = w;
    // flash light
    if (this.lightT < this.lightLife) {
      this.lightT += dt;
      const k = clamp01(this.lightT / this.lightLife);
      this.light.intensity = this.lightPeak * (k < 0.12 ? k / 0.12 : Math.pow(1 - (k - 0.12) / 0.88, 2));
    } else this.light.intensity = 0;
    this.updateNumbers(dt);
  }
  updateNumbers(dt) {
    if (!this.numbers.length) return;
    let w = 0;
    for (const n of this.numbers) {
      n.t += dt;
      if (n.t >= n.life) { n.el.remove(); continue; }
      this.numbers[w++] = n;
    }
    this.numbers.length = w;
    // sizes of the numbers that just appeared, read before any style write (one layout at most per frame)
    for (const n of this.numbers) if (n.t >= 0 && !n.w) { n.w = n.el.offsetWidth || 20; n.h = n.el.offsetHeight || 16; }
    // place every visible number, then push apart the ones that overlap (older ones keep their place):
    // damage / heal numbers move up, labels move down, eased so they never jitter
    const placed = this._placed ?? (this._placed = []);   // pooled boxes { x, y, w, h }
    let np = 0;
    const ease = Math.min(1, dt * 12);
    for (const n of this.numbers) {
      if (n.t < 0) continue;
      const k = n.t / n.life;
      tmpV.copy(n.p).project(this.camera);
      if (tmpV.z > 1 || tmpV.z < -1) { n.el.style.opacity = '0'; continue; }
      const x = (tmpV.x * 0.5 + 0.5) * this.viewW + n.dx - n.w / 2;
      const y0 = (-tmpV.y * 0.5 + 0.5) * this.viewH - easeOut(k) * n.rise - 44 + n.dy;
      const down = n.kind === 'label' || n.kind === 'info';
      let want = 0;
      for (let iter = 0; iter < 8; iter++) {
        const y = y0 + want;
        let hit = null;
        for (let i = 0; i < np; i++) { const b = placed[i]; if (x < b.x + b.w + 2 && x + n.w + 2 > b.x && y < b.y + b.h && y + n.h > b.y) { hit = b; break; } }
        if (!hit) break;
        want += down ? hit.y + hit.h + 1 - y : hit.y - n.h - 1 - y;
      }
      n.push = n.pushInit ? n.push + (want - n.push) * ease : want;
      n.pushInit = true;
      const y = y0 + n.push;
      const box = placed[np] ?? (placed[np] = { x: 0, y: 0, w: 0, h: 0 });
      np++;
      box.x = x; box.y = y0 + want; box.w = n.w; box.h = n.h;
      const pop = this.reduced ? 1 : k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.22 ? 1.15 - ((k - 0.12) / 0.1) * 0.15 : 1;
      n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${pop.toFixed(3)})`;
      n.el.style.opacity = String(k < 0.08 ? k / 0.08 : k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1);
    }
  }
  /**
   * Shader warm-up: one tiny instance of every effect material, at `pos`, so view.prepare() compiles their
   * programs before the first battle. Returns a function that removes them.
   */
  warmup(pos) {
    const objs = [];
    const add = (o) => { o.position.copy(pos); o.position.y += 0.01; o.scale.setScalar(1e-4); o.traverse((c) => { c.frustumCulled = false; }); this.root.add(o); objs.push(o); return o; };
    const mats = [
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }),   // ring
      new THREE.MeshBasicMaterial({ color: '#1c130c', transparent: true, depthWrite: false, toneMapped: false }),                                                       // scorch
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),                                                                                                                // orb core
      new THREE.MeshBasicMaterial({ map: this.tex.runes, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),                  // rune ring
    ];
    add(new THREE.Mesh(this.geo.ring, mats[0])); add(new THREE.Mesh(this.geo.disc, mats[1])); add(new THREE.Mesh(this.geo.orb, mats[2])); add(new THREE.Mesh(this.geo.plane, mats[3]));
    const sm = [
      new THREE.SpriteMaterial({ map: this.tex.star, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),   // glint
      new THREE.SpriteMaterial({ map: this.tex.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),                     // halos, fire
    ];
    for (const m of sm) add(new THREE.Sprite(m));
    const dome = add(this.makeDome('#8fc8ff'));
    const tpl = this.getTemplate?.('prop_arrow');
    if (tpl) add(tpl.scene.clone(true));
    return () => {
      for (const o of objs) this.root.remove(o);
      for (const m of [...mats, ...sm, dome.material]) m.dispose();
    };
  }

  /** Remove every running effect immediately. */
  clear() {
    for (const fx of this.effects) fx.dispose();
    this.effects.length = 0;
    for (const n of this.numbers) n.el.remove();
    this.numbers.length = 0;
    this.soft.clear(); this.bright.clear(); this.debris.clear();
    this.light.intensity = 0; this.lightT = this.lightLife;
  }
  dispose() {
    this.clear();
    this.soft.dispose(); this.bright.dispose(); this.debris.dispose();
    this.root.remove(this.soft.points, this.bright.points, this.debris.mesh, this.light);
    for (const g of Object.values(this.geo)) g.dispose();
    for (const t of Object.values(this.tex)) t.dispose();
  }
}
