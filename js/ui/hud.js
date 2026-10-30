// js/ui/hud.js — HUD de préparation (rapport d'éclaireurs, déploiement, programmation) et HUD de bataille
// (instant, vitesse, corbeaux, inspecteur d'unité, chronique, bandeau de fin).
//
// Comme screens.js, aucun import statique de modules d'autres équipes : main.js injecte { editor, sim, audio, campaign }
// via initHud(). La vue 3D est passée dans le contexte de mountPrep / mountBattle et n'est utilisée qu'à travers son API
// publique (setUnits, setHighlights, setSelected, on, projectHex, focusHex).
import { UNITS, TERRAIN, TRAITS, SPELLS, MAX_TICKS, RAVEN_SPEED_HEX, RAVEN_INTERCEPT_RANGE, RAVEN_INTERCEPT_CHANCE, CLASSES } from '../core/data.js';
import { programCost, describeRule, describeAction, validateProgram, cloneProgram } from '../core/program.js';
import { hexToWorld, worldDistHex, distance, key } from '../core/hex.js';
import { getTile, deployHexes, isDeployHex } from '../core/maputil.js';
import { h, add, clear, btn, icon, panel, portrait, programView, toast, withArticle, isPlural, isFeminine, statLine, traitNames, slotPips, rosterSlots, reasonText, NB, layoutMode, touchUi } from './screens.js';

/** Dépendances injectées : { editor, sim, audio, campaign }. */
export const hdeps = { editor: null, sim: null, audio: null, campaign: null };
/** @param {{editor?, sim?, audio?, campaign?}} d */
export function initHud(d = {}) { Object.assign(hdeps, d); }

