// js/core/data.js — catalogue partagé : c'est le CONTRAT entre tous les modules.
// Ne renommez aucun id. Ajouts autorisés uniquement s'ils sont rétro-compatibles.
// Module pur (aucune dépendance DOM), importable depuis Node pour les tests.

export const GAME_TITLE = 'Runes de Commandement';

// ---------------------------------------------------------------- Carte
export const MAP_W = 14;
export const MAP_H = 9;
export const DEPLOY_COLS = { player: [0, 1, 2], enemy: [11, 12, 13] };
export const MAX_TICKS = 80;
export const MAX_SUBSTEPS = 2;

// ---------------------------------------------------------------- Corbeaux
export const RAVEN_SPEED_HEX = 3;          // hex par tick
export const RAVEN_INTERCEPT_RANGE = 2;    // hex
export const RAVEN_INTERCEPT_CHANCE = 0.3; // par tireur antiRaven, une fois par corbeau
export const START_RAVENS = { player: 3, enemy: 2 };
export const MAX_RAVENS = 5;

// ---------------------------------------------------------------- Factions
export const FACTIONS = {
  royaume:  { id: 'royaume',  name: 'Le Royaume',   adjective: 'royal',   color: '#4a74c9', accent: '#d9b25a' },
  gobelins: { id: 'gobelins', name: 'Les Gobelins', adjective: 'gobelin', color: '#b5482e', accent: '#b9c46a' },
};

// ---------------------------------------------------------------- Terrains
// cost : coût d'entrée ; cavalryCost : coût pour la classe cavalry si différent.
// def : bonus de défense de l'unité qui s'y trouve (peut être négatif).
// rangedDef : bonus de défense supplémentaire contre les attaques à distance (arrow/bolt/sort offensif).
// rangeBonus : portée +N pour ranged/caster qui s'y trouvent. meleeAtkBonus : +N atq en mêlée contre une cible hors colline.
export const TERRAIN = {
  plain:  { id: 'plain',  name: 'Plaine',  passable: true,  cost: 1, def: 0,  help: 'Terrain découvert.' },
  forest: { id: 'forest', name: 'Forêt',   passable: true,  cost: 2, cavalryCost: 3, def: 1, rangedDef: 1, help: '+1 défense, et encore +1 contre les tirs. Lente à traverser, surtout à cheval.' },
  hill:   { id: 'hill',   name: 'Colline', passable: true,  cost: 2, def: 0,  rangeBonus: 1, meleeAtkBonus: 1, help: 'Tireurs : +1 portée. Mêlée : +1 attaque contre qui est en contrebas.' },
  ford:   { id: 'ford',   name: 'Gué',     passable: true,  cost: 2, def: -1, help: 'Seul passage à travers la rivière. −1 défense dans l’eau.' },
  ruins:  { id: 'ruins',  name: 'Ruines',  passable: true,  cost: 1, def: 2,  help: '+2 défense derrière les vieux murs.' },
  water:  { id: 'water',  name: 'Rivière', passable: false, cost: 99, def: 0, help: 'Infranchissable. Les corbeaux la survolent.' },
  rocks:  { id: 'rocks',  name: 'Rochers', passable: false, cost: 99, def: 0, help: 'Infranchissable.' },
};
// Terrains sur lesquels une unité peut se tenir (pour ON_TERRAIN et PLACES).
export const STANDABLE_TERRAINS = ['plain', 'forest', 'hill', 'ford', 'ruins'];
// Nombre de variantes de modèle 3D par terrain : clé d'asset = `tile_${terrain}_${variant}`.
export const TILE_VARIANTS = { plain: 3, forest: 2, hill: 1, ford: 1, ruins: 1, water: 1, rocks: 1 };

