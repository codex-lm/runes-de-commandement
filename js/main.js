// js/main.js — démarrage, routeur d'écrans (machine à états), boucle de bataille, sauvegarde, routes de débogage.
//
// Imports statiques pour l'export autonome LOB7. Le démarrage vérifie toujours les contrats des modules
// et affiche un panneau d'erreur en français si une fonction attendue manque.
//
// Démarrage en deux temps : l'interface (titre, carte de campagne, marchand, aide, réglages…) est utilisable dès que
// les modules sont chargés ; les modèles 3D et la vue se chargent en tâche de fond (app.viewP). Les écrans qui ont
// besoin du plateau (préparation, bataille, routes de débogage) attendent la vue derrière un écran d'attente.
//
// États : TITLE → CAMPAIGN → PREP → BATTLE → RESULT → (SHOP | CAMP | EVENT) → … → END   (+ fenêtres HELP / SETTINGS)
// Routes de débogage (location.hash, jetons nus) : #debug-map #debug-prep #debug-battle #debug-result #debug-shop
//   #debug-camp #debug-event #debug-end #debug-help — chacune crée une campagne à graine fixe (non sauvegardée).
// Pour les tests automatisés : window.__runes = { state, getRun, getBattle, view, go, autoDeploy, startBattle, setSpeed, finishBattleInstantly }.
//   state.ready : interface ET vue 3D prêtes ; state.uiReady : interface seule (menus utilisables).

import { installLocalization, getLanguage } from './i18n.js';
import * as data from './core/data.js';
import * as program from './core/program.js';
import * as hex from './core/hex.js';
import * as maputil from './core/maputil.js';
import * as mapgen from './core/mapgen.js';
import * as ai from './core/ai.js';
import * as sim from './core/sim.js';
import * as campaign from './core/campaign.js';
import * as scene from './render/scene.js';
import * as editor from './ui/editor.js';
import * as screens from './ui/screens.js';
import * as hud from './ui/hud.js';
import * as audio from './audio.js';

const M = {};
const STATIC_MODULES = { data, program, hex, maputil, mapgen, ai, sim, campaign, scene, editor, screens, hud, audio };
const MODULES = [
  { k: 'data', p: './core/data.js', label: 'Catalogue du jeu', need: ['UNITS', 'RUNES'] },
  { k: 'program', p: './core/program.js', label: 'Programmes de runes', need: ['validateProgram', 'sanitizeProgram', 'cloneProgram'] },
  { k: 'hex', p: './core/hex.js', label: 'Géométrie hexagonale', need: ['distance'] },
  { k: 'maputil', p: './core/maputil.js', label: 'Outils de carte', need: ['deployHexes', 'isDeployHex', 'getTile'] },
  { k: 'mapgen', p: './core/mapgen.js', label: 'Générateur de cartes', need: ['generateMap'] },
  { k: 'ai', p: './core/ai.js', label: 'Intelligence ennemie', need: ['planEnemyArmy', 'scoutReport', 'makeEnemyRavenPolicy'] },
  { k: 'sim', p: './core/sim.js', label: 'Moteur de bataille', need: ['createBattle', 'stepBattle', 'sendRaven', 'previewIntent'] },
  { k: 'campaign', p: './core/campaign.js', label: 'Campagne', need: ['newRun', 'saveRun', 'loadRun', 'clearRun', 'reachableNodes', 'enterNode', 'prepareBattle', 'applyBattleOutcome', 'stealRune', 'shopOffers', 'buyOffer', 'applyCamp', 'rollEvent', 'resolveEvent'] },
  { k: 'scene', p: './render/scene.js', label: 'Rendu 3D (three.js)', need: ['preloadAssets', 'createView'] },
  { k: 'editor', p: './ui/editor.js', label: 'Éditeur de runes', need: ['mountEditor', 'renderProgramView'], soft: true },
  { k: 'screens', p: './ui/screens.js', label: 'Écrans', need: ['renderTitle', 'renderCampaign'] },
  { k: 'hud', p: './ui/hud.js', label: 'Interface de bataille', need: ['mountPrep', 'mountBattle', 'onTick'] },
  { k: 'audio', p: './audio.js', label: 'Sons', need: ['play'], soft: true },
];

const SETTINGS_KEY = 'runes.settings.v1';
const UI_KEY = 'runes.ui.v1';
// Bataille en cours (carte, armées, programmes, graine, corbeaux envoyés) et dernier instant joué : un rechargement
// en pleine bataille la rejoue à l'identique (le moteur est déterministe) au lieu de revenir au déploiement.
const BATTLE_KEY = 'runes.battle.v1';
const BATTLE_TICK_KEY = 'runes.battle.tick.v1';
const DEBUG_SEED = 4242;
const BATTLE_KINDS = ['battle', 'elite', 'boss'];
const BOARD_SCREENS = new Set(['TITLE', 'PREP', 'BATTLE']);   // écrans où le plateau 3D se voit vraiment
const TICK_MS = 700;
const INPUT_GUARD_MS = 300;    // après un changement d'écran : le second clic d'un double-clic ne traverse pas
const COVER_PATIENCE_MS = 6000;

const app = {
  screen: 'BOOT',
  uiReady: false,      // modules chargés : menus utilisables
  ready: false,        // … et vue 3D créée
  debug: false,
  run: null,
  node: null,
  prep: null,          // { node, map, enemyPlan, seed, scout, placements: Map<uid,{q,r}> }
  battle: null,
  battleRec: null,     // enregistrement de la bataille en cours (voir startBattle / resumeBattle)
  battleIntro: null,   // bandeau du HUD quand la bataille commence en pause
  enemyPolicy: null,
  summary: null,
  result: null,
  speed: 1, lastSpeed: 1, modalPrevSpeed: null,
  loopGen: 0, ended: false, nav: 0,
  view: null, assets: null, viewP: null, loadProgress: 0,
  coverUrl: null, coverDone: false, coverLate: false, demoShown: false,
  ctl: null,           // contrôleur de l'écran courant
  overlay: null,       // contrôleur de la fenêtre (aide / réglages)
  settings: null, qualityExplicit: false, autoQuality: false, fpsChecked: false,
  errors: [],
  shopSold: new Set(),
  speedWaiters: [],
  inputGuardUntil: 0,
  saveWarned: false, audioMissing: false,
};

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uiRoot = () => $('#ui');
const clone = (x) => JSON.parse(JSON.stringify(x));
const toast = (text, kind = 'info', ms) => { try { M.screens?.toast?.(text, kind, ms); } catch { /* */ } };