const sfx = (n) => { try { hdeps.audio?.play?.(n); } catch { /* muet */ } };
/** Carillon doux quand une rune est posée / modifiée dans l'éditeur (limité à un toutes les 120 ms). */
let lastChime = 0;
const runeChime = () => {
  const t = performance.now();
  if (t - lastChime < 120) return;
  lastChime = t;
  try { hdeps.audio?.play?.('rune', { gain: 0.6 }); } catch { /* muet */ }
};
// Mise en page (mêmes requêtes que css/game.css) : 'desktop', 'phone' (portrait) ou 'landscape' (téléphone couché).
// isPhone : mise en page compacte ; sheetPhone : feuilles qui couvrent le plateau (portrait seulement).
const isPhone = () => layoutMode() !== 'desktop';
const sheetPhone = () => layoutMode() === 'phone';
/** Verbe selon l'entrée : « touchez » sur écran tactile, « cliquez » à la souris. */
const verb = (capFirst = false) => { const v = touchUi() ? 'touchez' : 'cliquez'; return capFirst ? v[0].toUpperCase() + v.slice(1) : v; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Les règles sont numérotées en chiffres romains dans l'éditeur (I, II, III…) : même numérotation partout.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const roman = (i) => ROMAN[i] ?? String(i + 1);
/** « Règle 2 : il manque une action. » → « Règle II : … » (messages de program.js). */
const romanRules = (s) => String(s ?? '').replace(/\bRègle (\d+)/g, (_, n) => `Règle ${roman(Number(n) - 1)}`);
const SIDE_FACTION = { player: 'royaume', enemy: 'gobelins' };

/** Garde anti double-clic : la vue peut émettre hexclick ET unitclick pour le même geste. */
function clickGate(ms = 60) {
  let last = { k: null, t: 0 };
  return (k) => { const t = performance.now(); if (last.k === k && t - last.t < ms) return false; last = { k, t }; return true; };
}

/** Infobulle de terrain/unité positionnée dans #overlay via view.projectHex. */
function makeTip(view) {
  const host = document.getElementById('overlay');
  const el = h('div', { class: 'hex-tip', hidden: true });
  host?.append(el);
  return {
    show(q, r, title, text, cls = '') {
      let p = null;
      try { p = view?.projectHex?.(q, r); } catch { p = null; }
      if (!p || p.visible === false) { el.hidden = true; return; }
      add(clear(el), h('b', { text: title }), text ? h('span', { text }) : null);
      el.className = `hex-tip ${cls}`.trim();
      el.style.left = `${Math.round(p.x)}px`; el.style.top = `${Math.round(p.y)}px`;
      el.hidden = false;
    },
    hide() { el.hidden = true; },
    destroy() { el.remove(); },
  };
}

function terrainInfo(map, q, r) {
  const t = getTile(map, q, r);
  if (!t) return null;
  return TERRAIN[t.terrain] ?? null;
}

// =====================================================================================================
// PRÉPARATION
// =====================================================================================================
/**
 * HUD de préparation.
 * @param {HTMLElement} root  conteneur (#ui)
 * @param {{
 *   view: object, run: object,
 *   prep: { node, map, enemyPlan, scout: string[], placements: Map<string,{q,r}> },
 *   actions: { place(uid,q,r):boolean, unplace(uid):void, autoDeploy():void, start():void, programChanged(uid):void,
 *              openHelp?():void, openSettings?():void }
 * }} ctx
 * @returns {{ el, update(), select(uid|null), destroy() }}
 */
export function mountPrep(root, ctx) {
  const { view, run, prep, actions } = ctx;
  const map = prep.map;
  const enemies = (prep.enemyPlan?.units ?? []).map((u, i) => ({ ...u, id: `e${i}`, side: 'enemy' }));
  const st = { sel: null, hover: null, editor: null, confirm: false };
  const gate = clickGate();
  const tip = makeTip(view);
  const unsub = [];

  const s = h('section', { class: 'screen screen-prep hud', id: 'screen-prep' });

  // ---- rapport d'éclaireurs
  const kindName = { battle: 'Bataille', elite: 'Élite', boss: 'Bataille finale' }[prep.node?.kind] ?? 'Bataille';
  const doctrine = prep.enemyPlan?.doctrine;
  const scoutBody = h('div', { class: 'scout-body', id: 'scout-body' },
    h('ul', { class: 'scout-list' }, (prep.scout ?? []).map(t => h('li', { text: t }))),
    doctrine?.name ? h('p', { class: 'scout-doctrine' }, h('span', { class: 'lbl', text: 'Doctrine présumée' }), h('b', { text: doctrine.name })) : null,
    doctrine?.name && doctrine.desc ? h('p', { class: 'scout-doctrine-desc', text: doctrine.desc }) : null);
  const scoutToggle = h('button', { type: 'button', class: 'scout-toggle', id: 'prep-scout-toggle', 'aria-expanded': 'true', 'aria-controls': 'scout-body' },
    h('span', { text: 'Rapport d’éclaireurs' }), icon('back', 'ico chev'));
  // Aide et réglages, accessibles pendant la préparation (là où l'on apprend les runes).
  const tools = h('div', { class: 'scout-tools' },
    actions.openHelp ? btn('', { id: 'prep-help', kind: 'ghost', ico: 'book', title: 'Comment jouer (?)', cls: 'btn-icon', onClick: () => actions.openHelp() }) : null,
    actions.openSettings ? btn('', { id: 'prep-settings', kind: 'ghost', ico: 'gear', title: 'Réglages', cls: 'btn-icon', onClick: () => actions.openSettings() }) : null);
  const scout = panel('scout-card', { id: 'prep-scout' }, tools,
    h('div', { class: 'eyebrow', text: `${kindName} · ${enemies.length} unités ennemies` }),
    h('h2', { class: 'scout-title', text: prep.node?.title || map?.name || 'Champ de bataille' }),
    prep.node?.title && map?.name ? h('p', { class: 'scout-place', text: `Champ de bataille : ${map.name}` }) : null,
    scoutToggle, scoutBody);
  // Le rapport se replie tout seul quand l'éditeur s'ouvre (pour laisser la place au plateau), sauf si le joueur
  // a lui-même choisi de l'ouvrir ou de le fermer (st.scoutUser).
  const setScout = (open) => { scout.classList.toggle('is-collapsed', !open); scoutToggle.setAttribute('aria-expanded', String(open)); };
  scoutToggle.addEventListener('click', () => {
    const open = scout.classList.contains('is-collapsed');
    st.scoutUser = open; setScout(open); sfx('ui');
  });
  st.scoutUser = null;
  // replié d'office au téléphone, et au bureau après la première bataille (le joueur connaît le rapport : il reste
  // replié jusqu'à ce qu'il le rouvre lui-même)
  const veteran = (run.battlesWon ?? 0) > 0 || (run.roster ?? []).some(ru => (ru.battles ?? 0) > 0);
  if (isPhone() || veteran) setScout(false);
  if (veteran) st.scoutUser = false;

  // ---- barre de roster + actions
  const cards = h('div', { class: 'roster-bar', role: 'listbox', 'aria-label': 'Vos unités', id: 'prep-roster' });
  const hint = h('p', { class: 'prep-hint', id: 'prep-hint', 'aria-live': 'polite' });
  const bAuto = btn('Déploiement auto', { id: 'prep-auto', kind: 'secondary', ico: 'dice', onClick: () => { actions.autoDeploy(); sfx('rune'); update(); setHint(`Troupes déployées. ${verb(true)} une unité pour lire ou graver ses runes.`); } });
  const bStart = btn('Lancer la bataille', { id: 'prep-start', kind: 'primary', ico: 'swords', onClick: () => tryStart() });
  const confirmBox = h('div', { class: 'inline-confirm prep-confirm', id: 'prep-confirm', hidden: true });
  const bar = h('footer', { class: 'prep-bar panel' },
    h('div', { class: 'prep-bar-top' }, hint, h('div', { class: 'prep-actions' }, bAuto, bStart)),
    confirmBox, cards);

  // ---- panneau d'édition
  const edHost = h('div', { class: 'editor-host', id: 'prep-editor-host' });
  const edHead = h('header', { class: 'ed-head' });
  const edFoot = h('footer', { class: 'ed-foot' });
  const edPanel = panel('prep-editor sheet', { id: 'prep-editor', hidden: true, role: 'region', 'aria-label': 'Programme de l’unité' }, edHead, edHost, edFoot);

  s.append(scout, edPanel, bar);
  root.append(s);
  requestAnimationFrame(() => s.classList.add('is-in'));

  // ------------------------------------------------------------------ helpers
  const roster = () => run.roster ?? [];
  const ruOf = (uid) => roster().find(r => r.uid === uid);
  const placedAt = (q, r) => { for (const [uid, p] of prep.placements) if (p.q === q && p.r === r) return uid; return null; };
  const enemyAt = (q, r) => enemies.find(e => e.q === q && e.r === r) || null;
  const commanderPlaced = () => roster().some(ru => UNITS[ru.type]?.cls === 'commander' && prep.placements.has(ru.uid));
  function setHint(t) { hint.textContent = t; }

  function syncView() {
    const units = [];
    for (const ru of roster()) {
      const p = prep.placements.get(ru.uid);
      if (!p) continue;
      const U = UNITS[ru.type];
      units.push({ id: ru.uid, uid: ru.uid, type: ru.type, side: 'player', q: p.q, r: p.r, hp: U.hp, maxHp: U.hp, alive: true, facing: 0, status: {} });
    }
    for (const e of enemies) {
      const U = UNITS[e.type];
      units.push({ id: e.id, type: e.type, side: 'enemy', q: e.q, r: e.r, hp: U?.hp ?? 1, maxHp: U?.hp ?? 1, alive: true, facing: 3, status: {} });
    }
    try { view?.setUnits?.(units); } catch (e) { console.warn(e); }
    const hl = [];
    for (const x of deployHexes(map, 'player')) hl.push({ q: x.q, r: x.r, kind: 'deploy' });
    for (const x of deployHexes(map, 'enemy')) hl.push({ q: x.q, r: x.r, kind: 'deploy-enemy' });
    const sp = st.sel && prep.placements.get(st.sel);
    if (sp) hl.push({ q: sp.q, r: sp.r, kind: 'select' });
    if (st.hover) hl.push({ q: st.hover.q, r: st.hover.r, kind: 'hover' });
    try { view?.setHighlights?.(hl); view?.setSelected?.(sp ? st.sel : null); } catch (e) { console.warn(e); }
  }

  function drawCards() {
    const keepScroll = cards.scrollLeft;
    clear(cards);
    const invalid = [];
    for (const ru of roster()) {
      const U = UNITS[ru.type];
      const placed = prep.placements.has(ru.uid);
      const used = programCost(ru.program), tot = rosterSlots(ru);
      const v = validateProgram(ru.program, ru.type, { unlocked: run.unlocked, slotsBonus: ru.bonus?.slots ?? 0 });
      if (placed && !v.ok) invalid.push(ru.name || U?.name);
      const c = h('button', {
        type: 'button', class: `ucard${placed ? ' is-placed' : ' is-reserve'}${st.sel === ru.uid ? ' is-selected' : ''}${U?.cls === 'commander' ? ' is-commander' : ''}${v.ok ? '' : ' is-invalid'}`,
        id: `card-${ru.uid}`, role: 'option', 'aria-selected': String(st.sel === ru.uid),
        title: `${ru.name || U?.name} — ${placed ? 'déployé' : 'en réserve'}`,
      },
      portrait(ru.type, { size: 'md' }),
      h('span', { class: 'uc-name', text: ru.name || U?.name }),
      h('span', { class: 'uc-meta' }, h('span', { class: 'uc-hp num', text: `PV ${U?.hp ?? '?'}` }), slotPips(used, tot)),
      h('span', { class: 'uc-flag', text: placed ? 'Déployé' : 'Réserve' }));
      c.addEventListener('click', () => {
        sfx('ui');
        if (st.sel === ru.uid && st.sheet === false) select(ru.uid);      // feuille masquée : on la rouvre
        else select(st.sel === ru.uid ? null : ru.uid);
      });
      c.addEventListener('pointerenter', () => sfx('hover'));
      cards.append(c);
    }
    const reserve = roster().filter(ru => !prep.placements.has(ru.uid)).length;
    bStart.disabled = false;
    bStart.classList.toggle('is-blocked', !commanderPlaced() || invalid.length > 0);
    bStart.title = !commanderPlaced() ? 'Placez d’abord votre commandant'
      : invalid.length ? `Programme invalide${NB}: ${invalid.join(', ')}`
      : (reserve ? `${reserve} unité(s) en réserve` : 'Toutes les unités sont déployées');
    // reconstruire les cartes ne doit pas faire sauter la barre ; la carte choisie reste visible
    cards.scrollLeft = keepScroll;
    revealSel();
  }
  /** Fait défiler la barre (et elle seule : pas scrollIntoView) pour montrer la carte de l'unité choisie. */
  function revealSel() {
    const c = cards.querySelector('.is-selected');
    if (!c) return;
    const l = c.getBoundingClientRect().left - cards.getBoundingClientRect().left + cards.scrollLeft;   // position dans le contenu défilant
    if (l < cards.scrollLeft) cards.scrollLeft = Math.max(0, l - 4);
    else if (l + c.offsetWidth > cards.scrollLeft + cards.clientWidth) cards.scrollLeft = l + c.offsetWidth - cards.clientWidth + 4;
  }

  function openEditor(ru, sheet = true) {
    st.editor?.destroy?.(); st.editor = null;
    clear(edHost); clear(edHead); clear(edFoot);
    // Au téléphone, la feuille d'édition couvre le plateau : on peut la masquer en gardant l'unité choisie (pour la placer).
    if (!ru || !sheet) { edPanel.hidden = true; s.classList.remove('has-editor'); return; }
    const U = UNITS[ru.type];
    const placed = prep.placements.has(ru.uid);
    const close = btn('', { id: 'prep-editor-close', kind: 'ghost', ico: 'close', title: 'Fermer', cls: 'btn-icon', onClick: () => select(null) });
    const traits = traitNames(ru.type);
    edHead.append(
      portrait(ru.type, { size: 'lg' }),
      h('div', { class: 'ed-id' },
        h('div', { class: 'eyebrow', text: `${ru.name && ru.name !== U.name ? U.name : (CLASSES[U.cls]?.name ?? '')}${ru.bonus?.atk ? ' · arme forgée' : ''}${ru.bonus?.slots ? ` · +${ru.bonus.slots} empl.` : ''}` }),
        h('h3', { class: 'ed-name', text: ru.name || U.name }),
        h('div', { class: 'ed-stats num', text: statLine(ru.type, ru.bonus) }),
        traits.length ? h('div', { class: 'ed-traits' }, (U.traits ?? []).map(t => h('span', { class: 'chip', title: TRAITS[t]?.help ?? '', text: TRAITS[t]?.name ?? t }))) : null,
        U.spells?.length ? h('div', { class: 'ed-traits' }, U.spells.map(sp => h('span', { class: 'chip chip-spell', title: SPELLS[sp]?.help ?? '', text: SPELLS[sp]?.name ?? sp }))) : null),
      close);
    if (hdeps.editor?.mountEditor) {
      try {
        st.editor = hdeps.editor.mountEditor(edHost, {
          unitType: ru.type, slotsBonus: ru.bonus?.slots ?? 0, program: cloneProgram(ru.program),
          unlocked: run.unlocked ?? null, title: null, compact: isPhone() || window.innerHeight <= 820,
          onChange: (p) => { ru.program = cloneProgram(p); actions.programChanged?.(ru.uid); drawCards(); runeChime(); },
        });
      } catch (e) {
        console.error(e);
        edHost.append(h('p', { class: 'muted', text: 'L’éditeur de runes n’a pas pu s’ouvrir.' }));
        programView(h('div'), ru.program, ru.type);
      }
    } else {
      edHost.append(h('p', { class: 'muted', text: 'Éditeur de runes indisponible : lecture seule.' }));
      const pv = h('div'); programView(pv, ru.program, ru.type); edHost.append(pv);
    }
    add(edFoot,
      h('p', { class: 'ed-where', text: placed ? `${verb(true)} un hexagone bleu pour la déplacer, ou de nouveau sur elle pour la renvoyer en réserve.` : `En réserve : ${verb()} un hexagone bleu pour la déployer.` }),
      h('div', { class: 'ed-foot-actions' },
        placed ? btn('Renvoyer en réserve', { id: 'prep-unplace', kind: 'ghost', size: 'sm', onClick: () => { actions.unplace(ru.uid); update(); } }) : null,
        btn(placed ? 'Déplacer' : 'Placer', { id: 'prep-place', kind: 'secondary', size: 'sm', cls: 'phone-only', onClick: () => select(ru.uid, { sheet: false }) })));
    edPanel.hidden = false;
    s.classList.add('has-editor');
  }

  function select(uid, { sheet = true } = {}) {
    st.sel = uid; st.sheet = sheet;
    st.confirm = false; confirmBox.hidden = true;
    const ru = uid ? ruOf(uid) : null;
    openEditor(ru, sheet);
    if (ru) {
      const p = prep.placements.get(uid);
      setHint(p ? `${ru.name || UNITS[ru.type].name} : ${verb()} un hexagone bleu pour la déplacer.` : `${ru.name || UNITS[ru.type].name} : ${verb()} un hexagone bleu pour la déployer.`);
      if (p && sheetPhone()) { try { view?.focusHex?.(p.q, p.r); } catch { /* */ } }
    } else defaultHint();
    if (!isPhone() && st.scoutUser == null) setScout(!ru);
    drawCards(); syncView(); frame();
  }

  function defaultHint() {
    if (!prep.placements.size) setHint('Choisissez une unité, puis un hexagone bleu pour la déployer.');
    else if (!commanderPlaced()) setHint('Placez votre commandant : sans lui, pas de bataille.');
    else if (touchUi()) setHint('Touchez une unité pour lire ou graver ses runes, ou un hexagone pour ses effets.');
    else setHint('Cliquez une unité pour lire ou graver ses runes. Survolez le terrain pour ses effets.');
  }

  /** Après select() (qui reconstruit l'éditeur) : amène la première erreur du programme sous les yeux. */
  function revealEditorError() {
    const go = () => {
      const t = edHost.querySelector('.rn-alerts, .rn-rule.has-error');
      if (!t) return;
      for (let p = t.parentElement; p && p !== edPanel; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
          p.scrollTop += t.getBoundingClientRect().top - p.getBoundingClientRect().top - 8;
          break;
        }
      }
      (t.matches('.rn-rule') ? t.querySelector('button') : null)?.focus?.({ preventScroll: true });
    };
    go(); requestAnimationFrame(go);
  }

  function tryStart() {
    if (!commanderPlaced()) {
      sfx('deny');
      const cmd = roster().find(ru => UNITS[ru.type]?.cls === 'commander');
      if (cmd) { select(cmd.uid); document.getElementById(`card-${cmd.uid}`)?.classList.add('is-nudge'); }
      setHint('Placez d’abord votre commandant : sans lui, pas de bataille.');   // après select(), qui réécrit l'aide
      return;
    }
    const bad = roster().filter(ru => prep.placements.has(ru.uid)).map(ru => ({ ru, v: validateProgram(ru.program, ru.type, { unlocked: run.unlocked, slotsBonus: ru.bonus?.slots ?? 0 }) })).filter(x => !x.v.ok);
    if (bad.length) {
      sfx('deny');
      const b = bad[0];
      select(b.ru.uid);
      document.getElementById(`card-${b.ru.uid}`)?.classList.add('is-nudge');
      setHint(`${withArticle(b.ru.name || UNITS[b.ru.type].name, true)} : programme invalide. ${romanRules(b.v.errors[0])}`);
      revealEditorError();
      return;
    }
    const reserve = roster().filter(ru => !prep.placements.has(ru.uid));
    if (reserve.length && !st.confirm) {
      st.confirm = true;
      clear(confirmBox).append(
        h('p', {}, `${reserve.length === 1 ? 'Une unité reste' : `${reserve.length} unités restent`} en réserve (${reserve.map(r => r.name || UNITS[r.type].name).join(', ')}). Elles ne combattront pas.`),
        h('div', { class: 'row' },
          btn('Lancer quand même', { id: 'prep-start-confirm', kind: 'primary', size: 'sm', onClick: () => { st.confirm = false; actions.start(); } }),
          btn('Annuler', { id: 'prep-start-cancel', kind: 'ghost', size: 'sm', onClick: () => { st.confirm = false; confirmBox.hidden = true; bStart.focus(); } })));
      confirmBox.hidden = false;
      confirmBox.querySelector('button')?.focus();
      return;
    }
    actions.start();
  }

  // ------------------------------------------------------------------ événements de la vue
  function onHex(q, r) {
    if (!gate(`${q},${r}`)) return;
    tip.hide();
    const mine = placedAt(q, r);
    const foe = enemyAt(q, r);
    if (foe) {
      const U = UNITS[foe.type];
      sfx('ui');
      setHint(`${U?.name} — ${statLine(foe.type)}${traitNames(foe.type).length ? ` · ${traitNames(foe.type).join(', ')}` : ''}. Leur grimoire reste scellé jusqu’à la victoire.`);
      return;
    }
    if (mine) {
      if (mine === st.sel) { actions.unplace(mine); sfx('page'); update(); setHint('Unité renvoyée en réserve.'); return; }
      sfx('ui'); select(mine); return;
    }
    const T = terrainInfo(map, q, r);
    if (isDeployHex(map, 'player', q, r)) {
      if (!st.sel) {
        // sans unité choisie, un clic (ou un toucher : pas de survol au téléphone) renseigne sur le terrain
        sfx('ui');
        setHint(`${T ? `${T.name} : ${T.help} ` : ''}Zone de déploiement : choisissez d’abord une unité dans la barre du bas.`);
        if (T && touchUi()) tip.show(q, r, T.name, `${T.help} · Zone de déploiement`);
        return;
      }
      const ok = actions.place(st.sel, q, r);
      if (ok !== false) { sfx('rune'); update(); select(st.sel, { sheet: !sheetPhone() }); }
      else { sfx('deny'); }
      return;
    }
    if (st.sel) { sfx('deny'); setHint(T && !T.passable ? `${T.name} : infranchissable.` : 'Hors de votre zone de déploiement (les hexagones bleus de votre camp).'); return; }
    if (T) { sfx('ui'); setHint(`${T.name} : ${T.help}`); if (touchUi()) tip.show(q, r, T.name, T.help); }
  }
  function onHover(q, r) {
    if (q == null) { st.hover = null; tip.hide(); syncView(); return; }
    if (st.hover && st.hover.q === q && st.hover.r === r) return;
    st.hover = { q, r };
    const T = terrainInfo(map, q, r);
    const mine = placedAt(q, r), foe = enemyAt(q, r);
    if (touchUi()) { syncView(); return; }    // pas de survol au doigt : l'infobulle suit le toucher (onHex)
    if (foe) tip.show(q, r, UNITS[foe.type]?.name ?? '', 'Gobelins', 'tip-gob');
    else if (mine) { const ru = ruOf(mine); tip.show(q, r, ru?.name || UNITS[ru?.type]?.name || '', 'Royaume', 'tip-roy'); }
    else if (T) tip.show(q, r, T.name, `${T.help}${isDeployHex(map, 'player', q, r) ? ' · Zone de déploiement' : ''}`);
    syncView();
  }
  const on = (name, fn) => { try { const u = view?.on?.(name, fn); if (typeof u === 'function') unsub.push(u); } catch (e) { console.warn(e); } };
  on('hexclick', (e) => { if (e && e.q != null) onHex(e.q, e.r); });
  on('unitclick', (e) => {
    if (!e?.unitId) return;
    const p = prep.placements.get(e.unitId) || enemies.find(x => x.id === e.unitId);
    if (p) onHex(p.q, p.r);
  });
  on('hexhover', (e) => onHover(e?.q ?? null, e?.r ?? null));

  const onKey = (e) => { if (e.key === 'Escape' && st.sel) { select(null); } };
  window.addEventListener('keydown', onKey);

  function update() {
    if (st.sel && !ruOf(st.sel)) st.sel = null;
    drawCards(); syncView();
    if (st.sel) openEditor(ruOf(st.sel), st.sheet !== false); else defaultHint();
    frame();
  }

  // Cadrage : on réserve à la caméra l'espace occupé par les panneaux (API optionnelle view.setInsets).
  let lastInsets = '';
  function frame() {
    if (!view?.setInsets) return;
    // tout de suite (la mise en page est déjà calculable) puis à l'image suivante (après les changements de classes) :
    // un navigateur qui étrangle requestAnimationFrame (onglet en arrière-plan, aperçu intégré) cadre quand même.
    applyFrame();
    requestAnimationFrame(applyFrame);
  }
  function applyFrame() {
    if (!s.isConnected) return;
    revealSel();
    {
      const W = window.innerWidth, H = window.innerHeight;
      const mode = layoutMode();
      const br = bar.getBoundingClientRect();
      const ins = { top: 0, right: 0, bottom: Math.max(0, Math.round(H - br.top)), left: 0 };
      if (mode === 'desktop') {
        const sr = scout.getBoundingClientRect();
        // rapport replié : une pastille en haut à gauche, sous laquelle passe le coin de l'anneau de décor (aucune
        // marge : réserver toute la largeur du haut éloignait la caméra) ; déplié, une colonne à gauche
        if (!scout.classList.contains('is-collapsed') && W > 960) ins.left = Math.round(sr.right);
        if (!edPanel.hidden && W > 960) ins.right = Math.round(W - edPanel.getBoundingClientRect().left);
        if (!edPanel.hidden && W <= 960) ins.bottom = Math.max(ins.bottom, Math.round(H - edPanel.getBoundingClientRect().top));
      } else if (mode === 'landscape') {
        // téléphone couché : rapport replié en haut à gauche, barre basse sur une ligne (aide au-dessus), éditeur à droite
        ins.top = Math.round(scout.getBoundingClientRect().bottom + 4);
        const hr = hint.getBoundingClientRect();
        if (hr.height) ins.bottom = Math.max(ins.bottom, Math.round(H - hr.top));
        if (!edPanel.hidden) ins.right = Math.round(W - edPanel.getBoundingClientRect().left);
      } else {
        ins.top = Math.round(scout.getBoundingClientRect().bottom);
      }
      const k = JSON.stringify(ins);
      if (k === lastInsets) return;
      const first = !lastInsets;
      lastInsets = k;
      try { view.setInsets(ins); if (first) view.resetCamera?.(); } catch { /* */ }
    }
  }
  const onResize = () => frame();
  window.addEventListener('resize', onResize);
  scoutToggle.addEventListener('click', () => frame());
  // Les panneaux changent de taille avec des transitions CSS (barre qui se rétrécit quand l'éditeur s'ouvre) :
  // on recadre à chaque changement de taille et à la fin des transitions, pas seulement au clic.
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => frame()) : null;
  for (const el of [bar, scout, edPanel]) { ro?.observe(el); el.addEventListener('transitionend', onResize); el.addEventListener('animationend', onResize); }
  update();

  return {
    el: s,
    update,
    select,
    destroy() {
      for (const u of unsub) { try { u(); } catch { /* */ } }
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      st.editor?.destroy?.();
      tip.destroy();
      s.remove();
    },
  };
}

