// js/ui/screens.js — écrans hors bataille : titre, carte de campagne, marchand, feu de camp, événement,
// résultat (grimoire ennemi), fin, aide, réglages. Plus les petits utilitaires DOM partagés avec hud.js.
//
// Ce module ne fait AUCUN import statique de modules d'autres équipes (editor, campaign, sim…) :
// main.js les charge et les injecte avec initScreens(deps), pour qu'un module manquant n'empêche pas l'UI de s'afficher.
//
// Chaque renderXxx(root, data, handlers) ajoute un <section class="screen"> dans root et renvoie un contrôleur
// { el, destroy(), ...méthodes de mise à jour }. Les handlers sont des callbacks (main.js possède l'état).
import { UNITS, RUNES, TRAITS, TERRAIN, CAMPAIGN, SPELLS, MAX_RAVENS, DEFAULT_PROGRAMS, CLASSES } from '../core/data.js';
import { programCost, unitSlotsFor, describeRule, runeAllowedFor, describeCond, describeAction } from '../core/program.js';
import { translate } from '../i18n.js';

/** Dépendances injectées par main.js : { editor, campaign, audio, assetsBase } (toutes optionnelles). */
export const deps = { editor: null, campaign: null, audio: null, assetsBase: 'assets/' };
/** @param {{editor?:object, campaign?:object, audio?:object, assetsBase?:string}} d */
export function initScreens(d = {}) { Object.assign(deps, d); }

export const NB = ' '; // espace insécable (typographie française : « Victoire ! »)

// ====================================================================== mise en page
// Mêmes requêtes que css/game.css : téléphone en portrait (étroit) ou en paysage (écran bas).
const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
export const PHONE_PORTRAIT_Q = '(max-width: 720px)';
export const PHONE_LANDSCAPE_Q = '(max-height: 500px) and (orientation: landscape)';
/** 'desktop' | 'phone' (portrait étroit) | 'landscape' (téléphone couché : la hauteur manque). */
export function layoutMode() {
  if (mq(PHONE_LANDSCAPE_Q)) return 'landscape';
  if (mq(PHONE_PORTRAIT_Q)) return 'phone';
  return 'desktop';
}
/** Mise en page tactile compacte (portrait ou paysage). */
export const isPhoneLayout = () => layoutMode() !== 'desktop';
/** Écran tactile sans survol : « touchez » plutôt que « cliquez », pas de « survolez ». */
export const touchUi = () => mq('(hover: none), (pointer: coarse)');

// ====================================================================== DOM
/**
 * Petit constructeur DOM. props : class, id, text, style (objet), dataset, on<Event> (fonction), autres attributs.
 * Les enfants peuvent être des nœuds, des chaînes, des tableaux, null/false (ignorés).
 */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  appendKids(el, kids);
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}
function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
/** Ajoute des enfants à el en ignorant null/false (contrairement à Element.append qui écrirait « null »). */
export function add(el, ...kids) { appendKids(el, kids); return el; }
/** Crée un élément SVG à partir d'un balisage statique (chaînes internes uniquement). */
export function svgEl(markup, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const s = t.content.firstElementChild;
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  return s;
}
export const clear = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); return el; };

// ====================================================================== icônes (traits, currentColor)
const I24 = (body, fill = false) => `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICONS = {
  raven: I24('<path d="M1.8 12.6c2.6-2.4 5.6-2.8 8.6-1.4 1-2.7 3.6-4.6 7.2-4.7l-1.5 1.7c2 .1 3.9.8 5.5 1.9-3 .2-5.8 1-7.7 2.9-1.1 2.3-3.1 3.7-6 3.9l1.7-1.9c-2.9.2-5.4-.6-7.8-2.4z"/><circle cx="16.9" cy="8.6" r=".6" fill="#120f0d"/>', true),
  coin: I24('<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="5.4" stroke-width="1.1"/><path d="M12 8.6v6.8M10.2 10.2h3.6" stroke-width="1.3"/>'),
  swords: I24('<path d="M4 4l11 11M20 4L9 15"/><path d="M13 17l4-4M7 13l4 4" /><path d="M16.5 16.5l3 3M7.5 16.5l-3 3"/>'),
  shield: I24('<path d="M12 3l7 2.6v5.6c0 4.6-3 8-7 9.8-4-1.8-7-5.2-7-9.8V5.6z"/>'),
  heart: I24('<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>'),
  pause: I24('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="2.6"/>'),
  play: I24('<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/>'),
  skip: I24('<path d="M5 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor" stroke-width="1.2"/><path d="M20.5 5.5v13" stroke-width="2"/>'),
  close: I24('<path d="M6 6l12 12M18 6L6 18" stroke-width="2"/>'),
  book: I24('<path d="M4 5.5c2.8-1 5.6-1 8 .8 2.4-1.8 5.2-1.8 8-.8v13c-2.8-1-5.6-1-8 .8-2.4-1.8-5.2-1.8-8-.8z"/><path d="M12 6.3v13"/>'),
  gear: I24('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1"/>'),
  menu: I24('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  back: I24('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  check: I24('<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.2"/>'),
  flag: I24('<path d="M6 21V4M6 4.5c3-1.6 6 1.6 9 0s4-.6 4-.6v8.6s-1 .9-4 .6-6-2.2-9-.6"/>'),
  dice: I24('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>'),
  sound: I24('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  mute: I24('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  eye: I24('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  scroll: I24('<path d="M7 4h11a2 2 0 0 1 0 4h-1v10a2 2 0 0 1-2 2H6a2 2 0 0 1 0-4h1z"/><path d="M7 4a2 2 0 0 0-2 2v2h2M10 9h5M10 12h5M10 15h3"/>'),
  hourglass: I24('<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>'),
  sparkle: I24('<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.6L12 17l-1.8-5.4L4.5 10l5.7-1.4z"/>'),
  // cadrage de la caméra : tout le champ (coins du cadre) / suivre l'action (mire)
  overview: I24('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path d="M12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z" stroke-width="1.4"/>'),
  follow: I24('<circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
};
/** Icône en ligne (SVG) ; name ∈ ICONS. */
export function icon(name, cls = 'ico') { return svgEl(ICONS[name] || ICONS.sparkle, cls); }

// Icônes des nœuds de la carte de campagne (viewBox 32, encre).
const N32 = (body) => `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const NODE_ICONS = {
  battle: N32('<path d="M5.5 5.5l14 14" stroke-width="2.4"/><path d="M26.5 5.5l-14 14" stroke-width="2.4"/><path d="M17 22.5l5.5-5.5M9.5 17l5.5 5.5"/><path d="M20.5 20.5l4 4M11.5 20.5l-4 4"/><circle cx="25.6" cy="25.6" r="1.6" fill="currentColor"/><circle cx="6.4" cy="25.6" r="1.6" fill="currentColor"/>'),
  elite: N32('<path d="M10 15.5a6 6 0 1 1 12 0v3l-2 2v3h-8v-3l-2-2z"/><circle cx="13.6" cy="16" r="1.7" fill="currentColor"/><circle cx="18.4" cy="16" r="1.7" fill="currentColor"/><path d="M16 18.6l-1 1.8h2z" fill="currentColor"/><path d="M14 21.4v2M16 21.4v2M18 21.4v2" stroke-width="1.2"/><path d="M10.6 12.4C6.4 11.6 4.4 8 6 3.6c.8 3.2 3 5.2 6.2 5.6"/><path d="M21.4 12.4c4.2-.8 6.2-4.4 4.6-8.8-.8 3.2-3 5.2-6.2 5.6"/>'),
  boss: N32('<path d="M8 11.5l1.6-7 4 4 2.4-5 2.4 5 4-4 1.6 7z" fill="currentColor" fill-opacity=".18"/><path d="M8.6 11.5h14.8"/><path d="M11 21a5 5 0 1 1 10 0v2.4l-1.6 1.6v2.6h-6.8V25L11 23.4z"/><circle cx="14" cy="21.4" r="1.4" fill="currentColor"/><circle cx="18" cy="21.4" r="1.4" fill="currentColor"/><path d="M14.4 26v1.6M16 26v1.6M17.6 26v1.6" stroke-width="1.1"/>'),
  shop: N32('<path d="M11 12.5c-4.6 3.6-5.6 14.5 5 14.5s9.6-10.9 5-14.5z"/><path d="M10.4 12.5h11.2"/><path d="M12 12.5L9.5 7.5l3.6 1.6L16 5.6l2.9 3.5 3.6-1.6-2.5 5"/><circle cx="16" cy="20" r="3.4"/><path d="M16 18.2v3.6" stroke-width="1.3"/>'),
  camp: N32('<path d="M16 4.5c3.8 4 6.6 7.5 4.6 12.6-.9 2.4-2.6 3.6-4.6 3.6-3 0-5.2-2.2-5.2-5 0-2.6 1.6-3.8 2.9-6.2.6 2.2 1.4 3.2 2.3 3.6.6-2.6.6-5.6 0-8.6z"/><path d="M16 13.5c1.8 2 2.2 4.2 0 5.8-2.2-1.6-1.8-3.8 0-5.8z" fill="currentColor" fill-opacity=".35"/><path d="M6.5 27.5l19-5.5M6.5 22l19 5.5" stroke-width="2.6"/>'),
  event: N32('<path d="M10.5 7h13a3 3 0 0 1 0 6h-1.6v11a3.5 3.5 0 0 1-3.5 3.5H8.5a3 3 0 0 1 0-6h2z"/><path d="M10.5 7a2.8 2.8 0 0 0-5.6 0v2.4h5.6M14 13.5h5.5M14 17h5.5M14 20.5h3.5"/>'),
};
export const NODE_KIND = {
  battle: { name: 'Bataille', desc: 'Une bande gobeline barre la route. Victoire : +50 or, +5 par ennemi abattu.' },
  elite:  { name: 'Élite', desc: 'Une troupe aguerrie aux grimoires plus riches. Victoire : +80 or et une rune.' },
  boss:   { name: 'Bataille finale', desc: 'Le Chef de guerre et son troll. Tout se joue ici.' },
  shop:   { name: 'Marchand', desc: 'Runes, recrues et corbeaux, contre de l’or.' },
  camp:   { name: 'Feu de camp', desc: 'Méditer (+1 emplacement) ou forger (+1 attaque). Un quartier-maître y loue une recrue.' },
  event:  { name: 'Événement', desc: 'Une rencontre sur la route. À vous de choisir.' },
};

