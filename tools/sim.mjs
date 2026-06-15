#!/usr/bin/env node
/*
 * Headless engine self-test: build two decks from the sample DB and play a full
 * bot-vs-bot game to completion. Verifies setup, the turn loop, the chain,
 * combat, and scoring all run without crashing or stalling and reach a winner.
 *
 *   node tools/sim.mjs            # one game, summary
 *   node tools/sim.mjs --verbose  # print the event log
 *   node tools/sim.mjs --games 50 # stress-run many seeds
 */
import { readFileSync } from "node:fs";
import { makeGame } from "../src/engine/state.js";
import { parseDecklist } from "../src/engine/cards.js";
import { setupGame, advance, submitAction, legalActions } from "../src/engine/rules.js";
import { chooseAction } from "../src/ai/bot.js";

// Load sample DB and build a DB shim (parseDecklist takes a db arg).
const payload = JSON.parse(readFileSync(new URL("../src/data/cards.sample.json", import.meta.url)));
const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const byName = new Map();
for (const c of payload.cards) byName.set(norm(c.name), c);
const db = { byName, byId: new Map(payload.cards.map((c) => [c.id, c])), all: payload.cards };

const DECK = `Legend: Jinx, Loose Cannon
Champion: Jinx, Rebel
Main:
3 Zaun Tinkerer
3 Chem-Bruiser
3 Powder Skirmisher
3 Rooftop Sniper
3 Stalwart Warden
3 Get Excited!
3 Rocket Barrage
3 Rally the Crew
3 Powder Keg
Battlefields:
1 Chem Market
1 Sump Pier
1 Chem Market
Runes:
12 Fury Rune`;

function playGame(seed, verbose) {
  const deck = parseDecklist(DECK, db);
  const g = makeGame({
    players: [
      { id: "p1", name: "Alpha", isBot: true },
      { id: "p2", name: "Beta", isBot: true },
    ],
    seed,
  });
  setupGame(g, [{ deck }, { deck }]);
  advance(g);

  let steps = 0;
  while (!g.winnerId && steps++ < 4000) {
    const pid = g.priorityId;
    if (!pid) { advance(g); continue; }
    const action = chooseAction(g, pid);
    if (!action) { advance(g); continue; }
    try {
      submitAction(g, pid, action, autoTarget);
    } catch (e) {
      throw new Error(`Illegal action by ${pid}: ${JSON.stringify(action)} → ${e.message}`);
    }
    // Safety: detect a stuck turn counter.
    if (g.turn > 300) throw new Error("Game exceeded 300 turns — likely a loop.");
  }
  if (verbose) {
    console.log([...g.log].reverse().map((e) => `T${e.turn} ${e.text}`).join("\n"));
  }
  return { winnerId: g.winnerId, turns: g.turn, steps, p1: g.players[0].points, p2: g.players[1].points };
}

// Bot target chooser (mirror of effects.autoChoose; kept here for the harness).
import { autoChoose } from "../src/engine/effects.js";
const autoTarget = autoChoose;

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const gi = args.indexOf("--games");
const games = gi >= 0 ? parseInt(args[gi + 1], 10) : 1;

let wins = { p1: 0, p2: 0, none: 0 };
let totalTurns = 0;
for (let i = 0; i < games; i++) {
  const r = playGame(1000 + i, verbose && games === 1);
  totalTurns += r.turns;
  if (r.winnerId === "p1") wins.p1++;
  else if (r.winnerId === "p2") wins.p2++;
  else wins.none++;
  if (games === 1)
    console.log(`Game over: winner=${r.winnerId} after ${r.turns} turns / ${r.steps} actions (score ${r.p1}-${r.p2}).`);
}
if (games > 1) {
  console.log(`Ran ${games} games. Wins: p1=${wins.p1} p2=${wins.p2} none=${wins.none}. Avg turns=${(totalTurns / games).toFixed(1)}.`);
  if (wins.none > 0) console.log(`⚠ ${wins.none} games ended with no winner (turn cap) — investigate.`);
}
