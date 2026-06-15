/*
 * Effect interpreter (Milestone 3, first pass).
 * Parses a card's oracle text into structured effects the engine can execute.
 * Anything it can't parse is returned as {op:"unimplemented", text} so the UI can
 * flag the card rather than silently misrepresent it.
 *
 * Supported patterns so far (extended over time, tracked in docs/RULES_MAP.md):
 *   "Deal N to a unit [in a base]"           → {op:"deal", amount, filter}
 *   "Draw [a card | N [cards]]"              → {op:"draw", amount}
 *   "Give a (friendly|target) unit +X/-X Might [this turn]" → {op:"mightMod", ...}
 *   "Gain N XP"                              → {op:"xp", amount}
 *   "Kill a (unit|gear)"                     → {op:"kill", filter}
 *   leading "Accelerate." / bare keyword lines are ignored (handled elsewhere)
 */
import { getPlayer, opponentOf, currentMight, removeFromBoard, logEvent } from "./state.js";
import { drawCards } from "./scoring.js";

// Standalone keyword/cost declarations that are NOT effects (handled elsewhere).
// Keywords that carry effect text (Deathknell:, Hunt, Weaponmaster, Legion, Level)
// are deliberately NOT here, so their effects still get flagged for M3.
const KEYWORD_LINE =
  /^(accelerate|tank|backline|shield|assault|deflect|ganking|hidden|ambush|action|reaction|temporary|vision|unique|quick-draw|repeat|equip)\b\s*\d*\.?$/i;

export function parseEffects(oracle) {
  const effects = [];
  if (!oracle) return effects;
  // Split into clauses on sentence/period boundaries and newlines.
  const clauses = oracle
    .replace(/\bWhen (you play me|I (?:am played|conquer|hold))[,:]?/gi, "") // strip trigger preface; handled by caller
    .split(/(?<=[.!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const c of clauses) {
    if (KEYWORD_LINE.test(c)) continue; // pure keyword line

    let m;
    if ((m = c.match(/deal\s+(\d+)\s+to\s+(?:a\s+)?(unit|enemy unit|friendly unit)(\s+in\s+a\s+base)?/i))) {
      effects.push({ op: "deal", amount: +m[1], target: m[2].toLowerCase(), baseOnly: !!m[3] });
      continue;
    }
    if ((m = c.match(/draw\s+(?:a\s+card|(\d+)\s+cards?)/i))) {
      effects.push({ op: "draw", amount: m[1] ? +m[1] : 1 });
      continue;
    }
    if ((m = c.match(/give\s+(?:a\s+)?(friendly|enemy|target)?\s*unit\s+([+-]\d+)\s+might(\s+this turn)?/i))) {
      effects.push({ op: "mightMod", side: (m[1] || "any").toLowerCase(), delta: +m[2], thisTurn: !!m[3] });
      continue;
    }
    if ((m = c.match(/gain\s+(\d+)\s+xp/i))) {
      effects.push({ op: "xp", amount: +m[1] });
      continue;
    }
    if ((m = c.match(/kill\s+(?:a\s+)?(unit|gear)/i))) {
      effects.push({ op: "kill", target: m[1].toLowerCase() });
      continue;
    }
    effects.push({ op: "unimplemented", text: c });
  }
  return effects;
}

/* Is every clause of this card's oracle understood by the interpreter? */
export function isFullyImplemented(card) {
  const eff = parseEffects(card.oracle || "");
  return !eff.some((e) => e.op === "unimplemented");
}

/* Execute a structured effect list for `pid`. `choose` is a callback the engine
 * uses to pick targets — supplied by the human UI or the bot. */
export function runEffects(g, pid, effects, ctx = {}, choose = autoChoose) {
  for (const e of effects) {
    switch (e.op) {
      case "deal": {
        const target = choose(g, pid, { kind: "unit", baseOnly: e.baseOnly, side: e.target, ctx });
        if (target) {
          target.damage += e.amount;
          logEvent(g, `${target.def.name} takes ${e.amount} damage.`);
          killIfLethal(g, target);
        }
        break;
      }
      case "draw":
        drawCards(g, pid, e.amount);
        logEvent(g, `${getPlayer(g, pid).name} draws ${e.amount}.`);
        break;
      case "mightMod": {
        const wantFriendly = e.side === "friendly" || e.side === "any";
        const target = choose(g, pid, { kind: "unit", side: wantFriendly ? "friendly" : "enemy", ctx });
        if (target) {
          target.tempMods.push({ stat: "might", delta: e.delta, expiry: e.thisTurn ? "endOfTurn" : "permanent" });
          logEvent(g, `${target.def.name} gets ${e.delta >= 0 ? "+" : ""}${e.delta} Might${e.thisTurn ? " this turn" : ""}.`);
        }
        break;
      }
      case "xp":
        getPlayer(g, pid).xp += e.amount;
        logEvent(g, `${getPlayer(g, pid).name} gains ${e.amount} XP.`);
        break;
      case "kill": {
        const target = choose(g, pid, { kind: e.target, side: "enemy", ctx });
        if (target) {
          const owner = getPlayer(g, target.ownerId);
          removeFromBoard(g, target);
          owner.trash.push(target);
          logEvent(g, `${target.def.name} is killed.`);
        }
        break;
      }
      case "unimplemented":
        logEvent(g, `⚠ Unimplemented effect skipped: "${e.text}"`, { kind: "warn" });
        break;
    }
  }
}

function killIfLethal(g, unit) {
  if (unit.def?.type === "Unit" && unit.damage >= currentMight(unit) && unit.damage > 0) {
    const owner = getPlayer(g, unit.ownerId);
    removeFromBoard(g, unit);
    owner.trash.push(unit);
    unit.damage = 0;
    logEvent(g, `${unit.def.name} dies.`);
  }
}

/* Default target chooser: pick a reasonable board unit. Used by the bot and as a
 * fallback. The human UI overrides this with an interactive picker. */
export function autoChoose(g, pid, req) {
  const board = g._board || [];
  const enemy = opponentOf(g, pid).id;
  let pool = board.filter((o) => {
    if (req.kind === "gear") return o.def?.type === "Gear";
    return o.def?.type === "Unit";
  });
  if (req.side === "friendly") pool = pool.filter((o) => o.controllerId === pid);
  else if (req.side === "enemy" || req.side === "enemy unit") pool = pool.filter((o) => o.controllerId === enemy);
  if (req.baseOnly) pool = pool.filter((o) => o.location?.startsWith("base:"));
  if (!pool.length) return null;
  // Heuristic: for harmful effects target the strongest enemy; for buffs the strongest friendly.
  pool.sort((a, b) => (currentMight(b) || 0) - (currentMight(a) || 0));
  return pool[0];
}