// =====================================================================================================
// BATAILLE
// =====================================================================================================
let activeBattleHud = null;
/** Point d'entrée de la boucle (INTERFACES) : met à jour le HUD de bataille actif. */
export function onTick(report, battle) { activeBattleHud?.onTick(report, battle); }

const VERB = {
  charge: ['charge', 'chargent'], melee: ['frappe', 'frappent'], arrow: ['tire sur', 'tirent sur'], bolt: ['foudroie', 'foudroient'],
  cast: ['lance', 'lancent'], heal: ['soigne', 'soignent'], ward: ['protège', 'protègent'], hex: ['maudit', 'maudissent'],
  shoot: ['abat', 'abattent'], receive: ['reçoit', 'reçoivent'],
};
const conj = (name, v) => VERB[v][isPlural(name) ? 1 : 0];

/**
 * HUD de bataille.
 * @param {HTMLElement} root
 * @param {{
 *   view: object, run: object, getBattle(): object,
 *   actions: { setSpeed(n), getSpeed(): number, sendRaven(unitId, program): {ok, reason?}, holdPause(on:boolean), finishInstantly(),
 *              openHelp?() },
 *   intro?: string|null   bandeau affiché tant que la bataille n'a pas été lancée (bataille commencée en pause)
 * }} ctx
 * @returns {{ el, onTick(report, battle), refresh(), showEnd(result, battle, onContinue), destroy() }}
 */
