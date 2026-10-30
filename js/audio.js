// js/audio.js — sons entièrement synthétisés (WebAudio), aucun fichier.
// Le contexte audio ne démarre qu'au premier geste de l'utilisateur (politique des navigateurs).
// Toutes les fonctions sont sûres à appeler à tout moment : sans contexte (ou sans WebAudio) elles ne font rien.
//
// API :
//   armAudio()                       — attache l'écoute du premier geste (pointerdown / keydown / touchstart)
//   play(name, { delay, gain })      — name ∈ SOUNDS (ui, hover, rune, clash, whoosh, boom, heal, caw, shot, victory, defeat, coin, page, deny)
//   playBattleEvents(events, durMs)  — sons d'un TickReport, regroupés et étalés dans la durée de l'animation
//   setVolume(0..1), getVolume(), setMuted(bool), isMuted()
//   startAmbient(), stopAmbient(), setAmbientIntensity(0..1)   — fond musical : morceau Suno en boucle (repli : accords lents + notes éparses), sans bruit

let ctx = null;
let master = null, sfx = null, amb = null, comp = null;
let noiseBuf = null;
let volume = 0.7;
let muted = false;
let wantAmbient = false;
let ambientNodes = null;
let armed = false;
const lastPlayed = new Map();

export const SOUNDS = ['ui', 'hover', 'rune', 'clash', 'whoosh', 'boom', 'heal', 'caw', 'shot', 'victory', 'defeat', 'coin', 'page', 'deny'];

function ensureContext() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC({ latencyHint: 'interactive' });
  } catch { ctx = null; return null; }
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  sfx = ctx.createGain(); sfx.gain.value = 0.9;
  amb = ctx.createGain(); amb.gain.value = 0.0;
  sfx.connect(comp); amb.connect(comp); comp.connect(master); master.connect(ctx.destination);
  // 4 s de bruit blanc, réutilisé par tous les sons bruités et par le vent. Générateur mulberry32 : l'ancienne congruence
  // linéaire calculée en flottants perdait ses bits de poids faible et bouclait sur 419 échantillons, soit un bourdon
  // d'environ 115 Hz (hauteur d'une voix grave) que le filtre du vent transformait en voix de talkie-walkie.
  noiseBuf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 4), ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let seed = 0x9e3779b9;
  for (let i = 0; i < d.length; i++) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return ctx;
}

/** Attache l'écoute du premier geste : crée/reprend le contexte audio et lance l'ambiance si demandée. */
export function armAudio() {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  const done = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    window.removeEventListener('touchstart', unlock, true);
  };
  // On ne se désabonne qu'une fois le contexte réellement démarré (un événement synthétique ne suffit pas).
  function unlock(e) {
    if (e && e.isTrusted === false) return;
    const c = ensureContext();
    if (!c) { done(); return; }
    const go = () => { if (c.state === 'running') { if (wantAmbient) buildAmbient(); done(); } };
    if (c.state === 'suspended') c.resume().then(go).catch(() => {}); else go();
  }
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchstart', unlock, true);
}

/** Volume principal, 0..1. */
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
}
export const getVolume = () => volume;
/** Coupe / rétablit tout le son. */
export function setMuted(m) {
  muted = !!m;
  if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
}
export const isMuted = () => muted;

const ready = () => !!ctx && ctx.state === 'running' && !muted && volume > 0;

// ------------------------------------------------------------------ briques
function env(g, t, a, peak, dec, sustain = 0.0001) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
  g.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + a + dec);
}
function osc(type, freq, t, dur, { gain = 0.2, a = 0.005, out = sfx, detune = 0 } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
  env(g, t, a, gain, dur);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + a + dur + 0.05);
  return { o, g };
}
function noise(t, dur, { gain = 0.2, a = 0.005, type = 'bandpass', freq = 1000, q = 1, out = sfx, freqEnd = null } = {}) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + a + dur);
  const g = ctx.createGain(); env(g, t, a, gain, dur);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t, Math.random() * 1.2); src.stop(t + a + dur + 0.05);
  return { src, f, g };
}

