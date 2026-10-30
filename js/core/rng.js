// js/core/rng.js — hasard déterministe et sérialisable (mulberry32).
// L'état tient dans un objet JSON { s } pour pouvoir cloner une bataille (structuredClone) et la rejouer.

export function hashSeed(input) {
  const str = String(input);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function createRng(seed) { return { s: (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0 }; }

export function rngNext(rng) {
  let t = (rng.s = (rng.s + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const rngInt = (rng, n) => Math.floor(rngNext(rng) * n);           // 0..n-1
export const rngRange = (rng, a, b) => a + Math.floor(rngNext(rng) * (b - a + 1)); // a..b inclus
export const rngPick = (rng, arr) => arr[rngInt(rng, arr.length)];
export const rngChance = (rng, p) => rngNext(rng) < p;
export function rngShuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rngInt(rng, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Sous-graine dérivée, stable : deriveSeed(run.seed, 'battle', 2)
export const deriveSeed = (...parts) => hashSeed(parts.join('|'));