// ---------------------------------------------------------------- Classes
export const CLASSES = {
  infantry:  { id: 'infantry',  name: 'Infanterie', plural: 'fantassins' },
  cavalry:   { id: 'cavalry',   name: 'Cavalerie',  plural: 'cavaliers' },
  ranged:    { id: 'ranged',    name: 'Tireurs',    plural: 'tireurs' },
  caster:    { id: 'caster',    name: 'Lanceur de sorts', plural: 'lanceurs de sorts' },
  colossus:  { id: 'colossus',  name: 'Colosse',    plural: 'colosses' },
  commander: { id: 'commander', name: 'Commandant', plural: 'commandants' },
};

// ---------------------------------------------------------------- Traits
export const TRAITS = {
  antiCavalry:  { name: 'Hérisson',      help: '+3 dégâts contre la cavalerie.' },
  charge:       { name: 'Charge',        help: '+2 dégâts s’il s’est déplacé pendant cet instant.' },
  antiRaven:    { name: 'Œil de faucon', help: 'Peut abattre les corbeaux ennemis qui passent à 2 hex (30 %, une fois par corbeau).' },
  horde:        { name: 'Horde',         help: '+1 attaque si au moins 2 alliés lui sont adjacents.' },
  regen:        { name: 'Régénération',  help: 'Récupère 1 PV à la fin de chaque instant.' },
  aura_inspire: { name: 'Inspiration',   help: 'Les alliés à 2 hex ou moins ont +1 défense.' },
  aura_rage:    { name: 'Rage',          help: 'Les alliés à 2 hex ou moins ont +1 attaque.' },
  heavy:        { name: 'Inébranlable',  help: 'Ignore les bonus de charge et d’anti-cavalerie dirigés contre lui.' },
};

// ---------------------------------------------------------------- Sorts
// targetKind 'enemy' => cible choisie dans TARGETS ; 'ally' => cible choisie dans ALLY_TARGETS.
export const SPELLS = {
  FIREBALL: { id: 'FIREBALL', name: 'Boule de feu', targetKind: 'enemy', range: 3, cooldown: 3, dmg: 3, splash: 1,
              help: '3 dégâts à la cible (ignore la défense), 1 dégât à TOUTES les unités adjacentes, alliés compris.' },
  WARD:     { id: 'WARD',     name: 'Égide',        targetKind: 'ally',  range: 2, cooldown: 4, amount: 2, duration: 3,
              help: '+2 défense à un allié pendant 3 instants.' },
  HEAL:     { id: 'HEAL',     name: 'Soin',         targetKind: 'ally',  range: 3, cooldown: 2, amount: 3,
              help: 'Rend 3 PV à un allié blessé.' },
  HEX:      { id: 'HEX',      name: 'Maléfice',     targetKind: 'enemy', range: 3, cooldown: 4, amount: 2, duration: 3,
              help: '−2 attaque à un ennemi pendant 3 instants.' },
};