// ------------------------------------------------------------------ sons
const synth = {
  ui(t, k) {
    osc('triangle', 740, t, 0.07, { gain: 0.10 * k });
    noise(t, 0.03, { gain: 0.05 * k, freq: 3200, q: 2 });
  },
  hover(t, k) { osc('sine', 1560, t, 0.05, { gain: 0.025 * k, a: 0.004 }); },
  page(t, k) { noise(t, 0.18, { gain: 0.06 * k, freq: 1800, freqEnd: 3800, q: 0.7, a: 0.02 }); },
  deny(t, k) { osc('square', 196, t, 0.12, { gain: 0.05 * k }); osc('square', 147, t + 0.08, 0.16, { gain: 0.05 * k }); },
  rune(t, k) {
    // carillon doux : deux partiels en quinte + un partiel inharmonique bref
    osc('sine', 1046.5, t, 0.9, { gain: 0.08 * k, a: 0.003 });
    osc('sine', 1568, t + 0.01, 0.6, { gain: 0.05 * k, a: 0.003, detune: 4 });
    osc('sine', 2794, t, 0.18, { gain: 0.02 * k, a: 0.002 });
  },
  coin(t, k) {
    osc('square', 1975, t, 0.08, { gain: 0.04 * k }); osc('square', 2637, t + 0.07, 0.25, { gain: 0.04 * k });
    osc('sine', 3951, t + 0.07, 0.3, { gain: 0.02 * k });
  },
  clash(t, k) {
    noise(t, 0.12, { gain: 0.22 * k, freq: 2600, q: 1.2, a: 0.002 });
    noise(t, 0.05, { gain: 0.16 * k, type: 'lowpass', freq: 500, a: 0.002 });
    for (const [f, gn, d] of [[523, 0.05, 0.28], [1187, 0.04, 0.22], [1873, 0.03, 0.18], [2650, 0.025, 0.14]]) {
      osc('triangle', f * (0.97 + Math.random() * 0.06), t, d, { gain: gn * k, a: 0.002 });
    }
  },
  whoosh(t, k) {
    noise(t, 0.28, { gain: 0.12 * k, freq: 500, freqEnd: 2600, q: 2.5, a: 0.06 });
    noise(t + 0.3, 0.06, { gain: 0.08 * k, type: 'lowpass', freq: 900, a: 0.002 }); // impact
  },
  boom(t, k) {
    noise(t, 0.9, { gain: 0.35 * k, type: 'lowpass', freq: 1800, freqEnd: 90, q: 0.7, a: 0.008 });
    const { o } = osc('sine', 90, t, 0.7, { gain: 0.3 * k, a: 0.005 });
    o.frequency.exponentialRampToValueAtTime(38, t + 0.6);
    noise(t + 0.05, 0.6, { gain: 0.06 * k, freq: 4000, q: 0.5, a: 0.05 }); // crépitement
  },
  heal(t, k) {
    [659.3, 880, 1108.7, 1318.5].forEach((f, i) => osc('sine', f, t + i * 0.07, 0.55, { gain: 0.06 * k, a: 0.03 }));
    osc('triangle', 2217, t + 0.28, 0.6, { gain: 0.015 * k, a: 0.05 });
  },
  caw(t, k) {
    // deux « kraa » en synthèse FM avec un formant passe-bande
    for (let i = 0; i < 2; i++) {
      const t0 = t + i * 0.24;
      const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
      const bp = ctx.createBiquadFilter(), g = ctx.createGain();
      car.type = 'sawtooth'; mod.type = 'sine';
      car.frequency.setValueAtTime(640 - i * 40, t0); car.frequency.exponentialRampToValueAtTime(420 - i * 30, t0 + 0.18);
      mod.frequency.setValueAtTime(155, t0);
      mg.gain.setValueAtTime(520, t0); mg.gain.exponentialRampToValueAtTime(140, t0 + 0.18);
      bp.type = 'bandpass'; bp.frequency.value = 1350; bp.Q.value = 2.2;
      env(g, t0, 0.012, 0.11 * k, 0.17);
      mod.connect(mg); mg.connect(car.frequency); car.connect(bp); bp.connect(g); g.connect(sfx);
      car.start(t0); mod.start(t0); car.stop(t0 + 0.25); mod.stop(t0 + 0.25);
    }
  },
  shot(t, k) {
    noise(t, 0.06, { gain: 0.2 * k, type: 'lowpass', freq: 700, a: 0.002 });
    noise(t + 0.02, 0.35, { gain: 0.07 * k, freq: 3000, q: 0.6, a: 0.01 }); // plumes
    const { o } = osc('sawtooth', 900, t + 0.03, 0.22, { gain: 0.05 * k });
    o.frequency.exponentialRampToValueAtTime(260, t + 0.25);
  },
  victory(t, k) {
    // fanfare : ré - la - ré, puis accord de ré majeur
    const brass = (f, t0, d, gn) => {
      const o = ctx.createOscillator(), f1 = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = f;
      f1.type = 'lowpass'; f1.frequency.setValueAtTime(600, t0); f1.frequency.linearRampToValueAtTime(2400, t0 + 0.08); f1.Q.value = 1;
      env(g, t0, 0.04, gn * k, d, 0.0001);
      o.connect(f1); f1.connect(g); g.connect(sfx); o.start(t0); o.stop(t0 + d + 0.1);
    };
    brass(293.7, t, 0.22, 0.07); brass(440, t + 0.2, 0.22, 0.07); brass(587.3, t + 0.4, 0.9, 0.08);
    brass(370, t + 0.42, 0.9, 0.05); brass(440, t + 0.44, 0.9, 0.05); brass(146.8, t + 0.4, 1.1, 0.06);
    [1174.7, 1480, 1760].forEach((f, i) => osc('sine', f, t + 0.45 + i * 0.05, 0.9, { gain: 0.015 * k, a: 0.02 }));
  },
  defeat(t, k) {
    [[220, 0], [174.6, 0.45], [146.8, 0.9]].forEach(([f, dt]) => {
      osc('triangle', f, t + dt, 0.7, { gain: 0.09 * k, a: 0.05 });
      osc('sine', f / 2, t + dt, 0.8, { gain: 0.06 * k, a: 0.08 });
    });
    noise(t, 1.6, { gain: 0.03 * k, type: 'lowpass', freq: 300, a: 0.4 });
  },
};

