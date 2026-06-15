# Riftbound Solo Trainer — Architecture & Roadmap

A **local, offline** practice tool: you pilot your deck while a **bot plays the
opponent's deck**, with a rules engine built faithfully to the official
*Riftbound Core Rules* (RUP3, last updated 2026-03-30). Built for private deck
testing only — pause, reset, or swap decks at any moment.

> Riot was contacted and approved this private, local-only training use.
> The card-data fetcher pulls from the public gallery (a permitted database
> use); the app itself never connects to live opponents.

## Design goals (from the brief)

1. **A bot opponent** that plays a full opponent decklist, not just goldfishing.
2. **Full-rulebook fidelity** — so practice never trains bad habits, illegal
   plays, or wrong action ordering. The engine enforces phases, priority, the
   Chain, showdowns, and combat exactly as written.
3. **Card-text fidelity** — top decks lean on specific card text, so cards are
   real implementations, not vanilla stand-ins.
4. **Paste-in decklists, saved locally** so you don't re-paste each session.
5. **No storage limit** — multi-file project, full card DB cached locally.

## Why a from-scratch engine (not automating Rift Atlas / TCG Arena)

Those are human-vs-human simulators with no rules enforcement and no AI; driving
them via a script is fragile and still gives you no opponent. A controlled local
engine is the only way to get an enforcing rules engine **and** a bot.

## Repository layout

```
index.html              Legacy "Gridiron Cup" app (unrelated; left untouched)
trainer.html            Riftbound trainer entry point (loads src/* as ES modules)
tools/
  fetch_cards.mjs       Node 18+ script: pull all cards → data/cards.json
data/
  cards.json            Generated card DB (you run the fetcher; git-ignored)
src/
  engine/               Framework-agnostic rules engine (pure JS, unit-testable)
    state.js            Game state, zones, game objects, RNG
    cards.js            Card DB loader, deck parsing/validation, deck storage
    keywords.js         The 22 Core-Rules keywords (§800)
    effects.js          Ability-text interpreter → structured effects
    chain.js            Chain, priority, focus, FEPR resolution (§300–340)
    combat.js           Showdowns + combat steps + damage assignment (§454–461)
    scoring.js          Conquer / Hold / Victory Score (§462–466)
    rules.js            Turn structure orchestrator (§300–317) + legal-action gen
  ai/
    bot.js              Opponent AI: legal-move generation + heuristic policy
  ui/
    app.js              React (CDN + htm, no build step) board & controls
docs/
  ARCHITECTURE.md       This file
  RULES_MAP.md          Rule-number → code mapping (the fidelity ledger)
```

## Engine model (faithful mapping)

| Core Rules concept | Where |
|---|---|
| Zones: Base, Battlefield Zone, Facedown, Hand, Main/Rune Deck, Trash, Legend, Champion, Banishment (§103–107) | `state.js` |
| Turn: Awaken → Beginning(Score) → Channel(+2 runes) → Draw → Main → Ending (§315–317) | `rules.js` |
| States: Neutral/Showdown × Open/Closed (§307–310) | `chain.js` |
| Priority & Focus (§311–313) | `chain.js` |
| The Chain + Resolve/FEPR (§320–340) | `chain.js` |
| Combat: Showdown → Damage → Resolution (§454–461) | `combat.js` |
| Damage assignment incl. Tank/Backline ordering (§460) | `combat.js` |
| Conquer / Hold / Winning Point (§462–466) | `scoring.js` |
| 1v1 Duel: Victory Score 8, 2 battlefields, 2nd player +1 rune turn 1 (§480) | `rules.js` |
| Keywords (§805–826) | `keywords.js` |

## Card-text fidelity strategy

We **cannot** hand-author 664 cards in one pass, so fidelity is layered:

1. **Keywords (22)** — fully implemented in `keywords.js`; cover a large share
   of card text mechanically (Tank, Shield, Assault, Deflect, Accelerate, …).
2. **Effect interpreter** (`effects.js`) — parses common oracle patterns into
   structured effects: *deal N to a unit*, *draw N*, *give +X/-X Might*, *kill*,
   *recall*, *create token*, *gain XP*, *channel/draw runes*, modal "Choose one",
   `Repeat`, etc.
3. **Manual overrides** — cards whose text the interpreter can't fully capture
   get a hand-written implementation keyed by card `id` in a registry. The UI
   **clearly flags** any card running on a partial/auto implementation, so you
   always know whether an interaction is engine-accurate.

`docs/RULES_MAP.md` is the living ledger of coverage — nothing is silently faked.

## Build milestones

- **M1 — Foundation ✅:** data pipeline, engine skeleton, zones, deck import/save,
  §103 validation, all 22 keywords encoded.
- **M2 — Match engine ✅ (headless):** setup/mulligan, full turn structure, Chain
  + priority/focus, showdowns, combat (Might sums, Tank/Backline damage order),
  Conquer/Hold scoring to Victory Score 8, a legal-move bot, and a first-pass
  effect interpreter. Verified by `node tools/sim.mjs --games 200` (0 stalls,
  0 illegal actions, sensible first-player win rate).
- **M2.5 — Interactive board (next):** wire the engine into a play UI so you can
  pilot your deck against the bot in the browser, with a live rules-trace log.
- **M3 — Effects & keywords:** grow the interpreter, add a manual override
  registry for cards it can't parse; UI flags any partial card.
- **M4 — Bot intelligence:** tempo/board/contest/combat-math heuristics, plus
  Action/Reaction play in showdowns.
- **M5 — Polish:** mulligan UI, undo, deck manager, "why is this (il)legal?" tips.

### Engine verification

`tools/sim.mjs` plays full bot-vs-bot games headlessly (the engine is pure JS,
no DOM), which is how M2 was validated and how regressions are caught going
forward. Run `node tools/sim.mjs --games 200`.

## Running it

1. `node tools/fetch_cards.mjs` on your machine → `data/cards.json`.
2. Serve the folder: `python3 -m http.server 8080` (ES modules need http://).
3. Open `http://localhost:8080/trainer.html`, paste your deck + a bot deck, play.
