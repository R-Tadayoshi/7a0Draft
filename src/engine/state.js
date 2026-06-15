/*
 * Game state model — Core Rules §103–180.
 * Pure data + small helpers. No UI, no rules flow (that lives in rules.js).
 *
 * Zones per player (§103, §107, §056.1):
 *   mainDeck, runeDeck, hand, trash, banishment, legendZone, championZone
 * Shared board (§107):
 *   bases[playerId]  — permanents & runes a player controls
 *   battlefields[]   — each a Location with a facedown sub-zone (§107.3)
 * Plus the Chain (§330) and per-turn bookkeeping.
 */

import { hasKeyword, keywordValue } from "./keywords.js";

/* Mulberry32 — small deterministic PRNG so a (seed, decks) pair replays
 * identically. Essential for debugging a bot's decisions. */
export function makeRng(seed = Date.now() >>> 0) {
  let a = seed >>> 0;
  const fn = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.seed = seed;
  fn.int = (n) => Math.floor(fn() * n);
  fn.shuffle = (arr) => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = fn.int(i + 1);
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  return fn;
}

let _uid = 1;
export const nextUid = () => "o" + _uid++;
export const resetUid = () => (_uid = 1);

/* A GameObject wraps a card definition with its live, mutable game state. */
export function makeObject(def, ownerId) {
  return {
    uid: nextUid(),
    def, // immutable card definition from the DB
    ownerId,
    controllerId: ownerId,
    // live status
    exhausted: false,
    damage: 0,
    location: null, // base:<pid> | bf:<index> | chain | facedown:<index>
    designation: null, // "attacker" | "defender" | null
    attached: [], // uids of gear attached to this top-most card
    attachedTo: null,
    counters: {},
    grantedKeywords: [], // [{kw,value,expiry}] added by effects
    tempMods: [], // [{stat:'might',delta,expiry}] temporary modifications (§110)
    facedown: false,
  };
}

/* Current Might of a unit: printed + permanent counters + temporary mods +
 * Assault (attacker) / Shield (defender). Damage does NOT reduce Might;
 * lethal is damage >= Might (§710, §460). */
export function currentMight(obj) {
  if (obj.def?.type !== "Unit") return null;
  let m = obj.def.might ?? 0;
  for (const mod of obj.tempMods) if (mod.stat === "might") m += mod.delta;
  m += (obj.counters.might || 0);
  if (obj.designation === "attacker" && hasKeyword(obj, "Assault"))
    m += keywordValue(obj, "Assault") || 1;
  if (obj.designation === "defender" && hasKeyword(obj, "Shield"))
    m += keywordValue(obj, "Shield") || 1;
  return Math.max(0, m);
}

export function isLethal(obj) {
  if (obj.def?.type !== "Unit") return false;
  const m = currentMight(obj);
  return obj.damage > 0 && obj.damage >= m;
}

/* Build the empty per-player container. */
function makePlayer(id, name, isBot) {
  return {
    id,
    name,
    isBot: !!isBot,
    points: 0,
    xp: 0,
    burnedOut: false,
    // non-board zones (arrays of GameObjects, except runePool which is counts)
    mainDeck: [],
    runeDeck: [],
    hand: [],
    trash: [],
    banishment: [],
    legend: null, // Champion Legend object
    champion: null, // Chosen Champion object (starts in champion zone)
    // resources: runes channeled to base produce Energy + Power (by domain)
    runePool: { energy: 0, power: {} }, // power keyed by domain, plus "A"=any
    cardsPlayedThisTurn: 0,
    domainIdentity: [], // from legend (§103.1.b)
  };
}

/* The whole game. mode currently targets 1v1 Duel (§480). */
export function makeGame({ players, mode = "duel1", seed } = {}) {
  const rng = makeRng(seed);
  return {
    mode,
    victoryScore: 8, // §480.3
    rng,
    turn: 0,
    turnPlayerId: null,
    phase: null, // awaken|beginning|channel|draw|main|ending
    step: null,
    // turn-state machine (§307–310)
    showdown: null, // {bfIndex, attackerId, defenderId, combat:bool}
    chain: [], // §330 — items resolve newest-first
    priorityId: null,
    focusId: null,
    players: players.map((p, i) => makePlayer(p.id ?? "p" + i, p.name, p.isBot)),
    battlefields: [], // [{def, index, controllerId, contested, facedown:[]}]
    log: [],
    winnerId: null,
    pendingChoices: [], // choices the active actor must resolve before continuing
  };
}

export const getPlayer = (g, id) => g.players.find((p) => p.id === id);
export const opponentOf = (g, id) => g.players.find((p) => p.id !== id);

/* All units present at a battlefield (top-most board objects there). */
export function unitsAt(g, bfIndex, controllerId = null) {
  const loc = "bf:" + bfIndex;
  const out = [];
  for (const p of g.players)
    for (const o of allBoardObjects(g, p.id))
      if (
        o.location === loc &&
        o.def?.type === "Unit" &&
        (controllerId == null || o.controllerId === controllerId)
      )
        out.push(o);
  return out;
}

/* Every board object a player controls (units/gear in base or at battlefields). */
export function allBoardObjects(g, controllerId) {
  return g._board ? g._board.filter((o) => o.controllerId === controllerId) : [];
}

/* The board is a flat list for simplicity; locations are tagged on objects. */
export function ensureBoard(g) {
  if (!g._board) g._board = [];
  return g._board;
}

export function placeOnBoard(g, obj, location) {
  ensureBoard(g);
  if (!g._board.includes(obj)) g._board.push(obj);
  obj.location = location;
  obj.facedown = location.startsWith("facedown:");
}

export function removeFromBoard(g, obj) {
  ensureBoard(g);
  g._board = g._board.filter((o) => o !== obj);
  obj.location = null;
  obj.designation = null;
}

export function logEvent(g, text, data = {}) {
  g.log.unshift({ turn: g.turn, phase: g.phase, text, ...data, t: Date.now() });
  if (g.log.length > 500) g.log.pop();
}
