/*
 * Turn-structure orchestrator & action API — Core Rules §104–119, §300–317, §480.
 * Targets 1v1 Duel: Victory Score 8, 1 chosen battlefield per side, second player
 * channels +1 rune on turn 1 (§480.7).
 *
 * Public API:
 *   setupGame(game, decks)            build decks, draw 4, choose battlefields
 *   advance(game)                     run automatic tasks until a decision is due
 *   legalActions(game, pid)           what the player with priority may do now
 *   submitAction(game, pid, action)   apply an action, then advance
 *
 * Resource model (M2 simplification, flagged for M3): each channeled Rune sits in
 * base and yields 1 Energy when readied. Power-pip costs and per-domain Power are
 * deferred to M3; sample/most cards only specify an Energy cost.
 */
import {
  getPlayer, opponentOf, makeObject, placeOnBoard, removeFromBoard,
  unitsAt, currentMight, logEvent,
} from "./state.js";
import { hasKeyword } from "./keywords.js";
import { turnState, canPlayNow, pushChain, passPriority, resolveTop } from "./chain.js";
import { openCombat, combatDamageStep } from "./combat.js";
import { holdAll, resetScoredThisTurn, checkWin, drawCards, conquer } from "./scoring.js";
import { parseEffects, runEffects, autoChoose } from "./effects.js";

/* ------------------------------- setup --------------------------------- */
function instantiate(defs, ownerId) {
  return defs.map((d) => makeObject(d, ownerId));
}
function expand(entries) {
  // entry {card, qty} → flat list of card defs
  const out = [];
  for (const e of entries) for (let i = 0; i < e.qty; i++) if (e.card) out.push(e.card);
  return out;
}

export function setupGame(g, decks) {
  // decks: [{deck, name}] aligned to g.players order. deck = parsed decklist.
  g.players.forEach((p, i) => {
    const d = decks[i].deck;
    p.domainIdentity = d.identity || [];
    p.mainDeck = g.rng.shuffle(instantiate(expand(d.main), p.id));
    // Rune deck: use provided runes, else synthesize 12 generic runes (M2).
    const runeDefs = d.runes.length ? expand(d.runes) : Array(12).fill({ id: "rune-generic", name: "Rune", type: "Rune", domains: p.domainIdentity });
    p.runeDeck = g.rng.shuffle(instantiate(runeDefs.slice(0, 12), p.id));
    p.runesInBase = 0;
    p.legend = d.legend?.card ? makeObject(d.legend.card, p.id) : null;
    p.champion = d.champion?.card ? makeObject(d.champion.card, p.id) : null;
    if (p.champion) {
      // Chosen Champion starts in the Champion Zone (§103.2.a.1).
      p.champion.location = "champion:" + p.id;
    }
    // Battlefield: duel picks 1 of the 3 provided (§480.5).
    const bfs = d.battlefields.filter((e) => e.card);
    const pick = bfs.length ? bfs[g.rng.int(bfs.length)].card : { id: "bf-generic", name: "Open Field", type: "Battlefield" };
    g.battlefields.push({ def: pick, index: g.battlefields.length, controllerId: null, contested: false, facedown: [] });
  });

  // Opening hands: draw 4 (§117). (Mulligan UI is M5; headless auto-keeps.)
  g.players.forEach((p) => drawCards(g, p.id, 4));

  // First player random (§116); index 0 starts. Mark the duel first-turn bonus.
  g.turnPlayerId = g.players[0].id;
  g._secondPlayerId = g.players[1].id;
  g.turn = 0;
  beginTurn(g);
}

/* ----------------------------- turn phases ----------------------------- */
function beginTurn(g) {
  g.turn++;
  const p = getPlayer(g, g.turnPlayerId);
  resetScoredThisTurn(g, p.id);
  p.cardsPlayedThisTurn = 0;
  logEvent(g, `— Turn ${g.turn}: ${p.name} —`, { kind: "turn" });

  // Awaken (§315.1): ready everything this player controls.
  for (const o of g._board || []) if (o.controllerId === p.id) o.exhausted = false;

  // Beginning → Scoring Step: Hold all controlled battlefields (§315.2.b).
  holdAll(g, p.id);
  if (checkWin(g)) return;

  // Channel (§315.3): channel 2 runes; second player +1 on turn 1 (§480.7).
  let channel = 2;
  if (g.turn === 2 && p.id === g._secondPlayerId) channel = 3; // second player's first turn
  const drawn = Math.min(channel, p.runeDeck.length);
  p.runeDeck.splice(0, drawn);
  p.runesInBase += drawn;

  // Draw (§315.4).
  drawCards(g, p.id, 1);

  // Energy available this turn = readied runes in base (M2 model).
  p.runePool = { energy: p.runesInBase, power: {} };

  // Enter Main Phase (§316): Neutral Open, turn player has priority.
  g.phase = "main";
  g.showdown = null;
  g.chain = [];
  g.priorityId = p.id;
  g.focusId = null;
  g._lastPasser = null;
}