// ---------------------------------------------------------------- Unités
// speed : points de mouvement gagnés par instant (0.5 = un hex de plaine tous les 2 instants).
// range : portée d'attaque de base en hex (1 = mêlée). cost : valeur (recrutement, score au temps limite).
// model : clé d'asset 3D (assets/models/<model>.glb) ; portrait : assets/portraits/<model>.webp
export const UNITS = {
  // --- Royaume (joueur)
  k_commander: { id: 'k_commander', faction: 'royaume', cls: 'commander', name: 'Commandant', hp: 10, atk: 2, def: 1, range: 1, speed: 1,   slots: 3, cost: 100, traits: ['aura_inspire'], spells: [], recruitable: false,
                 desc: 'Porte l’étendard. Les corbeaux partent de lui. S’il tombe, la bataille est perdue.' },
  k_pikemen:   { id: 'k_pikemen',   faction: 'royaume', cls: 'infantry',  name: 'Piquiers',   hp: 12, atk: 3, def: 1, range: 1, speed: 1,   slots: 3, cost: 40,  traits: ['antiCavalry'], spells: [], recruitable: true,
                 desc: 'Un mur de piques. Redoutables contre la cavalerie.' },
  k_knights:   { id: 'k_knights',   faction: 'royaume', cls: 'cavalry',   name: 'Chevaliers', hp: 10, atk: 4, def: 1, range: 1, speed: 2,   slots: 4, cost: 60,  traits: ['charge'], spells: [], recruitable: true,
                 desc: 'Rapides et brutaux en charge, fragiles s’ils s’enlisent.' },
  k_archers:   { id: 'k_archers',   faction: 'royaume', cls: 'ranged',    name: 'Archers',    hp: 7,  atk: 3, def: 0, range: 3, speed: 1,   slots: 4, cost: 45,  traits: ['antiRaven'], spells: [], recruitable: true,
                 desc: 'Tirent à 3 hex, mais pas s’ils ont bougé. Abattent les corbeaux.' },
  k_mage:      { id: 'k_mage',      faction: 'royaume', cls: 'caster',    name: 'Mage',       hp: 6,  atk: 2, def: 0, range: 2, speed: 1,   slots: 6, cost: 70,  traits: [], spells: ['FIREBALL', 'WARD'], recruitable: true,
                 desc: 'Le plus grand grimoire de l’armée. Boule de feu et Égide.' },
  k_golem:     { id: 'k_golem',     faction: 'royaume', cls: 'colossus',  name: 'Golem',      hp: 22, atk: 5, def: 2, range: 1, speed: 0.5, slots: 2, cost: 80,  traits: ['heavy'], spells: [], recruitable: true,
                 desc: 'Énorme, lent, et ne comprend que deux runes.' },
  // --- Gobelins (IA)
  g_warchief:  { id: 'g_warchief',  faction: 'gobelins', cls: 'commander', name: 'Chef de guerre',        hp: 12, atk: 3, def: 1, range: 1, speed: 1,   slots: 3, cost: 100, traits: ['aura_rage'], spells: [], recruitable: false,
                 desc: 'Hurle ses ordres et envoie ses corbeaux. Abattez-le et la horde se disperse.' },
  g_spears:    { id: 'g_spears',    faction: 'gobelins', cls: 'infantry',  name: 'Lanciers gobelins',     hp: 8,  atk: 2, def: 0, range: 1, speed: 1,   slots: 2, cost: 25,  traits: ['horde'], spells: [], recruitable: false,
                 desc: 'Nombreux, simples, plus dangereux en groupe.' },
  g_wolves:    { id: 'g_wolves',    faction: 'gobelins', cls: 'cavalry',   name: 'Chevaucheurs de loups', hp: 8,  atk: 3, def: 0, range: 1, speed: 2,   slots: 3, cost: 45,  traits: ['charge'], spells: [], recruitable: false,
                 desc: 'Rapides, chassent les isolés.' },
  g_archers:   { id: 'g_archers',   faction: 'gobelins', cls: 'ranged',    name: 'Archers gobelins',      hp: 5,  atk: 2, def: 0, range: 3, speed: 1,   slots: 3, cost: 35,  traits: ['antiRaven'], spells: [], recruitable: false,
                 desc: 'Tirent à 3 hex et guettent vos corbeaux.' },
  g_shaman:    { id: 'g_shaman',    faction: 'gobelins', cls: 'caster',    name: 'Chaman',                hp: 5,  atk: 1, def: 0, range: 2, speed: 1,   slots: 4, cost: 50,  traits: [], spells: ['HEAL', 'HEX'], recruitable: false,
                 desc: 'Soigne la horde et maudit vos meilleurs combattants.' },
  g_troll:     { id: 'g_troll',     faction: 'gobelins', cls: 'colossus',  name: 'Troll',                 hp: 24, atk: 5, def: 1, range: 1, speed: 0.5, slots: 1, cost: 90,  traits: ['regen', 'heavy'], spells: [], recruitable: false,
                 desc: 'Une seule rune tient dans sa tête. Il se régénère.' },
};
for (const u of Object.values(UNITS)) { u.model = u.id; u.portrait = `portraits/${u.id}.webp`; }

