/*
 * Riftbound keywords — Core Rules §800 "Keywords".
 * Each entry encodes the *functional* meaning so the engine, the effect
 * interpreter, and the bot can all reason about a card mechanically rather
 * than from prose. Text quotes are condensed from the comprehensive rules.
 *
 * `kind` taxonomy (from the rules' own classification):
 *   passive    — always-on while on the board (Tank, Shield, Assault, …)
 *   triggered  — fires on an event (Deathknell, Vision, Temporary, Hunt, …)
 *   activated  — has an activation cost (Equip)
 *   permissive — grants timing permission (Action, Reaction)
 *   cost       — optional/additional cost paid while playing (Accelerate, Repeat)
 *   dependent  — conditional gain of inner text (Legion, Level)
 *   deckbuild  — only matters during deck construction (Unique)
 */

export const KEYWORDS = {
  Accelerate: {
    kind: "cost",
    hasValue: false,
    summary:
      'As you play me, you may pay [1] and 1 Power as an additional cost. If you do, I enter ready.',
    rule: "805",
    // Power must match the unit's domain if single-domain; else any ([A]).
  },
  Action: {
    kind: "permissive",
    summary: "May be played/activated during Showdowns on any player's turn.",
    rule: "806",
    allowsState: ["ShowdownOpen", "ShowdownClosed:self"],
  },
  Assault: {
    kind: "passive",
    hasValue: true,
    default: 1,
    summary: "While I am an attacker, I have +X Might.",
    rule: "807",
    appliesWhen: "attacker",
    mightDelta: (v) => v,
  },
  Deathknell: {
    kind: "triggered",
    summary: "When I die (killed → trash), [effect].",
    rule: "808",
    trigger: "died",
  },
  Deflect: {
    kind: "passive",
    hasValue: true,
    default: 1,
    summary:
      "Opponent spells/abilities that choose me cost X more Power each time they choose me.",
    rule: "809",
  },
  Ganking: {
    kind: "passive",
    summary: "I may make a standard move from one battlefield to another.",
    rule: "810",
  },
  Hidden: {
    kind: "passive",
    summary:
      "You may pay [A] to hide me facedown at a battlefield you control; next turn I gain Reaction and can be played ignoring base cost.",
    rule: "811",
    grantsWhileFacedown: ["Reaction"],
  },
  Legion: {
    kind: "dependent",
    summary: "If you have played another card this turn, I gain [text].",
    rule: "812",
    condition: "playedAnotherCardThisTurn",
  },
  Reaction: {
    kind: "permissive",
    summary:
      "Has all of Action, plus may be played/activated during Closed States on any player's turn.",
    rule: "813",
    allowsState: ["ShowdownOpen", "ShowdownClosed", "NeutralClosed"],
    implies: ["Action"],
  },
  Shield: {
    kind: "passive",
    hasValue: true,
    default: 1,
    summary: "While I am a defender, I have +X Might.",
    rule: "814",
    appliesWhen: "defender",
    mightDelta: (v) => v,
  },
  Tank: {
    kind: "passive",
    summary:
      "I must be assigned lethal combat damage before non-Tank units I share a controller with.",
    rule: "815",
    damageOrder: "first",
  },
  Backline: {
    kind: "passive",
    summary:
      "I must be assigned lethal combat damage after non-Backline units I share a controller with.",
    rule: "826",
    damageOrder: "last",
  },
  Temporary: {
    kind: "triggered",
    summary:
      "At the start of my controller's Beginning Phase, before scoring, kill me.",
    rule: "816",
    trigger: "beginningPhase:self",
  },
  Vision: {
    kind: "triggered",
    summary: "When I'm played, look at the top of your Main Deck; you may recycle it.",
    rule: "817",
    trigger: "played:self",
  },
  Equip: {
    kind: "activated",
    summary: "[Cost]: Attach this gear to a unit you control.",
    rule: "818",
  },
  "Quick-Draw": {
    kind: "triggered",
    summary: "Has Reaction; when played, attach to a unit you control.",
    rule: "819",
    implies: ["Reaction"],
  },
  Repeat: {
    kind: "cost",
    hasValue: true,
    summary: "You may pay [Cost] to execute this spell's instructions one more time.",
    rule: "820",
  },
  Weaponmaster: {
    kind: "triggered",
    summary:
      "When played, you may attach an Equipment you control to me, paying its Equip cost reduced by [A].",
    rule: "821",
    trigger: "played:self",
  },
  Ambush: {
    kind: "passive",
    summary:
      "I may be played to a battlefield where you control units, and have Reaction while doing so.",
    rule: "822",
  },
  Hunt: {
    kind: "triggered",
    hasValue: true,
    default: 1,
    summary: "When I Conquer or Hold, my controller gains X XP.",
    rule: "823",
    trigger: "scored:self",
  },
  Level: {
    kind: "dependent",
    hasValue: true,
    summary: "While you have N or more XP, I gain [text].",
    rule: "824",
    condition: "xpAtLeast",
  },
  Unique: {
    kind: "deckbuild",
    summary: "A deck may contain only one card of this name.",
    rule: "825",
  },
};

export const KEYWORD_NAMES = Object.keys(KEYWORDS);

/** Effective keyword list for either a GameObject ({def,grantedKeywords}) or a
 * raw card def ({keywords}). Granted keywords (from effects) are merged in. */
export function effectiveKeywords(obj) {
  if (!obj) return [];
  if (obj.def) return [...(obj.def.keywords || []), ...(obj.grantedKeywords || [])];
  return obj.keywords || [];
}

/** Does this object have a keyword (optionally returning its value)? */
export function hasKeyword(obj, name) {
  const list = effectiveKeywords(obj);
  return list.some((k) => (typeof k === "string" ? k === name : k.kw === name));
}

export function keywordValue(obj, name) {
  const list = effectiveKeywords(obj);
  for (const k of list) {
    if (typeof k === "object" && k.kw === name)
      return k.value ?? KEYWORDS[name]?.default ?? null;
  }
  return hasKeyword(obj, name) ? KEYWORDS[name]?.default ?? null : null;
}

/** Permissive keywords that let a card act outside the turn player's main phase. */
export function timingPermissions(obj) {
  const out = new Set();
  if (hasKeyword(obj, "Reaction")) {
    out.add("Action");
    out.add("Reaction");
    return out;
  }
  if (hasKeyword(obj, "Action")) out.add("Action");
  return out;
}