/**
 * Joue un son synthétisé.
 * @param {string} name  un des SOUNDS
 * @param {{delay?: number, gain?: number}} [opts] delay en secondes, gain multiplicateur
 */
export function play(name, { delay = 0, gain = 1 } = {}) {
  if (!ready() || !synth[name]) return;
  // anti-rafale : pas deux fois le même son à moins de 35 ms (sauf ui)
  const now = ctx.currentTime + delay;
  const last = lastPlayed.get(name) ?? -1;
  if (name !== 'ui' && Math.abs(now - last) < 0.035) return;
  lastPlayed.set(name, now);
  try { synth[name](now + 0.005, gain); } catch (e) { /* un son raté ne doit jamais casser le jeu */ }
}

/**
 * Sons d'un instant de bataille, étalés dans la durée de l'animation (ms).
 * @param {Array<object>} events  TickReport.events (sim.js)
 * @param {number} durationMs
 */
export function playBattleEvents(events, durationMs = 700) {
  if (!ready() || !Array.isArray(events)) return;
  const d = Math.max(0.12, durationMs / 1000);
  const counts = {};
  const cap = { clash: 3, whoosh: 3, boom: 2, heal: 2, caw: 1, shot: 1, rune: 1, defeat: 1, victory: 1 };
  const fire = (name, at, gain = 1) => {
    counts[name] = (counts[name] || 0) + 1;
    if (counts[name] > (cap[name] ?? 2)) return;
    play(name, { delay: at + (counts[name] - 1) * 0.045, gain: gain * (1 - 0.18 * (counts[name] - 1)) });
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'attack':
        if (ev.kind === 'arrow' || ev.kind === 'bolt') fire('whoosh', d * 0.3, 0.9);
        else fire('clash', d * 0.5);
        break;
      case 'spell':
        if (ev.spell === 'FIREBALL') fire('boom', d * 0.55);
        else if (ev.spell === 'HEAL' || ev.spell === 'WARD') fire('heal', d * 0.4, 0.8);
        else fire('rune', d * 0.4, 0.8);
        break;
      // le croassement d'un corbeau du joueur est déjà joué à l'envoi (hud) : ici, seulement ceux de l'ennemi
      case 'raven_launch': if (ev.side !== 'player') fire('caw', 0.02, 0.7); break;
      case 'raven_shot': fire('shot', d * 0.6); break;
      case 'raven_deliver': fire('rune', d * 0.8, 0.7); break;
      default: break;
    }
  }
}