function endTurn(g) {
  // Ending Phase (§317): expire "this turn" mods, heal, empty pool.
  if (g._board)
    for (const o of g._board) {
      o.tempMods = o.tempMods.filter((m) => m.expiry !== "endOfTurn");
      if (o.def?.type === "Unit") o.damage = 0;
    }
  getPlayer(g, g.turnPlayerId).runePool = { energy: 0, power: {} };
  // Next player's turn.
  g.turnPlayerId = opponentOf(g, g.turnPlayerId).id;
  beginTurn(g);
}

/* --------------------------- the advance loop -------------------------- */
/* Runs automatic processing until a player must make a discretionary decision
 * (they have priority in a state where they have legal non-pass actions, OR they
 * must explicitly pass). The driver then calls legalActions/submitAction. */
export function advance(g) {
  let guard = 0;
  while (!g.winnerId && guard++ < 1000) {
    // Resolve a fully-passed chain top.
    if (g._resolveRequested) {
      g._resolveRequested = false;
      resolveTop(g, runChainItem);
      if (checkWin(g)) return;
      continue;
    }
    // If a combat damage step is queued (both passed in combat showdown), run it.
    if (g._combatDamageQueued) {
      g._combatDamageQueued = false;
      const res = combatDamageStep(g);
      if (checkWin(g)) return;
      if (res && res.restage != null) stageCombatIfAny(g);
      continue;
    }
    return; // waiting for the player with priority to act
  }
}

/* Execute a resolved chain item (spell or unit/gear "play"). */
function runChainItem(g, item) {
  const pid = item.controllerId;
  if (item.kind === "spell") {
    runEffects(g, pid, item.effects, { source: item.source }, item.choose || autoChoose);
  } else if (item.kind === "permanent") {
    // Unit/Gear enters the board.
    const obj = item.source;
    const loc = item.toLocation || "base:" + pid;
    // Enters exhausted unless Accelerate was paid (§805) — M2: Accelerate auto-applied.
    obj.exhausted = !item.accelerated && obj.def.type === "Unit" ? !hasKeyword(obj, "Accelerate") : false;
    placeOnBoard(g, obj, loc);
    logEvent(g, `${obj.def.name} enters at ${prettyLoc(g, loc)}.`);
    // "When you play me" effects.
    const pe = playEffects(obj.def);
    if (pe.length) runEffects(g, pid, pe, { source: obj }, item.choose || autoChoose);
    // If it entered onto a contested/opposing battlefield, combat may stage.
    if (loc.startsWith("bf:")) stageCombatIfAny(g);
  }
}

function playEffects(card) {
  const m = (card.oracle || "").match(/when you play me[,:]?\s*([^.!]+[.!]?)/i);
  return m ? parseEffects(m[1]) : [];
}

/* -------------------------- legal action gen --------------------------- */
export function legalActions(g, pid) {
  if (g.winnerId || g.priorityId !== pid) return [];
  const p = getPlayer(g, pid);
  const state = turnState(g);
  const actions = [];

  // Plays from hand (respecting timing via canPlayNow). Hand holds GameObjects.
  for (const obj of p.hand) {
    if (!canPlayNow(g, pid, obj)) continue;
    const def = obj.def;
    const cost = def.energy ?? 0;
    if (state === "NeutralOpen" && cost > p.runePool.energy) continue; // can't afford
    if (def.type === "Spell" || def.type === "Unit" || def.type === "Gear")
      actions.push({ type: "play", uid: obj.uid, name: def.name, cost, cardType: def.type });
  }

  // Standard move: a ready unit you control in base → a battlefield (§143/§440).
  if (state === "NeutralOpen") {
    for (const o of g._board || []) {
      if (o.controllerId !== pid || o.def?.type !== "Unit" || o.exhausted) continue;
      const inBase = o.location?.startsWith("base:");
      g.battlefields.forEach((bf, i) => {
        if (inBase || hasKeyword(o, "Ganking"))
          if (o.location !== "bf:" + i)
            actions.push({ type: "move", uid: o.uid, name: o.def.name, toBf: i, bfName: bf.def?.name });
      });
    }
  }

  // Always allowed: pass priority. In NeutralOpen this is "end turn".
  actions.push(state === "NeutralOpen" ? { type: "endTurn" } : { type: "pass" });
  return actions;
}