export function mountBattle(root, ctx) {
  const { view, run, actions } = ctx;
  const B = () => ctx.getBattle();
  const st = { pinned: null, hover: null, picking: false, modal: null, editor: null, ended: false, log: [], flashes: [], logSeq: 0, intro: !!ctx.intro };
  const gate = clickGate();
  const unsub = [];
  const tip = makeTip(view);
  const U = (id) => B()?.units?.find(u => u.id === id) ?? null;

  const s = h('section', { class: 'screen screen-battle hud', id: 'screen-battle' });

  // ---- barre du haut
  const tickNum = h('b', { class: 'num', id: 'b-tick', text: '0' });
  const tickBar = h('i', { class: 'tick-fill' });
  const tickBox = h('div', { class: 'tb-tick' }, h('span', { class: 'lbl', text: 'Instant' }), tickNum, h('span', { class: 'num of', text: `/ ${B()?.maxTicks ?? MAX_TICKS}` }), h('span', { class: 'tick-track' }, tickBar));
  const speedBtns = {};
  const speedSeg = h('div', { class: 'seg speed-seg', role: 'radiogroup', 'aria-label': 'Vitesse' });
  for (const [v, label, ico] of [[0, '', 'pause'], [1, '1×'], [2, '2×'], [4, '4×']]) {
    const b = h('button', { type: 'button', class: 'seg-btn', id: `spd-${v}`, role: 'radio', title: v === 0 ? 'Pause (Espace)' : `Vitesse ${label} (${v === 4 ? 3 : v})`, 'aria-label': v === 0 ? 'Pause' : `Vitesse ${label}` },
      ico ? icon(ico) : label);
    b.addEventListener('click', () => { sfx('ui'); actions.setSpeed(v === 0 && actions.getSpeed() === 0 ? -1 : v); });
    speedBtns[v] = b; speedSeg.append(b);
  }
  const bSkip = h('button', { type: 'button', class: 'seg-btn', id: 'b-skip', title: 'Résoudre la bataille sans animation', 'aria-label': 'Résoudre la bataille' }, icon('skip'));
  bSkip.addEventListener('click', () => { sfx('ui'); actions.finishInstantly(); });
  speedSeg.append(bSkip);
  // Cadrage de la caméra (vue facultative) : tout le champ, ou suivre l'action. Après un déplacement à la main,
  // aucun des deux n'est allumé : l'un ou l'autre ramène au cadrage automatique. R fait la même chose.
  const frameBtns = {};
  const frameSeg = view?.setFraming
    ? h('div', { class: 'seg frame-seg', id: 'b-frame', role: 'radiogroup', 'aria-label': 'Cadrage de la caméra' })
    : null;
  if (frameSeg) {
    for (const [mode, label, ico] of [['board', 'Vue d’ensemble (R)', 'overview'], ['action', 'Suivre l’action (R)', 'follow']]) {
      const b = h('button', { type: 'button', class: 'seg-btn', id: `b-frame-${mode}`, role: 'radio', title: label, 'aria-label': label.replace(' (R)', '') }, icon(ico));
      b.addEventListener('click', () => { sfx('ui'); try { view.setFraming(mode); } catch { /* */ } drawFraming(); });
      frameBtns[mode] = b; frameSeg.append(b);
    }
  }
  function drawFraming(f) {
    if (!frameSeg) return;
    let fr = f;
    if (!fr) { try { fr = view.getFraming?.(); } catch { fr = null; } }
    for (const [mode, b] of Object.entries(frameBtns)) {
      const on = !!fr && !fr.userMoved && fr.mode === mode;
      b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on));
    }
    // au téléphone, un seul bouton (la place manque) : celui qui change quelque chose — l'autre cadrage, ou, après
    // un déplacement à la main, le retour au cadrage choisi
    const mode = fr?.mode === 'board' ? 'board' : 'action';
    frameSeg.dataset.show = fr?.userMoved ? mode : (mode === 'board' ? 'action' : 'board');
  }
  const balRoy = h('i', { class: 'bal-roy' }), balGob = h('i', { class: 'bal-gob' });
  const balance = h('div', { class: 'tb-balance', title: 'Valeur des armées (coût × PV restants)' },
    h('span', { class: 'bal-lbl roy', text: 'Royaume' }), h('span', { class: 'bal-track' }, balRoy, balGob), h('span', { class: 'bal-lbl gob', text: 'Gobelins' }));
  const ravenIcons = h('span', { class: 'raven-pips', id: 'b-raven-pips' });
  const bRaven = btn('Envoyer un corbeau', { id: 'b-raven', kind: 'primary', size: 'sm', ico: 'raven', onClick: () => startPick() });
  const ravenCount = h('span', { class: 'raven-count num', id: 'b-raven-count', 'aria-hidden': 'true' });
  bRaven.append(ravenCount);
  const ravensBox = h('div', { class: 'tb-ravens' }, ravenIcons, bRaven);
  // « Comment jouer » en pleine bataille (l'aide met la bataille en pause et mène aux réglages)
  const bHelp = actions.openHelp
    ? h('button', { type: 'button', class: 'tb-help', id: 'b-help', title: 'Comment jouer (?)', 'aria-label': 'Comment jouer' }, '?')
    : null;
  bHelp?.addEventListener('click', () => { sfx('ui'); actions.openHelp(); });
  const topbar = panel('topbar', { id: 'b-topbar' }, tickBox, speedSeg, frameSeg, balance, ravensBox, bHelp);

  const flights = h('div', { class: 'flights', id: 'b-flights', 'aria-live': 'polite' });
  // Chronique compacte (3 dernières lignes) pendant la bataille ; le bouton la déplie (8 lignes, opaque).
  const logList = h('ol', { class: 'log-list', id: 'b-log-list' });
  const logToggle = h('button', { type: 'button', class: 'log-toggle', id: 'b-log-toggle', 'aria-expanded': 'false', 'aria-controls': 'b-log-list', title: 'Déplier la chronique' }, icon('back', 'ico chev'));
  const logPanel = panel('battle-log', { id: 'b-log' }, h('header', { class: 'log-head' }, h('h3', { class: 'panel-title', text: 'Chronique' }), logToggle), logList);
  logToggle.addEventListener('click', () => {
    const open = !logPanel.classList.contains('is-expanded');
    logPanel.classList.toggle('is-expanded', open);
    logToggle.setAttribute('aria-expanded', String(open));
    logToggle.title = open ? 'Replier la chronique' : 'Déplier la chronique';
    sfx('ui');
  });
  const insp = panel('inspector sheet', { id: 'b-insp', hidden: true, role: 'region', 'aria-label': 'Inspecteur d’unité' });
  const pickBar = panel('raven-pick', { id: 'b-pick', hidden: true });
  const endHost = h('div', { class: 'end-host', id: 'b-end', hidden: true });
  // Bandeau de départ : la bataille attend que le joueur l'engage (première bataille, reprise après rechargement).
  const introBox = ctx.intro
    ? panel('battle-intro', { id: 'b-intro', role: 'status' },
      h('p', { class: 'bi-text', text: ctx.intro }),
      h('p', { class: 'bi-keys', text: touchUi() ? 'Touchez « Engager le combat » quand vous êtes prêt.' : 'Espace, ou le bouton ci-dessous, pour engager le combat.' }),
      btn('Engager le combat', { id: 'b-go', kind: 'primary', ico: 'play', onClick: () => actions.setSpeed(-1) }))
    : null;

  add(s, topbar, flights, pickBar, introBox, logPanel, insp, endHost);
  root.append(s);
  requestAnimationFrame(() => s.classList.add('is-in'));

  // ------------------------------------------------------------------ barre du haut
  function drawTop() {
    const b = B(); if (!b) return;
    tickNum.textContent = String(b.tick);
    tickBar.style.width = `${Math.min(100, (100 * b.tick) / (b.maxTicks || MAX_TICKS))}%`;
    const sp = actions.getSpeed();
    for (const [v, el] of Object.entries(speedBtns)) { const on = Number(v) === sp; el.classList.toggle('is-on', on); el.setAttribute('aria-checked', String(on)); }
    s.classList.toggle('is-paused', sp === 0);
    // bandeau de départ : disparaît dès que la bataille est engagée (une fois pour toutes)
    if (st.intro && (sp !== 0 || st.ended)) st.intro = false;
    if (introBox) introBox.hidden = !st.intro || !!st.modal || st.picking;
    speedBtns[0].classList.toggle('is-pulse', st.intro);
    speedBtns[0].title = sp === 0 ? 'En pause : cliquez pour reprendre (Espace)' : 'Pause (Espace)';
    // Balance : part de son armée de départ que chaque camp garde (coût × PV restants). C'est la règle du temps limite :
    // au dernier instant, la plus grande part l'emporte ; à égalité, les Gobelins.
    let vp = 0, ve = 0;
    try { vp = hdeps.sim?.battleValue?.(b, 'player') ?? 0; ve = hdeps.sim?.battleValue?.(b, 'enemy') ?? 0; } catch { /* */ }
    const v0p = b.startValue?.player, v0e = b.startValue?.enemy;
    const shares = v0p > 0 && v0e > 0;
    const kp = shares ? vp / v0p : vp, ke = shares ? ve / v0e : ve;
    const tot = kp + ke || 1;
    balRoy.style.width = `${(100 * kp) / tot}%`; balGob.style.width = `${(100 * ke) / tot}%`;
    balance.title = shares
      ? `Armée encore debout : Royaume ${Math.round(100 * kp)}${NB}% · Gobelins ${Math.round(100 * ke)}${NB}%. Au temps limite, la plus grande part l’emporte (à égalité : les Gobelins).`
      : `Royaume ${Math.round(vp)} · Gobelins ${Math.round(ve)} (valeur des troupes restantes)`;
    st.timeWarn = timeWarning(b);
    balance.classList.toggle('is-warn', !!st.timeWarn);
    const left = b.ravensLeft?.player ?? 0;
    const cmd = b.units.find(u => u.side === 'player' && u.cls === 'commander');
    const cmdAlive = !!cmd?.alive;
    clear(ravenIcons);
    for (let i = 0; i < Math.max(left, run?.ravens ?? left); i++) ravenIcons.append(icon('raven', `ico ${i < left ? 'on' : 'off'}`));
    ravenIcons.setAttribute('aria-label', `${left} corbeau${left > 1 ? 'x' : ''} disponible${left > 1 ? 's' : ''}`);
    ravenCount.textContent = String(left);
    bRaven.setAttribute('aria-label', `Envoyer un corbeau (${left} restant${left > 1 ? 's' : ''})`);
    bRaven.disabled = st.ended || !cmdAlive || left <= 0;
    bRaven.title = !cmdAlive ? 'Votre commandant est tombé : plus de corbeaux.' : left <= 0 ? 'Plus de corbeaux.' : 'Envoyer un nouveau programme à une unité';
    bSkip.disabled = st.ended;
  }

  /**
   * « Au temps, l'ennemi l'emporte » : le joueur n'a plus que son commandant, ou il reste ≤ 20 instants et le temps
   * limite irait à l'ennemi (sim.timeoutWinner : part de l'armée conservée). Aucune nouvelle règle de défaite.
   */
  function timeWarning(b) {
    if (!b || b.result || st.ended) return null;
    const mine = b.units.filter(u => u.side === 'player' && u.alive);
    const alone = mine.length > 0 && mine.every(u => u.cls === 'commander');
    const late = b.tick >= (b.maxTicks || MAX_TICKS) - 20;
    if (!alone && !late) return null;
    let w = null;
    try { w = hdeps.sim?.timeoutWinner ? hdeps.sim.timeoutWinner(b) : ((hdeps.sim?.battleValue?.(b, 'player') ?? 0) <= (hdeps.sim?.battleValue?.(b, 'enemy') ?? 0) ? 'enemy' : 'player'); } catch { w = null; }
    return w === 'enemy' ? { left: Math.max(0, (b.maxTicks || MAX_TICKS) - b.tick) } : null;
  }

  // ------------------------------------------------------------------ corbeaux en vol
  function drawFlights() {
    const b = B(); clear(flights);
    if (!b) return;
    if (st.timeWarn) {
      flights.append(h('div', { class: 'flight flash-bad time-warn', id: 'b-time-warn', title: 'Au dernier instant, le camp qui a gardé la plus grande part de son armée l’emporte ; à égalité, les Gobelins. Attaquez, ou envoyez un corbeau.' },
        icon('hourglass'), h('span', {}, h('b', { text: `Au temps, l’ennemi l’emporte` }), ` · ${st.timeWarn.left} instant${st.timeWarn.left > 1 ? 's' : ''}`)));
    }
    for (const r of b.ravens ?? []) {
      if (!r.alive || r.delivered) continue;
      const t = U(r.unitId);
      if (!t) continue;
      const tw = hexToWorld(t.q, t.r);
      const eta = Math.max(1, Math.ceil(worldDistHex({ x: r.x, z: r.z }, tw) / RAVEN_SPEED_HEX));
      const mine = r.side === 'player';
      flights.append(h('div', { class: `flight ${mine ? 'side-royaume' : 'side-gobelins'}`, id: `flight-${r.id}` },
        icon('raven'), h('span', {}, mine ? 'Corbeau → ' : 'Corbeau gobelin → ', nameSpan(t, 'b')),
        h('span', { class: 'eta num', text: `${eta} instant${eta > 1 ? 's' : ''}` })));
    }
    for (const f of st.flashes) flights.append(f.el);
  }
  function flash(text, kind) {
    const el = h('div', { class: `flight flash flash-${kind}` }, icon(kind === 'good' ? 'check' : 'raven'), h('span', { text }));
    const f = { el, until: performance.now() + 2600 };
    st.flashes.push(f);
    setTimeout(() => { st.flashes = st.flashes.filter(x => x !== f); el.classList.add('is-out'); setTimeout(() => { el.remove(); }, 400); }, 2600);
  }

  // ------------------------------------------------------------------ chronique
  // Les noms (chronique, corbeaux en vol) désignent leur figurine : survol = surbrillance et inspecteur ; clic ou toucher
  // = épingler l'unité (et y amener la caméra si elle est hors champ, ce qui suspend le suivi de l'action 4 s).
  const nameSpan = (u, tag = 'span') => h(tag, { class: `nm side-${u?.faction || SIDE_FACTION[u?.side] || 'royaume'}`, text: u?.name ?? '?', dataset: u?.id ? { uid: u.id } : null });
  const nameHover = (e) => {
    const el = e.target.closest?.('.nm[data-uid]');
    if (!el || touchUi() || st.picking) return;
    const id = e.type === 'pointerover' ? el.dataset.uid : null;
    if (st.hover === id) return;
    st.hover = id && U(id) ? id : null;
    drawInspector(); syncHighlights();
  };
  const nameClick = (e) => {
    const el = e.target.closest?.('.nm[data-uid]');
    if (!el) return;
    const u = U(el.dataset.uid);
    if (!u) return;
    e.preventDefault(); e.stopPropagation();
    if (st.picking) { clickUnit(u.id); return; }
    sfx('ui');
    st.pinned = u.id; st.hover = null;
    let p = null;
    try { p = view?.projectUnit?.(u.id) ?? view?.projectHex?.(u.q, u.r); } catch { p = null; }
    if (u.alive && p && p.visible === false) { try { view.focusHex?.(u.q, u.r); } catch { /* */ } }
    drawInspector(); syncHighlights();
  };
  const artSpan = (u, capFirst = false) => {
    const full = withArticle(u?.name ?? '?', capFirst);
    const art = full.slice(0, full.length - (u?.name ?? '?').length);
    return [art, nameSpan(u)];
  };
  function pushLog(tick, side, parts, cls = '') {
    st.log.push({ id: ++st.logSeq, tick, side, parts, cls, el: null });
    if (st.log.length > 8) st.log.splice(0, st.log.length - 8);
  }
  // Les lignes déjà affichées sont conservées telles quelles (leur animation d'entrée ne rejoue pas) :
  // seules les nouvelles entrées sont ajoutées et les plus anciennes retirées.
  const emptyTick = h('span', { class: 'lt num' });
  // (une bataille reprise après un rechargement commence sans chronique : « La bataille reprend. »)
  const emptyLine = h('li', { class: 'log-line is-empty' }, emptyTick, h('span', { class: 'lx', text: (B()?.tick ?? 0) > 0 ? 'La bataille reprend.' : 'Les deux armées se font face.' }));
  function drawLog() {
    const keep = new Set(st.log.map(l => l.el).filter(Boolean));
    if (!st.log.length) keep.add(emptyLine);
    for (const li of [...logList.children]) if (!keep.has(li)) li.remove();
    for (const l of st.log) {
      if (l.el) continue;
      l.el = h('li', { class: `log-line side-${l.side} ${l.cls}`.trim() }, h('span', { class: 'lt num', text: String(l.tick) }), h('span', { class: 'lx' }, l.parts));
      logList.append(l.el);
    }
    if (!st.log.length) {
      emptyTick.textContent = String(B()?.tick ?? 0);
      if (!emptyLine.isConnected) logList.append(emptyLine);
    }
  }
  function logEvents(report, b) {
    const tick = report.tick ?? b.tick;
    for (const ev of report.events ?? []) {
      const a = ev.unitId ? U(ev.unitId) : null;
      const side = a ? (a.faction || SIDE_FACTION[a.side]) : 'neutral';
      switch (ev.type) {
        case 'attack': {
          const t = U(ev.targetId); if (!a || !t) break;
          const v = ev.kind === 'arrow' ? 'arrow' : ev.kind === 'bolt' ? 'bolt' : ((ev.bonuses ?? []).includes('charge') ? 'charge' : 'melee');
          pushLog(tick, side, [...artSpan(a, true), ` ${conj(a.name, v)} `, ...artSpan(t), h('span', { class: 'dmg num', text: ` (−${ev.dmg})` })]);
          break;
        }
        case 'spell': {
          if (!a) break;
          const t = U(ev.targetId);
          const self = ev.targetId === ev.unitId;
          const eff = (ev.effects ?? []).find(x => x.unitId === ev.targetId) ?? {};
          const who = artSpan(a, true);   // « Le Chaman », « Les Archers… », « Maître Évrard » (sujet avec son article)
          const self2 = isPlural(a.name) ? ' se soignent' : ' se soigne';
          const ward2 = isPlural(a.name) ? ' s’entourent d’une égide' : ' s’entoure d’une égide';
          if (ev.spell === 'FIREBALL') pushLog(tick, side, [...who, ` ${conj(a.name, 'cast')} une boule de feu sur `, ...artSpan(t), eff.dmg ? h('span', { class: 'dmg num', text: ` (−${eff.dmg})` }) : null], 'is-spell');
          else if (ev.spell === 'HEAL') pushLog(tick, side, self ? [...who, self2, eff.heal ? h('span', { class: 'heal num', text: ` (+${eff.heal})` }) : null] : [...who, ` ${conj(a.name, 'heal')} `, ...artSpan(t), eff.heal ? h('span', { class: 'heal num', text: ` (+${eff.heal})` }) : null], 'is-spell');
          else if (ev.spell === 'WARD') pushLog(tick, side, self ? [...who, ward2] : [...who, ` ${conj(a.name, 'ward')} `, ...artSpan(t), ' d’une égide'], 'is-spell');
          else if (ev.spell === 'HEX') pushLog(tick, side, [...who, ` ${conj(a.name, 'hex')} `, ...artSpan(t), h('span', { class: 'dmg num', text: ' (−2 atq)' })], 'is-spell');
          else pushLog(tick, side, [...who, ` ${conj(a.name, 'cast')} ${SPELLS[ev.spell]?.name ?? 'un sort'}`], 'is-spell');
          break;
        }
        case 'death': {
          const t = U(ev.unitId); if (!t) break;
          const pl = isPlural(t.name);
          const cmd = t.cls === 'commander';
          pushLog(tick, t.faction || SIDE_FACTION[t.side], [...artSpan(t, true), cmd ? (pl ? ' sont abattus !' : isFeminine(t.name) ? ' est abattue !' : ' est abattu !') : (pl ? ' sont anéantis.' : ' tombe.')], 'is-death');
          break;
        }
        case 'raven_launch': {
          const t = U(ev.unitId);
          if (ev.side === 'player') pushLog(tick, 'royaume', ['Un corbeau s’envole vers ', ...artSpan(t), '.'], 'is-raven');
          else pushLog(tick, 'gobelins', ['Un corbeau gobelin prend son envol.'], 'is-raven');
          break;
        }
        case 'raven_shot': {
          const r = (b.ravens ?? []).find(x => x.id === ev.ravenId);
          const by = U(ev.byId);
          if (r?.side === 'player') { pushLog(tick, 'gobelins', [...artSpan(by, true), ` ${conj(by?.name ?? '', 'shoot')} votre corbeau${NB}!`], 'is-raven is-bad'); flash(`Corbeau abattu${NB}!`, 'bad'); }
          else { pushLog(tick, 'royaume', [...artSpan(by, true), ` ${conj(by?.name ?? '', 'shoot')} un corbeau gobelin.`], 'is-raven'); flash('Corbeau gobelin abattu', 'good'); }
          break;
        }
        case 'raven_lost': {
          const r = (b.ravens ?? []).find(x => x.id === ev.ravenId);
          pushLog(tick, r?.side === 'enemy' ? 'gobelins' : 'royaume', [r?.side === 'enemy' ? 'Un corbeau gobelin' : 'Votre corbeau', ' ne trouve plus son destinataire.'], 'is-raven');
          if (r?.side !== 'enemy') flash('Corbeau perdu', 'bad');
          break;
        }
        case 'raven_deliver': {
          const r = (b.ravens ?? []).find(x => x.id === ev.ravenId);
          const t = U(ev.unitId);
          if (r?.side === 'enemy') pushLog(tick, 'gobelins', [...artSpan(t, true), ` ${conj(t?.name ?? '', 'receive')} de nouveaux ordres.`], 'is-raven');
          else { pushLog(tick, 'royaume', [...artSpan(t, true), ` ${conj(t?.name ?? '', 'receive')} vos nouveaux ordres.`], 'is-raven is-good'); flash(`Ordres livrés : ${t?.name ?? ''}`, 'good'); }
          break;
        }
        default: break;
      }
    }
  }

  // ------------------------------------------------------------------ inspecteur
  function intentText(b, u) {
    if (!u?.alive || b.result || !hdeps.sim?.previewIntent) return null;
    let pi = null;
    try { pi = hdeps.sim.previewIntent(b, u.id); } catch { return null; }
    if (!pi) return null;
    const it = pi.intent ?? {};
    const t = it.targetId ? U(it.targetId) : null;
    const rule = pi.ruleIndex >= 0 ? u.program?.rules?.[pi.ruleIndex] : null;
    let txt;
    switch (it.kind) {
      case 'attack': txt = t ? `attaquer ${withArticle(t.name)}` : 'attaquer'; break;
      case 'charge': txt = t ? `charger ${withArticle(t.name)}` : 'charger'; break;
      case 'cast': txt = `lancer ${SPELLS[it.spell]?.name ?? 'un sort'}${t ? ` sur ${t.id === u.id ? 'lui-même' : withArticle(t.name)}` : ''}`; break;
      case 'follow': txt = t ? `escorter ${withArticle(t.name)}` : 'escorter'; break;
      case 'move': txt = rule ? describeAction(rule.action, u.type) : 'se déplacer'; break;
      case 'hold': txt = 'tenir la position'; break;
      case 'retreat': txt = 'se replier'; break;
      case 'kite': txt = 'harceler à distance'; break;
      case 'idle': txt = 'rester sur place'; break;
      default: txt = rule ? describeAction(rule.action, u.type) : '…';
    }
    return { prefix: pi.ruleIndex === -1 ? 'Instinct' : `Règle ${roman(pi.ruleIndex)}`, txt, targetId: it.targetId ?? null, dest: it.dest ?? null };
  }
  function statusChips(u) {
    const out = [];
    const S = u.status ?? {};
    if (S.holding) out.push(['Tient la position', '+1 défense jusqu’au prochain instant', 'good']);
    if (S.charging) out.push(['Charge', '−1 défense jusqu’au prochain instant', 'warn']);
    if (S.ward > 0) out.push([`Égide +${S.wardAmt || 2}`, `${S.ward} instant${S.ward > 1 ? 's' : ''}`, 'good']);
    if (S.hex > 0) out.push([`Maléfice −${S.hexAmt || 2} atq`, `${S.hex} instant${S.hex > 1 ? 's' : ''}`, 'bad']);
    if (u.hitLastTick) out.push(['Frappé', 'A subi des dégâts au dernier instant', 'bad']);
    return out.map(([t, help, k]) => h('span', { class: `chip chip-${k}`, title: help, text: t }));
  }
  // L'inspecteur est rafraîchi à chaque instant. Sa coquille (en-tête, bouton Fermer, programme, bouton corbeau)
  // est construite une seule fois par unité inspectée : si on la reconstruisait à chaque instant, un clic dont
  // l'appui et le relâchement encadrent un rafraîchissement serait perdu. Seul le corps (PV, statuts, règle
  // active, intention) est reconstruit, et seulement quand son contenu change.
  const ins = { id: null, body: null, prog: null, raven: null, bodyKey: '' };
  function buildInspectorShell(u) {
    clear(insp);
    const mine = u.side === 'player';
    const fac = u.faction || SIDE_FACTION[u.side];
    const close = btn('', { id: 'insp-close', kind: 'ghost', ico: 'close', title: 'Fermer', cls: 'btn-icon', onClick: () => { st.pinned = null; st.hover = null; drawInspector(); syncHighlights(); } });
    ins.body = h('div', { class: 'insp-body' });
    insp.append(
      h('header', { class: 'insp-head' },
        portrait(u.type, { size: 'md' }),
        h('div', { class: 'insp-id' },
          h('div', { class: `eyebrow side-${fac}`, text: `${mine ? 'Royaume' : 'Gobelins'} · ${u.name !== UNITS[u.type]?.name ? UNITS[u.type]?.name : (CLASSES[u.cls]?.name ?? '')}` }),
          h('h3', { class: 'insp-name', text: u.name })),
        close),
      ins.body);
    ins.prog = null; ins.raven = null;
    if (mine) {
      ins.prog = h('div', { class: 'insp-prog' });
      ins.raven = btn('Envoyer un corbeau à cette unité', { id: 'insp-raven', kind: 'secondary', size: 'sm', ico: 'raven', onClick: () => { if (ins.id) openRavenModal(ins.id); } });
      insp.append(h('div', { class: 'lbl', text: 'Programme' }), ins.prog, ins.raven);
    } else {
      insp.append(h('p', { class: 'sealed' }, h('span', { class: 'seal-glyph', 'aria-hidden': 'true', text: 'ᛒ' }), 'Grimoire scellé : vous le lirez après la victoire.'));
    }
    ins.id = u.id; ins.bodyKey = '';
  }
  function drawInspector() {
    const b = B();
    const id = st.hover ?? st.pinned;
    const u = id ? U(id) : null;
    if (!u || !b) { insp.hidden = true; s.classList.remove('has-insp'); ins.id = null; return; }
    if (ins.id !== u.id) buildInspectorShell(u);
    const it = u.alive ? intentText(b, u) : null;
    const key = JSON.stringify([u.hp, u.maxHp, u.alive, u.atk, u.def, u.range, u.speed, u.kills, u.status, u.hitLastTick, u.lastRule, u.program, it]);
    if (key !== ins.bodyKey) {
      ins.bodyKey = key;
      const pct = Math.max(0, Math.min(100, (100 * u.hp) / (u.maxHp || 1)));
      clear(ins.body).append(
        h('div', { class: `hpbar${pct <= 34 ? ' is-low' : ''}${u.alive ? '' : ' is-dead'}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(u.maxHp), 'aria-valuenow': String(u.hp), 'aria-label': 'Points de vie' },
          h('i', { style: { width: `${pct}%` } }), h('span', { class: 'num', text: u.alive ? `${u.hp} / ${u.maxHp} PV` : 'Tombé au combat' })),
        h('div', { class: 'insp-stats num', text: `Atq ${u.atk} · Déf ${u.def} · Portée ${u.range} · Vit ${u.speed === 0.5 ? '½' : u.speed}${u.kills ? ` · ${u.kills} victime${u.kills > 1 ? 's' : ''}` : ''}` }));
      const chips = statusChips(u);
      const traits = (u.traits ?? []).map(t => h('span', { class: 'chip chip-trait', title: TRAITS[t]?.help ?? '', text: TRAITS[t]?.name ?? t }));
      if (chips.length || traits.length) ins.body.append(h('div', { class: 'insp-chips' }, chips, traits));
      if (u.alive) {
        const now = h('div', { class: 'insp-now' });
        const rules = u.program?.rules ?? [];
        const lr = u.lastRule;
        now.append(h('div', { class: 'lbl', text: 'Au dernier instant' }),
          h('p', { class: 'rule-now' }, lr == null ? 'En attente du premier instant.' : lr === -1 ? 'Instinct : aucune règle applicable.' : [h('b', { text: `Règle ${roman(lr)} · ` }), rules[lr] ? describeRule(rules[lr], u.type) : '?']));
        if (it) now.append(h('div', { class: 'lbl', text: 'Prochain instant' }), h('p', { class: 'intent' }, h('b', { text: `${it.prefix} · ` }), cap(it.txt)));
        ins.body.append(now);
      }
    }
    if (ins.prog) programView(ins.prog, u.program, u.type, { highlightRule: u.lastRule ?? null, compact: true });
    if (ins.raven) {
      const left = b.ravensLeft?.player ?? 0;
      const cmdAlive = !!b.units.find(x => x.side === 'player' && x.cls === 'commander' && x.alive);
      ins.raven.hidden = !u.alive;
      ins.raven.disabled = st.ended || !left || !cmdAlive;
    }
    insp.hidden = false;
    s.classList.add('has-insp');
    dockInspector(u, it);
  }
  /**
   * L'inspecteur reste un calque (il s'ouvre au survol : la caméra ne bouge pas pour lui). S'il cache l'unité
   * inspectée ou sa cible, il passe du côté opposé (à gauche, au-dessus de la chronique).
   */
  function dockInspector(u, it) {
    if (layoutMode() !== 'desktop' || !view?.projectHex) { insp.classList.remove('is-left'); return; }
    const W = window.innerWidth;
    const r = insp.getBoundingClientRect();
    // rectangle qu'occuperait l'inspecteur à droite (indépendant du côté actuel : pas d'oscillation)
    const zone = { l: W - 16 - r.width - 14, r: W, t: r.top - 14, b: r.bottom + 14 };
    const pts = [];
    const add2 = (x) => { if (x?.alive !== false && x) { try { pts.push(view.projectHex(x.q, x.r)); const p = view.projectUnit?.(x.id); if (p) pts.push(p); } catch { /* */ } } };
    add2(u);
    add2(it?.targetId ? U(it.targetId) : (u.lastTargetId ? U(u.lastTargetId) : null));
    const hit = pts.some(p => p && p.visible !== false && p.x >= zone.l && p.x <= zone.r && p.y >= zone.t && p.y <= zone.b);
    insp.classList.toggle('is-left', hit);
  }

  function syncHighlights() {
    const b = B(); if (!b) return;
    const hl = [];
    if (st.picking) {
      for (const u of b.units) if (u.alive && u.side === 'player') hl.push({ q: u.q, r: u.r, kind: 'deploy' });
    } else {
      const u = U(st.hover ?? st.pinned);
      if (u?.alive) {
        hl.push({ q: u.q, r: u.r, kind: 'select' });
        const it = intentText(b, u);
        const t = it?.targetId ? U(it.targetId) : (u.lastTargetId ? U(u.lastTargetId) : null);
        if (t?.alive) hl.push({ q: t.q, r: t.r, kind: 'target' });
        if (it?.dest && !(it.dest.q === u.q && it.dest.r === u.r)) hl.push({ q: it.dest.q, r: it.dest.r, kind: 'path' });
      }
    }
    try { view?.setHighlights?.(hl); view?.setSelected?.(st.pinned && U(st.pinned)?.alive ? st.pinned : null); } catch { /* */ }
  }

  // ------------------------------------------------------------------ corbeaux : choix du destinataire puis modale
  function startPick() {
    const b = B(); if (!b || st.ended) return;
    if (st.modal) return;
    st.picking = true;
    // l'inspecteur se ferme : sinon il recouvre la barre de choix (et, au téléphone, tout le plateau)
    st.pinned = null; st.hover = null; drawInspector();
    if (introBox) introBox.hidden = true;
    clear(pickBar).append(
      h('div', { class: 'pick-text' }, icon('raven'), h('span', {}, h('b', { text: `À qui envoyer le corbeau${NB}?` }),
        touchUi() ? ' Touchez l’unité destinataire :' : ' Cliquez une de vos unités sur le champ, ou ici :')),
      h('div', { class: 'pick-list' }, b.units.filter(u => u.alive && u.side === 'player').map(u => {
        const c = h('button', { type: 'button', class: 'pick-chip', id: `pick-${u.id}` }, portrait(u.type, { size: 'xs' }), h('span', { text: u.name }));
        c.addEventListener('click', () => { sfx('ui'); openRavenModal(u.id); });
        return c;
      })),
      btn('Annuler', { id: 'pick-cancel', kind: 'ghost', size: 'sm', onClick: () => endPick() }));
    pickBar.hidden = false;
    s.classList.add('is-picking');
    syncHighlights();
    pickBar.querySelector('.pick-chip')?.focus();
  }
  function endPick() { st.picking = false; pickBar.hidden = true; s.classList.remove('is-picking'); syncHighlights(); drawTop(); }

  /**
   * Tireurs anti-corbeaux ennemis à ≤ 2 hex de la trajectoire (segment commandant → destinataire, départ compris),
   * comme le moteur : chacun tire une seule fois par corbeau (30 %). Risque = 1 − 0,7^N (positions actuelles).
   */
  function interceptRisk(b, from, to) {
    const shooters = b.units.filter(u => u.alive && u.side === 'enemy' && (u.traits ?? []).includes('antiRaven'));
    const a = hexToWorld(from.q, from.r), c = hexToWorld(to.q, to.r);
    const dx = c.x - a.x, dz = c.z - a.z, L2 = dx * dx + dz * dz;
    let n = 0;
    for (const sh of shooters) {
      const w = hexToWorld(sh.q, sh.r);
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.z - a.z) * dz) / L2)) : 0;
      if (worldDistHex({ x: a.x + dx * t, z: a.z + dz * t }, w) <= RAVEN_INTERCEPT_RANGE + 1e-9) n++;
    }
    return { n, pct: Math.round(100 * (1 - Math.pow(1 - RAVEN_INTERCEPT_CHANCE, n))) };
  }

  function openRavenModal(unitId) {
    const b = B(); const u = U(unitId);
    if (!b || !u?.alive || st.ended) return;
    endPick();
    closeModal();
    actions.holdPause(true);
    const cmd = b.units.find(x => x.side === 'player' && x.cls === 'commander' && x.alive);
    const d = cmd ? worldDistHex(hexToWorld(cmd.q, cmd.r), hexToWorld(u.q, u.r)) : 0;
    const eta = Math.max(1, Math.ceil(d / RAVEN_SPEED_HEX));
    const risk = cmd ? interceptRisk(b, cmd, u) : { n: 0, pct: 0 };
    const bonus = Math.max(0, (u.slots ?? 0) - (UNITS[u.type]?.slots ?? 0));
    let program = cloneProgram(u.program);
    const err = h('p', { class: 'modal-err', 'aria-live': 'assertive', hidden: true });
    const host = h('div', { class: 'editor-host' });
    const layer = h('div', { class: 'modal-layer', id: 'raven-modal' });
    const m = panel('raven-modal sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'raven-title' });
    const send = btn('Envoyer le corbeau', { id: 'raven-send', kind: 'primary', ico: 'raven', sound: null, onClick: () => {
      const v = validateProgram(program, u.type, { unlocked: run?.unlocked ?? null, slotsBonus: bonus });
      if (!v.ok) { sfx('deny'); err.hidden = false; err.textContent = v.errors[0]; return; }
      const r = actions.sendRaven(u.id, program);
      if (r?.ok) { sfx('caw'); toast(`Le corbeau s’envole vers ${withArticle(u.name)}.`, 'info'); closeModal(); drawAll(); }
      else { sfx('deny'); err.hidden = false; err.textContent = r?.reason || 'Le corbeau ne peut pas partir.'; }
    } });
    const cancel = btn('Annuler', { id: 'raven-cancel', kind: 'ghost', onClick: () => closeModal() });
    m.append(
      h('header', { class: 'stage-head' }, portrait(u.type, { size: 'md' }),
        h('div', {}, h('div', { class: 'eyebrow', text: 'Corbeau messager' }), h('h2', { class: 'stage-title', id: 'raven-title', text: `Nouveaux ordres pour ${withArticle(u.name)}` })),
        btn('', { id: 'raven-close', kind: 'ghost', ico: 'close', title: 'Fermer', cls: 'btn-icon', onClick: () => closeModal() })),
      h('div', { class: 'raven-facts' },
        h('span', { class: 'fact' }, icon('hourglass'), `Vol estimé : ${eta} instant${eta > 1 ? 's' : ''}`),
        h('span', { class: `fact ${risk.n ? 'is-bad' : 'is-good'}`, title: risk.n ? 'Chaque archer gobelin à 2 hex de la trajectoire tire une fois sur le corbeau (30 %), d’après les positions actuelles.' : null }, icon('eye'),
          risk.n ? `${risk.n} tireur${risk.n > 1 ? 's' : ''} gobelin${risk.n > 1 ? 's' : ''} près de la trajectoire · risque ${risk.pct}${NB}%` : 'Trajectoire dégagée'),
        h('span', { class: 'fact' }, icon('raven'), `${b.ravensLeft?.player ?? 0} corbeau${(b.ravensLeft?.player ?? 0) > 1 ? 'x' : ''} restant${(b.ravensLeft?.player ?? 0) > 1 ? 's' : ''}`)),
      h('p', { class: 'raven-note', text: 'L’ancien programme reste actif pendant le vol. La bataille est en pause pendant que vous écrivez.' }),
      host, err,
      h('footer', { class: 'stage-foot' }, cancel, send));
    layer.append(m);
    layer.addEventListener('click', (e) => { if (e.target === layer) closeModal(); });
    s.append(layer);
    st.modal = layer;
    if (hdeps.editor?.mountEditor) {
      try {
        st.editor = hdeps.editor.mountEditor(host, {
          unitType: u.type, slotsBonus: bonus, program: cloneProgram(program), unlocked: run?.unlocked ?? null,
          onChange: (p) => { program = cloneProgram(p); err.hidden = true; runeChime(); }, title: null, compact: isPhone(),
          highlightRule: u.lastRule ?? null,
        });
      } catch (e) { console.error(e); host.append(h('p', { class: 'muted', text: 'L’éditeur de runes n’a pas pu s’ouvrir.' })); }
    } else host.append(h('p', { class: 'muted', text: 'Éditeur de runes indisponible.' }));
    requestAnimationFrame(() => layer.classList.add('is-in'));
    (m.querySelector('.editor-host button, .editor-host [tabindex]') || send).focus?.();
  }
  function closeModal() {
    if (!st.modal) return;
    st.editor?.destroy?.(); st.editor = null;
    st.modal.remove(); st.modal = null;
    actions.holdPause(false);
    drawTop();
  }

  // ------------------------------------------------------------------ événements de la vue
  function clickUnit(id) {
    if (!gate(`u:${id}`)) return;
    const u = U(id);
    if (!u) return;
    if (st.picking) {
      if (u.side === 'player' && u.alive) { sfx('ui'); openRavenModal(u.id); }
      else { sfx('deny'); toast('Choisissez une de vos unités vivantes.', 'bad', 1800); }
      return;
    }
    sfx('ui'); tip.hide();
    st.pinned = st.pinned === id && !isPhone() ? null : id;
    drawInspector(); syncHighlights();
  }
  const unitAt = (q, r) => B()?.units?.find(u => u.alive && u.q === q && u.r === r) ?? null;
  const on = (name, fn) => { try { const u = view?.on?.(name, fn); if (typeof u === 'function') unsub.push(u); } catch (e) { console.warn(e); } };
  on('unitclick', (e) => { if (e?.unitId) clickUnit(e.unitId); });
  on('hexclick', (e) => {
    if (e?.q == null) return;
    const u = (e.unitId && U(e.unitId)) || unitAt(e.q, e.r);
    if (u) { clickUnit(u.id); return; }
    if (!gate(`h:${e.q},${e.r}`)) return;
    if (!st.picking && st.pinned) { st.pinned = null; drawInspector(); syncHighlights(); }
    // au doigt, pas de survol : toucher un hexagone vide montre ses effets
    if (touchUi() && !st.picking) {
      const map = B()?.map; const T = map ? terrainInfo(map, e.q, e.r) : null;
      if (T) tip.show(e.q, e.r, T.name, T.help); else tip.hide();
    }
  });
  const setHover = (id) => {
    if (touchUi()) return;
    if (st.hover === id) return;
    st.hover = id; drawInspector(); syncHighlights();
  };
  on('unithover', (e) => setHover(e?.unitId ?? null));
  on('framing', (f) => drawFraming(f));
  for (const el of [logList, flights]) {
    el.addEventListener('pointerover', nameHover); el.addEventListener('pointerout', nameHover);
    el.addEventListener('click', nameClick);
  }
  on('hexhover', (e) => {
    if (touchUi()) return;
    if (e?.q == null) { tip.hide(); setHover(null); return; }
    const u = (e.unitId && U(e.unitId)) || unitAt(e.q, e.r);
    setHover(u ? u.id : null);
    if (!u) {
      const map = B()?.map; const T = map ? terrainInfo(map, e.q, e.r) : null;
      if (T) tip.show(e.q, e.r, T.name, T.help); else tip.hide();
    } else tip.hide();
  });

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (st.modal) closeModal();
    else if (st.picking) endPick();
    else if (st.pinned) { st.pinned = null; drawInspector(); syncHighlights(); }
  };
  window.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ fin
  function showEnd(result, b, onContinue) {
    st.ended = true;
    endPick(); closeModal();
    const won = result?.winner === 'player';
    const lostP = b.units.filter(u => u.side === 'player' && !u.alive).length;
    const killed = b.units.filter(u => u.side === 'enemy' && !u.alive).length;
    const cont = btn('Continuer', { id: 'b-continue', kind: 'primary', size: 'lg', onClick: () => onContinue?.() });
    clear(endHost).append(h('div', { class: `end-banner ${won ? 'is-won' : 'is-lost'}`, role: 'alertdialog', 'aria-labelledby': 'end-title' },
      h('div', { class: 'eb-glyph', 'aria-hidden': 'true', text: won ? 'ᛏ' : 'ᚾ' }),
      h('h2', { class: 'eb-title', id: 'end-title', text: won ? 'Victoire' : 'Défaite' }),
      h('p', { class: 'eb-reason', text: reasonText(result) }),
      h('p', { class: 'eb-stats num', text: `Instant ${result?.tick ?? b.tick} · ${killed} ennemi${killed > 1 ? 's' : ''} abattu${killed > 1 ? 's' : ''} · ${lostP ? `${lostP} perte${lostP > 1 ? 's' : ''}` : 'aucune perte'}` }),
      cont));
    endHost.hidden = false;
    s.classList.add('is-ended');
    requestAnimationFrame(() => endHost.classList.add('is-in'));
    drawTop();
    setTimeout(() => cont.focus(), 60);
  }

  function drawAll() { drawTop(); drawFlights(); drawLog(); drawInspector(); syncHighlights(); drawFraming(); }
  drawAll();
  // Cadrage : la barre du haut (et, au téléphone, la chronique en bas) ne doivent pas masquer le plateau.
  // Au bureau, la chronique compacte a une hauteur fixe et l'inspecteur est un calque : aucune marge ne
  // dépend de leur contenu (sinon la caméra se recadrerait à chaque ligne ajoutée ou à chaque survol).
  let lastInsets = '';
  const applyBoardFrame = () => {
    if (!s.isConnected) return;
    try {
      const tb = topbar.getBoundingClientRect();
      const lg = logPanel.getBoundingClientRect();
      const mode = layoutMode();
      const ins = { top: Math.round(tb.bottom + 6), right: 0, bottom: 24, left: 0 };
      if (mode === 'phone') ins.bottom = Math.round(window.innerHeight - lg.top);
      else if (mode === 'landscape') { ins.bottom = 8; ins.left = Math.round(lg.right + 6); }   // chronique en colonne à gauche
      const k = JSON.stringify(ins);
      if (k === lastInsets) return;
      const first = !lastInsets;
      lastInsets = k;
      view?.setInsets?.(ins);
      if (first) view?.resetCamera?.();
    } catch { /* */ }
  };
  const frameBoard = () => { applyBoardFrame(); requestAnimationFrame(applyBoardFrame); };
  frameBoard();
  window.addEventListener('resize', frameBoard);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => frameBoard()) : null;
  ro?.observe(topbar); ro?.observe(logPanel);

  const api = {
    el: s,
    onTick(report, b) {
      if (report) logEvents(report, b);
      // une unité inspectée qui meurt reste affichée (« Tombé au combat ») ; on lâche le survol
      if (st.hover && !U(st.hover)?.alive) st.hover = null;
      drawAll();
    },
    refresh: drawAll,
    showEnd,
    isModalOpen: () => !!st.modal,
    openRaven: (unitId) => (unitId ? openRavenModal(unitId) : startPick()),
    destroy() {
      for (const u of unsub) { try { u(); } catch { /* */ } }
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', frameBoard);
      ro?.disconnect();
      closeModal();
      tip.destroy();
      s.remove();
      if (activeBattleHud === api) activeBattleHud = null;
    },
  };
  activeBattleHud = api;
  return api;
}
