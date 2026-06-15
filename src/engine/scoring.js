/*
 * Scoring — Core Rules §462–466.
 *  Conquer: gain control of a battlefield you haven't scored this turn (§464.1).
 *  Hold:    still control a battlefield during your Beginning Phase (§464.2).
 *  A player scores at most once per battlefield per turn (§465).
 *  Reaching the Victory Score (8 in duel) wins, checked on Cleanup (§323.1).
 */
import { getPlayer, logEvent } from "./state.js";

/* Mark that `pid` scored battlefield `bfIndex` this turn (Conquer or Hold). */
function markScored(g, pid, bfIndex) {
  g._scoredThisTurn = g._scoredThisTurn || {};
  (g._scoredThisTurn[pid] = g._scoredThisTurn[pid] || new Set()).add(bfIndex);
}
function alreadyScored(g, pid, bfIndex) {
  return !!g._scoredThisTurn?.[pid]?.has(bfIndex);
}
export function resetScoredThisTurn(g, pid) {
  g._scoredThisTurn = g._scoredThisTurn || {};
  g._scoredThisTurn[pid] = new Set();
}

/* Award a point for a Score, honoring the Winning-Point restriction (§466.1.b).
 * For a Hold at match point you simply win; for a Conquer at match point you only
 * win if you've scored every battlefield this turn, else you draw instead. */
export function gainScorePoint(g, pid, method, bfIndex) {
  const p = getPlayer(g, pid);
  const atMatchPoint = p.points >= g.victoryScore - 1;
  if (atMatchPoint) {
    if (method === "hold") {
      p.points++;
    } else {
      const allScored = allBattlefieldsScored(g, pid);
      if (allScored) p.points++;
      else {
        drawCards(g, pid, 1);
        logEvent(g, `${p.name} is at match point via Conquer but hasn't scored every battlefield — draws instead (§466.1.b).`);
        return;
      }
    }
  } else {
    p.points++;
  }
  logEvent(g, `${p.name} scores by ${method} (now ${p.points}/${g.victoryScore}).`, { kind: "score" });
}

function allBattlefieldsScored(g, pid) {
  return g.battlefields.every((_, i) => alreadyScored(g, pid, i));
}

/* Conquer: called when `pid` establishes control of `bfIndex`. */
export function conquer(g, pid, bfIndex) {
  if (alreadyScored(g, pid, bfIndex)) return;
  markScored(g, pid, bfIndex);
  gainScorePoint(g, pid, "conquer", bfIndex);
  // TODO(M3): trigger Conquer abilities at this battlefield (§466.2.a).
}

/* Hold: during the turn player's Beginning Phase, score each battlefield they
 * control that they haven't scored yet this turn (§315.2.b, §464.2). */
export function holdAll(g, pid) {
  g.battlefields.forEach((bf, i) => {
    if (bf.controllerId === pid && !alreadyScored(g, pid, i)) {
      markScored(g, pid, i);
      gainScorePoint(g, pid, "hold", i);
      // TODO(M3): trigger Hold abilities here (§466.2.b).
    }
  });
}

/* Victory check — run on every Cleanup (§323.1). */
export function checkWin(g) {
  for (const p of g.players) {
    if (p.points >= g.victoryScore) {
      const opp = g.players.find((x) => x !== p);
      if (!opp || p.points > opp.points) {
        g.winnerId = p.id;
        logEvent(g, `${p.name} wins with ${p.points} points!`, { kind: "win" });
        return true;
      }
    }
  }
  return false;
}

/* Small draw helper kept here to avoid a circular import with rules.js. */
export function drawCards(g, pid, n) {
  const p = getPlayer(g, pid);
  for (let i = 0; i < n; i++) {
    if (p.mainDeck.length === 0) {
      p.burnedOut = true; // §431 Burn Out
      logEvent(g, `${p.name} is Burned Out (empty Main Deck).`);
      continue;
    }
    const card = p.mainDeck.shift();
    card.location = null;
    p.hand.push(card);
  }
}