export const START_ROSTER = ['k_commander', 'k_pikemen', 'k_knights', 'k_archers', 'k_mage', 'k_golem'];

// ---------------------------------------------------------------- Sélecteurs de cible
// Cibles ennemies. En cas d'égalité : le plus proche, puis l'id le plus petit.
export const TARGETS = {
  NEAREST:   { id: 'NEAREST',   name: 'le plus proche' },
  WEAKEST:   { id: 'WEAKEST',   name: 'le plus faible',      help: 'Le moins de PV restants.' },
  STRONGEST: { id: 'STRONGEST', name: 'le plus redoutable',  help: 'La plus forte attaque × PV restants.' },
  COMMANDER: { id: 'COMMANDER', name: 'le commandant' },
  RANGED:    { id: 'RANGED',    name: 'un tireur',           cls: ['ranged', 'caster'], help: 'Le plus proche des tireurs et lanceurs de sorts.' },
  CAVALRY:   { id: 'CAVALRY',   name: 'un cavalier',         cls: ['cavalry'] },
  COLOSSUS:  { id: 'COLOSSUS',  name: 'un colosse',          cls: ['colossus'] },
  THREAT:    { id: 'THREAT',    name: 'qui menace mon commandant', help: 'L’ennemi le plus proche de mon commandant.' },
  ISOLATED:  { id: 'ISOLATED',  name: 'un isolé',            help: 'Le plus proche des ennemis sans aucun allié adjacent.' },
};
// Cibles alliées (sorts de soutien, escorte).
export const ALLY_TARGETS = {
  SELF:           { id: 'SELF',           name: 'moi-même' },
  ALLY_WEAKEST:   { id: 'ALLY_WEAKEST',   name: 'l’allié le plus blessé', help: 'Plus petit ratio PV/PV max, hors unités intactes. Peut être soi-même.' },
  ALLY_COMMANDER: { id: 'ALLY_COMMANDER', name: 'mon commandant' },
  ALLY_NEAREST:   { id: 'ALLY_NEAREST',   name: 'l’allié le plus proche' },
  ALLY_COLOSSUS:  { id: 'ALLY_COLOSSUS',  name: 'notre colosse' },
};
// Lieux (destination de ADVANCE). Si l'unité y est déjà, ADVANCE n'est pas applicable.
export const PLACES = {
  ENEMY_CAMP:   { id: 'ENEMY_CAMP',   name: 'le camp ennemi',       help: 'Vers la zone de déploiement adverse.' },
  CENTER:       { id: 'CENTER',       name: 'le centre',            help: 'Autour des deux hex du milieu de la carte.' },
  HILL:         { id: 'HILL',         name: 'la colline la plus proche' },
  FOREST:       { id: 'FOREST',       name: 'la forêt la plus proche' },
  RUINS:        { id: 'RUINS',        name: 'les ruines les plus proches' },
  FORD:         { id: 'FORD',         name: 'le gué le plus proche' },
  MY_COMMANDER: { id: 'MY_COMMANDER', name: 'mon commandant',       help: 'Jusqu’à lui être adjacent.' },
  START:        { id: 'START',        name: 'ma position de départ' },
};
export const PCT_OPTIONS = [25, 50, 75];

