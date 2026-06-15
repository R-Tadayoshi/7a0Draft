/*
 * Opponent bot (Milestone 4, first pass).
 * Chooses among the engine's legal actions with simple, transparent heuristics.
 * It never makes an illegal play — it only ever picks from legalActions(), so the
 * rules engine remains the single source of truth.
 *
 * Policy summary (intentionally readable so behavior is auditable):
 *   1. Curve out: play the most expensive affordable unit/spell.
 *   2. Develop & contest: move ready units to score open battlefields or to win
 *      favorable combats (our Might sum at the battlefield > theirs).
 *   3. Otherwise end the turn / pass.
 *   In showdowns it currently passes (Action/Reaction play comes with M3 effects).
 */
import { unitsAt, currentMight, opponentOf } from "../engine/state.js";
import { legalActions } from "../engine/rules.js";
import { turnState } from "../engine/chain.js";

export function chooseAction(g, pid) {
  const actions = legalActions(g, pid);
  if (!actions.length) return null;
  const state = turnState(g);

  if (state !== "NeutralOpen") {
    // In reaction/showdown windows the first-pass bot simply passes.
    return actions.find((a) => a.type === "pass") || actions[0];
  }

  const plays = actions.filter((a) => a.type === "play");
  const moves = actions.filter((a) => a.type === "move");
  const opp = opponentOf(g, pid).id;

  // 2a. A move that takes an uncontrolled/open battlefield = free point.
  const scoreMoves = moves.filter((m) => {
    const bf = g.battlefields[m.toBf];
    const enemyMight = unitsAt(g, m.toBf, opp).reduce((s, u) => s + currentMight(u), 0);
    return bf.controllerId !== pid && enemyMight === 0;
  });
  if (scoreMoves.length) return scoreMoves[0];

  // 1. Curve out: highest-cost affordable play.
  if (plays.length) {
    plays.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    // Prefer developing a unit if we have nothing on board to contest with.
    const unit = plays.find((p) => p.cardType === "Unit");
    return unit || plays[0];
  }

  // 2b. A move into a winnable combat.
  const goodCombat = moves.find((m) => {
    const mover = (g._board || []).find((o) => o.uid === m.uid);
    const ours = unitsAt(g, m.toBf, pid).reduce((s, u) => s + currentMight(u), 0) + (currentMight(mover) || 0);
    const theirs = unitsAt(g, m.toBf, opp).reduce((s, u) => s + currentMight(u), 0);
    return theirs > 0 && ours > theirs;
  });
  if (goodCombat) return goodCombat;

  // 3. Nothing useful → end the turn.
  return actions.find((a) => a.type === "endTurn") || actions.find((a) => a.type === "pass") || actions[0];
}