// ====================================================================== unités : glyphes, portraits, noms
const UNIT_GLYPH = {
  k_commander: 'ᛟ', k_pikemen: 'ᛉ', k_knights: 'ᛖ', k_archers: 'ᛏ', k_mage: 'ᚲ', k_golem: 'ᚦ',
  g_warchief: 'ᚺ', g_spears: 'ᛜ', g_wolves: 'ᚹ', g_archers: 'ᛣ', g_shaman: 'ᛗ', g_troll: 'ᚦ',
};
export const unitGlyph = (type) => UNIT_GLYPH[type] || 'ᚱ';
export const sideOf = (type) => (UNITS[type]?.faction === 'gobelins' ? 'gobelins' : 'royaume');
const portraitState = new Map(); // type -> 'ok' | 'missing'
const portraitPath = new Map();  // type -> chemin relatif à assetsBase (d'après le manifeste), versionné ?v=<octets>
/**
 * Indique les portraits réellement livrés (assets/manifest.json). Avec un manifeste, on ne demande jamais un fichier
 * absent (pas d'erreur 404 en console) ; sans manifeste (null), on tente portraits/<type>.webp et on se rabat sur le glyphe.
 * L'URL porte la taille du fichier (?v=…, comme les modèles 3D) : un hôte qui garde tout en cache sert la nouvelle
 * image dès qu'elle change.
 * @param {object|null} manifest
 */
export function setAssetManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.assets) return;
  for (const type of Object.keys(UNITS)) {
    const a = manifest.assets[type];
    const p = a?.portrait;
    if (typeof p === 'string' && p) portraitPath.set(type, Number.isFinite(a.portraitBytes) ? `${p}${p.includes('?') ? '&' : '?'}v=${a.portraitBytes}` : p);
    else portraitState.set(type, 'missing');
  }
}

/**
 * Portrait d'unité : médaillon à glyphe runique (toujours présent) + image assets/portraits/<type>.webp par-dessus,
 * retirée proprement si elle manque.
 */
export function portrait(type, { size = 'md', extraClass = '' } = {}) {
  const side = sideOf(type);
  const el = h('span', { class: `portrait portrait-${size} side-${side} ${extraClass}`.trim(), 'aria-hidden': 'true' },
    h('span', { class: 'portrait-glyph', text: unitGlyph(type) }));
  if (portraitState.get(type) !== 'missing') {
    const img = h('img', { class: 'portrait-img', alt: '', draggable: 'false', decoding: 'async', loading: 'lazy',
      src: `${deps.assetsBase}${portraitPath.get(type) ?? `portraits/${type}.webp`}` });
    img.addEventListener('load', () => { portraitState.set(type, 'ok'); el.classList.add('has-img'); });
    img.addEventListener('error', () => { portraitState.set(type, 'missing'); img.remove(); });
    if (portraitState.get(type) === 'ok') el.classList.add('has-img');
    el.append(img);
  }
  return el;
}

// Grammaire minimale des noms d'unités : « Piquiers de Valmont » (pluriel), « Golem de Roche-Grise » (masculin),
// « Sire Aymeric », « Sœur Clémence » (noms propres, sans article).
const MASC_HEADS = ['Golem', 'Troll', 'Chaman', 'Chef', 'Mage', 'Commandant', 'Capitaine', 'Corbeau'];
const FEM_HEADS = ['Milice', 'Horde', 'Compagnie'];
const headOf = (name) => String(name ?? '').split(/[\s’']/)[0];
/** Le nom est-il pluriel (« Piquiers », « Archers gobelins », « Lances d’Argentfer ») ? */
export const isPlural = (name = '') => /[sx]$/i.test(headOf(name));
const FEM_PROPER = ['Dame', 'Sœur', 'Isaure', 'Ermengarde', 'Mélisende'];
/** Nom féminin singulier (« Dame Ysolde », « la Milice… ») — pour accorder « abattue ». */
export const isFeminine = (name = '') => !isPlural(name) && (FEM_HEADS.includes(headOf(name)) || FEM_PROPER.includes(headOf(name)));
/** Article défini du nom : 'les' | 'le' | 'la' | '' (nom propre). */
export function articleOf(name) {
  const head = headOf(name);
  if (isPlural(name)) return 'les';
  if (MASC_HEADS.includes(head)) return 'le';
  if (FEM_HEADS.includes(head)) return 'la';
  return '';
}
/** « les Piquiers », « le Troll », « Sire Aymeric ». cap = majuscule initiale. */
export function withArticle(name, cap = false) {
  const a = articleOf(name);
  const s = a ? `${a} ${name}` : String(name ?? '');
  return cap && s ? s[0].toUpperCase() + s.slice(1) : s;
}
export const unitName = (u) => u?.name || UNITS[u?.type]?.name || '?';

/** Emplacements totaux d'une unité du roster (campaign.unitSlots si dispo). */
export function rosterSlots(ru) {
  try { if (deps.campaign?.unitSlots) return deps.campaign.unitSlots(ru); } catch { /* repli */ }
  return unitSlotsFor(ru.type, ru.bonus?.slots ?? 0);
}

// ====================================================================== runes (pastilles décoratives)
const KIND_CLASS = { cond: 'perc', action: 'act', logic: 'link' };
const KIND_NAME = { cond: 'Perception', action: 'Action', logic: 'Liaison' };
/** Pastille émaillée d'une rune (glyphe + nom), colorée par famille. */
export function runeChip(runeId, { size = 'md', withKind = false } = {}) {
  const r = RUNES[runeId];
  if (!r) return h('span', { class: 'rchip', text: runeId });
  return h('span', { class: `rchip rchip-${KIND_CLASS[r.kind]} rchip-${size}`, title: r.help || '' },
    h('span', { class: 'rchip-glyph', 'aria-hidden': 'true', text: r.glyph }),
    h('span', { class: 'rchip-name', text: r.name }),
    withKind ? h('span', { class: 'rchip-kind', text: KIND_NAME[r.kind] }) : null);
}

/** Bloc de rune statique : celui de l'éditeur (editor.runeBadge) s'il existe, sinon la pastille maison. */
export function runeArt(runeId, { size = 'lg' } = {}) {
  if (deps.editor?.runeBadge) {
    try { return h('span', { class: 'rune-art' }, deps.editor.runeBadge(runeId, { showName: true, compact: size !== 'lg' })); }
    catch { /* repli */ }
  }
  return runeChip(runeId, { size, withKind: true });
}

/**
 * Affiche un programme en lecture seule via editor.renderProgramView, avec repli texte si l'éditeur manque.
 * extra : options supplémentaires transmises telles quelles (title, slotsBonus, unlocked, showInstinct).
 * @returns {HTMLElement} l'hôte
 */
export function programView(host, program, unitType, { highlightRule = null, compact = true, ...extra } = {}) {
  host.classList.add('progview');
  if (deps.editor?.renderProgramView) {
    // renderProgramView remplace lui-même le contenu et, si le programme n'a pas changé, ne met à jour que la
    // surbrillance : on ne vide donc pas le conteneur (appel à chaque instant depuis l'inspecteur de bataille).
    try { deps.editor.renderProgramView(host, program, { unitType, highlightRule, compact, ...extra }); return host; }
    catch (e) { console.warn('renderProgramView a échoué', e); }
  }
  clear(host);
  const ol = h('ol', { class: 'progtext' });
  (program?.rules ?? []).forEach((r, i) => ol.append(h('li', { class: i === highlightRule ? 'is-active' : '' }, describeRule(r, unitType))));
  if (!(program?.rules ?? []).length) ol.append(h('li', { class: 'muted' }, 'Aucune règle : l’unité suit son instinct.'));
  host.append(ol);
  return host;
}

// ====================================================================== boutons, panneaux, toasts
const sfx = (n) => { try { deps.audio?.play?.(n); } catch { /* muet */ } };
/**
 * Bouton standard. kind : 'primary' (doré) | 'secondary' (filet) | 'ghost' | 'danger'.
 * @returns {HTMLButtonElement}
 */
export function btn(label, { id, kind = 'secondary', onClick, disabled = false, ico = null, title = null, size = null, sound = 'ui', cls = '' } = {}) {
  const b = h('button', { type: 'button', id, class: `btn btn-${kind}${size ? ` btn-${size}` : ''} ${cls}`.trim(), disabled, title, 'aria-label': title && !label ? title : null });
  if (ico) b.append(icon(ico));
  if (label) b.append(h('span', { class: 'btn-label', text: label }));
  b.addEventListener('click', (e) => { if (b.disabled) return; if (sound) sfx(sound); onClick?.(e); });
  b.addEventListener('pointerenter', () => { if (!b.disabled) sfx('hover'); });
  return b;
}
/** Panneau « cuir et dorure ». */
export function panel(cls = '', props = {}, ...kids) { return h('div', { ...props, class: `panel ${cls}`.trim() }, ...kids); }
function screenEl(name, extra = '') {
  return h('section', { class: `screen screen-${name} ${extra}`.trim(), id: `screen-${name}`, 'aria-label': name });
}
function mount(root, el) { root.append(el); requestAnimationFrame(() => el.classList.add('is-in')); return el; }

/** Message éphémère dans #toasts. kind : 'info' | 'good' | 'bad' | 'gold'. */
export function toast(text, kind = 'info', ms = 2800) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = h('div', { class: `toast toast-${kind}` }, text);
  host.append(t);
  while (host.children.length > 4) host.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('is-in'));
  setTimeout(() => { t.classList.remove('is-in'); t.classList.add('is-out'); setTimeout(() => t.remove(), 400); }, ms);
}

const statLine = (type, bonus = {}) => {
  const u = UNITS[type];
  if (!u) return '';
  const atk = u.atk + (bonus?.atk ?? 0);
  return `PV ${u.hp} · Atq ${atk} · Déf ${u.def} · Portée ${u.range} · Vit ${u.speed === 0.5 ? '½' : u.speed}`;
};
export { statLine };
export const traitNames = (type) => (UNITS[type]?.traits ?? []).map(t => TRAITS[t]?.name).filter(Boolean);

// ====================================================================== TITRE
/**
 * Écran titre.
 * @param {HTMLElement} root
 * @param {{ hasSave: boolean, saveInfo?: string, coverUrl?: string|null, ready?: boolean }} data
 * @param {{ onNew: Function, onResume: Function, onHelp: Function, onSettings: Function }} on
 * @returns {{ el, setProgress(p:number, label?:string), setReady(hasSave:boolean, saveInfo?:string), destroy() }}
 */