// ------------------------------------------------------------------ ambiance : nappe d'accords lente + notes éparses
// Accords en ré mineur (i, VI, III, VII) tuilés les uns sur les autres, et quelques notes de pentatonique jouées comme
// des cordes pincées, dans un écho doux. Volontairement sans aucun bruit : un souffle qui gonfle puis s'efface en boucle
// s'entendait comme des parasites de radio.
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const CHORDS = [
  [38, 45, 53, 57, 60],   // Ré mineur
  [34, 46, 53, 58, 62],   // Si♭ majeur
  [41, 48, 53, 57, 60],   // Fa majeur
  [36, 43, 52, 55, 60],   // Do majeur
];
const CHORD_LEN = 14, CHORD_ATTACK = 4.5, CHORD_RELEASE = 5.5, LOOKAHEAD = 8;
const PENTA = [69, 72, 74, 77, 79, 81];   // la do ré fa sol la
let ambientBus = null, ambientTimer = 0, ambientChord = 0, nextChordAt = 0, nextNoteAt = 0;

function ambientTrack(n, end) { ambientNodes.push({ n, end }); }

function playChord(notes, t0) {
  const end = t0 + CHORD_LEN + CHORD_RELEASE + 0.1;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.0001, t0);
  cg.gain.linearRampToValueAtTime(1, t0 + CHORD_ATTACK);
  cg.gain.setValueAtTime(1, t0 + CHORD_LEN);
  cg.gain.linearRampToValueAtTime(0.0001, t0 + CHORD_LEN + CHORD_RELEASE);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.4;
  lp.connect(cg); cg.connect(ambientBus);
  notes.forEach((m, i) => {
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = m < 50 ? 'triangle' : 'sine';
      o.frequency.value = mtof(m); o.detune.value = det + (i - 2) * 1.5;
      g.gain.value = m < 50 ? 0.034 : 0.02;
      o.connect(g); g.connect(lp); o.start(t0); o.stop(end);
      ambientTrack(o, end);
    }
  });
}

