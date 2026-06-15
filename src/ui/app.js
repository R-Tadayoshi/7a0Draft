/*
 * Riftbound Solo Trainer — UI shell (Milestone 1).
 * React + htm via CDN, no build step. This milestone proves the data pipeline:
 * load the card DB, paste/validate/save your deck and the bot's deck against the
 * real Core-Rules deck-construction checks. The live match engine (chain,
 * combat, scoring) and the bot land in subsequent milestones — see the status
 * panel and docs/ARCHITECTURE.md.
 */
import { html, render, useState, useEffect } from "https://esm.sh/htm/react?deps=react@18,react-dom@18";
import {
  loadCardDB,
  parseDecklist,
  validateDeck,
  loadDecks,
  saveDeck,
  deleteDeck,
} from "../engine/cards.js";
import { KEYWORDS } from "../engine/keywords.js";

const SAMPLE_DECK = `# Sample Fury deck (works with the bundled sample DB)
Legend: Jinx, Loose Cannon
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

function DeckPanel({ title, accent, db, value, onChange }) {
  const [parsed, setParsed] = useState(null);
  const [report, setReport] = useState(null);
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(loadDecks());

  function check() {
    const p = parseDecklist(value, db);
    const r = validateDeck(p);
    setParsed(p);
    setReport(r);
  }

  return html`
    <div class="panel" style=${{ borderTopColor: accent }}>
      <div class="panel-h">
        <span class="dot" style=${{ background: accent }}></span>${title}
      </div>
      <textarea
        class="deck-input"
        spellcheck="false"
        placeholder="Paste a decklist…  e.g.  3 Get Excited!"
        value=${value}
        onInput=${(e) => onChange(e.target.value)}
      ></textarea>
      <div class="row">
        <button class="btn" onClick=${check}>Validate</button>
        <input
          class="txt"
          placeholder="save as…"
          value=${saveName}
          onInput=${(e) => setSaveName(e.target.value)}
        />
        <button
          class="btn ghost"
          disabled=${!saveName.trim()}
          onClick=${() => {
            setSaved(saveDeck(saveName.trim(), value));
            setSaveName("");
          }}
        >Save</button>
      </div>
      ${Object.keys(saved).length > 0 &&
      html`<div class="saved">
        ${Object.keys(saved).map(
          (n) => html`<span class="chip" key=${n}>
            <button class="link" onClick=${() => onChange(saved[n].text)}>${n}</button>
            <button class="x" onClick=${() => setSaved(deleteDeck(n))}>×</button>
          </span>`
        )}
      </div>`}
      ${report &&
      html`<div class="report">
        <div class=${report.ok ? "ok" : "bad"}>
          ${report.ok ? "✓ Legal deck" : `✗ ${report.errors.length} problem(s)`}
        </div>
        <div class="counts">
          Main ${report.counts.mainCount} · Runes ${report.counts.runeCount} ·
          Battlefields ${report.counts.bfCount} · Signatures ${report.counts.sigCount}
          ${parsed?.identity?.length ? ` · Identity ${parsed.identity.join("/")}` : ""}
        </div>
        ${report.errors.map((e, i) => html`<div class="err" key=${i}>• ${e}</div>`)}
        ${report.warnings.map((w, i) => html`<div class="warn" key=${i}>• ${w}</div>`)}
      </div>`}
    </div>
  `;
}

function App() {
  const [db, setDb] = useState(null);
  const [err, setErr] = useState(null);
  const [usingSample, setUsingSample] = useState(false);
  const [mine, setMine] = useState("");
  const [bot, setBot] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const d = await loadCardDB("data/cards.json");
        setDb(d);
      } catch {
        try {
          const d = await loadCardDB("src/data/cards.sample.json");
          setDb(d);
          setUsingSample(true);
          setMine(SAMPLE_DECK);
        } catch (e2) {
          setErr(e2.message);
        }
      }
    })();
  }, []);

  if (err)
    return html`<div class="wrap"><div class="banner bad">${err}</div></div>`;
  if (!db) return html`<div class="wrap"><div class="banner">Loading card database…</div></div>`;

  return html`
    <div class="wrap">
      <header>
        <div class="logo">Riftbound <span>Solo Trainer</span></div>
        <div class="db-meta">
          ${db.meta.count} cards${usingSample ? " (sample)" : ""}
        </div>
      </header>

      ${usingSample &&
      html`<div class="banner warn">
        Using the bundled sample database. Run
        <code>node tools/fetch_cards.mjs</code> on your machine to generate the
        full <code>data/cards.json</code> (all ~664 cards), then reload.
      </div>`}

      <div class="decks">
        <${DeckPanel} title="Your deck" accent="#02a644" db=${db} value=${mine} onChange=${setMine} />
        <${DeckPanel} title="Bot's deck" accent="#ff7700" db=${db} value=${bot} onChange=${setBot} />
      </div>

      <${StatusPanel} />
    </div>
  `;
}

function StatusPanel() {
  const kw = Object.entries(KEYWORDS);
  return html`
    <div class="status">
      <div class="status-h">Build status</div>
      <ul>
        <li class="done">✓ Card-data fetcher (<code>tools/fetch_cards.mjs</code>)</li>
        <li class="done">✓ Decklist paste, parse & save (localStorage)</li>
        <li class="done">✓ Core-Rules §103 deck validation (size, copies, domain identity, signatures)</li>
        <li class="done">✓ Game-state model & all ${kw.length} keywords encoded</li>
        <li class="done">✓ Live match engine: turn phases, Chain, priority/focus, showdowns</li>
        <li class="done">✓ Combat (Might sums, Tank/Backline) & scoring to Victory Score 8</li>
        <li class="done">✓ Bot opponent + effect interpreter (verified: 200 headless games, 0 stalls)</li>
        <li class="todo">▢ Interactive board UI to play in-browser (next)</li>
        <li class="todo">▢ Expand card-effect coverage + manual overrides (ongoing, M3)</li>
        <li class="todo">▢ Smarter bot: combat math, resource curve, reaction play (M4)</li>
      </ul>
      <div style=${{ fontSize: "12px", color: "var(--muted)", margin: "0 0 12px" }}>
        Engine is verified headlessly via <code>node tools/sim.mjs --games 200</code>.
        The interactive board (play against the bot in this page) is the next step.
      </div>
      <div class="kw-h">Keywords encoded</div>
      <div class="kw-grid">
        ${kw.map(([name, k]) => html`<span class="kw" key=${name} title=${k.summary}>${name}</span>`)}
      </div>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));