// ---------------------------------------------------------------- Runes
// kind : 'cond' (perception), 'action', 'logic' (liaison).
// params : liste ordonnée { key, type:'int'|'enum', min, max, default, options, exclude? }
//   options pour enum : 'TARGETS' | 'ALLY_TARGETS' | 'PLACES' | 'TERRAINS' | 'CLASSES' | 'PCT' | 'ENEMY_SPELLS' | 'ALLY_SPELLS' | 'SPELLS'
//   'ENEMY_SPELLS'/'ALLY_SPELLS' = sorts de l'unité dont SPELLS[x].targetKind correspond. 'TERRAINS' = STANDABLE_TERRAINS.
//   exclude : valeurs de la liste interdites pour ce paramètre (ex. escorter « moi-même »).
//   maxByRange (int) : maximum plafonné à la portée de base de l'unité (program.paramBounds ; ex. KITE).
// text : gabarit d'affichage ; {key} est remplacé par la pastille du paramètre.
// classes : si présent, seules ces classes d'unité peuvent utiliser la rune.
// unlocked : débloquée dès le début de la campagne. price : prix au Marchand (runes verrouillées).
// glyph : glyphe runique (Elder Futhark) affiché sur le bloc.
export const RUNES = {
  // --- Perception
  ENEMY_WITHIN:        { id: 'ENEMY_WITHIN',        kind: 'cond', glyph: 'ᛖ', name: 'Ennemi proche',      text: 'un ennemi à ≤ {n} hex', unlocked: true,
                         params: [{ key: 'n', type: 'int', min: 1, max: 8, default: 3 }], help: 'Vrai si au moins un ennemi vivant est à n hex ou moins.' },
  ENEMY_IN_RANGE:      { id: 'ENEMY_IN_RANGE',      kind: 'cond', glyph: 'ᛉ', name: 'À portée',           text: 'un ennemi est à ma portée', unlocked: true,
                         params: [], help: 'Vrai si un ennemi est à portée d’attaque (bonus de colline compris).' },
  HP_BELOW:            { id: 'HP_BELOW',            kind: 'cond', glyph: 'ᚢ', name: 'Blessé',             text: 'mes PV < {pct} %', unlocked: true,
                         params: [{ key: 'pct', type: 'enum', options: 'PCT', default: 50 }], help: 'Vrai si mes PV sont sous ce seuil.' },
  ALLY_HIT:            { id: 'ALLY_HIT',            kind: 'cond', glyph: 'ᚺ', name: 'Allié frappé',       text: 'un allié à ≤ {n} hex a été frappé', unlocked: true,
                         params: [{ key: 'n', type: 'int', min: 1, max: 6, default: 2 }], help: 'Vrai si un allié proche a subi des dégâts à l’instant précédent.' },
  ON_TERRAIN:          { id: 'ON_TERRAIN',          kind: 'cond', glyph: 'ᛟ', name: 'Terrain',            text: 'je suis sur {terrain}', unlocked: true,
                         params: [{ key: 'terrain', type: 'enum', options: 'TERRAINS', default: 'hill' }], help: 'Vrai si je me tiens sur ce terrain.' },
  CAN_CAST:            { id: 'CAN_CAST',            kind: 'cond', glyph: 'ᚲ', name: 'Sort prêt',          text: '{spell} est prêt', unlocked: true, classes: ['caster'],
                         params: [{ key: 'spell', type: 'enum', options: 'SPELLS', default: null }], help: 'Vrai si ce sort n’est pas en recharge.' },
  TICK_AT_LEAST:       { id: 'TICK_AT_LEAST',       kind: 'cond', glyph: 'ᛃ', name: 'Patience',           text: 'depuis ≥ {t} instants', unlocked: false, price: 40,
                         params: [{ key: 't', type: 'int', min: 1, max: 60, default: 8 }], help: 'Vrai à partir de cet instant de la bataille. Pour attendre, puis frapper.' },
  ENEMY_CLASS_WITHIN:  { id: 'ENEMY_CLASS_WITHIN',  kind: 'cond', glyph: 'ᛈ', name: 'Repérage',           text: 'des {cls} ennemis à ≤ {n} hex', unlocked: false, price: 50,
                         params: [{ key: 'cls', type: 'enum', options: 'CLASSES', default: 'cavalry' }, { key: 'n', type: 'int', min: 1, max: 8, default: 3 }], help: 'Vrai si une unité ennemie de cette classe est à n hex ou moins.' },
  ISOLATED_ENEMY_WITHIN: { id: 'ISOLATED_ENEMY_WITHIN', kind: 'cond', glyph: 'ᛁ', name: 'Proie isolée',     text: 'un ennemi isolé à ≤ {n} hex', unlocked: false, price: 50,
                         params: [{ key: 'n', type: 'int', min: 1, max: 8, default: 4 }], help: 'Vrai si un ennemi sans aucun allié adjacent est à n hex ou moins.' },
  OUTNUMBERED:         { id: 'OUTNUMBERED',         kind: 'cond', glyph: 'ᚾ', name: 'Débordé',            text: 'plus d’ennemis que d’alliés à ≤ {n} hex', unlocked: false, price: 50,
                         params: [{ key: 'n', type: 'int', min: 1, max: 6, default: 2 }], help: 'Vrai si les ennemis sont plus nombreux que mes alliés (moi compris) dans ce rayon.' },
  COMMANDER_THREATENED: { id: 'COMMANDER_THREATENED', kind: 'cond', glyph: 'ᛠ', name: 'Chef menacé',      text: 'un ennemi à ≤ {n} hex de mon commandant', unlocked: false, price: 60,
                         params: [{ key: 'n', type: 'int', min: 1, max: 6, default: 2 }], help: 'Vrai si un ennemi s’approche de mon commandant.' },
  ALLY_HP_BELOW:       { id: 'ALLY_HP_BELOW',       kind: 'cond', glyph: 'ᛒ', name: 'Allié blessé',       text: 'un allié à ≤ {n} hex a PV < {pct} %', unlocked: false, price: 50,
                         params: [{ key: 'pct', type: 'enum', options: 'PCT', default: 50 }, { key: 'n', type: 'int', min: 1, max: 6, default: 3 }], help: 'Vrai si un allié proche (pas moi) est sous ce seuil.' },
  // --- Liaison
  AND:                 { id: 'AND', kind: 'logic', glyph: 'ᚷ', name: 'ET',  text: 'ET',  unlocked: true,  params: [], help: 'Toutes les conditions de la règle doivent être vraies. Coûte 1 par règle.' },
  OR:                  { id: 'OR',  kind: 'logic', glyph: 'ᛜ', name: 'OU',  text: 'OU',  unlocked: false, price: 40, params: [], help: 'Au moins une condition de la règle doit être vraie. Coûte 1 par règle.' },
  NOT:                 { id: 'NOT', kind: 'logic', glyph: 'ᛣ', name: 'NON', text: 'NON', unlocked: false, price: 60, params: [], help: 'Inverse une condition. Coûte 1 par condition niée.' },
  // --- Actions
  ATTACK:              { id: 'ATTACK',  kind: 'action', glyph: 'ᛏ', name: 'Attaquer',  text: 'attaquer {target}', unlocked: true,
                         params: [{ key: 'target', type: 'enum', options: 'TARGETS', default: 'NEAREST' }], help: 'Se rapproche de la cible puis la frappe dès qu’elle est à portée. Les tireurs choisissent d’abord parmi les ennemis à portée qui correspondent. Non applicable si aucune cible ne correspond.' },
  ADVANCE:             { id: 'ADVANCE', kind: 'action', glyph: 'ᚱ', name: 'Avancer',   text: 'avancer vers {place}', unlocked: true,
                         params: [{ key: 'place', type: 'enum', options: 'PLACES', default: 'ENEMY_CAMP' }], help: 'Marche vers ce lieu sans chercher le combat. Non applicable si on y est déjà.' },
  HOLD:                { id: 'HOLD',    kind: 'action', glyph: 'ᛇ', name: 'Tenir',     text: 'tenir la position', unlocked: true,
                         params: [], help: 'Reste sur place, +1 défense. Frappe un ennemi à portée.' },
  RETREAT:             { id: 'RETREAT', kind: 'action', glyph: 'ᚦ', name: 'Se replier', text: 'se replier', unlocked: true,
                         params: [], help: 'S’éloigne de l’ennemi le plus proche, vers son propre camp. Peut quitter un contact.' },
  FOLLOW:              { id: 'FOLLOW',  kind: 'action', glyph: 'ᛗ', name: 'Escorter',  text: 'escorter {ally}', unlocked: false, price: 50,
                         params: [{ key: 'ally', type: 'enum', options: 'ALLY_TARGETS', default: 'ALLY_COMMANDER', exclude: ['SELF'] }],
                         help: 'Reste adjacent à cet allié et frappe les ennemis qui s’en approchent. « Le plus blessé » ne vaut que si un allié est blessé.' },
  KITE:                { id: 'KITE',    kind: 'action', glyph: 'ᚹ', name: 'Harceler',  text: 'harceler en gardant {n} hex', unlocked: false, price: 60, classes: ['ranged', 'caster'],
                         params: [{ key: 'n', type: 'int', min: 2, max: 4, default: 3, maxByRange: true }], help: 'Tire si possible ; sinon recule pour garder cette distance (au plus sa portée) avec l’ennemi le plus proche.' },
  CHARGE:              { id: 'CHARGE',  kind: 'action', glyph: 'ᛞ', name: 'Charger',   text: 'charger {target}', unlocked: false, price: 50, classes: ['cavalry', 'commander', 'colossus'],
                         params: [{ key: 'target', type: 'enum', options: 'TARGETS', default: 'NEAREST' }], help: 'Cavalerie : +1 mouvement cet instant (franchit une colline ou un gué d’un trait) et bonus de charge doublé (+4). Commandant et colosse : élan +1 attaque s’ils ont bougé. Toujours −1 défense jusqu’au prochain instant.' },
  CAST_ENEMY:          { id: 'CAST_ENEMY', kind: 'action', glyph: 'ᛊ', name: 'Sort offensif', text: 'lancer {spell} sur {target}', unlocked: true, classes: ['caster'],
                         params: [{ key: 'spell', type: 'enum', options: 'ENEMY_SPELLS', default: null }, { key: 'target', type: 'enum', options: 'TARGETS', default: 'NEAREST' }],
                         help: 'Lance ce sort si la cible est à portée et le sort prêt ; sinon se rapproche (sans lancer). Choisit d’abord parmi les ennemis à portée du sort qui correspondent. Non applicable si le sort est en recharge.' },
  CAST_ALLY:           { id: 'CAST_ALLY', kind: 'action', glyph: 'ᛚ', name: 'Sort de soutien', text: 'lancer {spell} sur {ally}', unlocked: true, classes: ['caster'],
                         params: [{ key: 'spell', type: 'enum', options: 'ALLY_SPELLS', default: null }, { key: 'ally', type: 'enum', options: 'ALLY_TARGETS', default: 'ALLY_WEAKEST' }],
                         help: 'Comme le sort offensif, sur un allié. Non applicable si aucun allié ne correspond (ex. personne n’est blessé pour Soin).' },
};
export const RUNE_KIND_INFO = {
  cond:   { name: 'Perception', color: 'var(--rune-perc)' },
  action: { name: 'Action',     color: 'var(--rune-act)' },
  logic:  { name: 'Liaison',    color: 'var(--rune-link)' },
};
export const STARTER_RUNES = Object.values(RUNES).filter(r => r.unlocked).map(r => r.id);

