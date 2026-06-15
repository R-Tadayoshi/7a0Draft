/*
 * Showdowns & Combat — Core Rules §341–346, §454–461.
 *
 * Flow for 1v1 (orchestrated by rules.advance):
 *   1. A unit moves onto a battlefield contested with opposing units → combat is
 *      "staged". rules.advance calls openCombat() which sets up the showdown and
 *      gives the attacker focus.
 *   2. Players take Action/Reaction in the Combat Showdown (handled by the chain
 *      + advance loop). When both pass with an empty chain → combatDamageStep().
 *   3. combatResolutionStep(): heal, recall, determine control, score.
 */
import {
  getPlayer, opponentOf, unitsAt, currentMight, isLethal,
  removeFromBoard, logEvent,
} from "./state.js";
import { hasKeyword } from "./keywords.js";
import { conquer } from "./scoring.js";

/* Open a combat showdown at bfIndex. attackerId applied the Contested status. */
export function openCombat(g, bfIndex, attackerId) {
  const defenderId = opponentOf(g, attackerId).id;
  g.showdown = { bfIndex, attackerId, defenderId, combat: true };
  // Designate attackers/defenders among units present (§459.2.b).
  for (const u of unitsAt(g, bfIndex, attackerId)) u.designation = "attacker";
  for (const u of unitsAt(g, bfIndex, defenderId)) u.designation = "defender";
  // Attacker gains focus & priority to open the showdown (§459.2.b.1.a, §459.2.c).
  g.focusId = attackerId;
  g.priorityId = attackerId;
  g._lastPasser = null;
  logEvent(g, `Combat staged at "${g.battlefields[bfIndex].def?.name || bfIndex}".`, { kind: "combat" });
}

/* Order a player's units for damage assignment: Tank first, Backline last,
 * everything else in the middle (§460.2.c, §815, §826). */
function assignmentOrder(units) {
  const tanks = units.filter((u) => hasKeyword(u, "Tank"));
  const back = units.filter((u) => hasKeyword(u, "Backline") && !hasKeyword(u, "Tank"));
  const mid = units.filter((u) => !hasKeyword(u, "Tank") && !hasKeyword(u, "Backline"));
  return [...tanks, ...mid, ...back];
}

/* Assign `total` combat damage among `targets` following the lethal-chunk and
 * no-overkill rules (§460.2.c). Damage is marked (added), to be evaluated for
 * lethality simultaneously after both sides assign. */
function assignDamage(total, targets) {
  const order = assignmentOrder(targets);
  let remaining = total;
  for (let i = 0; i < order.length && remaining > 0; i++) {
    const u = order[i];
    const need = currentMight(u); // lethal chunk for assignment ordering
    const isLast = i === order.length - 1;
    let give = Math.min(need, remaining);
    if (isLast && remaining > need) give = remaining; // overkill only when nothing else remains
    u.damage += give;
    remaining -= give;
  }
}

/* Step 2: The Combat Damage Step (§460). Both sides deal simultaneously. */
export function combatDamageStep(g) {
  const { bfIndex, attackerId, defenderId } = g.showdown;
  const attackers = unitsAt(g, bfIndex, attackerId);
  const defenders = unitsAt(g, bfIndex, defenderId);
  if (!attackers.length || !defenders.length) {
    return combatResolutionStep(g); // one side gone; no damage exchanged
  }
  const atkMight = attackers.reduce((s, u) => s + currentMight(u), 0);
  const defMight = defenders.reduce((s, u) => s + currentMight(u), 0);
  // Assign (mark) both directions before applying kills, so it's simultaneous.
  assignDamage(atkMight, defenders);
  assignDamage(defMight, attackers);
  logEvent(g, `Combat damage: attackers ${atkMight} vs defenders ${defMight}.`, { kind: "combat" });

  // Apply lethal simultaneously: units with damage >= Might die → trash (§323.3a).
  for (const u of [...attackers, ...defenders]) {
    if (isLethal(u)) {
      const owner = getPlayer(g, u.ownerId);
      removeFromBoard(g, u);
      owner.trash.push(u);
      u.damage = 0;
      logEvent(g, `${u.def.name} (${u.controllerId === attackerId ? "atk" : "def"}) is killed.`, { kind: "combat" });
      // TODO(M3): Deathknell triggers here (§808).
    }
  }
  return combatResolutionStep(g);
}

/* Step 3: The Resolution Step (§461). */
export function combatResolutionStep(g) {
  const { bfIndex, attackerId, defenderId } = g.showdown;
  // 3c. Heal all units (clear marked damage from survivors).
  if (g._board) for (const o of g._board) if (o.def?.type === "Unit") o.damage = 0;

  let attackers = unitsAt(g, bfIndex, attackerId);
  let defenders = unitsAt(g, bfIndex, defenderId);

  // 3d. Recall attackers present if defenders are still present (§461.1.a.2).
  if (attackers.length && defenders.length) {
    for (const u of attackers) recallToBase(g, u);
    attackers = [];
  }

  // Determine result & establish control (§461.3–461.5).
  const bf = g.battlefields[bfIndex];
  if (attackers.length && !defenders.length) {
    establishControl(g, bfIndex, attackerId);
  } else if (defenders.length && !attackers.length) {
    establishControl(g, bfIndex, defenderId);
  } else if (!attackers.length && !defenders.length) {
    bf.controllerId = null; // uncontrolled (§461.5.b)
    bf.contested = false;
  } else {
    // Both still present (e.g., nothing died): re-stage combat (§461.3.d.1).
    bf.contested = true;
  }

  // Clear designations & end combat (§461.7).
  if (g._board) for (const o of g._board) o.designation = null;
  const stillStaged = bf.contested && unitsAt(g, bfIndex, attackerId).length && unitsAt(g, bfIndex, defenderId).length;
  g.showdown = null;
  g.focusId = null;
  g.priorityId = g.turnPlayerId;
  g._lastPasser = null;
  logEvent(g, `Combat ends at "${bf.def?.name || bfIndex}".`, { kind: "combat" });
  return { restage: stillStaged ? bfIndex : null };
}

function establishControl(g, bfIndex, pid) {
  const bf = g.battlefields[bfIndex];
  const had = bf.controllerId;
  bf.controllerId = pid;
  bf.contested = false;
  if (had !== pid) {
    logEvent(g, `${getPlayer(g, pid).name} takes "${bf.def?.name || bfIndex}".`, { kind: "control" });
    conquer(g, pid, bfIndex); // Establishing control = a Conquer if not yet scored (§461.5.d)
  }
}

export function recallToBase(g, unit) {
  unit.location = "base:" + unit.controllerId;
  unit.designation = null;
  // Recall keeps damage/exhaust per §453; combat heal already cleared damage.
}