export function renderTitle(root, data, on) {
  const s = screenEl('title');
  const coverEl = h('div', { class: 'title-cover' });
  const setCover = (url) => {
    if (!url) { coverEl.style.backgroundImage = ''; s.classList.remove('has-cover', 'has-cover-portrait'); return; }
    coverEl.style.backgroundImage = `url("${url}")`;
    s.classList.add('has-cover');
    // cadrage vertical (téléphone tenu droit) : les armées sont en haut de l'image, le voile s'éclaircit en haut
    s.classList.toggle('has-cover-portrait', /portrait/i.test(url));
  };
  setCover(data.coverUrl);
  s.append(coverEl, h('div', { class: 'title-scrim' }));
  const col = h('div', { class: 'title-col' });
  const menu = h('nav', { class: 'title-menu', 'aria-label': 'Menu principal' });
  const confirmBox = h('div', { class: 'inline-confirm', id: 'title-confirm', hidden: true });
  const bNew = btn('Nouvelle campagne', { id: 'btn-new', kind: 'primary', size: 'lg', onClick: () => {
    if (state.hasSave) { confirmBox.hidden = false; bNew.hidden = true; confirmBox.querySelector('button')?.focus(); }
    else on.onNew?.();
  } });
  const bResume = btn('Reprendre', { id: 'btn-resume', size: 'lg', onClick: () => on.onResume?.() });
  const resumeMeta = h('span', { class: 'btn-meta' });
  bResume.append(resumeMeta);
  const bHelp = btn('Comment jouer', { id: 'btn-help', kind: 'ghost', ico: 'book', onClick: () => on.onHelp?.() });
  const bSet = btn('Réglages', { id: 'btn-settings', kind: 'ghost', ico: 'gear', onClick: () => on.onSettings?.() });
  confirmBox.append(
    h('p', {}, 'Une campagne est en cours. L’abandonner pour en commencer une nouvelle ?'),
    h('div', { class: 'row' },
      btn('Abandonner et recommencer', { id: 'btn-new-confirm', kind: 'danger', onClick: () => on.onNew?.() }),
      btn('Annuler', { id: 'btn-new-cancel', kind: 'ghost', onClick: () => { confirmBox.hidden = true; bNew.hidden = false; bNew.focus(); } })));
  menu.append(bNew, confirmBox, bResume, h('div', { class: 'title-minor' }, bHelp, bSet));
  const prog = h('div', { class: 'title-progress', id: 'title-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' },
    h('div', { class: 'tp-track' }, h('i', { class: 'tp-fill' })), h('span', { class: 'tp-label', text: 'Les figurines sortent de leur boîte…' }));
  col.append(
    h('div', { class: 'title-runes', 'aria-hidden': 'true', text: 'ᚱᚢᚾᛖᛋ · ᛞᛖ · ᚲᛟᛗᛗᚨᚾᛞᛖᛗᛖᚾᛏ' }),
    h('h1', { class: 'title-name' }, h('span', { class: 't1', text: 'Runes' }), h('span', { class: 't2', text: 'de Commandement' })),
    h('p', { class: 'title-tag', text: 'Gravez les ordres de vos troupes avant la bataille. Ensuite, seuls vos corbeaux pourront les changer.' }),
    menu, prog);
  s.append(col, h('footer', { class: 'title-foot' }, h('span', { text: 'Prototype · un wargame de runes et de corbeaux' })));
  const state = { hasSave: false };
  // setReady active le menu dès que l'interface est prête ; la barre de progression (modèles 3D) continue
  // en tâche de fond et ne s'efface qu'à setProgress(1).
  const setReady = (hasSave, saveInfo = '') => {
    state.hasSave = !!hasSave;
    s.classList.add('is-ready');
    for (const b of [bNew, bHelp, bSet]) b.disabled = false;
    bResume.disabled = !hasSave; bResume.hidden = !hasSave;
    resumeMeta.textContent = saveInfo || '';
  };
  // « Comment jouer » et « Réglages » n'ont besoin ni des modèles ni de la vue 3D : actifs dès l'affichage.
  for (const b of [bNew, bResume]) b.disabled = true;
  bResume.hidden = true;
  if (data.ready) { setReady(data.hasSave, data.saveInfo); prog.classList.add('is-done'); }
  mount(root, s);
  return {
    el: s,
    setProgress(p, label) {
      const pc = Math.round(Math.max(0, Math.min(1, p)) * 100);
      prog.querySelector('.tp-fill').style.width = `${pc}%`;
      prog.setAttribute('aria-valuenow', String(pc));
      prog.querySelector('.tp-label').textContent = label || `Les figurines sortent de leur boîte… ${pc}${NB}%`;
      prog.classList.toggle('is-done', p >= 1);
    },
    setReady,
    setCover,
    focus() { (state.hasSave ? bResume : bNew).focus(); },
    destroy() { s.remove(); },
  };
}

// ====================================================================== CARTE DE CAMPAGNE
function nodeLayout(map, vertical) {
  const cols = map.columns;
  const pos = {};
  const W = vertical ? 600 : 1000, H = vertical ? 1000 : 560;
  cols.forEach((ids, c) => {
    const n = ids.length;
    ids.forEach((id, i) => {
      const along = (c + 0.5) / cols.length;          // 0..1 le long du voyage
      const across = n === 1 ? 0.5 : 0.18 + (0.64 * i) / (n - 1);
      // léger décalage pseudo-aléatoire pour un tracé « à la main »
      const jit = ((c * 37 + i * 61) % 11 - 5) / 5;
      if (vertical) pos[id] = { x: across * W + jit * 14, y: H - along * H + jit * 8 };
      else pos[id] = { x: along * W + jit * 10, y: across * H + jit * 14 };
    });
  });
  return { pos, W, H };
}

function inkDecor(W, H, seed, vertical) {
  // Décor d'encre discret : collines, bosquets, une rose des vents. Déterministe.
  let s = (Number(seed) || 7) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let out = '';
  for (let i = 0; i < 9; i++) {
    const x = 40 + rnd() * (W - 80), y = 40 + rnd() * (H - 80);
    if (rnd() < 0.5) out += `<path d="M${x} ${y}q10 -14 20 0q10 -12 20 0" />`;
    else out += `<path d="M${x} ${y + 8}l6 -16l6 16M${x + 9} ${y + 8}l5 -12l5 12" />`;
  }
  const cx = vertical ? W - 70 : W - 70, cy = vertical ? 70 : H - 66;
  out += `<g transform="translate(${cx} ${cy})" class="rose"><circle r="26"/><circle r="3"/><path d="M0 -36L5 -5L0 0L-5 -5ZM0 36L5 5L0 0L-5 5Z" class="rose-n"/><path d="M-36 0L-5 -5L0 0L-5 5ZM36 0L5 -5L0 0L5 5Z"/><text y="-42" text-anchor="middle">N</text></g>`;
  // tracé de rivière
  out += vertical
    ? `<path class="river" d="M0 ${H * 0.55} C ${W * 0.3} ${H * 0.5}, ${W * 0.4} ${H * 0.62}, ${W * 0.7} ${H * 0.57} S ${W} ${H * 0.5}, ${W} ${H * 0.52}"/>`
    : `<path class="river" d="M${W * 0.47} 0 C ${W * 0.42} ${H * 0.3}, ${W * 0.56} ${H * 0.45}, ${W * 0.5} ${H * 0.7} S ${W * 0.55} ${H}, ${W * 0.53} ${H}"/>`;
  return `<g class="decor">${out}</g>`;
}

/**
 * Carte de campagne « manuscrit enluminé ».
 * @param {HTMLElement} root
 * @param {{ run: object, reachable: object[] }} data   reachable = campaign.reachableNodes(run)
 * @param {{ onPick(nodeId), onMenu(), onHelp(), onSettings() }} on
 */