// ---------------------------------------------------------------- Programmes
// Program = { rules: Rule[] }
// Rule    = { conds: Cond[], logic: 'AND'|'OR', action: Action }   (conds vide => TOUJOURS)
// Cond    = { id, params: {}, not?: boolean }
// Action  = { id, params: {} }
const C = (id, params = {}, not = false) => (not ? { id, params, not: true } : { id, params });
const A = (id, params = {}) => ({ id, params });
const R = (conds, action, logic = 'AND') => ({ conds, logic, action });

// Programmes par défaut du joueur : n'utilisent que des runes de départ et tiennent dans les slots.
// Chevaliers : ils vont chercher les tireurs adverses et rompent le combat une fois gravement blessés.
// Mage : boule de feu dès qu'un ennemi approche, repli au contact, sinon il tient (il ne marche plus au front).
export const DEFAULT_PROGRAMS = {
  k_commander: { rules: [ R([C('ENEMY_WITHIN', { n: 2 })], A('RETREAT')), R([], A('HOLD')) ] },
  k_pikemen:   { rules: [ R([C('ENEMY_IN_RANGE')], A('ATTACK', { target: 'NEAREST' })), R([], A('ADVANCE', { place: 'CENTER' })) ] },
  k_knights:   { rules: [ R([C('HP_BELOW', { pct: 25 })], A('RETREAT')), R([], A('ATTACK', { target: 'RANGED' })), R([], A('ATTACK', { target: 'WEAKEST' })) ] },
  k_archers:   { rules: [ R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('ATTACK', { target: 'NEAREST' })) ] },
  k_mage:      { rules: [ R([C('ENEMY_WITHIN', { n: 4 })], A('CAST_ENEMY', { spell: 'FIREBALL', target: 'NEAREST' })),
                          R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')),
                          R([], A('HOLD')) ] },
  k_golem:     { rules: [ R([], A('ATTACK', { target: 'NEAREST' })) ] },
  g_warchief:  { rules: [ R([C('ENEMY_WITHIN', { n: 2 })], A('RETREAT')), R([], A('HOLD')) ] },
  g_spears:    { rules: [ R([], A('ATTACK', { target: 'NEAREST' })) ] },
  g_wolves:    { rules: [ R([C('ENEMY_WITHIN', { n: 5 })], A('ATTACK', { target: 'WEAKEST' })), R([], A('ADVANCE', { place: 'ENEMY_CAMP' })) ] },
  g_archers:   { rules: [ R([C('ENEMY_WITHIN', { n: 1 })], A('RETREAT')), R([], A('ATTACK', { target: 'NEAREST' })) ] },
  g_shaman:    { rules: [ R([C('CAN_CAST', { spell: 'HEAL' })], A('CAST_ALLY', { spell: 'HEAL', ally: 'ALLY_WEAKEST' })), R([], A('ADVANCE', { place: 'MY_COMMANDER' })) ] },
  g_troll:     { rules: [ R([], A('ATTACK', { target: 'NEAREST' })) ] },
};
export const ruleHelpers = { C, A, R };

// ---------------------------------------------------------------- Campagne
export const CAMPAIGN = {
  startGold: 60,
  rewardBattle: 50,
  rewardElite: 80,
  rewardPerKill: 5,
  stealFallbackGold: 25,
  ravenPrice: 60,
  maxSlotBonus: 2,
  maxAtkBonus: 1,
  columns: [['battle'], ['shop', 'camp', 'event'], ['battle', 'elite'], ['shop', 'camp'], ['boss']],
};

// ---------------------------------------------------------------- Assets 3D
// Toutes les clés que le moteur de rendu sait afficher. Fichier : assets/models/<key>.glb
// Le moteur DOIT avoir un repli procédural pour chaque clé (si le .glb manque ou échoue).
export const ASSET_KEYS = {
  tiles: Object.entries(TILE_VARIANTS).flatMap(([t, n]) => Array.from({ length: n }, (_, i) => `tile_${t}_${i}`)),
  units: Object.keys(UNITS),
  props: ['prop_raven', 'prop_arrow', 'deco_tree_0', 'deco_tree_1', 'deco_rock_0', 'prop_tent_royaume', 'prop_tent_gobelins'],
};
