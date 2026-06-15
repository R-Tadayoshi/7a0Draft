/*
 * Turn states, Priority/Focus, and the Chain — Core Rules §307–346.
 *
 * The four turn-states (§310) gate what may be played:
 *   NeutralOpen   — turn player's main phase; any card/ability (default timing)
 *   NeutralClosed — a Chain exists outside a showdown; only Reaction
 *   ShowdownOpen  — showdown/combat, no Chain; only Action/Reaction
 *   ShowdownClosed— showdown/combat with a Chain; only Reaction
 *
 * We model the Chain as an array that resolves newest-first (§340). Each chain
 * item records its controller so priority/focus can pass correctly.
 */
import { getPlayer, opponentOf, logEvent } from "./state.js";
import { timingPermissions } from "./keywords.js";

export function turnState(g) {
  const showdown = !!g.showdown;
  const closed = g.chain.length > 0;
  if (showdown) return closed ? "ShowdownClosed" : "ShowdownOpen";
  return closed ? "NeutralClosed" : "NeutralOpen";
}

/* Can `obj` (a card/ability about to be played) be played right now by player
 * `pid`, given the turn state? Enforces §308–313 timing. */
export function canPlayNow(g, pid, obj) {
  const state = turnState(g);
  const perms = timingPermissions(obj); // set of {Action,Reaction}
  switch (state) {
    case "NeutralOpen":
      // Only the turn player, only when they hold priority.
      return g.turnPlayerId === pid && g.priorityId === pid;
    case "NeutralClosed":
      // Only Reaction, only the player who currently holds priority.
      return g.priorityId === pid && perms.has("Reaction");
    case "ShowdownOpen":
      // Action or Reaction, by the player with priority (who also has focus).
      return g.priorityId === pid && (perms.has("Action") || perms.has("Reaction"));
    case "ShowdownClosed":
      return g.priorityId === pid && perms.has("Reaction");
  }
  return false;
}

/* Push a spell/ability onto the Chain. Closes the state and hands priority to
 * the controller (who may add more / hold), per §330–340. */
export function pushChain(g, item) {
  // item: { kind:'spell'|'ability', controllerId, source, effect, targets, label }
  g.chain.push(item);
  logEvent(g, `${getPlayer(g, item.controllerId).name} plays ${item.label}`, {
    kind: "play",
  });
  // After putting an item on the chain, the controller retains priority to add
  // more; opponents get reaction windows as priority passes (§340.4).
  g.priorityId = item.controllerId;
}

/* The player with priority passes. Returns a description of what happened so the
 * caller (rules.advance) can continue the loop. */
export function passPriority(g) {
  const pid = g.priorityId;
  const opp = opponentOf(g, pid).id;

  if (g.chain.length > 0) {
    // Closed state: passing either hands priority to the opponent (so they can
    // react) or, if everyone has passed in succession, resolves the top item.
    if (g._lastPasser && g._lastPasser !== pid) {
      // Both players passed in a row → resolve the newest chain item (§340).
      g._lastPasser = null;
      return { type: "resolveTop" };
    }
    g._lastPasser = pid;
    g.priorityId = opp;
    return { type: "passed", to: opp };
  }

  // Open state.
  if (g.showdown) {
    // ShowdownOpen: passing focus moves it to the other player (§340.2.a).
    // When both have passed with no chain, the showdown step ends.
    if (g._lastPasser && g._lastPasser !== pid) {
      g._lastPasser = null;
      return { type: "endShowdownStep" };
    }
    g._lastPasser = pid;
    g.focusId = opp;
    g.priorityId = opp;
    return { type: "focusPassed", to: opp };
  }

  // NeutralOpen: the turn player passing with an empty chain ends the phase.
  g._lastPasser = null;
  return { type: "endPhase" };
}

/* Resolve the newest item on the Chain (§340.1). The actual effect execution is
 * delegated to the effect runner passed in, so chain.js stays free of card data. */
export function resolveTop(g, runEffect) {
  const item = g.chain.pop();
  if (!item) return;
  logEvent(g, `${item.label} resolves`, { kind: "resolve" });
  runEffect(g, item);
  // After resolution: if chain now empty, open state; controller of new top gets
  // priority (§340.4). Reset the pass tracker so reaction windows re-open.
  g._lastPasser = null;
  if (g.chain.length === 0) {
    // Open state resumes; in a showdown, focus passes to next player (§340.2.a).
    if (g.showdown) {
      g.priorityId = g.focusId;
    } else {
      g.priorityId = g.turnPlayerId;
    }
  } else {
    g.priorityId = g.chain[g.chain.length - 1].controllerId;
  }
}