export function renderCampaign(root, { run, reachable = [] }, on) {
  const s = screenEl('campaign', 'full');
  const map = run?.map;
  const reach = new Set(reachable.map(n => n.id));
  const visited = new Set(run?.visited ?? []);
  const vertical = layoutMode() === 'phone';

  const sheet = h('div', { class: 'manuscript' });
  const head = h('header', { class: 'ms-head' },
    h('div', { class: 'ms-eyebrow', text: 'Carte de campagne' }),
    h('h2', { class: 'ms-title', text: 'La Marche des Corneilles' }));
  const hint = h('p', { class: 'ms-hint', id: 'ms-hint', 'aria-live': 'polite' },
    reachable.length ? 'Choisissez votre prochaine étape : les sceaux qui luisent vous sont ouverts.' : 'Aucune route ouverte.');
  sheet.append(head);

  if (map?.columns?.length) {
    const { pos, W, H } = nodeLayout(map, vertical);
    let paths = '', nodesSvg = '';
    for (const id of Object.keys(map.nodes)) {
      const n = map.nodes[id], a = pos[id];
      if (!a) continue;
      for (const nx of n.next ?? []) {
        const b = pos[nx];
        if (!b) continue;
        const travelled = visited.has(id) && visited.has(nx);
        const open = (run.position === id && reach.has(nx)) || (!run.position && false);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const bend = vertical ? { x: (a.x - b.x) * 0.15, y: 0 } : { x: 0, y: (a.y - b.y) * 0.15 };
        paths += `<path class="ms-path${travelled ? ' is-travelled' : ''}${open ? ' is-open' : ''}" d="M${a.x} ${a.y} Q ${mx + bend.x} ${my + bend.y} ${b.x} ${b.y}"/>`;
      }
    }
    const svg = svgEl(`<svg viewBox="0 0 ${W} ${H}" class="ms-map" preserveAspectRatio="xMidYMid meet">${inkDecor(W, H, run.seed, vertical)}<g class="paths">${paths}</g><g class="nodes">${nodesSvg}</g></svg>`);
    svg.removeAttribute('aria-hidden');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Carte de campagne');
    const gNodes = svg.querySelector('.nodes');
    const NS = 'http://www.w3.org/2000/svg';
    for (const id of Object.keys(map.nodes)) {
      const n = map.nodes[id], p = pos[id];
      if (!p) continue;
      const isReach = reach.has(id), isVisited = visited.has(id), isHere = run.position === id;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `ms-node kind-${n.kind}${isReach ? ' is-reach' : ''}${isVisited ? ' is-visited' : ''}${isHere ? ' is-here' : ''}`);
      g.setAttribute('transform', `translate(${p.x} ${p.y})`);
      g.setAttribute('id', `node-${id}`);
      const big = n.kind === 'boss' ? 1.25 : 1;
      const r = 34 * big;
      const label = `${NODE_KIND[n.kind]?.name ?? n.kind}${n.title ? ` — ${n.title}` : ''}`;
      if (isReach) { g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button'); g.setAttribute('aria-label', label); }
      g.innerHTML = `${isReach ? `<circle class="halo" r="${r + 16}"/>` : ''}<circle class="ring2" r="${r + 5}"/><circle class="disc" r="${r}"/>`
        + `<g class="ic" transform="translate(${-r * 0.62} ${-r * 0.62}) scale(${(r * 1.24) / 32})">${NODE_ICONS[n.kind]?.replace(/^<svg[^>]*>|<\/svg>$/g, '') ?? ''}</g>`
        + `<text data-i18n-ignore="true" class="lbl" y="${r + 24}" text-anchor="middle">${wrapLabel(n.title || NODE_KIND[n.kind]?.name || '').map((ln, i) => `<tspan x="0" dy="${i ? '1.05em' : 0}">${escapeXml(ln)}</tspan>`).join('')}</text>`
        + (isVisited && !isHere ? `<g class="stamp" transform="translate(${r * 0.62} ${-r * 0.6}) rotate(-14)"><circle r="13"/><path d="M-6 0l4 4.5 8-9"/></g>` : '')
        + (isHere ? `<g class="here" transform="translate(0 ${-r - 14})"><path d="M0 0v-26M0 -26c6 -3 10 3 16 0v10c-6 3 -10 -3 -16 0"/></g>` : '');
      const show = () => { hint.textContent = `${label}. ${NODE_KIND[n.kind]?.desc ?? ''}`; };
      g.addEventListener('pointerenter', () => { show(); if (isReach) sfx('hover'); });
      g.addEventListener('focus', show);
      if (isReach) {
        const pick = () => { sfx('page'); on.onPick?.(id); };
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      }
      gNodes.append(g);
    }
    sheet.append(h('div', { class: 'ms-frame' }, svg));
  } else {
    sheet.append(h('p', { class: 'ms-empty', text: 'La carte de campagne est illisible (données manquantes).' }));
  }
  sheet.append(hint);

  // ---- panneau latéral : ressources + compagnie
  const side = panel('camp-side');
  const totalCols = map?.columns?.length ?? 5;
  const step = run?.position && map?.nodes?.[run.position] ? map.nodes[run.position].col + 1 : 0;
  side.append(
    h('div', { class: 'res-row' },
      res('coin', run?.gold ?? 0, 'Or', 'res-gold'),
      res('raven', `${run?.ravens ?? 0}`, 'Corbeaux', 'res-ravens'),
      res('flag', `${run?.battlesWon ?? 0}`, 'Victoires', 'res-wins')),
    h('div', { class: 'progress-steps', 'aria-label': `Étape ${step} sur ${totalCols}` },
      ...Array.from({ length: totalCols }, (_, i) => h('i', { class: i < step ? 'done' : (i === step ? 'next' : '') }))),
    h('h3', { class: 'side-title', text: 'Votre compagnie' }),
  );
  const list = h('ul', { class: 'roster-list' });
  for (const ru of run?.roster ?? []) {
    const u = UNITS[ru.type];
    const used = programCost(ru.program), tot = rosterSlots(ru);
    list.append(h('li', { class: 'roster-row' },
      portrait(ru.type, { size: 'sm' }),
      h('div', { class: 'rr-main' },
        h('div', { class: 'rr-name' }, ru.name || u?.name || ru.type,
          ru.bonus?.atk ? h('span', { class: 'badge badge-forge', title: 'Arme forgée : +1 attaque' }, `+${ru.bonus.atk} atq`) : null,
          ru.bonus?.slots ? h('span', { class: 'badge badge-med', title: 'Méditation : emplacements supplémentaires' }, `+${ru.bonus.slots} empl.`) : null),
        h('div', { class: 'rr-sub' }, `${u?.name ?? ''}${ru.kills ? ` · ${ru.kills} victime${ru.kills > 1 ? 's' : ''}` : ''}`)),
      h('div', { class: 'rr-slots', title: 'Emplacements de runes utilisés / total' }, slotPips(used, tot))));
  }
  side.append(list);
  const known = (run?.unlocked ?? []).filter(id => RUNES[id]);
  const locked = Object.keys(RUNES).filter(id => !known.includes(id));
  side.append(h('h3', { class: 'side-title', text: `Runes connues · ${known.length}/${Object.keys(RUNES).length}` }),
    h('div', { class: 'rune-cloud' }, known.map(id => runeChip(id, { size: 'sm' })), locked.length ? h('span', { class: 'rune-locked-note' }, `${locked.length} encore scellées`) : null));
  side.append(h('div', { class: 'side-actions' },
    btn('Comment jouer', { id: 'camp-help', kind: 'ghost', ico: 'book', onClick: () => on.onHelp?.() }),
    btn('Réglages', { id: 'camp-settings', kind: 'ghost', ico: 'gear', onClick: () => on.onSettings?.() }),
    btn('Menu', { id: 'camp-menu', kind: 'ghost', ico: 'menu', onClick: () => on.onMenu?.() })));

  s.append(h('div', { class: 'camp-layout' }, sheet, side));
  mount(root, s);
  const first = s.querySelector('.ms-node.is-reach');
  return { el: s, focus() { first?.focus(); }, destroy() { s.remove(); } };
}
/** Coupe un intitulé de nœud en 1 ou 2 lignes équilibrées (≈ 15 caractères). */
function wrapLabel(t) {
  const s = translate(String(t));
  if (s.length <= 15) return [s];
  const words = s.split(' ');
  let best = [s], bestD = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const d = Math.max(a.length, b.length);
    if (d < bestD) { bestD = d; best = [a, b]; }
  }
  return best;
}
function escapeXml(t) { return String(t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function res(ico, value, label, id) {
  return h('div', { class: 'res', id }, icon(ico), h('b', { class: 'num', text: String(value) }), h('span', { class: 'res-lbl', text: label }));
}
/** Petites pastilles d'emplacements utilisés / total. */
export function slotPips(used, total) {
  const wrap = h('span', { class: `pips${used > total ? ' is-over' : ''}`, 'aria-label': `${used} emplacements sur ${total}` });
  for (let i = 0; i < Math.max(total, used); i++) wrap.append(h('i', { class: i < used ? (i < total ? 'on' : 'over') : '' }));
  wrap.append(h('span', { class: 'pips-num num', text: `${used}/${total}` }));
  return wrap;
}

// ====================================================================== cadre commun des écrans « étape »
function stageScreen(name, { eyebrow, title, glyph = null, kindIcon = null }) {
  const s = screenEl(name, 'full stage');
  const p = panel(`stage-panel stage-${name}`);
  const head = h('header', { class: 'stage-head' },
    kindIcon ? h('span', { class: 'stage-medal' }, svgEl(NODE_ICONS[kindIcon])) : null,
    h('div', {},
      h('div', { class: 'eyebrow', text: eyebrow }),
      h('h2', { class: 'stage-title', text: title })),
    glyph ? h('span', { class: 'stage-glyph', 'aria-hidden': 'true', text: glyph }) : null);
  const body = h('div', { class: 'stage-body' });
  const foot = h('footer', { class: 'stage-foot' });
  p.append(head, body, foot);
  s.append(p);
  return { s, p, body, foot, head };
}

// ====================================================================== MARCHAND
/**
 * Échoppe du marchand.
 * @param {{ run, offers: object[] }} data   offers = campaign.shopOffers(run, node)
 * @param {{ onBuy(offer): {ok:boolean, reason?:string, run?:object}, onLeave() }} on
 * @returns {{ el, update(run, offers), destroy() }}
 */
export function renderShop(root, { run, offers }, on) {
  const { s, body, foot } = stageScreen('shop', { eyebrow: 'Marchand', title: 'L’échoppe du colporteur', kindIcon: 'shop' });
  const goldEl = h('div', { class: 'purse', id: 'shop-gold' });
  const grid = h('div', { class: 'offer-grid' });
  const intro = h('p', { class: 'stage-intro', text: '« Des runes arrachées aux grimoires gobelins, des épées à louer, et mes meilleurs corbeaux. Tout se paie, capitaine. »' });
  body.append(h('div', { class: 'stage-toprow' }, intro, goldEl), grid);
  foot.append(btn('Reprendre la route', { id: 'shop-leave', kind: 'primary', ico: 'back', onClick: () => on.onLeave?.() }));
  let cur = { run, offers };
  const draw = () => {
    clear(goldEl).append(icon('coin'), h('b', { class: 'num', text: String(cur.run?.gold ?? 0) }), h('span', { text: ' or' }));
    clear(grid);
    (cur.offers ?? []).forEach((o, i) => grid.append(offerCard(o, i)));
    if (!(cur.offers ?? []).length) grid.append(h('p', { class: 'muted', text: 'L’étal est vide.' }));
  };
  const offerCard = (o, i) => {
    const afford = (cur.run?.gold ?? 0) >= o.price;
    const ravenMax = o.kind === 'raven' && (cur.run?.ravens ?? 0) >= MAX_RAVENS;
    const card = h('article', { class: `offer offer-${o.kind}${o.sold ? ' is-sold' : ''}`, id: `offer-${o.id ?? i}` });
    let art;
    if (o.kind === 'rune' && RUNES[o.runeId]) art = h('div', { class: 'offer-art' }, runeArt(o.runeId));
    else if (o.kind === 'unit' && UNITS[o.unitType]) art = h('div', { class: 'offer-art' }, portrait(o.unitType, { size: 'lg' }), h('span', { class: 'offer-type', text: UNITS[o.unitType].name }));
    else art = h('div', { class: 'offer-art offer-art-raven' }, icon('raven', 'ico ico-xl'));
    const title = o.label || o.unitName || (o.kind === 'rune' ? RUNES[o.runeId]?.name : o.kind === 'unit' ? UNITS[o.unitType]?.name : 'Corbeau supplémentaire');
    const desc = o.desc || (o.kind === 'rune' ? RUNES[o.runeId]?.help : o.kind === 'unit' ? UNITS[o.unitType]?.desc : `Un corbeau de plus à chaque bataille (max ${MAX_RAVENS}).`);
    const extra = null;
    const buy = btn(o.sold ? 'Vendu' : (ravenMax ? 'Volière pleine' : `Acheter · ${o.price}`), {
      id: `buy-${o.id ?? i}`, kind: afford && !o.sold && !ravenMax ? 'primary' : 'secondary', size: 'sm', sound: null,
      disabled: o.sold || !afford || ravenMax,
      onClick: () => {
        const r = on.onBuy?.(o);
        if (r?.ok) { sfx('coin'); toast(r.text || (o.kind === 'rune' ? `Rune apprise : ${RUNES[o.runeId]?.name ?? title}` : o.kind === 'unit' ? `${withArticle(title, true)} rejoignent l’armée.` : 'Un corbeau de plus dans la volière.'), 'gold'); }
        else { sfx('deny'); toast(r?.reason || 'Achat impossible.', 'bad'); }
      },
    });
    if (!afford && !o.sold) buy.title = 'Pas assez d’or';
    add(card, art, h('h3', { class: 'offer-title', text: title }), h('p', { class: 'offer-desc', text: desc || '' }), extra,
      h('div', { class: 'offer-foot' }, h('span', { class: 'price num' }, icon('coin'), String(o.price)), buy));
    return card;
  };
  draw();
  mount(root, s);
  return { el: s, update(run2, offers2) { cur = { run: run2 ?? cur.run, offers: offers2 ?? cur.offers }; draw(); }, destroy() { s.remove(); } };
}

// ====================================================================== FEU DE CAMP
/**
 * Feu de camp : méditer (+1 emplacement) ou forger (+1 attaque) pour UNE unité ; à côté, le quartier-maître loue une
 * recrue au prix du marché (achat indépendant du repos, encore possible après).
 * @param {{ run, offers?: object[], quartermaster?: {name, desc} }} data   offers = campaign.campOffers(run, node)
 * @param {{ onApply({kind, uid}): {ok, reason?, run?}, onBuy?(offer): {ok, reason?, text?, run?}, onLeave() }} on
 * @returns {{ el, update(run, offers), destroy() }}
 */
export function renderCamp(root, { run, offers = [], quartermaster = null }, on) {
  const { s, body, foot } = stageScreen('camp', { eyebrow: 'Feu de camp', title: 'Une nuit sous les étoiles', kindIcon: 'camp' });
  const st = { kind: 'meditate', uid: null, done: false };
  const intro = h('p', { class: 'stage-intro', text: 'Les braises crépitent. Le temps d’une veillée, une seule de vos unités peut s’y préparer.' });
  const choices = h('div', { class: 'camp-choices', role: 'radiogroup', 'aria-label': 'Activité' });
  const mk = (kind, title, desc, glyph) => {
    const b = h('button', { type: 'button', class: 'choice-card', id: `camp-${kind}`, role: 'radio', 'aria-checked': 'false' },
      h('span', { class: 'cc-glyph', 'aria-hidden': 'true', text: glyph }),
      h('span', { class: 'cc-title', text: title }), h('span', { class: 'cc-desc', text: desc }));
    b.addEventListener('click', () => { if (st.done) return; sfx('ui'); st.kind = kind; drawUnits(); });
    return b;
  };
  const cMed = mk('meditate', 'Méditer', `+1 emplacement de rune permanent (max +${CAMPAIGN.maxSlotBonus} par unité).`, 'ᛗ');
  const cForge = mk('forge', 'Forger', `+1 attaque permanente (max +${CAMPAIGN.maxAtkBonus} par unité).`, 'ᛏ');
  choices.append(cMed, cForge);
  const unitsGrid = h('div', { class: 'camp-units', role: 'radiogroup', 'aria-label': 'Unité' });
  const outcome = h('p', { class: 'camp-outcome', 'aria-live': 'polite' });
  const confirm = btn('Choisissez une unité', { id: 'camp-confirm', kind: 'primary', disabled: true, sound: null, onClick: () => {
    if (!st.uid || st.done) return;
    const r = on.onApply?.({ kind: st.kind, uid: st.uid });
    if (r?.ok) {
      st.done = true; sfx('rune');
      const ru = (r.run ?? run).roster.find(x => x.uid === st.uid);
      outcome.textContent = r.text || (st.kind === 'meditate'
        ? `${withArticle(ru?.name ?? 'L’unité', true)} médite longuement : un emplacement de rune de plus.`
        : `Le forgeron affûte les armes : +1 attaque pour ${withArticle(ru?.name ?? 'l’unité')}.`);
      run = r.run ?? run;
      s.classList.add('is-done');
      confirm.hidden = true; leave.querySelector('.btn-label').textContent = 'Reprendre la route';
      leave.classList.replace('btn-ghost', 'btn-primary');
      drawUnits(); leave.focus();
    } else { sfx('deny'); toast(r?.reason || 'Impossible.', 'bad'); }
  } });
  const leave = btn('Lever le camp sans rien faire', { id: 'camp-leave', kind: 'ghost', onClick: () => on.onLeave?.() });
  const drawUnits = () => {
    cMed.setAttribute('aria-checked', String(st.kind === 'meditate')); cForge.setAttribute('aria-checked', String(st.kind === 'forge'));
    cMed.classList.toggle('is-on', st.kind === 'meditate'); cForge.classList.toggle('is-on', st.kind === 'forge');
    clear(unitsGrid);
    for (const ru of run.roster ?? []) {
      const maxed = st.kind === 'meditate' ? (ru.bonus?.slots ?? 0) >= CAMPAIGN.maxSlotBonus : (ru.bonus?.atk ?? 0) >= CAMPAIGN.maxAtkBonus;
      let why = maxed ? (st.kind === 'meditate' ? 'au maximum' : 'déjà forgé') : '';
      if (!st.done && deps.campaign?.canCamp) {
        try { const c = deps.campaign.canCamp(run, { kind: st.kind, uid: ru.uid }); if (c && !c.ok && maxed) why = c.reason || why; } catch { /* */ }
      }
      const u = UNITS[ru.type];
      const b = h('button', { type: 'button', class: `unit-pick${st.uid === ru.uid ? ' is-on' : ''}${maxed ? ' is-maxed' : ''}`, id: `camp-unit-${ru.uid}`,
        role: 'radio', 'aria-checked': String(st.uid === ru.uid), disabled: maxed || st.done, title: maxed ? why : null },
        portrait(ru.type, { size: 'md' }),
        h('span', { class: 'up-name', text: ru.name || u?.name }),
        h('span', { class: 'up-sub num', text: st.kind === 'meditate' ? `${rosterSlots(ru)} emplacements${maxed ? ' · au maximum' : ''}` : `Attaque ${(u?.atk ?? 0) + (ru.bonus?.atk ?? 0)}${maxed ? ' · déjà forgé' : ''}` }));
      b.addEventListener('click', () => { if (st.done) return; sfx('ui'); st.uid = ru.uid; drawUnits(); });
      unitsGrid.append(b);
    }
    const sel = run.roster.find(x => x.uid === st.uid);
    const selMaxed = sel && (st.kind === 'meditate' ? (sel.bonus?.slots ?? 0) >= CAMPAIGN.maxSlotBonus : (sel.bonus?.atk ?? 0) >= CAMPAIGN.maxAtkBonus);
    if (selMaxed) st.uid = null;
    confirm.disabled = !st.uid || st.done;
    confirm.querySelector('.btn-label').textContent = st.uid
      ? `${st.kind === 'meditate' ? 'Méditer avec' : 'Forger pour'} ${withArticle(run.roster.find(x => x.uid === st.uid)?.name ?? '')}`
      : 'Choisissez une unité';
  };
  // ---- quartier-maître : même carte que l'échoppe du marchand
  let qmOffers = offers ?? [];
  const qm = h('section', { class: 'camp-qm', id: 'camp-qm', hidden: !qmOffers.length || !on.onBuy });
  const qmGold = h('div', { class: 'purse', id: 'camp-gold' });
  const qmGrid = h('div', { class: 'offer-grid offer-grid-qm' });
  qm.append(h('div', { class: 'stage-toprow' },
    h('div', {}, h('h3', { class: 'sub-title', text: quartermaster?.name ?? 'Le quartier-maître' }),
      h('p', { class: 'stage-intro', text: quartermaster?.desc ?? 'Une compagnie attend preneur au bivouac.' })), qmGold), qmGrid);
  const drawQm = () => {
    clear(qmGold).append(icon('coin'), h('b', { class: 'num', text: String(run?.gold ?? 0) }), h('span', { text: ' or' }));
    clear(qmGrid);
    for (const o of qmOffers) {
      const afford = (run?.gold ?? 0) >= o.price;
      const title = o.label || o.unitName || UNITS[o.unitType]?.name || 'Recrue';
      const buy = btn(o.sold ? 'Engagée' : `Engager · ${o.price}`, {
        id: `camp-buy-${o.id}`, kind: afford && !o.sold ? 'primary' : 'secondary', size: 'sm', sound: null, disabled: o.sold || !afford,
        onClick: () => {
          const r = on.onBuy?.(o);
          if (r?.ok) { sfx('coin'); toast(r.text || `${withArticle(title, true)} rejoignent l’armée.`, 'gold'); }
          else { sfx('deny'); toast(r?.reason || 'Impossible.', 'bad'); }
        },
      });
      if (!afford && !o.sold) buy.title = 'Pas assez d’or';
      qmGrid.append(add(h('article', { class: `offer offer-unit${o.sold ? ' is-sold' : ''}`, id: `camp-offer-${o.id}` }),
        UNITS[o.unitType] ? h('div', { class: 'offer-art' }, portrait(o.unitType, { size: 'lg' }), h('span', { class: 'offer-type', text: UNITS[o.unitType].name })) : null,
        h('h3', { class: 'offer-title', text: title }), h('p', { class: 'offer-desc', text: o.desc || UNITS[o.unitType]?.desc || '' }),
        h('div', { class: 'offer-foot' }, h('span', { class: 'price num' }, icon('coin'), String(o.price)), buy)));
    }
  };
  drawQm();
  body.append(intro, choices, h('h3', { class: 'sub-title', text: 'Quelle unité ?' }), unitsGrid, outcome, qm);
  foot.append(leave, confirm);
  drawUnits();
  mount(root, s);
  return {
    el: s,
    // après un achat : nouvel état de la campagne (or, recrue dans l'armée) et stock à jour
    update(run2, offers2) { run = run2 ?? run; qmOffers = offers2 ?? qmOffers; drawQm(); drawUnits(); },
    destroy() { s.remove(); },
  };
}

// ====================================================================== ÉVÉNEMENT
/**
 * Événement narratif.
 * @param {{ run, event: {id,title,text,choices:[{id,label,desc,disabled?,reason?}], resolved?, outcome?} }} data
 * @param {{ onChoose(choiceId): {ok?:boolean, text:string}|string, onLeave() }} on
 */
export function renderEvent(root, { run, event }, on) {
  const { s, body, foot } = stageScreen('event', { eyebrow: 'Événement', title: event?.title || 'Sur la route', kindIcon: 'event' });
  const text = h('p', { class: 'event-text dropcap', text: event?.text || '' });
  const list = h('div', { class: 'event-choices' });
  const outcome = h('div', { class: 'event-outcome', hidden: true, 'aria-live': 'polite' });
  const err = h('p', { class: 'modal-err', hidden: true, 'aria-live': 'assertive' });
  const leave = btn('Reprendre la route', { id: 'event-leave', kind: 'primary', ico: 'back', onClick: () => on.onLeave?.() });
  leave.hidden = true;
  const finish = (b, t) => {
    for (const x of list.querySelectorAll('button')) { x.disabled = true; x.classList.toggle('is-chosen', x === b); }
    outcome.hidden = false; err.hidden = true;
    clear(outcome).append(h('p', { text: t || 'Vous reprenez votre chemin.' }));
    leave.hidden = false; leave.focus();
  };
  (event?.choices ?? []).forEach((c, i) => {
    const b = h('button', { type: 'button', class: 'event-choice', id: `event-choice-${c.id ?? i}`, disabled: !!c.disabled, title: c.disabled ? c.reason || '' : null },
      h('span', { class: 'ec-num', 'aria-hidden': 'true', text: ['ᚠ', 'ᚢ', 'ᚦ'][i] || '·' }),
      h('span', { class: 'ec-body' }, h('span', { class: 'ec-label', text: c.label }), c.desc ? h('span', { class: 'ec-desc', text: c.desc }) : null,
        c.disabled && c.reason ? h('span', { class: 'ec-reason', text: c.reason }) : null));
    b.addEventListener('click', () => {
      const r = on.onChoose?.(c.id);
      const t = typeof r === 'string' ? r : r?.text;
      if (r && typeof r === 'object' && r.ok === false) { sfx('deny'); err.hidden = false; err.textContent = t || 'Ce choix est impossible.'; return; }
      sfx('page');
      finish(b, t);
    });
    list.append(b);
  });
  if (event?.resolved) {
    const chosen = list.querySelector(`#event-choice-${CSS.escape(String(event.resolved))}`);
    finish(chosen, event.outcome);
  }
  if (!(event?.choices ?? []).length) { leave.hidden = false; }
  body.append(err);
  body.append(text, list, outcome);
  foot.append(leave);
  mount(root, s);
  return { el: s, destroy() { s.remove(); } };
}

// ====================================================================== RÉSULTAT + GRIMOIRE
const REASON_TEXT = {
  player: { commander: 'Le Chef de guerre est tombé : la horde se disperse.', annihilation: 'L’armée gobeline est anéantie.', time: 'Le temps est écoulé : vos troupes ont mieux tenu, le terrain est à vous.' },
  enemy:  { commander: 'Votre commandant est tombé. L’armée se débande.', annihilation: 'Votre armée a été anéantie.', time: 'Le temps est écoulé : la horde a mieux préservé ses forces. Il fallait l’emporter.' },
};
/** Phrase française expliquant un résultat de bataille. */
export function reasonText(result) {
  if (!result) return '';
  return REASON_TEXT[result.winner]?.[result.reason] ?? (result.winner === 'player' ? 'Le champ de bataille est à vous.' : 'La bataille est perdue.');
}

/**
 * Résultat de bataille : bandeau, or, pertes, abattus, grimoire ennemi, vol d'une rune (ou +25 or).
 * @param {{ run, summary: {won,gold,lost,kills,stealable,enemyPrograms,freeRune?,goldBreakdown?,stolen?}, result?: object, node?: object,
 *           allowSteal?: boolean, stealable?: string[] }} data
 *   stealable : runes proposées (par défaut summary.stealable) ; allowSteal=false : grimoire en lecture seule.
 * @param {{ onSteal(runeId): boolean|{ok}, onSkip(): void, onContinue(): void }} on
 */
export function renderResult(root, { run, summary, result = null, node = null, allowSteal = true, stealable: offered = null }, on) {
  const won = !!summary?.won;
  const s = screenEl('result', `full ${won ? 'is-won' : 'is-lost'}`);
  const p = panel('result-panel');
  const banner = h('header', { class: 'result-banner' },
    h('div', { class: 'rb-glyph', 'aria-hidden': 'true', text: won ? 'ᛏ' : 'ᚾ' }),
    h('h2', { class: 'rb-title', text: won ? 'Victoire' : 'Défaite' }),
    h('p', { class: 'rb-reason', text: reasonText(result) || (won ? 'Le champ de bataille est à vous.' : 'La bataille est perdue.') }));
  const lost = summary?.lost ?? [];
  const stats = h('div', { class: 'result-stats' },
    stat('Or gagné', `+${summary?.gold ?? 0}`, 'coin', 'res-gold'),
    stat('Ennemis abattus', String(summary?.kills ?? 0), 'swords', '', 'Ennemi abattu'),
    stat('Pertes', lost.length ? String(lost.length) : 'Aucune', 'heart', lost.length ? 'is-bad' : 'is-good', 'Perte'));
  let lostLine = null;
  if (lost.length) {
    // Accord du participe et du pronom : « Tombée au combat : Sœur Clémence. Elle ne reviendra pas. »,
    // « Tombés au combat : Piquiers de Valmont. Ils ne reviendront pas. » (liste mixte : masculin).
    const names = lost.map(unitName);
    const pl = names.length > 1 || isPlural(names[0]);
    const fem = pl ? names.every(n => /^Lances\b/.test(n) || isFeminine(n)) : isFeminine(names[0]);
    const part = `Tombé${fem ? 'e' : ''}${pl ? 's' : ''} au combat${NB}: `;
    const end = pl ? (fem ? 'Elles ne reviendront pas.' : 'Ils ne reviendront pas.') : (fem ? 'Elle ne reviendra pas.' : 'Il ne reviendra pas.');
    lostLine = h('p', { class: 'result-lost' }, part, names.map((n, i) => [i ? (i === names.length - 1 ? ' et ' : ', ') : '', h('b', { text: n })]), `. ${end}`);
  }
  const breakdown = (summary?.goldBreakdown ?? []).length > 1
    ? h('p', { class: 'result-breakdown num' }, summary.goldBreakdown.map((g, i) => [i ? ' · ' : '', `${g.label} +${g.amount}`]))
    : null;
  const freeRune = summary?.freeRune && RUNES[summary.freeRune]
    ? h('div', { class: 'free-rune' }, h('span', { class: 'lbl', text: 'Butin de l’élite' }), runeArt(summary.freeRune), h('span', { class: 'sc-help', text: RUNES[summary.freeRune].help }))
    : null;

  // Grimoire : un feuillet par programme ennemi distinct
  const gr = h('section', { class: 'grimoire', 'aria-label': 'Grimoire ennemi' });
  gr.append(h('h3', { class: 'gr-title' }, h('span', { class: 'gr-glyph', 'aria-hidden': 'true', text: 'ᛒ' }), 'Le grimoire ennemi'),
    h('p', { class: 'gr-intro', text: won ? 'Les ordres des gobelins, tels qu’on les a trouvés sur leurs morts. Lisez-les : ce sont aussi vos prochaines leçons.' : 'Ce que pensaient vos ennemis. Peut-être la prochaine fois…' }));
  const pages = h('div', { class: 'gr-pages' });
  const seen = new Set();
  for (const ep of summary?.enemyPrograms ?? []) {
    const k = `${ep.type}|${JSON.stringify(ep.program)}`;
    if (seen.has(k)) continue; seen.add(k);
    const host = h('div', { class: 'gr-prog' });
    programView(host, ep.program, ep.type, { compact: true, unlocked: won ? (run?.unlocked ?? null) : null });   // « à voler » seulement après une victoire
    const count = ep.count > 1 ? ` ×${ep.count}` : '';
    pages.append(h('article', { class: 'gr-page' },
      h('header', { class: 'gr-head' }, portrait(ep.type, { size: 'sm' }), h('div', {}, h('div', { class: 'gr-name', text: `${ep.name || UNITS[ep.type]?.name || ep.type}${count}` }), h('div', { class: 'gr-sub', text: `${UNITS[ep.type]?.slots ?? '?'} emplacements · ${programCost(ep.program)} utilisés` }))),
      host));
  }
  if (!pages.children.length) pages.append(h('p', { class: 'muted', text: 'Aucun grimoire n’a été retrouvé.' }));
  gr.append(pages);

  // Vol d'une rune : un clic ne fait que CHOISIR (on peut comparer) ; le bouton du bas confirme et enregistre.
  const steal = h('section', { class: 'steal', 'aria-label': 'Voler une rune' });
  const canSteal = won && allowSteal;
  const pickSt = { id: null, done: false };
  const gold = CAMPAIGN.stealFallbackGold;
  const commit = () => {
    if (!canSteal) { on.onContinue?.(); return; }
    if (pickSt.done || !pickSt.id) return;
    if (pickSt.id === 'gold') {
      on.onSkip?.(); sfx('coin'); toast(`+${gold}${NB}or`, 'gold');
    } else {
      const res2 = on.onSteal?.(pickSt.id);
      if (res2 === false || res2?.ok === false) { sfx('deny'); toast('Cette rune ne peut pas être volée.', 'bad'); return; }
      sfx('rune'); toast(`Rune apprise${NB}: ${RUNES[pickSt.id]?.name ?? pickSt.id}`, 'gold');
    }
    pickSt.done = true; cont.disabled = true;
    on.onContinue?.();
  };
  const cont = btn(canSteal ? 'Choisissez votre butin' : 'Continuer', { id: 'result-continue', kind: 'primary', sound: canSteal ? null : 'ui', onClick: () => commit() });
  if (canSteal) {
    const stealable = (offered ?? summary?.stealable ?? []).filter(id => RUNES[id]);
    steal.append(h('h3', { class: 'sub-title', text: stealable.length ? 'Volez une rune à leur grimoire' : 'Rien de neuf dans ce grimoire' }));
    const cards = h('div', { class: 'steal-cards', role: 'radiogroup', 'aria-label': 'Butin du grimoire' });
    // Paramètres réellement employés par l'ennemi (« des cavaliers à ≤ 3 hex ») pour illustrer chaque rune.
    const seenParams = new Map();
    for (const ep of summary?.enemyPrograms ?? []) {
      for (const rule of ep.program?.rules ?? []) {
        for (const c of [...(rule.conds ?? []), rule.action]) if (c?.id && !seenParams.has(c.id)) seenParams.set(c.id, { params: c.params ?? {}, unitType: ep.type });
      }
    }
    const roster = run?.roster ?? [];
    const opts = [];
    const select = (b, id, focus = false) => {
      if (pickSt.done) return;
      pickSt.id = id;
      for (const x of opts) { const on2 = x === b; x.classList.toggle('is-on', on2); x.setAttribute('aria-checked', String(on2)); x.tabIndex = on2 ? 0 : -1; }
      if (focus) b.focus();
      cont.disabled = false;
      cont.querySelector('.btn-label').textContent = id === 'gold' ? `Prendre ${gold}${NB}or et continuer` : `Voler «${NB}${RUNES[id].name}${NB}» et continuer`;
    };
    for (const id of stealable) {
      const r = RUNES[id];
      const usedBy = seenParams.get(id);
      const who = r.classes?.length ? r.classes.map(c => CLASSES[c]?.plural ?? c).join(', ') : 'toutes les unités';
      const usable = roster.some(ru => runeAllowedFor(id, ru.type));
      const b = h('button', { type: 'button', class: `steal-card${usable ? '' : ' is-unusable'}`, id: `steal-${id}`, role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
        h('span', { class: 'sc-name', text: r.name }),
        runePhrase(id, usedBy),
        h('span', { class: 'sc-help', text: r.help || '' }),
        h('span', { class: 'sc-who' }, h('span', { class: 'lbl', text: 'Utilisable par' }), ` ${who}`),
        usable ? null : h('span', { class: 'sc-warn', text: 'Aucune de vos unités actuelles ne peut l’employer.' }));
      b.addEventListener('click', () => { sfx('ui'); select(b, id); });
      opts.push(b); cards.append(b);
    }
    const g = h('button', { type: 'button', class: 'steal-card steal-gold', id: 'steal-gold', role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
      h('span', { class: 'sc-gold' }, icon('coin', 'ico ico-lg'), h('b', { class: 'num', text: `+${gold}` })),
      h('span', { class: 'sc-help', text: stealable.length ? 'Ignorer le grimoire et prendre l’or.' : 'Aucune rune nouvelle : prenez l’or.' }));
    g.addEventListener('click', () => { sfx('ui'); select(g, 'gold'); });
    opts.push(g); cards.append(g);
    opts[0].tabIndex = 0;
    // Flèches : parcourir les choix comme un groupe de boutons radio.
    cards.addEventListener('keydown', (e) => {
      const i = opts.indexOf(document.activeElement);
      if (i < 0) return;
      const d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const j = (i + d + opts.length) % opts.length;
      select(opts[j], opts[j] === g ? 'gold' : stealable[j], true);
    });
    steal.append(cards, h('p', { class: 'steal-note', text: 'Les runes marquées « à voler » dans le grimoire sont celles que vous ne connaissez pas encore. Votre choix n’est définitif qu’au bouton ci-dessous.' }), h('div', { class: 'steal-foot' }, cont));
    cont.disabled = true;
    if (!stealable.length) select(g, 'gold');
  }
  // Au bureau : grimoire à gauche, choix de la rune à droite (colonne collante) ; au téléphone : l'un sous l'autre.
  add(p, banner, stats, breakdown, lostLine, freeRune,
    h('div', { class: `result-body${canSteal ? ' has-steal' : ''}` }, gr, canSteal ? steal : null),
    canSteal ? null : h('footer', { class: 'stage-foot' }, cont));
  s.append(p);
  mount(root, s);
  return { el: s, destroy() { s.remove(); } };
}
/**
 * Une statistique (valeur + légende). one : légende au singulier, employée pour 0, 1 ou « Aucune »
 * (« 1 Perte », « Aucune perte »).
 */
function stat(label, value, ico, cls = '', one = null) {
  const isText = !/^[+−-]?\d/.test(String(value));
  const n = Number(value);
  const single = one && (isText ? /^aucun/i.test(String(value)) : Math.abs(n) < 2);
  return h('div', { class: `stat ${cls}${isText ? ' is-text' : ''}`.trim() }, icon(ico), h('b', { class: 'num', text: value }), h('span', { text: single ? one : label }));
}
/** Phrase d'une rune telle qu'elle s'écrit dans un programme (« des cavaliers ennemis à ≤ 3 hex »). */
function runePhrase(runeId, used = null) {
  if (deps.editor?.runeBadge) {
    try { return h('span', { class: 'rune-art sc-phrase' }, deps.editor.runeBadge(runeId, { unitType: used?.unitType ?? null, params: used?.params ?? null, showName: false, compact: true })); }
    catch { /* repli texte */ }
  }
  const r = RUNES[runeId];
  let txt = r?.name ?? runeId;
  try {
    const node = { id: runeId, params: used?.params ?? {} };
    txt = r?.kind === 'cond' ? describeCond(node, used?.unitType ?? null) : r?.kind === 'action' ? describeAction(node, used?.unitType ?? null) : txt;
  } catch { /* nom seul */ }
  return h('span', { class: 'sc-phrase', text: txt });
}

// ====================================================================== FIN
/**
 * Fin de campagne.
 * @param {{ run, won: boolean }} data
 * @param {{ onNew(), onTitle() }} on
 */
export function renderEnd(root, { run, won }, on) {
  const s = screenEl('end', `full ${won ? 'is-won' : 'is-lost'}`);
  const p = panel('end-panel');
  const roster = run?.roster ?? [];
  const kills = run?.stats?.kills ?? roster.reduce((a, u) => a + (u.kills ?? 0), 0);
  const learned = run?.stats?.runesLearned ?? (run?.unlocked ?? []).filter(id => RUNES[id] && !RUNES[id].unlocked).length;
  add(p, 
    h('div', { class: 'end-glyph', 'aria-hidden': 'true', text: won ? 'ᛟ' : 'ᚺ' }),
    h('h2', { class: 'end-title', text: won ? 'La Marche est libérée' : 'La campagne s’achève' }),
    h('p', { class: 'end-text', text: won
      ? (run?.lastOutcome?.summary?.reason === 'time'
        ? 'Le Chef de guerre bat en retraite, sa horde en lambeaux : la Marche est à vous. On chantera longtemps vos runes et vos corbeaux.'
        : 'Le Chef de guerre gît dans la boue et sa horde se disperse. On chantera longtemps vos runes et vos corbeaux.')
      : 'Les corbeaux ne reviendront pas ce soir. D’autres capitaines reprendront vos grimoires.' }),
    h('div', { class: 'result-stats' },
      stat('Batailles gagnées', String(run?.battlesWon ?? 0), 'flag', '', 'Bataille gagnée'),
      stat('Or en bourse', String(run?.gold ?? 0), 'coin', 'res-gold'),
      stat('Ennemis abattus', String(kills), 'swords', '', 'Ennemi abattu'),
      run?.stats ? stat('Unités perdues', String(run.stats.unitsLost ?? 0), 'heart', run.stats.unitsLost ? 'is-bad' : 'is-good', 'Unité perdue') : null,
      stat('Runes apprises', String(learned), 'sparkle', '', 'Rune apprise')),
    roster.length ? h('div', { class: 'end-roster' }, h('h3', { class: 'sub-title', text: won ? 'Les survivants' : 'Ceux qui restaient' }),
      h('div', { class: 'end-units' }, roster.map(ru => h('div', { class: 'end-unit' }, portrait(ru.type, { size: 'md' }), h('span', { text: ru.name || UNITS[ru.type]?.name }))))) : null,
    h('footer', { class: 'stage-foot' },
      btn('Écran titre', { id: 'end-title', kind: 'ghost', onClick: () => on.onTitle?.() }),
      btn('Nouvelle campagne', { id: 'end-new', kind: 'primary', onClick: () => on.onNew?.() })));
  s.append(p);
  mount(root, s);
  return { el: s, destroy() { s.remove(); } };
}

// ====================================================================== AIDE
const HELP_ILLU = {
  tick: `<svg viewBox="0 0 240 88" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(14 14)"><circle cx="26" cy="26" r="24" class="ill-disc"/><path d="M16 26h20M26 16v20" stroke-width="2"/><text x="26" y="66" text-anchor="middle">Décider</text></g>
    <path d="M70 40h18" class="ill-arrow"/><path d="M84 35l5 5-5 5"/>
    <g transform="translate(94 14)"><circle cx="26" cy="26" r="24" class="ill-disc"/><path d="M12 32l9-12 7 7 10-13" stroke-width="2"/><text x="26" y="66" text-anchor="middle">Bouger</text></g>
    <path d="M150 40h18" class="ill-arrow"/><path d="M164 35l5 5-5 5"/>
    <g transform="translate(174 14)"><circle cx="26" cy="26" r="24" class="ill-disc"/><path d="M14 14l24 24M38 14L14 38" stroke-width="2.2"/><text x="26" y="66" text-anchor="middle">Frapper</text></g></svg>`,
  slots: `<svg viewBox="0 0 240 80" fill="none" stroke="currentColor" stroke-width="1.5">
    <g class="ill-perc"><rect x="8" y="22" width="62" height="30" rx="6"/><text x="39" y="42" text-anchor="middle">SI … 1</text></g>
    <g class="ill-link"><rect x="78" y="22" width="40" height="30" rx="6"/><text x="98" y="42" text-anchor="middle">ET 1</text></g>
    <g class="ill-perc"><rect x="126" y="22" width="40" height="30" rx="6"/><text x="146" y="42" text-anchor="middle">… 1</text></g>
    <g class="ill-act"><rect x="174" y="22" width="58" height="30" rx="6"/><text x="203" y="42" text-anchor="middle">ALORS 1</text></g>
    <text x="120" y="72" text-anchor="middle" class="ill-cap">= 4 emplacements</text></svg>`,
  ravens: `<svg viewBox="0 0 240 80" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M22 66V18M22 18c8-4 14 4 22 0v13c-8 4-14-4-22 0" class="ill-royal"/>
    <path d="M44 50 C 90 10, 150 10, 200 46" stroke-dasharray="2 7" class="ill-path"/>
    <path transform="translate(108 14) scale(1.5)" d="M1.8 12.6c2.6-2.4 5.6-2.8 8.6-1.4 1-2.7 3.6-4.6 7.2-4.7l-1.5 1.7c2 .1 3.9.8 5.5 1.9-3 .2-5.8 1-7.7 2.9-1.1 2.3-3.1 3.7-6 3.9l1.7-1.9c-2.9.2-5.4-.6-7.8-2.4z" fill="currentColor" stroke="none"/>
    <circle cx="206" cy="54" r="10" class="ill-royal"/><text x="206" y="58" text-anchor="middle" class="ill-cap">ᛖ</text>
    <circle cx="150" cy="66" r="7" class="ill-gob"/><circle cx="150" cy="66" r="24" stroke-dasharray="3 4" class="ill-gob" opacity=".7"/></svg>`,
  commander: `<svg viewBox="0 0 240 80" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <circle cx="120" cy="44" r="32" stroke-dasharray="3 5" class="ill-royal" opacity=".8"/>
    <path d="M114 62V22M114 22c8-4 14 4 22 0v13c-8 4-14-4-22 0" class="ill-royal" stroke-width="2"/>
    <circle cx="74" cy="44" r="8"/><circle cx="166" cy="44" r="8"/><circle cx="120" cy="70" r="6" opacity=".5"/>
    <text x="74" y="72" text-anchor="middle" class="ill-cap">+1 déf</text><text x="166" y="72" text-anchor="middle" class="ill-cap">+1 déf</text></svg>`,
};
const TERRAIN_SW = { forest: '#4e7a3a', hill: '#9a8a55', ford: '#6fb7c2', ruins: '#a39b8b', water: '#3f8fa8', plain: '#93b566', rocks: '#8e8a82' };

/**
 * « Comment jouer » : 6 cartes illustrées.
 * @param {{}} data
 * @param {{ onClose() }} on
 */
export function renderHelp(root, _data, on) {
  // on.onSettings (facultatif) : lien vers les réglages, pour l'aide ouverte en pleine bataille.
  const s = screenEl('help', 'full modal-screen');
  const p = panel('help-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' });
  const close = btn('', { id: 'help-close', kind: 'ghost', ico: 'close', title: 'Fermer', cls: 'btn-icon', onClick: () => on.onClose?.() });
  const grid = h('div', { class: 'help-grid' });
  const card = (n, title, text, illu) => h('article', { class: 'help-card', id: `help-card-${n}` },
    h('div', { class: 'hc-num', 'aria-hidden': 'true', text: ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', 'ᚲ'][n - 1] }),
    h('h3', { class: 'hc-title', text: title }), illu, h('p', { class: 'hc-text', text }));

  const ex = h('div', { class: 'hc-illu hc-prog' });
  programView(ex, DEFAULT_PROGRAMS.k_knights, 'k_knights', { highlightRule: 0, compact: true });
  grid.append(
    card(1, 'Des runes, pas des ordres', `Avant la bataille, chaque unité reçoit un programme : des règles «${NB}SI… ALORS…${NB}». À chaque instant, elle lit ses règles de haut en bas et applique la première qui peut s’exécuter. Sinon : instinct, elle frappe l’ennemi à portée.`, ex),
    card(2, 'L’instant', 'Les deux armées décident en même temps sur la même image du champ de bataille, se déplacent, puis frappent. Tous les coups portent ensemble : une unité qui tombe frappe une dernière fois. Au bout de 80 instants, le camp qui a gardé la plus grande part de son armée l’emporte ; à égalité, les Gobelins.', h('div', { class: 'hc-illu' }, svgEl(HELP_ILLU.tick))),
    card(3, 'Les emplacements', 'Chaque condition et chaque action coûtent 1 emplacement, la liaison ET/OU 1 par règle, NON +1. TOUJOURS est gratuit. Le golem n’en a que 2 ; le mage, 6. Le feu de camp en ajoute.', h('div', { class: 'hc-illu' }, svgEl(HELP_ILLU.slots))),
    card(4, 'Les corbeaux', `En pleine bataille, un corbeau porte un nouveau programme à une unité. Il part du commandant et vole 3 hex par instant. Chaque archer ennemi qu’il frôle à 2 hex a une chance de l’abattre (30${NB}%). La bataille se met en pause pendant que vous écrivez.`, h('div', { class: 'hc-illu' }, svgEl(HELP_ILLU.ravens))),
    card(5, 'Le commandant', 'Il inspire les alliés à 2 hex (+1 défense) et c’est de lui que partent les corbeaux. S’il tombe, la bataille est perdue. Abattez le Chef de guerre gobelin et la horde se disperse.', h('div', { class: 'hc-illu' }, svgEl(HELP_ILLU.commander))),
    card(6, 'Le terrain', `${touchUi() ? 'Touchez' : 'Survolez'} un hexagone pour lire ses effets. Vos troupes se déploient sur les hexagones bleus de votre camp.`, h('ul', { class: 'hc-terrain' },
      ['forest', 'hill', 'ford', 'ruins', 'water'].map(t => h('li', {}, h('i', { class: 'sw', style: { background: TERRAIN_SW[t] } }), h('b', { text: TERRAIN[t].name }), h('span', { text: TERRAIN[t].help })))))
  );
  add(p, 
    h('header', { class: 'stage-head' }, h('div', {}, h('div', { class: 'eyebrow', text: 'Le manuel du capitaine' }), h('h2', { class: 'stage-title', id: 'help-title', text: 'Comment jouer' })), close),
    grid,
    h('footer', { class: 'help-foot' },
      h('p', {}, 'Après chaque victoire, lisez le ', h('b', { text: 'grimoire ennemi' }), ' et volez-lui une rune. Les morts ne reviennent pas ; les survivants guérissent.'),
      touchUi() ? null : h('p', { class: 'keys' }, kbd('Espace'), ' pause · ', kbd('1'), ' ', kbd('2'), ' ', kbd('3'), ' vitesse · ', kbd('R'), ' vue d’ensemble ou suivre l’action · ', kbd('?'), ' aide · ', kbd('Échap'), ' fermer'),
      on.onSettings ? btn('Réglages', { id: 'help-settings', kind: 'ghost', size: 'sm', ico: 'gear', onClick: () => on.onSettings?.() }) : null));
  s.append(p);
  s.addEventListener('click', (e) => { if (e.target === s) on.onClose?.(); });
  mount(root, s);
  close.focus();
  return { el: s, destroy() { s.remove(); } };
}
const kbd = (t) => h('kbd', { text: t });

// ====================================================================== RÉGLAGES
/**
 * Réglages : qualité, volume, vitesse par défaut.
 * @param {{ settings: {quality:'high'|'low', volume:number, muted:boolean, speed:1|2|4} }} data
 * @param {{ onChange(settings), onClose() }} on
 */
export function renderSettings(root, { settings }, on) {
  const st = { ...settings };
  const s = screenEl('settings', 'full modal-screen');
  const p = panel('settings-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' });
  const emit = () => on.onChange?.({ ...st });
  const seg = (name, opts, cur, onPick) => {
    const g = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name });
    for (const [val, label] of opts) {
      const b = h('button', { type: 'button', class: `seg-btn${cur === val ? ' is-on' : ''}`, id: `set-${name}-${val}`, role: 'radio', 'aria-checked': String(cur === val) }, label);
      b.addEventListener('click', () => { sfx('ui'); for (const x of g.children) { x.classList.toggle('is-on', x === b); x.setAttribute('aria-checked', String(x === b)); } onPick(val); });
      g.append(b);
    }
    return g;
  };
  const vol = h('input', { type: 'range', id: 'set-volume', min: '0', max: '100', step: '5', value: String(Math.round((st.volume ?? 0.7) * 100)), 'aria-label': 'Volume' });
  const volOut = h('output', { class: 'num', for: 'set-volume', text: `${vol.value}${NB}%` });
  vol.addEventListener('input', () => { st.volume = Number(vol.value) / 100; volOut.textContent = `${vol.value}${NB}%`; emit(); });
  vol.addEventListener('change', () => sfx('rune'));
  const mute = h('button', { type: 'button', id: 'set-mute', class: `btn btn-ghost btn-icon${st.muted ? ' is-on' : ''}`, 'aria-pressed': String(!!st.muted), title: st.muted ? 'Rétablir le son' : 'Couper le son' }, icon(st.muted ? 'mute' : 'sound'));
  mute.addEventListener('click', () => { st.muted = !st.muted; clear(mute).append(icon(st.muted ? 'mute' : 'sound')); mute.setAttribute('aria-pressed', String(st.muted)); mute.title = st.muted ? 'Rétablir le son' : 'Couper le son'; emit(); if (!st.muted) sfx('ui'); });
  const close = btn('', { id: 'settings-close', kind: 'ghost', ico: 'close', title: 'Fermer', cls: 'btn-icon', onClick: () => on.onClose?.() });
  add(p, 
    h('header', { class: 'stage-head' }, h('div', {}, h('div', { class: 'eyebrow', text: 'Options' }), h('h2', { class: 'stage-title', id: 'settings-title', text: 'Réglages' })), close),
    h('div', { class: 'set-rows' },
      h('div', { class: 'set-row' }, h('div', { class: 'set-lbl' }, h('b', { text: 'Qualité graphique' }), h('span', { text: 'Basse : ombres et effets allégés, pour les petites machines.' })),
        seg('quality', [['high', 'Haute'], ['low', 'Basse']], st.quality, (v) => { st.quality = v; emit(); })),
      h('div', { class: 'set-row' }, h('div', { class: 'set-lbl' }, h('b', { text: 'Volume' }), h('span', { text: 'Musique et effets sonores synthétisés.' })),
        h('div', { class: 'vol' }, mute, vol, volOut)),
      h('div', { class: 'set-row' }, h('div', { class: 'set-lbl' }, h('b', { text: 'Vitesse de bataille' }), h('span', { text: 'Vitesse au début de chaque bataille.' })),
        seg('speed', [[1, '1×'], [2, '2×'], [4, '4×']], st.speed, (v) => { st.speed = v; emit(); }))),
    h('footer', { class: 'stage-foot' }, btn('Fermer', { id: 'settings-done', kind: 'primary', onClick: () => on.onClose?.() })));
  s.append(p);
  s.addEventListener('click', (e) => { if (e.target === s) on.onClose?.(); });
  mount(root, s);
  close.focus();
  return { el: s, destroy() { s.remove(); } };
}

// ====================================================================== chargement / erreurs (utilisés par main.js)
/** Petit écran d'attente (ex. « Les éclaireurs reviennent… »). */
export function renderWait(root, text) {
  const s = screenEl('wait', 'full');
  const p = h('p', { text, 'aria-live': 'polite' });
  s.append(panel('wait-panel', {}, h('div', { class: 'wait-glyph', 'aria-hidden': 'true', text: 'ᚱ' }), p));
  mount(root, s);
  return { el: s, setText(t) { p.textContent = t; }, destroy() { s.remove(); } };
}
