#!/usr/bin/env node
/*
 * Riftbound card-data fetcher
 * --------------------------------------------------------------------------
 * Pulls the FULL card list (name, cost, Might, domains, tags, type, and the
 * complete oracle / ability text) from the official Riftbound card gallery and
 * writes it to data/cards.json, which the trainer app loads at runtime.
 *
 * The official site is a Next.js app that ships a no-auth JSON data endpoint:
 *     https://riftbound.leagueoflegends.com/_next/data/<BUILD_ID>/en-us/card-gallery.json
 * The BUILD_ID changes whenever Riot redeploys, so we scrape the gallery HTML
 * first to discover the current one, then download the JSON.
 *
 * Run it on YOUR machine (the trainer's sandbox can't reach Riot's CDN):
 *     node tools/fetch_cards.mjs
 *     node tools/fetch_cards.mjs --out data/cards.json --pretty
 *     node tools/fetch_cards.mjs --raw data/cards.raw.json   # also keep the raw dump
 *
 * Requires Node 18+ (uses the built-in global fetch). No npm install needed.
 *
 * NOTE ON SCOPE: this is a card *database* fetch — exactly the category Riot's
 * third-party policy permits (galleries / deckbuilders / theorycrafting). It is
 * not an automated-gameplay client. We hit the endpoint a handful of times with
 * a polite delay; do not crank up the request rate.
 * --------------------------------------------------------------------------
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const BASE = "https://riftbound.leagueoflegends.com";
const GALLERY = "/en-us/card-gallery/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ----------------------------- arg parsing ------------------------------ */
function parseArgs(argv) {
  const args = { out: "data/cards.json", raw: null, pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--raw") args.raw = argv[++i] || "data/cards.raw.json";
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node tools/fetch_cards.mjs [--out file] [--raw file] [--pretty]"
      );
      process.exit(0);
    }
  }
  return args;
}