// =====================================================================================================
// Réglages et sauvegarde d'interface (localStorage, toujours en try/catch)
// =====================================================================================================
function defaultSettings() {
  // Téléphone (tactile, petit côté ≤ 500 px, en portrait comme en paysage) : qualité basse. Tablettes : haute.
  let small = false;
  try { small = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 500; } catch { /* */ }
  return { quality: small ? 'low' : 'high', volume: 0.7, muted: false, speed: 1 };
}
function loadSettings() {
  const d = defaultSettings();
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s && typeof s === 'object') {
      app.qualityExplicit = s.quality === 'low' || s.quality === 'high';
      return {
        quality: s.quality === 'low' ? 'low' : (s.quality === 'high' ? 'high' : d.quality),
        volume: Number.isFinite(s.volume) ? Math.max(0, Math.min(1, s.volume)) : d.volume,
        muted: !!s.muted,
        speed: [1, 2, 4].includes(s.speed) ? s.speed : 1,
      };
    }
  } catch { /* stockage indisponible */ }
  return d;
}
function saveSettings() {
  // une qualité abaissée automatiquement (fluidité) ne vaut que pour la session : elle n'est pas enregistrée
  const s = { ...app.settings };
  if (app.autoQuality) delete s.quality;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* */ }
}
function saveUi(obj) { if (app.debug) return; try { localStorage.setItem(UI_KEY, JSON.stringify(obj)); } catch { /* */ } }
function loadUi() { try { return JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch { return null; } }
function save() {
  if (app.debug || !app.run) return;
  let ok = false;
  try { ok = M.campaign.saveRun(app.run) !== false; } catch (e) { console.warn('Sauvegarde impossible', e); }
  if (!ok) warnSave();
}
/** Prévient une fois par session que la sauvegarde échoue (stockage plein, refusé ou cloisonné). */
function warnSave() {
  if (app.saveWarned || app.debug) return;
  app.saveWarned = true;
  toast('Sauvegarde impossible dans ce navigateur : la campagne sera perdue si vous fermez la page.', 'bad', 8000);
}
function storageWorks() {
  try { const k = 'runes.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch { return false; }
}
function loadSavedRun() {
  try { const r = M.campaign.loadRun(); return r && r.status === 'active' ? r : null; } catch { return null; }
}

// ---- bataille en cours
function saveBattleRec() {
  if (app.debug || !app.battleRec) return;
  try { localStorage.setItem(BATTLE_KEY, JSON.stringify(app.battleRec)); } catch { warnSave(); }
}
function saveBattleTick(tick) {
  if (app.debug || !app.battleRec) return;
  try { localStorage.setItem(BATTLE_TICK_KEY, String(tick)); } catch { /* */ }
}
function loadBattleRec() {
  try {
    const r = JSON.parse(localStorage.getItem(BATTLE_KEY) || 'null');
    if (!r || r.v !== 1 || !r.map || !r.enemyPlan || !Array.isArray(r.units) || !Array.isArray(r.sent)) return null;
    r.tick = Math.max(0, Number(localStorage.getItem(BATTLE_TICK_KEY)) || 0);
    return r;
  } catch { return null; }
}
function clearBattleRec() {
  app.battleRec = null;
  if (app.debug) return;   // une route de débogage ne touche jamais à la vraie partie
  try { localStorage.removeItem(BATTLE_KEY); localStorage.removeItem(BATTLE_TICK_KEY); } catch { /* */ }
}

// =====================================================================================================
// Chargement des modules + panneau d'erreur
// =====================================================================================================
function explain(err) {
  const msg = String(err?.message || err || '');
  if (/WebGL/i.test(msg)) return 'votre navigateur n’a pas pu activer WebGL (accélération matérielle désactivée, pilote graphique bloqué ou machine virtuelle ?).';
  if (/does not provide an export|n'exporte pas|fonction manquante/i.test(msg)) return 'une fonction attendue par le contrat (docs/INTERFACES.md) est absente.';
  if (/Failed to fetch|Importing a module script failed|error loading dynamically imported|404|NetworkError/i.test(msg)) return 'fichier introuvable ou inaccessible (ou l’un des fichiers qu’il importe).';
  if (err instanceof SyntaxError || /SyntaxError|Unexpected token|Unexpected identifier/i.test(msg)) return 'erreur de syntaxe dans le fichier.';
  return 'erreur pendant le chargement.';
}

/** Initialise les modules importés ; onLoaded(m, module) peut lancer le préchargement 3D en parallèle. */
async function loadModules(onLoaded) {
  const results = await Promise.allSettled(MODULES.map(m => Promise.resolve(STATIC_MODULES[m.k]).then((mod) => {
    try { onLoaded?.(m, mod); } catch (e) { console.warn(e); }
    return mod;
  })));
  const failures = [];
  results.forEach((r, i) => {
    const m = MODULES[i];
    if (r.status === 'fulfilled') {
      const missing = (m.need ?? []).filter(n => r.value[n] === undefined);
      if (missing.length) failures.push({ ...m, error: new Error(`fonction manquante : ${missing.join(', ')}`) });
      else M[m.k] = r.value;
    } else failures.push({ ...m, error: r.reason });
  });
  return failures;
}

function showFatal(failures, { canContinue = false, title = 'Le jeu n’a pas pu démarrer', onContinue = null } = {}) {
  const root = uiRoot();
  if (!root) return;
  root.innerHTML = '';
  const wrap = document.createElement('section');
  wrap.className = 'screen screen-fatal full is-in';
  wrap.id = 'screen-fatal';
  const p = document.createElement('div');
  p.className = 'panel fatal-panel';
  p.setAttribute('role', 'alert');
  const local = location.protocol === 'file:';
  const usesThree = failures.some(f => f.k === 'scene');
  const noWebgl = failures.some(f => f.k === 'webgl' || /WebGL/i.test(String(f.error?.message || f.error || '')));
  p.innerHTML = `
    <div class="eyebrow">Runes de Commandement</div>
    <h2 class="stage-title"></h2>
    <p>Certaines parties du jeu n’ont pas pu être chargées :</p>
    <ul class="fatal-list"></ul>
    <p class="fatal-hint"></p>
    <div class="row fatal-actions"></div>`;
  p.querySelector('h2').textContent = title;
  const ul = p.querySelector('.fatal-list');
  for (const f of failures) {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = f.label;
    const code = document.createElement('code'); code.textContent = `js/${f.p.replace('./', '')}`;
    const why = document.createElement('span'); why.textContent = ` — ${explain(f.error)}`;
    const det = document.createElement('details');
    const sum = document.createElement('summary'); sum.textContent = 'Détail technique';
    const pre = document.createElement('pre'); pre.textContent = String(f.error?.stack || f.error?.message || f.error);
    det.append(sum, pre);
    li.append(b, ' ', code, why, det);
    ul.append(li);
  }
  p.querySelector('.fatal-hint').textContent = local
    ? 'Le jeu est ouvert depuis un fichier local : les navigateurs bloquent alors les modules. Lancez un petit serveur depuis le dossier runes/ (python -m http.server 8765) puis ouvrez http://localhost:8765/dev.html.'
    : noWebgl
      ? 'Le jeu a besoin de la 3D (WebGL) : activez l’accélération matérielle dans les réglages du navigateur, mettez à jour le pilote graphique, ou essayez un autre navigateur.'
    : usesThree
      ? 'Le rendu 3D ne peut pas charger ses fichiers locaux : rechargez le jeu, puis réessayez.'
      : 'Si le jeu est en cours de développement, un fichier est peut-être en train d’être écrit : réessayez dans un instant.';
  const actions = p.querySelector('.fatal-actions');
  const retry = document.createElement('button');
  retry.type = 'button'; retry.className = 'btn btn-primary'; retry.id = 'fatal-retry'; retry.textContent = 'Réessayer';
  retry.addEventListener('click', () => location.reload());
  actions.append(retry);
  if (canContinue && onContinue) {
    const go2 = document.createElement('button');
    go2.type = 'button'; go2.className = 'btn btn-ghost'; go2.id = 'fatal-continue'; go2.textContent = 'Continuer quand même';
    go2.addEventListener('click', () => { wrap.remove(); onContinue(); });
    actions.append(go2);
  }
  wrap.append(p);
  root.append(wrap);
  retry.focus();
}

function runtimeToast(text) { toast(text, 'bad', 5000); }

// Erreurs globales : seules celles du jeu méritent un message. Une extension du navigateur (portefeuille, bloqueur…)
// qui injecte son script dans la page lève ses propres erreurs : console seulement.
const FOREIGN_RE = /(chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;
function isForeignError(message, file, stack) {
  if (FOREIGN_RE.test(String(file ?? '')) || FOREIGN_RE.test(String(stack ?? ''))) return true;
  return /^Script error\.?$/i.test(String(message ?? '')) && !file;   // script d'une autre origine, sans détail
}
const toastedErrors = new Set();
function errorToast(message) {
  if (!app.uiReady) return;
  const k = String(message).slice(0, 200);
  if (toastedErrors.has(k)) return;    // une même erreur ne s'affiche qu'une fois ; des erreurs différentes, si
  toastedErrors.add(k);
  runtimeToast(`Erreur : ${message}`);
}

/** Le fragment publié peut être placé tout entier dans <body> par l'hôte : on range ce qui relève de l'en-tête. */
function adoptHead() {
  try {
    document.documentElement.lang = getLanguage();
    for (const el of document.querySelectorAll('body > title, body link[rel~="icon"], body meta[name], body link[rel="preconnect"]')) document.head.append(el);
  } catch { /* */ }
}

/**
 * Garde contre les doubles clics : un clic qui change d'écran fait apparaître le suivant sous le pointeur ; le second
 * clic du même geste ne doit pas l'actionner. Pendant INPUT_GUARD_MS après go() (ou l'ouverture d'une fenêtre),
 * les appuis du pointeur et leurs clics sont absorbés (phase de capture : écrans, HUD, fenêtres et canevas 3D).
 * Les clics clavier (Entrée, Espace : detail = 0) passent toujours.
 * On compare l'HEURE DE L'ÉVÉNEMENT (e.timeStamp), pas l'heure de son traitement : sur une machine chargée, le
 * second clic peut n'être traité que bien après l'affichage du nouvel écran, alors qu'il visait l'ancien.
 */
function installInputGuard() {
  let swallow = false;
  const guarded = (e) => (e.timeStamp || performance.now()) < app.inputGuardUntil;
  const stop = (e) => { e.stopPropagation(); e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); };
  document.addEventListener('pointerdown', (e) => { swallow = guarded(e); if (swallow) stop(e); }, true);
  document.addEventListener('click', (e) => {
    if (e.detail === 0) return;
    if (swallow || guarded(e)) { swallow = false; stop(e); }
  }, true);
  for (const t of ['dblclick', 'contextmenu']) document.addEventListener(t, (e) => { if (guarded(e)) stop(e); }, true);
}

// =====================================================================================================
// Démarrage
// =====================================================================================================
async function boot() {
  adoptHead();
  app.settings = { ...defaultSettings(), ...(() => { try { return loadSettings(); } catch { return {}; } })() };
  // outil de mise au point : dev.html?quality=low force la qualité basse (non sauvegardé)
  try { const q = new URLSearchParams(location.search).get('quality'); if (q === 'low' || q === 'high') { app.settings.quality = q; app.qualityExplicit = true; } } catch { /* */ }
  app.speed = app.lastSpeed = app.settings.speed;
  // Le manifeste (petit) et la couverture partent tout de suite, en parallèle des modules et des modèles.
  app.manifestP = fetch(new URL('../assets/manifest.json', import.meta.url), { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  app.coverP = app.manifestP.then(m => coverFiles(m).reduce((p, f) => p.then(u => u || probeImage(`assets/${f}`)), Promise.resolve(null)));
  let failures = [];
  // Dès que le moteur 3D est chargé, les modèles partent (sans attendre l'éditeur, le HUD, etc.).
  try { failures = await loadModules((m, mod) => { if (m.k === 'scene' && mod.preloadAssets && mod.createView) startView(mod); }); }
  catch (e) { failures = [{ k: '?', p: './main.js', label: 'Démarrage', error: e }]; }
  app.errors = failures.map(f => ({ module: f.k, message: String(f.error?.message || f.error) }));
  const hard = failures.filter(f => !f.soft);
  if (hard.length) { showFatal(failures); console.error('Modules en échec :', failures); exposeTestApi(); return; }
  // Les sons sont facultatifs : sans audio.js, le jeu démarre en silence (simple message une fois le titre affiché).
  const audioFail = failures.find(f => f.k === 'audio');
  if (audioFail) { console.warn('Sons indisponibles :', audioFail.error); app.audioMissing = true; }
  const blocking = failures.filter(f => f.k !== 'audio');
  if (blocking.length) {
    // l'éditeur de runes manque : on prévient, on peut continuer (programmes en lecture seule)
    exposeTestApi();
    await new Promise(res => showFatal(blocking, { canContinue: true, title: 'Le jeu peut démarrer, en mode dégradé', onContinue: res }));
  }
  if (!M.audio) M.audio = { play() {}, playBattleEvents() {}, armAudio() {}, setVolume() {}, setMuted() {}, startAmbient() {}, stopAmbient() {}, setAmbientIntensity() {} };
  M.screens.initScreens({ editor: M.editor ?? null, campaign: M.campaign, audio: M.audio, assetsBase: 'assets/' });
  M.hud.initHud({ editor: M.editor ?? null, sim: M.sim, audio: M.audio, campaign: M.campaign });
  M.audio.armAudio?.();
  M.audio.setVolume?.(app.settings.volume);
  M.audio.setMuted?.(app.settings.muted);
  M.audio.startAmbient?.();
  app.manifestP.then((m) => { try { M.screens.setAssetManifest?.(m); } catch { /* */ } });

  window.addEventListener('error', (e) => {
    if (isForeignError(e.message, e.filename, e.error?.stack)) { console.warn('Erreur externe ignorée :', e.message); return; }
    console.error(e.error || e.message);
    errorToast(e.message || 'inconnue');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (isForeignError(r?.message ?? r, '', r?.stack)) { console.warn('Rejet externe ignoré :', r?.message ?? r); return; }
    console.error(r);
    errorToast(r?.message || r || 'inconnue');
  });
  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('hashchange', () => { const r = debugRoute(); if (r && app.uiReady) runDebug(r); });
  for (const q of [M.screens.PHONE_PORTRAIT_Q, M.screens.PHONE_LANDSCAPE_Q].filter(Boolean)) {
    matchMedia(q).addEventListener?.('change', () => { if (app.screen === 'CAMPAIGN' && !app.overlay) go('CAMPAIGN'); });
  }
  installInputGuard();
  exposeTestApi();
  if (!app.viewP) startView(M.scene);
  if (app.webglMissing) {
    // sans WebGL, ni préparation ni bataille : inutile de télécharger les modèles, on l'explique tout de suite
    showFatal([{ k: 'webgl', p: './render/scene.js', label: 'Rendu 3D (WebGL)', error: new Error('WebGL indisponible') }]);
    return;
  }

  // Écran titre immédiatement : menus actifs, les modèles finissent de charger en arrière-plan.
  $('#boot')?.remove();
  app.screen = 'TITLE';
  app.ctl = M.screens.renderTitle(uiRoot(), { hasSave: false }, titleHandlers());
  app.ctl.setProgress?.(app.loadProgress * 0.95);
  app.uiReady = true;
  app.coverP.then(onCoverReady);
  setTimeout(() => { app.coverLate = true; maybeDemoBoard(); }, COVER_PATIENCE_MS);
  const route = debugRoute();
  if (route) { await runDebug(route); return; }
  enterTitle();
  if (app.audioMissing) toast('Sons indisponibles : le jeu reste jouable en silence.', 'info', 5000);
  if (!storageWorks()) warnSave();
  else { try { if (M.campaign.savedRunStatus?.() === 'corrupt') toast('Sauvegarde illisible : commencez une nouvelle campagne.', 'bad', 8000); } catch { /* */ } }
}

/** WebGL est-il disponible ? (sonde jetable : le contexte est aussitôt rendu, les navigateurs en limitent le nombre) */
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

/** Modèles puis vue 3D, en tâche de fond. app.viewP se résout avec la vue (ou null si elle n'a pas pu être créée). */
function startView(scene) {
  if (app.viewP) return;
  if (!webglAvailable()) { app.webglMissing = true; app.viewP = Promise.resolve(null); return; }
  const title = (p, label) => { if (app.screen === 'TITLE') app.ctl?.setProgress?.(p, label); };
  app.viewP = (async () => {
    let assets;
    try {
      // le manifeste déjà demandé au démarrage (pour la couverture) sert aussi aux modèles : pas de second envoi
      const manifest = await app.manifestP;
      assets = await scene.preloadAssets({ base: 'assets/', manifest, onProgress: (p) => { app.loadProgress = p; title(p * 0.95); } });
    } catch (e) { console.warn('Préchargement des modèles impossible, repli procédural', e); assets = undefined; }
    app.assets = assets;
    app.loadProgress = 1;
    title(0.96, 'Le diorama se monte…');
    const q = app.settings.quality;
    const v = await scene.createView($('#view'), { assets, quality: q });
    // un changement de qualité fait dans les Réglages pendant le chargement n'est pas perdu
    if (app.settings.quality !== q) { try { v.setQuality?.(app.settings.quality); } catch (e) { console.warn(e); } }
    app.view = v;
    app.ready = true;
    try { v.setActive?.(boardVisible(app.screen) || app.screen === 'PREP_LOADING'); } catch { /* */ }
    watchContext(v);
    title(1, 'Prêt.');
    maybeDemoBoard();
    return v;
  })().catch((e) => {
    console.error(e);
    showFatal([{ k: 'scene', p: './render/scene.js', label: 'Rendu 3D (création de la vue)', error: e }]);
    return null;
  });
}

/** Le plateau 3D se voit-il sur cet écran ? Au titre, seulement sans couverture (plateau de démonstration). */
function boardVisible(screen) { return screen === 'TITLE' ? !app.coverUrl : BOARD_SCREENS.has(screen); }

/**
 * Perte du contexte WebGL (pilote réinitialisé, onglet en arrière-plan sur mobile…) : la boucle de bataille attend
 * le retour de l'affichage (voir battleLoop) ; si rien ne revient, on conseille de recharger (la bataille reprendra).
 */
function watchContext(v) {
  let t = 0;
  v.on?.('contextlost', () => {
    if (app.screen === 'BATTLE') toast('Affichage interrompu : la bataille est en pause.', 'bad', 5000);
    clearTimeout(t);
    t = setTimeout(() => {
      if (app.view?.contextLost?.()) toast('L’affichage 3D ne revient pas : rechargez la page, la campagne (et la bataille en cours) reprendra où elle en était.', 'bad', 12000);
    }, 5000);
  });
  v.on?.('contextrestored', () => clearTimeout(t));
}

/**
 * Attend la vue 3D derrière l'écran d'attente `wait` (progression des modèles affichée).
 * @returns {Promise<boolean>} false si la vue n'a pas pu être créée ou si le joueur a changé d'écran entre-temps.
 */
async function needView(wait, nav) {
  if (app.view) return nav === app.nav;
  const upd = () => wait?.setText?.(`Les figurines sortent de leur boîte… ${Math.round(app.loadProgress * 100)} %`);
  upd();
  const iv = setInterval(upd, 250);
  try { await app.viewP; } finally { clearInterval(iv); }
  return !!app.view && nav === app.nav;
}

function coverFiles(manifest) {
  // couverture : cadrage vertical pour un téléphone tenu droit, version légère sur petit écran, sinon pleine
  // définition (noms d'après le manifeste s'il existe ; chacune se rabat sur la suivante si elle manque)
  const small = matchMedia('(max-width: 960px)').matches;
  const upright = matchMedia('(orientation: portrait) and (max-width: 960px)').matches;
  return manifest
    ? [upright ? manifest.coverPortrait : null, small ? manifest.coverSmall : null, manifest.cover].filter(f => typeof f === 'string' && f)
    : [upright ? 'cover_portrait.jpg' : null, small ? 'cover_small.jpg' : null, 'cover.jpg'].filter(Boolean);
}
function probeImage(url) {
  // Pas de délai qui ferait abandonner une couverture lente : elle remplace le plateau de démonstration dès qu'elle arrive.
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img.naturalWidth > 0 ? url : null);
    img.onerror = () => res(null);
    img.src = url;
  });
}
function onCoverReady(url) {
  app.coverDone = true;
  if (url) {
    app.coverUrl = url;
    if (app.screen === 'TITLE') {
      app.ctl?.setCover?.(url);
      // la couverture opaque cache le plateau : inutile de le redessiner (ni de le faire dériver) derrière
      document.getElementById('app')?.classList.remove('title-drift');
      try { app.view?.setActive?.(false); } catch { /* */ }
    }
  }
  maybeDemoBoard();
}
/** Sans couverture (absente, ou encore en route après COVER_PATIENCE_MS), le titre montre un petit diorama 3D. */
function maybeDemoBoard() {
  if (app.screen !== 'TITLE' || app.coverUrl || !app.view || app.demoShown) return;
  if (!app.coverDone && !app.coverLate) return;
  app.demoShown = true;
  showDemoBoard();
  document.getElementById('app')?.classList.add('title-drift');
  try { app.view.setActive?.(true); } catch { /* */ }
  requestAnimationFrame(() => frameTitle(true));
}

// =====================================================================================================
// Routeur
// =====================================================================================================
function teardown() {
  app.nav++;
  closeOverlay();
  try { app.ctl?.destroy?.(); } catch (e) { console.warn(e); }
  app.ctl = null;
  document.getElementById('app')?.classList.remove('title-drift', 'is-board', 'is-dim');
  // (les marges de cadrage de la vue sont fixées par chaque écran de plateau : titre, préparation, bataille)
  const ov = document.getElementById('overlay');
  if (ov) ov.querySelectorAll('.hex-tip').forEach(n => n.remove());
}

/**
 * Change d'écran. screen ∈ TITLE CAMPAIGN PREP BATTLE RESULT SHOP CAMP EVENT END HELP SETTINGS.
 * HELP et SETTINGS s'ouvrent en fenêtre par-dessus l'écran courant.
 */
function go(screen, opts = {}) {
  screen = String(screen || '').toUpperCase();
  if (screen === 'HELP' || screen === 'SETTINGS') { openOverlay(screen); return; }
  if (!app.uiReady && screen !== 'TITLE') return;
  if (app.screen === 'BATTLE' && screen !== 'BATTLE') {
    stopLoop();
    // une bataille quittée en pause ne doit pas laisser la vue figée (effets, chiffres, bataille suivante)
    try { app.view?.setPaused?.(false); app.view?.clearEffects?.(); } catch { /* */ }
  }
  teardown();
  app.inputGuardUntil = performance.now() + INPUT_GUARD_MS;
  app.screen = screen;
  // Derrière les écrans opaques (et la couverture du titre), le plateau n'a pas besoin d'être redessiné (API facultative).
  try { app.view?.setActive?.(boardVisible(screen)); } catch { /* */ }
  const root = uiRoot();
  const appEl = document.getElementById('app');
  M.audio.setAmbientIntensity?.(screen === 'BATTLE' ? 0.45 : 1);
  try {
    switch (screen) {
      case 'TITLE': return enterTitle();
      case 'CAMPAIGN': {
        if (!app.run) return go('TITLE');
        appEl.classList.add('is-dim');
        let reach = [];
        try { reach = M.campaign.reachableNodes(app.run) ?? []; } catch (e) { console.warn(e); }
        app.ctl = M.screens.renderCampaign(root, { run: app.run, reachable: reach }, {
          onPick: (id) => pickNode(id),
          onMenu: () => go('TITLE'),
          onHelp: () => openOverlay('HELP'),
          onSettings: () => openOverlay('SETTINGS'),
        });
        app.ctl.focus?.();
        return;
      }
      case 'PREP': {
        if (!app.prep || !app.view) { const n = currentNode(); if (n && BATTLE_KINDS.includes(n.kind)) return enterPrep(n); return go('CAMPAIGN'); }
        appEl.classList.add('is-board');
        app.ctl = M.hud.mountPrep(root, {
          view: app.view, run: app.run, prep: app.prep,
          actions: {
            place: placeUnit, unplace: unplaceUnit, autoDeploy: () => autoDeploy(),
            start: () => startBattle(), programChanged: () => save(),
            openHelp: () => openOverlay('HELP'), openSettings: () => openOverlay('SETTINGS'),
          },
        });
        checkFrameRate();
        return;
      }
      case 'BATTLE': {
        if (!app.battle) return go('PREP');
        appEl.classList.add('is-board');
        const intro = app.battleIntro;
        app.battleIntro = null;
        app.ctl = M.hud.mountBattle(root, {
          view: app.view, run: app.run, getBattle: () => app.battle, intro: app.speed === 0 ? intro : null,
          actions: {
            setSpeed, getSpeed: () => app.speed, sendRaven: playerRaven,
            holdPause, finishInstantly: () => finishBattleInstantly(),
            openHelp: () => openOverlay('HELP'),
          },
        });
        startLoop();
        checkFrameRate();
        return;
      }
      case 'RESULT': {
        if (!app.summary) return go('CAMPAIGN');
        appEl.classList.add('is-dim');
        const node = app.node || currentNode();
        const pend = app.run?.pendingSteal ?? null;
        app.ctl = M.screens.renderResult(root, {
          run: app.run, summary: app.summary, result: app.result, node,
          allowSteal: !!pend, stealable: pend?.runes ?? app.summary.stealable ?? [],
        }, {
          onSteal: (runeId) => {
            try { app.run = M.campaign.stealRune(app.run, runeId) ?? app.run; } catch (e) { console.error(e); return false; }
            if (app.run.pendingSteal) return false;  // refusé par la campagne
            save(); saveUi({ nodeId: node?.id, phase: 'done' });
            return true;
          },
          onSkip: () => {
            try { app.run = M.campaign.skipSteal ? (M.campaign.skipSteal(app.run) ?? app.run) : { ...app.run, gold: (app.run.gold ?? 0) + 25 }; }
            catch (e) { console.error(e); }
            save(); saveUi({ nodeId: node?.id, phase: 'done' });
          },
          onContinue: () => afterResult(),
        });
        return;
      }
      case 'SHOP': {
        const node = currentNode();
        if (!node) return go('CAMPAIGN');
        appEl.classList.add('is-dim');
        const offers = () => {
          let list = [];
          try { list = M.campaign.shopOffers(app.run, node) ?? []; } catch (e) { console.error(e); }
          return list.map(o => ({ ...o, sold: o.sold || app.shopSold.has(o.id) }));
        };
        app.ctl = M.screens.renderShop(root, { run: app.run, offers: offers() }, {
          onBuy: (offer) => {
            let r;
            try { r = M.campaign.buyOffer(app.run, offer); } catch (e) { r = { ok: false, reason: e.message }; }
            if (r?.ok) {
              app.run = r.run ?? app.run; app.shopSold.add(offer.id); save();
              saveUi({ nodeId: node.id, phase: 'shop', sold: [...app.shopSold] });
              app.ctl.update(app.run, offers());
            }
            return r;
          },
          onLeave: () => leaveNode(node),
        });
        return;
      }
      case 'CAMP': {
        const node = currentNode();
        if (!node) return go('CAMPAIGN');
        appEl.classList.add('is-dim');
        // quartier-maître : une recrue à louer, indépendante du repos (campaign.campOffers / buyOffer)
        const qmOffers = () => { try { return M.campaign.campOffers?.(app.run, node) ?? []; } catch (e) { console.error(e); return []; } };
        app.ctl = M.screens.renderCamp(root, { run: app.run, node, offers: qmOffers(), quartermaster: M.campaign.QUARTERMASTER ?? null }, {
          onApply: (choice) => {
            let r;
            try { r = M.campaign.applyCamp(app.run, choice); } catch (e) { r = { ok: false, reason: e.message }; }
            if (r?.ok) { app.run = r.run ?? app.run; save(); saveUi({ nodeId: node.id, phase: 'done' }); }
            return r;
          },
          onBuy: M.campaign.campOffers ? (offer) => {
            let r;
            try { r = M.campaign.buyOffer(app.run, offer); } catch (e) { r = { ok: false, reason: e.message }; }
            if (r?.ok) { app.run = r.run ?? app.run; save(); app.ctl?.update?.(app.run, qmOffers()); }
            return r;
          } : null,
          onLeave: () => leaveNode(node),
        });
        return;
      }
      case 'EVENT': {
        const node = currentNode();
        if (!node) return go('CAMPAIGN');
        appEl.classList.add('is-dim');
        let event = null;
        try { event = M.campaign.rollEvent(app.run, node); } catch (e) { console.error(e); }
        app.ctl = M.screens.renderEvent(root, { run: app.run, event }, {
          onChoose: (choiceId) => {
            try {
              const r = M.campaign.resolveEvent(app.run, event, choiceId);
              if (r?.ok === false) return { ok: false, text: r.text };
              app.run = r?.run ?? app.run; save(); saveUi({ nodeId: node.id, phase: 'done' });
              return { ok: true, text: r?.text ?? '' };
            } catch (e) { console.error(e); return { ok: true, text: 'Le vent emporte vos paroles. Rien ne se passe.' }; }
          },
          onLeave: () => leaveNode(node),
        });
        return;
      }
      case 'END': {
        appEl.classList.add('is-dim');
        const won = opts.won ?? (app.run?.status === 'won');
        saveUi({ phase: 'done' });
        M.audio.play(won ? 'victory' : 'defeat');
        app.ctl = M.screens.renderEnd(root, { run: app.run, won }, {
          onNew: () => newCampaign(),
          onTitle: () => go('TITLE'),
        });
        return;
      }
      default:
        console.warn('Écran inconnu', screen);
        return go('TITLE');
    }
  } catch (e) {
    console.error(e);
    runtimeToast(`Impossible d’afficher l’écran ${screen} : ${e.message}`);
  }
}

function enterTitle() {
  const saved = loadSavedRun();
  let info = '';
  if (saved) {
    const n = saved.position ? saved.map?.nodes?.[saved.position] : null;
    const cols = saved.map?.columns?.length ?? 5;
    info = `Étape ${n ? n.col + 1 : 1}/${cols} · ${saved.gold ?? 0} or · ${(saved.roster ?? []).length} unités`;
  }
  if (app.screen === 'TITLE' && app.ctl?.setReady) {
    // premier affichage : l'écran titre est déjà là (barre de progression), on le complète sans le recréer ;
    // une fenêtre (aide, réglages) ouverte pendant le chargement reste ouverte
    app.ctl.setReady(!!saved, info);
    if (app.coverUrl) app.ctl.setCover?.(app.coverUrl);
    app.ctl.setProgress?.(app.ready ? 1 : app.loadProgress * 0.95, app.ready ? 'Prêt.' : undefined);
  } else {
    teardown();
    app.screen = 'TITLE';
    app.demoShown = false;
    app.ctl = M.screens.renderTitle(uiRoot(), { hasSave: !!saved, saveInfo: info, coverUrl: app.coverUrl, ready: true }, titleHandlers());
    if (!app.ready) app.ctl.setProgress?.(app.loadProgress * 0.95);
    try { app.view?.setActive?.(boardVisible('TITLE')); } catch { /* */ }
  }
  maybeDemoBoard();
  // la dérive lente du plateau n'a de sens que si on le voit (pas sous la couverture)
  document.getElementById('app')?.classList.toggle('title-drift', !app.coverUrl);
  if (!app.overlay) app.ctl.focus?.();
}
/** Cadre le plateau de démonstration dans la partie libre de l'écran titre (à droite du titre ; au-dessus du menu au téléphone). */
function frameTitle(reset = false) {
  if (app.screen !== 'TITLE' || app.coverUrl) return;
  const col = document.querySelector('.title-col');
  if (!col || !app.view?.setInsets) return;
  const r = col.getBoundingClientRect();
  const phone = M.screens?.layoutMode ? M.screens.layoutMode() === 'phone' : matchMedia('(max-width: 720px)').matches;
  try {
    app.view.setInsets(phone ? { top: 0, right: 0, bottom: Math.round((window.innerHeight - r.top) * 0.6), left: 0 } : { top: 0, right: 0, bottom: 0, left: Math.round(r.right * 0.75) });
    if (reset) app.view.resetCamera?.();
  } catch { /* */ }
}
let titleResizeT = 0;
window.addEventListener('resize', () => { clearTimeout(titleResizeT); titleResizeT = setTimeout(() => frameTitle(false), 120); });
function titleHandlers() {
  return {
    onNew: () => newCampaign(),
    onResume: () => resumeCampaign(),
    onHelp: () => openOverlay('HELP'),
    onSettings: () => openOverlay('SETTINGS'),
  };
}

function openOverlay(kind) {
  // Passer de l'aide aux réglages garde la pause en cours (pas de reprise d'un instant entre les deux fenêtres).
  const carry = !!app.overlay?.paused;
  const prevFocus = app.overlay ? app.overlay.prevFocus : document.activeElement;
  closeOverlay({ keepPause: carry });
  const host = document.createElement('div');
  host.className = 'overlay-layer';
  host.id = 'overlay-layer';
  uiRoot().append(host);
  const close = () => closeOverlay();
  let ctl;
  if (kind === 'HELP') ctl = M.screens.renderHelp(host, {}, { onClose: close, onSettings: () => openOverlay('SETTINGS') });
  else ctl = M.screens.renderSettings(host, { settings: app.settings }, {
    onChange: (s) => applySettings(s),
    onClose: close,
  });
  app.overlay = { host, ctl, kind, prevFocus, paused: carry };
  app.inputGuardUntil = performance.now() + INPUT_GUARD_MS;
  if (!carry && app.screen === 'BATTLE' && app.speed !== 0) { holdPause(true); app.overlay.paused = true; }
}
function closeOverlay({ keepPause = false } = {}) {
  const o = app.overlay;
  if (!o) return;
  app.overlay = null;
  try { o.ctl?.destroy?.(); } catch { /* */ }
  o.host.remove();
  if (o.paused && !keepPause) holdPause(false);
  if (!keepPause) { try { o.prevFocus?.focus?.(); } catch { /* */ } }
}
function applySettings(s) {
  const prevQ = app.settings.quality;
  app.settings = { ...app.settings, ...s };
  if (prevQ !== app.settings.quality) { app.autoQuality = false; app.qualityExplicit = true; }
  saveSettings();
  M.audio.setVolume?.(app.settings.volume);
  M.audio.setMuted?.(app.settings.muted);
  if (prevQ !== app.settings.quality) { try { app.view?.setQuality?.(app.settings.quality); } catch (e) { console.warn(e); } }
}

/**
 * Repli automatique de qualité, une fois par session et seulement si le joueur n'a jamais choisi : on mesure la
 * cadence réelle sur un plateau (après 1 s d'échauffement : compilation des shaders, envoi des modèles) ; si la
 * médiane dépasse 24 ms par image, qualité basse pour la session (non enregistrée, la prochaine session remesure).
 */
function checkFrameRate() {
  if (app.fpsChecked || app.qualityExplicit || app.debug || app.settings.quality !== 'high' || !app.view?.setQuality) return;
  // navigateur piloté ou sans écran (tests, captures) : rendu logiciel, cadence non représentative
  try { if (navigator.webdriver || /Headless/i.test(navigator.userAgent)) return; } catch { /* */ }
  app.fpsChecked = true;
  const samples = [];
  let last = 0;
  const t0 = performance.now();
  const step = (t) => {
    if (!['PREP', 'BATTLE'].includes(app.screen) || app.overlay) { app.fpsChecked = false; return; }   // on remesurera
    if (t - t0 > 1000) { if (last) samples.push(t - last); last = t; }
    if (samples.length < 120) { requestAnimationFrame(step); return; }
    samples.sort((a, b) => a - b);
    const med = samples[samples.length >> 1];
    if (med > 24 && app.settings.quality === 'high' && !app.qualityExplicit) {
      app.settings.quality = 'low';
      app.autoQuality = true;
      try { app.view.setQuality('low'); } catch (e) { console.warn(e); }
      toast('Qualité graphique réduite pour la fluidité (Réglages).', 'info', 5000);
    }
  };
  requestAnimationFrame(step);
}

// =====================================================================================================
// Campagne
// =====================================================================================================
function currentNode() {
  const id = app.run?.position;
  return id ? app.run?.map?.nodes?.[id] ?? null : null;
}

function newCampaign(seed) {
  try { M.campaign.clearRun(); } catch { /* */ }
  saveUi(null);
  clearBattleRec();
  app.run = M.campaign.newRun(seed ?? (Date.now() >>> 0));
  app.prep = null; app.battle = null; app.summary = null; app.shopSold = new Set();
  save();
  M.audio.play('page');
  go('CAMPAIGN');
}

/**
 * Reprise d'une sauvegarde. L'état fin vient de campaign.js (bataille en attente, choix de rune en attente,
 * événement non résolu) ; runes.ui.v1 ne sert qu'à revenir chez le marchand / au feu de camp si on y était.
 * Une bataille interrompue est rejouée à l'identique (runes.battle.v1) : recharger la page ne l'efface pas.
 */
function resumeCampaign() {
  const run = loadSavedRun();
  if (!run) { newCampaign(); return; }
  app.run = run;
  app.prep = null; app.battle = null; app.summary = null; app.result = null;
  const C = M.campaign;
  const node = currentNode();
  app.node = node;
  let pending = null;
  try { pending = C.pendingBattle ? C.pendingBattle(run) : null; } catch { pending = null; }
  const rec = loadBattleRec();
  if (pending) {
    if (rec && rec.nodeId === pending.id && rec.runSeed === (run.seed ?? null)) { resumeBattle(pending, rec); return; }
    clearBattleRec();
    const ui = loadUi();
    if (ui?.phase === 'battle' && ui.nodeId === pending.id) toast('La bataille avait été interrompue : elle reprend au déploiement.', 'info', 6000);
    enterPrep(pending);
    return;
  }
  if (rec) clearBattleRec();   // enregistrement périmé (bataille déjà soldée)
  const lo = run.lastOutcome;
  if (run.pendingSteal && lo?.summary && (!node || lo.nodeId === node.id)) {
    app.summary = lo.summary;
    app.result = { winner: lo.summary.won ? 'player' : 'enemy', reason: lo.summary.reason ?? null };
    go('RESULT'); return;
  }
  if (node?.kind === 'event' && run.event && !run.event.resolved) { go('EVENT'); return; }
  const ui = loadUi();
  if (node && ui?.nodeId === node.id) {
    if (node.kind === 'shop' && ui.phase === 'shop') { go('SHOP'); return; }
    if (node.kind === 'camp' && ui.phase === 'camp' && !run.campUsed) { go('CAMP'); return; }
  }
  go('CAMPAIGN');
}

function pickNode(nodeId) {
  if (!app.run) return;
  try { app.run = M.campaign.enterNode(app.run, nodeId) ?? app.run; }
  catch (e) { console.error(e); runtimeToast(`Étape inaccessible : ${e.message}`); return; }
  const node = app.run.map.nodes[nodeId];
  app.node = node;
  app.shopSold = new Set();
  clearBattleRec();
  save();
  if (BATTLE_KINDS.includes(node.kind)) { saveUi({ nodeId, phase: 'prep' }); enterPrep(node); }
  else if (node.kind === 'shop') { saveUi({ nodeId, phase: 'shop', sold: [] }); go('SHOP'); }
  else if (node.kind === 'camp') { saveUi({ nodeId, phase: 'camp' }); go('CAMP'); }
  else if (node.kind === 'event') { saveUi({ nodeId, phase: 'event' }); go('EVENT'); }
  else go('CAMPAIGN');
}

function leaveNode(node) {
  saveUi({ nodeId: node?.id, phase: 'done' });
  if (app.run?.status === 'lost') { go('END', { won: false }); return; }
  M.audio.play('page');
  go('CAMPAIGN');
}

function afterResult() {
  const node = app.node || currentNode();
  saveUi({ nodeId: node?.id, phase: 'done' });
  const won = !!app.summary?.won;
  app.battle = null; app.prep = null;
  if (!won || app.run?.status === 'lost') { go('END', { won: false }); return; }
  if (node?.kind === 'boss' || app.run?.status === 'won') { go('END', { won: true }); return; }
  go('CAMPAIGN');
}

// =====================================================================================================
// Préparation
// =====================================================================================================
async function enterPrep(node) {
  teardown();
  const nav = app.nav;
  app.screen = 'PREP_LOADING';
  app.node = node;
  const wait = M.screens.renderWait(uiRoot(), 'Les éclaireurs reviennent avec leur rapport…');
  app.ctl = wait;
  if (!app.view) {
    if (!(await needView(wait, nav))) return;
    wait.setText?.('Les éclaireurs reviennent avec leur rapport…');
  }
  try { app.view.setActive?.(true); } catch { /* */ }
  await sleep(40); // laisse le navigateur peindre l'attente : l'IA simule des dizaines de batailles
  if (nav !== app.nav) return;
  let prepared;
  try {
    // version asynchrone si la campagne la fournit : l'IA rend la main entre deux candidats (attente animée)
    if (M.campaign.prepareBattleAsync) {
      prepared = await M.campaign.prepareBattleAsync(app.run, node, {
        yieldFn: (p) => {
          if (p?.total) wait.setText?.(`Les éclaireurs reviennent avec leur rapport… ${Math.round((100 * p.done) / p.total)} %`);
          return new Promise(res => setTimeout(res, 0));
        },
      });
    } else prepared = M.campaign.prepareBattle(app.run, node);
  } catch (e) { console.error(e); wait.destroy(); app.ctl = null; runtimeToast(`Préparation impossible : ${e.message}`); go('CAMPAIGN'); return; }
  if (nav !== app.nav) return;
  save();   // la campagne peut mémoriser le plan ennemi (run.battlePlan) : le rapport ne change plus au rechargement
  const { map, enemyPlan, seed } = prepared;
  let scout = [];
  try { scout = M.ai.scoutReport(enemyPlan, map) ?? []; } catch (e) { console.warn(e); }
  if (Array.isArray(prepared.notes)) scout = [...scout, ...prepared.notes];
  app.prep = { node, map, enemyPlan, seed, scout, placements: new Map() };
  try { app.view.setPlates?.(true); app.view.setMap(map); app.view.setRavens?.([]); } catch (e) { console.warn(e); }   // le HUD recadre la caméra
  autoDeploy();
  // Shaders du plateau, des figurines et des effets compilés derrière l'écran d'attente : sans cela, la première
  // image de la préparation, puis la première boule de feu ou le premier corbeau, figent l'écran un instant.
  if (app.view.prepare) {
    try { app.view.setUnits(prepUnits(app.prep)); } catch (e) { console.warn(e); }
    wait.setText?.('Les figurines prennent place sur le champ de bataille…');
    try { await app.view.prepare(); } catch (e) { console.warn(e); }
    if (nav !== app.nav) return;
  }
  app.screen = 'PREP_LOADING';
  go('PREP');
}

/** Figurines de la préparation pour la vue (mêmes champs que le HUD de préparation). */
function prepUnits(p) {
  const { UNITS } = M.data;
  const out = [];
  for (const ru of app.run?.roster ?? []) {
    const pos = p.placements.get(ru.uid);
    if (!pos) continue;
    const U = UNITS[ru.type];
    out.push({ id: ru.uid, uid: ru.uid, type: ru.type, side: 'player', q: pos.q, r: pos.r, hp: U.hp, maxHp: U.hp, alive: true, facing: 0, status: {} });
  }
  (p.enemyPlan?.units ?? []).forEach((e, i) => {
    const U = UNITS[e.type];
    out.push({ id: `e${i}`, type: e.type, side: 'enemy', q: e.q, r: e.r, hp: U?.hp ?? 1, maxHp: U?.hp ?? 1, alive: true, facing: 3, status: {} });
  });
  return out;
}

function placeUnit(uid, q, r) {
  const p = app.prep; if (!p) return false;
  if (!M.maputil.isDeployHex(p.map, 'player', q, r)) return false;
  for (const [u, pos] of p.placements) if (u !== uid && pos.q === q && pos.r === r) return false;
  p.placements.set(uid, { q, r });
  return true;
}
function unplaceUnit(uid) { app.prep?.placements.delete(uid); }

/** Déploiement automatique : commandant à l'arrière, mêlée devant, tireurs au milieu (collines), cavalerie aux ailes. */
function autoDeploy() {
  const p = app.prep;
  if (!p || !app.run) return;
  const { UNITS } = M.data;
  const map = p.map;
  const free = M.maputil.deployHexes(map, 'player').map(x => {
    const t = M.maputil.getTile(map, x.q, x.r);
    return { q: x.q, r: x.r, col: t?.col ?? x.q, row: t?.row ?? 0, terrain: t?.terrain ?? 'plain' };
  });
  p.placements.clear();
  const used = new Set();
  const mid = Math.floor((map.h ?? 9) / 2);
  const PRIO = { commander: 0, colossus: 1, infantry: 2, ranged: 3, caster: 4, cavalry: 5 };
  const PLAN = {
    commander: { col: 0, rows: [0, 1, -1] },
    colossus: { col: 2, rows: [0, 1, -1, 2] },
    infantry: { col: 2, rows: [-1, 1, -2, 2, 0, -3, 3] },
    ranged: { col: 1, rows: [-1, 1, 0, -2, 2] },
    caster: { col: 1, rows: [0, 1, -1, 2] },
    cavalry: { col: 2, rows: [-3, 3, -2, 2] },
  };
  const count = {};
  const order = [...app.run.roster].sort((a, b) => (PRIO[UNITS[a.type]?.cls] ?? 9) - (PRIO[UNITS[b.type]?.cls] ?? 9));
  for (const ru of order) {
    const cls = UNITS[ru.type]?.cls ?? 'infantry';
    const plan = PLAN[cls] ?? PLAN.infantry;
    const i = (count[cls] = (count[cls] ?? -1) + 1);
    const tRow = mid + plan.rows[i % plan.rows.length];
    let best = null, bestS = Infinity;
    for (const x of free) {
      const k = `${x.q},${x.r}`;
      if (used.has(k)) continue;
      let sc = 3 * Math.abs(x.col - plan.col) + 2 * Math.abs(x.row - tRow);
      if (x.terrain === 'ford') sc += 4;
      if (x.terrain === 'forest') sc += cls === 'cavalry' ? 3 : cls === 'ranged' ? 1 : 0;
      if (x.terrain === 'hill' && (cls === 'ranged' || cls === 'caster')) sc -= 1.5;
      if (x.terrain === 'ruins' && (cls === 'commander' || cls === 'ranged')) sc -= 1;
      if (sc < bestS) { bestS = sc; best = x; }
    }
    if (!best) break;
    used.add(`${best.q},${best.r}`);
    p.placements.set(ru.uid, { q: best.q, r: best.r });
  }
  if (app.screen === 'PREP') app.ctl?.update?.();
}

// =====================================================================================================
// Bataille
// =====================================================================================================
/** Crée la bataille d'un enregistrement (copies : le moteur ne doit pas modifier l'enregistrement). */
function createBattleFrom(rec) {
  const r = clone(rec);
  return M.sim.createBattle({
    map: r.map,
    player: { faction: 'royaume', units: r.units },
    enemy: { faction: 'gobelins', units: r.enemyPlan.units },
    seed: r.seed,
    ravens: r.ravens,
  });
}

function startBattle() {
  const p = app.prep, run = app.run;
  if (!p || !run) return false;
  const { UNITS, START_RAVENS } = M.data;
  const hasCmd = run.roster.some(ru => UNITS[ru.type]?.cls === 'commander' && p.placements.has(ru.uid));
  if (!hasCmd) { runtimeToast('Placez d’abord votre commandant.'); return false; }
  const units = [];
  for (const ru of run.roster) {
    const pos = p.placements.get(ru.uid);
    if (!pos) continue;
    const program = M.program.sanitizeProgram(ru.program, ru.type, { unlocked: run.unlocked ?? null, slotsBonus: ru.bonus?.slots ?? 0 });
    units.push({ uid: ru.uid, type: ru.type, name: ru.name || UNITS[ru.type]?.name, q: pos.q, r: pos.r, program, bonus: { atk: ru.bonus?.atk ?? 0, slots: ru.bonus?.slots ?? 0 } });
  }
  // L'enregistrement de la bataille (tout ce qu'il faut pour la rejouer à l'identique) est figé AVANT la création.
  let rec;
  try {
    rec = clone({
      v: 1, runSeed: run.seed ?? null, nodeId: p.node?.id ?? null,
      map: p.map, enemyPlan: p.enemyPlan, seed: p.seed, units,
      ravens: { player: run.ravens ?? START_RAVENS.player, enemy: p.enemyPlan.ravens ?? START_RAVENS.enemy },
      sent: [],
    });
    app.battle = createBattleFrom(rec);
  } catch (e) { console.error(e); runtimeToast(`La bataille ne peut pas commencer : ${e.message}`); return false; }
  try { app.enemyPolicy = M.ai.makeEnemyRavenPolicy(p.enemyPlan); } catch (e) { console.warn(e); app.enemyPolicy = null; }
  app.battleRec = rec;
  app.ended = false;
  app.summary = null; app.result = null;
  app.modalPrevSpeed = null;
  app.lastSpeed = app.settings.speed || 1;
  // Première bataille de la campagne : elle attend que le joueur l'engage (le temps de regarder le champ).
  const first = !app.debug && (run.battlesWon ?? 0) === 0;
  setSpeed(first ? 0 : app.lastSpeed);     // passe aussi par view.setPaused : une vue restée en pause repart
  app.battleIntro = first ? 'Première bataille : prenez le temps d’observer le champ, puis engagez le combat.' : null;
  save();
  saveBattleRec(); saveBattleTick(0);
  saveUi({ nodeId: p.node?.id, phase: 'battle' });
  try { app.view.setUnits(app.battle.units); app.view.setRavens?.(app.battle.ravens ?? []); app.view.setHighlights?.([]); app.view.setSelected?.(null); } catch (e) { console.warn(e); }
  M.audio.play('caw', { gain: 0.6 });
  go('BATTLE');
  return true;
}

/**
 * Reprise d'une bataille interrompue (rechargement, onglet fermé) : on la recrée depuis son enregistrement et on
 * rejoue sans animation jusqu'au dernier instant joué, en réappliquant les corbeaux du joueur à l'instant exact
 * où ils sont partis (même ordre que la boucle : corbeaux du joueur, politique ennemie, instant). Le joueur
 * reprend la main au même moment, en pause ; si la bataille était déjà finie, on passe au résultat.
 */
async function resumeBattle(node, rec) {
  teardown();
  const nav = app.nav;
  app.screen = 'PREP_LOADING';
  app.node = node;
  const wait = M.screens.renderWait(uiRoot(), 'La bataille reprend…');
  app.ctl = wait;
  if (!app.view && !(await needView(wait, nav))) return;
  wait.setText?.('La bataille reprend…');
  await sleep(30);
  if (nav !== app.nav) return;
  let b;
  try {
    b = createBattleFrom(rec);
    app.enemyPolicy = M.ai.makeEnemyRavenPolicy(clone(rec.enemyPlan));
  } catch (e) {
    console.error(e); wait.destroy(); app.ctl = null; clearBattleRec();
    runtimeToast(`La bataille ne peut pas reprendre : ${e.message}`);
    enterPrep(node);
    return;
  }
  app.battleRec = { ...rec };
  delete app.battleRec.tick;
  app.prep = { node, map: rec.map, enemyPlan: rec.enemyPlan, seed: rec.seed, scout: [], placements: new Map(rec.units.map(u => [u.uid, { q: u.q, r: u.r }])) };
  app.battle = b;
  app.ended = false; app.summary = null; app.result = null;
  const target = Math.max(rec.tick || 0, ...rec.sent.map(s => s.tick || 0));
  const applyRavens = () => {
    for (const s of rec.sent) if (s.tick === b.tick) { try { M.sim.sendRaven(b, 'player', s.unitId, s.program); } catch (e) { console.warn(e); } }
  };
  let guard = 0;
  while (!b.result && b.tick < target && guard++ < 2000) { applyRavens(); stepOnce(b, 0, { record: false }); }
  if (!b.result) applyRavens();      // corbeaux envoyés après le dernier instant joué
  wait.destroy(); app.ctl = null;
  if (nav !== app.nav) return;
  try {
    app.view.setActive?.(true);
    app.view.setPlates?.(true); app.view.setMap(rec.map);
    app.view.setUnits(b.units); app.view.setRavens?.(b.ravens ?? []); app.view.setHighlights?.([]); app.view.setSelected?.(null);
  } catch (e) { console.warn(e); }
  if (b.result) { onBattleEnd(); go('RESULT'); return; }
  app.modalPrevSpeed = null;
  app.lastSpeed = app.settings.speed || 1;
  setSpeed(0);
  app.battleIntro = `La bataille avait été interrompue : elle reprend à l’instant ${b.tick}.`;
  saveUi({ nodeId: node.id, phase: 'battle' });
  go('BATTLE');
}

function notifySpeed() { const w = app.speedWaiters; app.speedWaiters = []; w.forEach(f => f()); }
function waitForSpeed() { return new Promise(res => app.speedWaiters.push(res)); }

/** Vitesse : 0 = pause, 1, 2 ou 4. -1 = reprendre à la dernière vitesse. */
function setSpeed(n) {
  n = Number(n);
  if (n === -1) n = app.lastSpeed || 1;
  if (![0, 1, 2, 4].includes(n)) n = n >= 3 ? 4 : n > 0 ? Math.round(n) : 0;
  if (n > 0) app.lastSpeed = n;
  app.speed = n;
  if (app.modalPrevSpeed != null && n > 0) app.modalPrevSpeed = null;
  try { app.view?.setPaused?.(n === 0); } catch { /* */ }
  notifySpeed();
  if (app.screen === 'BATTLE') app.ctl?.refresh?.();
  return n;
}
/** Pause « modale » (rédaction d'un corbeau, fenêtre d'aide) : restaure la vitesse précédente à la fermeture. */
function holdPause(on) {
  if (on) {
    if (app.modalPrevSpeed == null) app.modalPrevSpeed = app.speed;
    if (app.speed !== 0) setSpeed(0);
  } else {
    const prev = app.modalPrevSpeed;
    app.modalPrevSpeed = null;
    if (prev) setSpeed(prev);
  }
}

function playerRaven(unitId, program) {
  const b = app.battle;
  if (!b || b.result) return { ok: false, reason: 'La bataille est terminée.' };
  const tick = b.tick;
  let r;
  try { r = M.sim.sendRaven(b, 'player', unitId, program); } catch (e) { r = { ok: false, reason: e.message }; }
  if (r?.ok) {
    // noté avec l'instant AVANT lequel il part : la reprise le renvoie au même moment
    if (app.battleRec) { try { app.battleRec.sent.push({ tick, unitId, program: clone(program) }); } catch { /* */ } saveBattleRec(); }
    try { app.view.setRavens?.(b.ravens); } catch { /* */ }
    app.ctl?.refresh?.();
  }
  return r;
}

function stepOnce(b, durationMs, { record = true } = {}) {
  if (app.enemyPolicy && (b.ravensLeft?.enemy ?? 0) > 0) {
    try {
      const pol = app.enemyPolicy(b);
      if (pol && pol.unitId && pol.program) M.sim.sendRaven(b, 'enemy', pol.unitId, pol.program);
    } catch (e) { console.warn('Politique de corbeaux ennemie', e); }
  }
  const report = M.sim.stepBattle(b);
  if (record) saveBattleTick(b.tick);
  try { M.hud.onTick(report, b); } catch (e) { console.warn(e); }
  if (durationMs) M.audio.playBattleEvents?.(report.events, durationMs);
  return report;
}

function startLoop() {
  const gen = ++app.loopGen;
  battleLoop(gen).catch(e => { console.error(e); runtimeToast(`La bataille s’est interrompue : ${e.message}`); });
}
function stopLoop() { app.loopGen++; notifySpeed(); }

async function battleLoop(gen) {
  const b = app.battle;
  await sleep(500);
  while (gen === app.loopGen && b === app.battle && !b.result) {
    if (app.speed === 0) { await waitForSpeed(); continue; }
    // onglet masqué : le navigateur suspend l'animation, on suspend donc aussi la bataille
    if (document.hidden) { await new Promise(r => document.addEventListener('visibilitychange', r, { once: true })); continue; }
    // contexte WebGL perdu : la bataille attend que l'affichage revienne (sans toucher à la pause du joueur)
    if (app.view?.contextLost?.()) {
      let off = null;
      await Promise.race([new Promise(r => { off = app.view.on?.('contextrestored', r); }), waitForSpeed()]);
      try { off?.(); } catch { /* */ }
      continue;
    }
    const dur = TICK_MS / app.speed;
    const report = stepOnce(b, dur);
    const anim = Promise.resolve().then(() => app.view.playTick(report, b, { duration: dur }));
    try { await Promise.race([anim, sleep(dur * 4 + 2000)]); }
    catch (e) { console.warn('playTick', e); try { app.view.setUnits(b.units); app.view.setRavens?.(b.ravens); } catch { /* */ } await sleep(dur); }
    if (gen !== app.loopGen) return;
    if (b.result) { onBattleEnd({ live: true }); return; }
  }
  if (gen === app.loopGen && b.result) onBattleEnd({ live: true });
}

/** Résout le reste de la bataille sans animation (tests, bouton « résoudre »). */
function finishBattleInstantly() {
  const b = app.battle;
  if (!b) return null;
  stopLoop();
  let last = null, guard = 0;
  while (!b.result && guard++ < 2000) last = stepOnce(b, 0);
  try { app.view.setUnits(b.units); app.view.setRavens?.(b.ravens ?? []); } catch (e) { console.warn(e); }
  if (last) app.ctl?.refresh?.();
  onBattleEnd();
  return b.result;
}

/** Fin de bataille. live : la fin vient d'être jouée à l'écran (plan de victoire avant le bandeau). */
function onBattleEnd({ live = false } = {}) {
  const b = app.battle;
  if (!b || app.ended) return;
  app.ended = true;
  app.result = b.result;
  try {
    const out = M.campaign.applyBattleOutcome(app.run, b);
    app.run = out?.run ?? app.run;
    app.summary = out?.summary ?? { won: b.result?.winner === 'player', gold: 0, lost: [], kills: 0, stealable: [], enemyPrograms: [] };
  } catch (e) {
    console.error(e);
    app.summary = { won: b.result?.winner === 'player', gold: 0, lost: [], kills: 0, stealable: [], enemyPrograms: [] };
  }
  save();
  clearBattleRec();     // la bataille est soldée et enregistrée dans la campagne : plus rien à rejouer
  saveUi({ nodeId: (app.node || currentNode())?.id, phase: 'result', summary: app.summary, result: app.result });
  const won = b.result?.winner === 'player';
  M.audio.play(won ? 'victory' : 'defeat');
  if (app.screen === 'BATTLE') {
    // fin jouée en direct : la caméra glisse au ras du commandant vainqueur (≈ 1,5 s) avant le bandeau
    let ms = 0;
    if (live) { try { ms = app.view?.celebrate?.(b.result?.winner) ?? 0; } catch (e) { console.warn(e); } }
    const show = () => { if (app.screen === 'BATTLE' && app.battle === b) app.ctl?.showEnd?.(b.result, b, () => go('RESULT')); };
    if (ms > 0) setTimeout(show, ms); else show();
  }
}

// =====================================================================================================
// Clavier
// =====================================================================================================
function onGlobalKey(e) {
  if (e.key === 'Escape' && app.overlay) { e.preventDefault(); closeOverlay(); return; }
  const t = e.target;
  const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  // « ? » ou F1 : aide, depuis le titre, la carte, la préparation et la bataille (qu'elle met en pause)
  if ((e.key === '?' || e.key === 'F1') && !app.overlay && !app.ctl?.isModalOpen?.() && ['TITLE', 'CAMPAIGN', 'PREP', 'BATTLE'].includes(app.screen)) {
    e.preventDefault();
    openOverlay('HELP');
    return;
  }
  if (app.screen !== 'BATTLE' || app.overlay || app.ended) return;
  if (app.ctl?.isModalOpen?.()) return;
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (t?.tagName === 'BUTTON') t.blur();
    setSpeed(app.speed === 0 ? -1 : 0);
  } else if (e.key === '1') setSpeed(1);
  else if (e.key === '2') setSpeed(2);
  else if (e.key === '3') setSpeed(4);
}

// =====================================================================================================
// Plateau de démonstration (écran titre sans couverture)
// =====================================================================================================
function showDemoBoard() {
  if (!app.view || !M.mapgen) return;
  try {
    const map = M.mapgen.generateMap({ seed: 'titre-corneilles', kind: 'battle', index: 0 });
    app.view.setMap(map);
    const want = [
      ['k_commander', 'player', 0, 4], ['k_pikemen', 'player', 3, 3], ['k_knights', 'player', 3, 6], ['k_archers', 'player', 1, 2],
      ['k_mage', 'player', 2, 5], ['k_golem', 'player', 4, 4],
      ['g_warchief', 'enemy', 13, 4], ['g_troll', 'enemy', 9, 4], ['g_spears', 'enemy', 10, 2], ['g_spears', 'enemy', 10, 6],
      ['g_wolves', 'enemy', 11, 7], ['g_archers', 'enemy', 12, 2], ['g_shaman', 'enemy', 12, 5],
    ];
    const used = new Set();
    const tiles = map.tiles.filter(t => ['plain', 'forest', 'hill', 'ruins'].includes(t.terrain));
    const units = [];
    want.forEach(([type, side, col, row], i) => {
      let best = null, bd = Infinity;
      for (const t of tiles) {
        const k = `${t.q},${t.r}`; if (used.has(k)) continue;
        const d = Math.abs(t.col - col) * 1.5 + Math.abs(t.row - row);
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) return;
      used.add(`${best.q},${best.r}`);
      const U = M.data.UNITS[type];
      units.push({ id: `demo${i}`, type, side, q: best.q, r: best.r, hp: U.hp, maxHp: U.hp, alive: true, facing: side === 'player' ? 0 : 3, status: {} });
    });
    app.view.setPlates?.(false);
    app.view.setUnits(units);
    app.view.setHighlights?.([]);
    const c = M.hex.hexToWorld(6, 1);
    app.view.setRavens?.([{ id: 'demo-raven', side: 'player', unitId: 'demo4', program: { rules: [] }, x: c.x, z: c.z, alive: true, delivered: false, launchedAt: 0 }]);
  } catch (e) { console.warn('Plateau de démonstration indisponible', e); }
}

// =====================================================================================================
// Débogage
// =====================================================================================================
const DEBUG_ROUTES = ['map', 'prep', 'battle', 'result', 'shop', 'camp', 'event', 'end', 'help'];
function debugRoute() {
  const m = /^#debug-([a-z]+)$/.exec(location.hash || '');
  return m && DEBUG_ROUTES.includes(m[1]) ? m[1] : null;
}
function findNode(run, kind) {
  for (const col of run.map.columns) for (const id of col) if (run.map.nodes[id]?.kind === kind) return run.map.nodes[id];
  return null;
}
function forceEnter(node) {
  try { app.run = M.campaign.enterNode(app.run, node.id) ?? app.run; } catch { /* nœud non atteignable : on force */ }
  if (app.run.position !== node.id) {
    // débogage : on « téléporte » l'armée sur le nœud, avec les mêmes champs que campaign.enterNode
    const combat = BATTLE_KINDS.includes(node.kind);
    Object.assign(app.run, {
      position: node.id, visited: [...new Set([...(app.run.visited ?? []), node.id])],
      nodeDone: !(combat || node.kind === 'event'), campUsed: false, shop: null, event: null, lastOutcome: null,
    });
  }
  app.node = node;
}
async function runDebug(route) {
  app.debug = true;
  stopLoop();
  closeOverlay();
  app.run = M.campaign.newRun(DEBUG_SEED);
  app.prep = null; app.battle = null; app.battleRec = null; app.summary = null; app.shopSold = new Set();
  document.title = `[debug-${route}] Runes de Commandement`;
  const first = app.run.map.nodes[app.run.map.columns[0][0]];
  switch (route) {
    case 'map': go('CAMPAIGN'); break;
    case 'help': go('CAMPAIGN'); openOverlay('HELP'); break;
    // les routes de plateau attendent la vue 3D (enterPrep affiche la progression des modèles)
    case 'prep': forceEnter(first); await enterPrep(first); break;
    case 'battle': forceEnter(first); await enterPrep(first); if (app.screen === 'PREP') startBattle(); break;
    case 'result': forceEnter(first); await enterPrep(first); if (app.screen === 'PREP' && startBattle()) { finishBattleInstantly(); go('RESULT'); } break;
    case 'shop': { const n = findNode(app.run, 'shop') ?? first; app.run.gold = Math.max(app.run.gold ?? 0, 260); forceEnter(n); go(n.kind === 'shop' ? 'SHOP' : 'CAMPAIGN'); break; }
    case 'camp': { const n = findNode(app.run, 'camp') ?? first; forceEnter(n); go(n.kind === 'camp' ? 'CAMP' : 'CAMPAIGN'); break; }
    case 'event': { const n = findNode(app.run, 'event') ?? first; forceEnter(n); go(n.kind === 'event' ? 'EVENT' : 'CAMPAIGN'); break; }
    case 'end': app.run = { ...app.run, status: 'won', battlesWon: 3 }; if (!app.uiReady) return; go('END', { won: true }); break;
    default: go('TITLE');
  }
}

// =====================================================================================================
// API de test
// =====================================================================================================
function exposeTestApi() {
  window.__runes = {
    get state() {
      return {
        screen: app.screen, ready: app.ready, uiReady: app.uiReady, viewReady: !!app.view, debug: app.debug, speed: app.speed,
        tick: app.battle?.tick ?? null, result: app.battle?.result ?? null,
        nodeId: app.run?.position ?? null, placements: app.prep ? Object.fromEntries(app.prep.placements) : null,
        errors: app.errors,
      };
    },
    getRun: () => app.run,
    getBattle: () => app.battle,
    get view() { return app.view; },
    go: (s, o) => go(s, o),
    autoDeploy: () => { autoDeploy(); return app.prep ? Object.fromEntries(app.prep.placements) : null; },
    startBattle: () => startBattle(),
    setSpeed: (n) => setSpeed(n),
    finishBattleInstantly: () => finishBattleInstantly(),
    modules: M,
  };
}

installLocalization();
boot().catch((e) => {
  console.error(e);
  showFatal([{ k: 'main', p: './main.js', label: 'Démarrage du jeu', error: e }]);
});