function playPluck(t, m) {
  const f = mtof(m), end = t + 4;
  const out = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (out) { out.pan.value = (Math.random() * 2 - 1) * 0.5; out.connect(ambientBus); }
  const dest = out ?? ambientBus;
  for (const [mul, peak, dec] of [[1, 0.075, 3.2], [2, 0.014, 1.2], [3, 0.005, 0.6]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f * mul;
    env(g, t, 0.012, peak, dec);
    o.connect(g); g.connect(dest); o.start(t); o.stop(end);
    ambientTrack(o, end);
  }
}

// ---- morceau enregistré (Suno, assets/music/theme.mp3) : lu en boucle, la fin se fondant dans le début. Si le fichier
// manque ou ne se décode pas, la nappe synthétique ci-dessus prend le relais.
const MUSIC_URL = 'assets/music/theme.mp3';
const MUSIC_XFADE = 6;     // s : la fin du morceau (déjà en fondu) et son début se chevauchent, sans coupure à la boucle
const MUSIC_TRIM = 0.7;    // morceau mixé fort (RMS ≈ 0,13) : calé pour rester un fond (≈ 0,05 en sortie, ×0,45 en bataille)
const MUSIC_RATE = 32000;  // décodé à 32 kHz (le MP3 coupe vers 16 kHz) : 51 Mo de mémoire au lieu de 77
const fadeCurve = (f) => Float32Array.from({ length: 64 }, (_, i) => f((i / 63) * Math.PI / 2));
const FADE_IN = fadeCurve(Math.sin), FADE_OUT = fadeCurve(Math.cos);   // puissance constante
let musicBuf = null, musicState = 0, musicNextAt = 0, musicStarted = false, musicTrim = null;
// musicState : 0 pas demandé, 1 en chargement, 2 prêt, 3 indisponible

function loadMusic() {
  if (musicState) return;
  musicState = 1;
  const c = ctx;
  const decode = async (bytes) => {
    try { return await new OfflineAudioContext(2, 1, MUSIC_RATE).decodeAudioData(bytes.slice(0)); }
    catch { return c.decodeAudioData(bytes); }
  };
  fetch(MUSIC_URL)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(decode)
    .then((buf) => { musicBuf = buf; musicState = 2; if (ctx === c && ambientNodes) musicNextAt = c.currentTime + 0.1; })
    .catch(() => {
      musicState = 3;
      if (ctx === c && ambientNodes) { nextChordAt = c.currentTime + 0.1; nextNoteAt = c.currentTime + 6; }
    });
}

function playMusic(t, first) {
  const d = musicBuf.duration, x = Math.min(MUSIC_XFADE, d / 4);
  const src = ctx.createBufferSource(); src.buffer = musicBuf;
  const g = ctx.createGain(); g.gain.value = 0;
  g.gain.setValueCurveAtTime(FADE_IN, t, first ? 3 : x);
  g.gain.setValueCurveAtTime(FADE_OUT, t + d - x, x);
  src.connect(g); g.connect(musicTrim);
  src.start(t); src.stop(t + d + 0.1);
  ambientTrack(src, t + d + 0.1);
}

// Planifie à l'avance (LOOKAHEAD s) : morceau, accords et notes sont posés sur l'horloge audio, le minuteur ne sert
// qu'à remplir la file, donc un onglet ralenti ne fait pas de trou.
function tickAmbient() {
  if (!ctx || !ambientNodes) return;
  const now = ctx.currentTime;
  if (musicState === 2) {
    while (musicNextAt < now + LOOKAHEAD) {
      // la boucle suivante se cale sur l'heure RÉELLE de départ de celle-ci (le minuteur peut avoir pris du retard)
      const t = Math.max(musicNextAt, now);
      playMusic(t, !musicStarted);
      musicStarted = true;
      musicNextAt = t + musicBuf.duration - Math.min(MUSIC_XFADE, musicBuf.duration / 4);
    }
  } else if (musicState === 3) {
    while (nextChordAt < now + LOOKAHEAD) {
      playChord(CHORDS[ambientChord++ % CHORDS.length], nextChordAt);
      nextChordAt += CHORD_LEN;
    }
    while (nextNoteAt < now + LOOKAHEAD) {
      const i = Math.floor(Math.random() * PENTA.length);
      playPluck(nextNoteAt, PENTA[i]);
      if (Math.random() < 0.3) playPluck(nextNoteAt + 0.55, PENTA[Math.max(0, Math.min(PENTA.length - 1, i + (Math.random() < 0.5 ? -1 : 1)))]);
      nextNoteAt += 5 + Math.random() * 7;
    }
  }
  ambientNodes = ambientNodes.filter((x) => x.end > now);
  ambientTimer = setTimeout(tickAmbient, 2000);
}

function buildAmbient() {
  if (!ctx || ambientNodes) return;
  const t = ctx.currentTime;
  ambientNodes = [];
  // bus commun + écho doux pour la nappe de repli (retard filtré qui se répète en s'éteignant)
  const bus = ctx.createGain();
  const dl = ctx.createDelay(1.5); dl.delayTime.value = 0.43;
  const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 1500;
  const fb = ctx.createGain(); fb.gain.value = 0.38;
  const wet = ctx.createGain(); wet.gain.value = 0.4;
  bus.connect(amb); bus.connect(dl); dl.connect(fl); fl.connect(fb); fb.connect(dl); fl.connect(wet); wet.connect(amb);
  ambientBus = bus;
  musicTrim = ctx.createGain(); musicTrim.gain.value = MUSIC_TRIM; musicTrim.connect(amb);
  ambientChord = 0; nextChordAt = t + 0.1; nextNoteAt = t + 6;
  musicStarted = false;
  if (musicState === 0) loadMusic();
  else if (musicState === 2) musicNextAt = t + 0.1;
  tickAmbient();
  amb.gain.cancelScheduledValues(t);
  amb.gain.setValueAtTime(amb.gain.value, t);
  amb.gain.linearRampToValueAtTime(0.55, t + 3);
}

/** Lance le fond sonore (morceau en boucle, ou nappe synthétique si le fichier manque). Effectif au premier geste si le contexte n'existe pas encore. */
export function startAmbient() {
  wantAmbient = true;
  if (ctx && ctx.state === 'running') buildAmbient();
  else if (ctx && ambientNodes) amb.gain.setTargetAtTime(0.55, ctx.currentTime, 0.8);
}
/** Coupe le fond sonore en fondu. */
export function stopAmbient() {
  wantAmbient = false;
  if (!ctx || !ambientNodes) return;
  clearTimeout(ambientTimer); ambientTimer = 0;
  amb.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.5);
  const nodes = ambientNodes, bus = ambientBus, trim = musicTrim; ambientNodes = null; ambientBus = null; musicTrim = null;
  setTimeout(() => {
    for (const { n } of nodes) { try { n.stop(); } catch { /* déjà arrêté */ } }
    try { bus?.disconnect(); trim?.disconnect(); } catch { /* déjà déconnecté */ }
  }, 2500);
}
/** Intensité du fond sonore (0..1), ex. plus présent sur la carte de campagne, plus discret en bataille. */
export function setAmbientIntensity(x) {
  if (!ctx || !amb) return;
  amb.gain.setTargetAtTime(0.55 * Math.max(0, Math.min(1, x)), ctx.currentTime, 0.8);
}