/* ----------------------------- submit ---------------------------------- */
export function submitAction(g, pid, action, choose = autoChoose) {
  if (g.priorityId !== pid) throw new Error("not your priority");
  const p = getPlayer(g, pid);

  switch (action.type) {
    case "play": {
      const idx = p.hand.findIndex((c) => c.uid === action.uid);
      if (idx < 0) throw new Error("card not in hand");
      const obj = p.hand[idx]; // GameObject
      const def = obj.def;
      const cost = def.energy ?? 0;
      if (turnState(g) === "NeutralOpen" && cost > p.runePool.energy) throw new Error("cannot afford");
      p.hand.splice(idx, 1);
      p.runePool.energy -= cost;
      p.cardsPlayedThisTurn++;
      if (def.type === "Spell") {
        pushChain(g, { kind: "spell", controllerId: pid, source: obj, label: def.name, effects: parseEffects(def.oracle), choose });
      } else {
        // Unit/Gear: played onto the chain as a permanent entering the board.
        const toLocation = action.toBf != null ? "bf:" + action.toBf : "base:" + pid;
        pushChain(g, { kind: "permanent", controllerId: pid, source: obj, label: def.name, toLocation, accelerated: hasKeyword(obj, "Accelerate"), choose });
      }
      break;
    }
    case "move": {
      const o = (g._board || []).find((x) => x.uid === action.uid && x.controllerId === pid);
      if (!o || o.exhausted) throw new Error("illegal move");
      o.location = "bf:" + action.toBf;
      o.exhausted = true; // standard move exhausts (M2 model)
      const bf = g.battlefields[action.toBf];
      if (bf.controllerId !== pid) bf.contested = true;
      logEvent(g, `${o.def.name} moves to "${bf.def?.name || action.toBf}".`);
      stageCombatIfAny(g);
      break;
    }
    case "pass": {
      const r = passPriority(g);
      handlePassResult(g, r);
      break;
    }
    case "endTurn": {
      if (turnState(g) !== "NeutralOpen") throw new Error("can only end turn in your main phase");
      endTurn(g);
      break;
    }
    default:
      throw new Error("unknown action " + action.type);
  }
  advance(g);
}

function handlePassResult(g, r) {
  switch (r.type) {
    case "resolveTop":
      g._resolveRequested = true;
      break;
    case "endShowdownStep":
      // Combat showdown closed by both passing → proceed to damage step.
      if (g.showdown?.combat) g._combatDamageQueued = true;
      else endNonCombatShowdown(g);
      break;
    case "endPhase":
      endTurn(g);
      break;
    // "passed" / "focusPassed" → priority moved; nothing else to do.
  }
}

/* A non-combat showdown (mover reached an empty battlefield with no opposition):
 * the mover establishes control → Conquer (§446, §461.5). */
function endNonCombatShowdown(g) {
  const { bfIndex, attackerId } = g.showdown;
  const bf = g.battlefields[bfIndex];
  const movers = unitsAt(g, bfIndex, attackerId);
  g.showdown = null; g.focusId = null; g._lastPasser = null;
  g.priorityId = g.turnPlayerId;
  if (movers.length && bf.controllerId !== attackerId) {
    bf.controllerId = attackerId; bf.contested = false;
    logEvent(g, `${getPlayer(g, attackerId).name} takes "${bf.def?.name || bfIndex}".`, { kind: "control" });
    conquer(g, attackerId, bfIndex); // establishing control = Conquer (§461.5.d)
  }
}

/* If a battlefield now has units from both players, open a combat showdown;
 * if a player moved to an uncontested empty battlefield, open a non-combat one. */
function stageCombatIfAny(g) {
  if (g.showdown) return;
  for (let i = 0; i < g.battlefields.length; i++) {
    const a = unitsAt(g, i, g.turnPlayerId);
    const opp = opponentOf(g, g.turnPlayerId).id;
    const b = unitsAt(g, i, opp);
    const bf = g.battlefields[i];
    if (a.length && b.length) {
      // Opposing units → combat. Attacker = whoever contested (turn player here).
      openCombat(g, i, g.turnPlayerId);
      return;
    }
    if (bf.contested && ((a.length && bf.controllerId !== g.turnPlayerId))) {
      // Non-combat showdown: mover reached an uncontrolled/empty battlefield.
      g.showdown = { bfIndex: i, attackerId: g.turnPlayerId, defenderId: opp, combat: false };
      g.focusId = g.turnPlayerId; g.priorityId = g.turnPlayerId; g._lastPasser = null;
      return;
    }
  }
}

/* ------------------------------ helpers -------------------------------- */
function prettyLoc(g, loc) {
  if (loc?.startsWith("bf:")) return `"${g.battlefields[+loc.slice(3)]?.def?.name || loc}"`;
  if (loc?.startsWith("base:")) return "base";
  return loc;
}
