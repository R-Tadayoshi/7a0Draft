/*
 * Card database + decklist handling.
 *  - loadCardDB(): read data/cards.json (from tools/fetch_cards.mjs)
 *  - parseDecklist(): turn pasted text into a structured deck
 *  - validateDeck(): enforce Core Rules §103 deck-construction
 *  - saveDeck()/loadDecks(): persist to localStorage so you never re-paste
 *
 * Decklist text format (forgiving — matches common Riftbound exports):
 *   Lines like "3 Get Excited!"  or  "3x Get Excited!"  or  "Get Excited! x3"
 *   Section headers (Champion:, Legend:, Battlefields:, Runes:, Main:) optional.
 *   A leading "1 <Champion Unit>" with a Champion supertype is auto-detected as
 *   the Chosen Champion; the Legend line is matched to a Legend-type card.
 *   Lines starting with # or // are comments.
 */

const LS_KEY = "riftbound.trainer.decks.v1";

let DB = null; // { byId, byName, all }

export async function loadCardDB(url = "data/cards.json") {
  if (DB) return DB;
  let payload;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    payload = await res.json();
  } catch (e) {
    throw new Error(
      `Could not load ${url} (${e.message}). Run "node tools/fetch_cards.mjs" first.`
    );
  }
  const all = payload.cards || payload; // tolerate raw array
  const byId = new Map();
  const byName = new Map();
  for (const c of all) {
    byId.set(c.id, c);
    byName.set(normName(c.name), c);
  }
  DB = { byId, byName, all, meta: { count: all.length, fetchedAt: payload.fetchedAt } };
  return DB;
}

export function getDB() {
  if (!DB) throw new Error("Card DB not loaded — call loadCardDB() first.");
  return DB;
}

const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/* Parse pasted decklist text into { entries:[{name,qty,card,found}], champion,
 * legend, battlefields[], runes[], errors[] }. Resolution is best-effort against
 * the loaded DB; unresolved names are reported, not dropped. */
export function parseDecklist(text, db = getDB()) {
  const lines = String(text).split(/\r?\n/);
  const result = {
    main: [],
    champion: null,
    legend: null,
    battlefields: [],
    runes: [],
    warnings: [],
  };
  let section = "main";
  const lineRe = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s*[xX]\s*(\d+))?\s*$/;

  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    // A section header, with or without an inline card after the colon.
    // "Legend:"            → switch section, next lines belong to it
    // "Legend: Jinx, ..."  → switch section AND parse the remainder as a card
    const hdr = line.match(/^(champion|legend|battlefields?|runes?|main(?:\s*deck)?)\s*:\s*(.*)$/i);
    if (hdr) {
      const h = hdr[1].toLowerCase();
      section = h.startsWith("champion") ? "champion"
        : h.startsWith("legend") ? "legend"
        : h.startsWith("battlefield") ? "battlefields"
        : h.startsWith("rune") ? "runes" : "main";
      if (!hdr[2].trim()) continue; // header only; nothing left to parse
      line = hdr[2].trim(); // fall through to parse the inline card
    }
    const m = line.match(lineRe);
    if (!m) continue;
    const qty = parseInt(m[1] || m[3] || "1", 10);
    const name = m[2].trim();
    const card = db.byName.get(normName(name)) || null;
    if (!card) result.warnings.push(`Unknown card: "${name}"`);
    const entry = { name, qty, card, id: card?.id || null };

    // Route by explicit section, else infer from card type.
    const type = card?.type;
    const isChampUnit =
      type === "Unit" && (card?.superTypes || []).some((s) => /champion/i.test(s));
    if (section === "legend" || type === "Legend") result.legend = entry;
    else if (section === "champion" || (section === "main" && isChampUnit && !result.champion))
      result.champion = result.champion || entry;
    else if (section === "battlefields" || type === "Battlefield") result.battlefields.push(entry);
    else if (section === "runes" || type === "Rune") result.runes.push(entry);
    else result.main.push(entry);

    // A champion unit also belongs in the main deck (the chosen one is a copy).
    if (isChampUnit && section !== "champion" && entry !== result.champion)
      result.main.push(entry);
  }
  return result;
}

/* Validate against §103. Returns { ok, errors[], warnings[], counts }. */
export function validateDeck(deck) {
  const errors = [];
  const warnings = [...(deck.warnings || [])];

  const mainCount = deck.main.reduce((n, e) => n + e.qty, 0);
  if (mainCount < 40) errors.push(`Main deck has ${mainCount} cards; minimum is 40 (§103.2).`);

  if (!deck.legend) errors.push("No Champion Legend found (§103.1).");
  if (!deck.champion) errors.push("No Chosen Champion unit found (§103.2.a).");

  // Domain identity from the legend (§103.1.b).
  const identity = (deck.legend?.card?.domains || []).map((d) => d.toLowerCase());
  deck.identity = identity;

  // ≤3 copies per named card (§103.2.b); Unique → 1 (§825).
  const byName = new Map();
  for (const e of deck.main) byName.set(e.name, (byName.get(e.name) || 0) + e.qty);
  for (const [name, n] of byName) {
    const card = deck.main.find((e) => e.name === name)?.card;
    const isUnique = (card?.keywords || []).some((k) => (k.kw || k) === "Unique");
    const max = isUnique ? 1 : 3;
    if (n > max) errors.push(`"${name}" appears ${n}× (max ${max}).`);
    // Domain-identity legality (§103.1.b.3/4).
    if (card && identity.length) {
      const cd = (card.domains || []).map((d) => d.toLowerCase());
      if (cd.length && !cd.every((d) => identity.includes(d)))
        errors.push(`"${name}" (${cd.join("/")}) is outside your ${identity.join("/") || "—"} identity.`);
    }
  }

  // Signature cap: ≤3 total signature cards matching the legend's champion tag (§103.2.d).
  const sigCount = deck.main
    .filter((e) => (e.card?.superTypes || []).some((s) => /signature/i.test(s)))
    .reduce((n, e) => n + e.qty, 0);
  if (sigCount > 3) errors.push(`${sigCount} Signature cards; max 3 (§103.2.d).`);

  // Rune deck: exactly 12 (§103.3.a). If absent, we can auto-fill at game start.
  const runeCount = deck.runes.reduce((n, e) => n + e.qty, 0);
  if (runeCount && runeCount !== 12)
    warnings.push(`Rune deck has ${runeCount} runes; rules expect 12 (§103.3.a).`);

  // Battlefields: duel provides 3, uses 1 (§480.4). Warn if not 3.
  const bfCount = deck.battlefields.reduce((n, e) => n + e.qty, 0);
  if (bfCount && bfCount !== 3)
    warnings.push(`${bfCount} battlefields provided; duel expects 3 (§480.4).`);

  return { ok: errors.length === 0, errors, warnings, counts: { mainCount, runeCount, bfCount, sigCount } };
}

/* ---- local persistence ---- */
export function loadDecks() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
export function saveDeck(name, text) {
  const all = loadDecks();
  all[name] = { text, savedAt: Date.now() };
  localStorage.setItem(LS_KEY, JSON.stringify(all));
  return all;
}
export function deleteDeck(name) {
  const all = loadDecks();
  delete all[name];
  localStorage.setItem(LS_KEY, JSON.stringify(all));
  return all;
}