/* ------------------------------ utilities ------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asJson = false) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: asJson ? "application/json" : "text/html" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return asJson ? res.json() : res.text();
}

/* Discover the current Next.js build id from the gallery HTML. */
async function findBuildId() {
  const html = await get(BASE + GALLERY);
  // Most reliable: the buildManifest path. Fall back to "buildId" in __NEXT_DATA__.
  const m =
    html.match(/\/_next\/static\/([^/"]+)\/_buildManifest\.js/) ||
    html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error("Could not locate Next.js build id in gallery HTML.");
  return m[1];
}

/* The cards live in one of the "blades" of the page payload. The exact index
 * shifts between deploys, so we search every blade for the cards collection
 * instead of hard-coding blades[2]. */
function extractItems(data) {
  const blades = data?.pageProps?.page?.blades;
  if (Array.isArray(blades)) {
    for (const b of blades) {
      const items = b?.cards?.items;
      if (Array.isArray(items) && items.length) return items;
    }
  }
  // Last resort: deep-scan for the first array of objects that look like cards.
  let found = null;
  const seen = new Set();
  (function walk(node) {
    if (found || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === "object" && "name" in x))
        found = node;
      else node.forEach(walk);
    } else {
      for (const k of Object.keys(node)) walk(node[k]);
    }
  })(data);
  if (!found) throw new Error("Could not find a cards array in the payload.");
  return found;
}

/* -------------------------- text normalisation -------------------------- */
/* Riot stores ability text as HTML with inline cost glyphs. Convert it into
 * clean plain text while preserving the bracket tokens the engine parses,
 * e.g. [1], [P], [Action], [>], [M], [S]. */
function htmlToOracle(html) {
  if (!html) return "";
  let t = String(html);
  // Cost / symbol glyphs are usually <span class="...energy-3...">; many dumps
  // already inline readable tokens. Normalise common ones, then strip tags.
  t = t
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<li>/gi, "\n• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t;
}

const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/* Map a raw card object to our normalised schema. */
function normalise(card) {
  const type = card?.cardType?.type?.[0] || {};
  const superTypes = (card?.cardType?.superType || []).map((s) => s.label);
  const domains = (card?.domain?.values || []).map((d) => d.label);
  const oracle = htmlToOracle(card?.text?.richText?.body || "");
  return {
    id: card.id,
    name: card.name,
    code: card.publicCode || null,
    number: card.collectorNumber ?? null,
    set: card?.set?.value?.id || null,
    setName: card?.set?.value?.label || null,
    type: type.label || null, // Unit | Spell | Gear | Legend | Battlefield | Rune
    typeId: type.id || null,
    superTypes, // e.g. ["Champion"], ["Signature"]
    rarity: card?.rarity?.value?.label || null,
    domains, // e.g. ["Fury"], ["Calm","Mind"]
    energy: num(card?.energy?.value?.id), // main-deck play cost (Units/Gear)
    might: num(card?.might?.value?.id), // Units
    power: num(card?.power?.value?.id), // Power pip cost where present
    tags: card?.tags?.tags || [], // e.g. ["Jinx","Yordle"]
    oracle, // full ability / rules text, plain
    abilityHtml: card?.text?.richText?.body || "", // kept for re-parsing
    image: card?.cardImage?.url || null,
    keywords: detectKeywords(oracle),
  };
}

/* The 22 keywords from Core Rules §800. Detection is text-based; the engine
 * treats these as first-class. Anything else lives in `oracle` for the
 * effect-interpreter / manual implementation layer. */
const KEYWORDS = [
  "Accelerate", "Action", "Assault", "Deathknell", "Deflect", "Ganking",
  "Hidden", "Legion", "Reaction", "Shield", "Tank", "Temporary", "Vision",
  "Equip", "Quick-Draw", "Repeat", "Weaponmaster", "Ambush", "Hunt",
  "Level", "Unique", "Backline",
];
function detectKeywords(oracle) {
  const out = [];
  for (const kw of KEYWORDS) {
    // Match "Shield", "Shield 2", "[Shield]", "[Shield 3]" etc.
    const re = new RegExp(`\\[?${kw.replace("-", "\\-")}\\b(?:\\s*(\\d+))?\\]?`, "i");
    const m = oracle.match(re);
    if (m) out.push(m[1] ? { kw, value: num(m[1]) } : { kw });
  }
  return out;
}

/* -------------------------------- main ---------------------------------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("Riftbound card fetcher");
  console.log("Discovering build id…");
  const buildId = await findBuildId();
  console.log("  build id:", buildId);

  await sleep(400); // be polite
  const url = `${BASE}/_next/data/${buildId}/en-us/card-gallery.json`;
  console.log("Downloading card payload…");
  const data = await get(url, true);

  const rawItems = extractItems(data);
  console.log(`  found ${rawItems.length} cards`);

  if (args.raw) {
    await mkdir(dirname(args.raw), { recursive: true });
    await writeFile(args.raw, JSON.stringify(rawItems, null, 2));
    console.log("  raw dump →", args.raw);
  }

  const cards = rawItems.map(normalise);

  // Summaries so you can sanity-check the pull.
  const byType = {};
  const bySet = {};
  for (const c of cards) {
    byType[c.type || "?"] = (byType[c.type || "?"] || 0) + 1;
    bySet[c.setName || "?"] = (bySet[c.setName || "?"] || 0) + 1;
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    buildId,
    count: cards.length,
    cards,
  };
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(
    args.out,
    JSON.stringify(payload, null, args.pretty ? 2 : 0)
  );

  console.log("\nDone.");
  console.log("  output:", args.out);
  console.log("  by set:", bySet);
  console.log("  by type:", byType);
}

main().catch((e) => {
  console.error("\nFetch failed:", e.message);
  console.error(
    "\nIf the official endpoint is unreachable, you can also export a deck/card\n" +
      "list from Piltover Archive or Rift Atlas and adapt tools/fetch_cards.mjs to\n" +
      "their JSON — the app only needs the normalised schema in data/cards.json."
  );
  process.exit(1);
});
