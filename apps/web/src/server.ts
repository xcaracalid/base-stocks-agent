/**
 * Stock Agent on Base — public dashboard (v1).
 *
 * A zero-dependency Node HTTP server that renders two pages straight from
 * the project's own snapshot store on every request:
 *
 *   /        Watchlist — every tokenized stock the store knows: live
 *            Aerodrome DEX price vs Chainlink NAV, premium/discount, pool
 *            depth, feed freshness, composite score.
 *   /agent   Agent — the paper portfolio (equity, cash, holdings) and the
 *            full decision log read from the stored decision records.
 *
 * All numbers come from the store (Tokenized Stocks API snapshots,
 * Chainlink cross-checks, Aerodrome reads, agent decision records) via
 * the same code the agent itself uses — nothing is hardcoded or mocked.
 *
 * Run: npm run web   (PORT env to change the port, default 4173)
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { SnapshotStore } from "../../../packages/data/src/store.ts";
import { computeSignals, type TokenSignals } from "../../../packages/signals/src/engine.ts";
import {
  deserializePortfolio,
  equityUsdc,
  type PaperPortfolio,
} from "../../../packages/portfolio/src/paper.ts";
import type { DecisionRecord } from "../../../packages/portfolio/src/planner.ts";

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

// ---------------------------------------------------------------- helpers

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function usd(v: number | null | undefined, digits: "2" | "4" = "2"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return "$" + (digits === "4" ? nf4 : nf2).format(v);
}

function num(v: number | null | undefined, dp = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function pct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(dp)}%`;
}

function compactUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function ageStr(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** "2026-11-19T13:57:56.889Z" → "2026-11-19 13:57 UTC" */
function timeStr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// ------------------------------------------------------------------- css

const CSS = `
  :root {
    --bg: #0a0e1a; --panel: #111830; --panel2: #0d1428; --line: #22305a;
    --text: #e9edf9; --muted: #8f9bbd; --faint: #5d6a8f;
    --accent: #4d7cff; --accent-dim: #1c2f66;
    --green: #34d399; --amber: #fbbf24; --red: #f87171;
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5; font-size: 15px;
  }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  a { color: var(--accent); text-decoration: none; }
  header.top {
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #0d1531, var(--bg));
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px; }
  .topbar { display: flex; align-items: center; gap: 14px; padding: 18px 0 6px; flex-wrap: wrap; }
  .logo {
    width: 42px; height: 42px; border-radius: 11px; flex: none;
    background: #0052ff; color: #fff; display: grid; place-items: center;
    font-weight: 800; font-size: 17px; letter-spacing: -0.5px;
  }
  .title h1 { margin: 0; font-size: 23px; letter-spacing: -0.3px; }
  .title p { margin: 1px 0 0; color: var(--muted); font-size: 13.5px; }
  .topright { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .pill {
    border: 1px solid var(--line); border-radius: 999px; padding: 3px 11px;
    font-size: 12.5px; color: var(--muted); background: var(--panel2); white-space: nowrap;
  }
  .pill.paper { border-color: #6b5518; color: var(--amber); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
  .dot.live { background: var(--green); box-shadow: 0 0 7px var(--green); }
  nav.tabs { display: flex; gap: 6px; padding: 10px 0 0; }
  nav.tabs a {
    padding: 7px 16px; border: 1px solid var(--line); border-bottom: none;
    border-radius: 9px 9px 0 0; color: var(--muted); font-size: 14px; background: var(--panel2);
  }
  nav.tabs a.active { color: var(--text); background: var(--panel); border-color: var(--line); font-weight: 600; }
  main { padding: 22px 0 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.7px; }
  .card .v { font-size: 24px; font-weight: 700; margin-top: 3px; }
  .card .s { color: var(--faint); font-size: 12.5px; margin-top: 1px; }
  section.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 20px; overflow: hidden; }
  section.panel > h2 { margin: 0; padding: 14px 18px 4px; font-size: 16.5px; }
  section.panel > p.sub { margin: 0; padding: 0 18px 12px; color: var(--muted); font-size: 13px; }
  .tblwrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th {
    text-align: left; color: var(--muted); font-size: 11.5px; text-transform: uppercase;
    letter-spacing: 0.6px; font-weight: 600; padding: 9px 14px; border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line); background: var(--panel2); white-space: nowrap;
  }
  td { padding: 9px 14px; border-bottom: 1px solid #1a2447; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: #141d3d; }
  td.r, th.r { text-align: right; }
  .sym { font-weight: 700; }
  .name { color: var(--muted); font-size: 12.5px; display: block; font-weight: 400; }
  .badge {
    display: inline-block; border-radius: 999px; padding: 1.5px 9px; font-size: 12px;
    border: 1px solid var(--line); white-space: nowrap;
  }
  .badge.green { color: var(--green); border-color: #14532d; background: #0c231a; }
  .badge.amber { color: var(--amber); border-color: #6b5518; background: #261d05; }
  .badge.red { color: var(--red); border-color: #6e2430; background: #2a0e13; }
  .badge.gray { color: var(--muted); background: var(--panel2); }
  .badge.blue { color: var(--accent); border-color: var(--accent-dim); background: #0d1a3d; }
  .pos { color: var(--green); } .neg { color: var(--red); }
  .muted { color: var(--muted); } .small { font-size: 12.5px; }
  .decision { padding: 4px 18px 16px; }
  .decision + .decision { border-top: 1px solid var(--line); }
  .decision h3 { margin: 14px 0 2px; font-size: 15.5px; }
  .decision .meta { color: var(--muted); font-size: 12.5px; margin-bottom: 8px; }
  .decision p.rationale { margin: 6px 0 12px; max-width: 88ch; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 12px; }
  details.uni { margin-top: 6px; }
  details.uni summary { cursor: pointer; color: var(--accent); font-size: 13px; padding: 4px 0; }
  footer { border-top: 1px solid var(--line); margin-top: 6px; }
  footer .wrap { padding-top: 16px; padding-bottom: 30px; color: var(--faint); font-size: 12.5px; }
  footer p { margin: 4px 0; max-width: 100ch; }
`;

// ----------------------------------------------------------------- shell

interface ShellOpts {
  active: "watchlist" | "agent";
  snapshotLabel: string;
}

function shell(opts: ShellOpts, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>Stock Agent on Base — ${opts.active === "watchlist" ? "Watchlist" : "Agent"}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="topbar">
      <div class="logo">SA</div>
      <div class="title">
        <h1>Stock Agent on Base</h1>
        <p>Autonomous research-to-portfolio agent · Coinbase tokenized stocks · Base</p>
      </div>
      <div class="topright">
        <span class="pill paper">PAPER PORTFOLIO</span>
        <span class="pill"><span class="dot live"></span>${esc(opts.snapshotLabel)}</span>
      </div>
    </div>
    <nav class="tabs">
      <a href="/" class="${opts.active === "watchlist" ? "active" : ""}">Watchlist</a>
      <a href="/agent" class="${opts.active === "agent" ? "active" : ""}">Agent &amp; Decisions</a>
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer>
  <div class="wrap">
    <p><strong>Not financial advice.</strong> This dashboard is a research demonstration built for the
    Base Stocks Maxxing Builder Quest. The portfolio shown is a <strong>paper portfolio</strong>:
    simulated USDC, simulated trades executed at Chainlink NAV inside the simulation only —
    no real funds are held, moved, or at risk, and nothing here is a promise of returns.</p>
    <p>Tokenized stocks are available only to persons in eligible jurisdictions <strong>outside the
    United States</strong>. This project does not enable trading for U.S. users and claims no rights
    in any underlying public company. Prices: Aerodrome DEX spot and Chainlink NAV on Base,
    snapshotted by the agent from public sources.</p>
  </div>
</footer>
</body>
</html>`;
}

// -------------------------------------------------------------- watchlist

function freshnessBadge(sig: TokenSignals): string {
  if (sig.navFreshness === "missing") return `<span class="badge gray">No NAV</span>`;
  if (sig.navFreshness === "stale")
    return `<span class="badge amber"><span class="dot" style="background:var(--amber)"></span>Stale · ${ageStr(sig.navAgeHours)} old</span>`;
  return `<span class="badge green"><span class="dot" style="background:var(--green)"></span>Fresh · ${ageStr(sig.navAgeHours)} old</span>`;
}

function premiumCell(sig: TokenSignals): string {
  const p = sig.premiumDiscountPct;
  if (p === null) {
    const label =
      sig.premiumDiscountStatus === "dust-pool" ? "Dust pool — excluded"
      : sig.premiumDiscountStatus === "no-pool" ? "No pool"
      : sig.premiumDiscountStatus === "no-nav" ? "No NAV" : "—";
    return `<span class="muted small">${label}</span>`;
  }
  const word = p < 0 ? "discount" : p > 0 ? "premium" : "at NAV";
  const cls = p < 0 ? "green" : p > 0 ? "amber" : "gray";
  const thin = sig.premiumDiscountStatus === "thin" ? ` <span class="muted small">(thin pool)</span>` : "";
  return `<span class="badge ${cls} num">${pct(p)} ${word}</span>${thin}`;
}

export function watchlistPage(store: SnapshotStore): string {
  const signals = computeSignals(store);
  const snaps = store.latestSnapshots();
  const nameByAddr = new Map(snaps.map((s) => [s.contractAddress.toLowerCase(), s]));
  const latestTakenAt = snaps.reduce((m, s) => (s.takenAt > m ? s.takenAt : m), "");
  const runs = store.runCount();

  const withNav = signals
    .filter((s) => s.navPrice !== null)
    .sort((a, b) => (b.dexDepthUsd ?? -1) - (a.dexDepthUsd ?? -1));
  const noNav = signals
    .filter((s) => s.navPrice === null)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const rows = withNav
    .map((sig) => {
      const snap = nameByAddr.get(sig.contractAddress.toLowerCase());
      return `<tr>
        <td><span class="sym">${esc(sig.symbol)}</span><span class="name">${esc(snap?.name ?? "")}</span></td>
        <td class="r num">${usd(sig.dexSpotUsd, "4")}</td>
        <td class="r num">${usd(sig.navPrice, "4")}</td>
        <td class="r">${premiumCell(sig)}</td>
        <td class="r num">${compactUsd(sig.dexDepthUsd)}</td>
        <td>${freshnessBadge(sig)}</td>
        <td class="r num">${sig.compositeScore === null ? "—" : sig.compositeScore.toFixed(3)}</td>
      </tr>`;
    })
    .join("\n");

  const noNavRows = noNav
    .map((sig) => {
      const snap = nameByAddr.get(sig.contractAddress.toLowerCase());
      const supply = snap?.totalSupply;
      return `<tr>
        <td><span class="sym">${esc(sig.symbol)}</span></td>
        <td class="muted">${esc(snap?.name ?? "")}</td>
        <td class="r num">${supply === undefined ? "—" : nf0.format(supply)}</td>
        <td class="r muted num">${snap?.firstMintDate ? esc(snap.firstMintDate.slice(0, 10)) : "—"}</td>
        <td><span class="badge gray">NAV not published</span></td>
      </tr>`;
    })
    .join("\n");

  const body = `
  <div class="cards">
    <div class="card"><div class="k">Universe tracked</div><div class="v num">${signals.length}</div><div class="s">tokenized stocks on Base</div></div>
    <div class="card"><div class="k">With Chainlink NAV</div><div class="v num">${withNav.length}</div><div class="s">the agent's decision universe</div></div>
    <div class="card"><div class="k">Snapshots stored</div><div class="v num">${runs}</div><div class="s">taken every 20 minutes</div></div>
    <div class="card"><div class="k">Latest snapshot</div><div class="v num" style="font-size:19px;padding-top:5px">${timeStr(latestTakenAt)}</div><div class="s">API + Chainlink + Aerodrome</div></div>
  </div>

  <section class="panel">
    <h2>Decision universe — tokenized stocks with a Chainlink NAV</h2>
    <p class="sub">Live Aerodrome DEX spot vs the Chainlink reference NAV the agent trades on (in simulation).
    Premium/discount is measured on each token's deepest pool; pools under $10k depth are excluded from the signal.</p>
    <div class="tblwrap"><table>
      <thead><tr>
        <th>Token</th><th class="r">DEX price</th><th class="r">Chainlink NAV</th>
        <th class="r">Premium / discount</th><th class="r">Pool depth</th><th>Feed</th><th class="r">Score</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>

  <section class="panel">
    <h2>Also tracked — no NAV published yet</h2>
    <p class="sub">The agent snapshots the full listed universe. These ${noNav.length} tokens do not currently publish a
    Chainlink NAV, so no premium can be computed and they stay outside the decision universe until a NAV appears.</p>
    <div class="tblwrap"><table>
      <thead><tr><th>Token</th><th>Name</th><th class="r">Total supply</th><th class="r">First mint</th><th>Status</th></tr></thead>
      <tbody>${noNavRows}</tbody>
    </table></div>
  </section>`;

  return shell(
    { active: "watchlist", snapshotLabel: `Snapshot #${runs} · ${timeStr(latestTakenAt)}` },
    body,
  );
}

// ----------------------------------------------------------------- agent

function statusBadge(status: string): string {
  switch (status) {
    case "execute": return `<span class="badge blue">planned</span>`;
    case "skipped-band": return `<span class="badge gray">in band — no-op</span>`;
    case "skipped-cooldown": return `<span class="badge amber">cooldown</span>`;
    case "skipped-premium": return `<span class="badge amber">premium filter</span>`;
    case "skipped-stale": return `<span class="badge red">stale feed — frozen</span>`;
    case "skipped-nonav": return `<span class="badge red">no NAV — frozen</span>`;
    default: return `<span class="badge gray">${esc(status)}</span>`;
  }
}

function decisionHtml(rec: DecisionRecord, id: number): string {
  const kindBadge =
    rec.kind === "rebalance"
      ? `<span class="badge blue">REBALANCE</span>`
      : `<span class="badge gray">HOLD</span>`;
  const executed = rec.actions.filter((a) => a.outcome === "executed").length;

  const targets = rec.targets.length
    ? `<div class="chips">${rec.targets
        .map(
          (t) =>
            `<span class="badge blue num">${esc(t.symbol)} · score ${t.compositeScore.toFixed(3)} · target ${(t.targetWeight * 100).toFixed(0)}%</span>`,
        )
        .join("")}</div>`
    : `<p class="muted small">No targets this cycle.</p>`;

  const actionRows = rec.actions
    .map((a) => {
      const outcome =
        a.outcome === "executed"
          ? `<span class="badge green">executed</span>`
          : a.outcome === "rejected"
            ? `<span class="badge red">rejected</span>`
            : statusBadge(a.status);
      return `<tr>
        <td><span class="sym">${esc(a.symbol)}</span></td>
        <td>${a.side === "buy" ? "Buy" : "Sell"}</td>
        <td class="r num">${(a.currentWeight * 100).toFixed(1)}% → ${(a.targetWeight * 100).toFixed(1)}%</td>
        <td class="r num">${a.usdcValue > 0 ? usd(a.usdcValue) : "—"}</td>
        <td>${outcome}</td>
        <td class="muted small">${esc(a.outcomeDetail ?? a.detail)}</td>
      </tr>`;
    })
    .join("\n");

  const uniRows = rec.universe
    .map(
      (u) => `<tr>
        <td><span class="sym">${esc(u.symbol)}</span></td>
        <td class="r num">${u.compositeScore === null ? "—" : u.compositeScore.toFixed(3)}</td>
        <td class="r num">${usd(u.navPrice, "4")}</td>
        <td class="r num">${u.navAgeHours === null ? "—" : ageStr(u.navAgeHours)}</td>
        <td class="r num">${pct(u.premiumDiscountPct)}</td>
        <td class="r num">${pct(u.momentum24hPct)}</td>
        <td class="r num">${pct(u.supplyFlowPct)}</td>
        <td class="r num">${compactUsd(u.dexDepthUsd)}</td>
      </tr>`,
    )
    .join("\n");

  return `<div class="decision">
    <h3>Decision #${id} &nbsp;${kindBadge}</h3>
    <div class="meta num">${timeStr(rec.at)} · snapshot run ${rec.runId ?? "—"} · ${executed} trade(s) executed ·
      equity ${usd(rec.equityUsdc)} · cash ${usd(rec.cashBeforeUsdc)} → ${usd(rec.cashAfterUsdc)}</div>
    <p class="rationale">${esc(rec.rationale)}</p>
    ${targets}
    <div class="tblwrap"><table>
      <thead><tr><th>Token</th><th>Side</th><th class="r">Weight now → target</th><th class="r">Size</th><th>Outcome</th><th>Detail</th></tr></thead>
      <tbody>${actionRows || `<tr><td colspan="6" class="muted">No actions considered.</td></tr>`}</tbody>
    </table></div>
    <details class="uni" open>
      <summary>Scored universe for this decision (${rec.universe.length} tickers)</summary>
      <div class="tblwrap"><table>
        <thead><tr><th>Token</th><th class="r">Score</th><th class="r">NAV</th><th class="r">NAV age</th>
        <th class="r">Premium</th><th class="r">Momentum 24h</th><th class="r">Supply flow</th><th class="r">Pool depth</th></tr></thead>
        <tbody>${uniRows}</tbody>
      </table></div>
    </details>
  </div>`;
}

export function agentPage(store: SnapshotStore): string {
  const snaps = store.latestSnapshots();
  const navBySymbol = new Map(
    snaps.filter((s) => s.navPrice !== undefined).map((s) => [s.symbol, s.navPrice!]),
  );
  const latestTakenAt = snaps.reduce((m, s) => (s.takenAt > m ? s.takenAt : m), "");
  const runs = store.runCount();

  const stateJson = store.loadPaperStateJson();
  let pf: PaperPortfolio | null = null;
  if (stateJson) pf = deserializePortfolio(stateJson);

  let summaryCards = "";
  let holdingsSection = "";
  if (pf) {
    const equity = equityUsdc(pf, navBySymbol);
    const posRows = [...pf.positions.values()]
      .map((p) => {
        const nav = navBySymbol.get(p.symbol);
        const value = nav !== undefined ? p.qtyTokens * nav : null;
        const weight = value !== null && equity > 0 ? (value / equity) * 100 : null;
        const cost = p.qtyTokens * p.avgNavPrice;
        const pnl = value !== null ? value - cost : null;
        const pnlPct = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null;
        return { p, nav, value, weight, pnl, pnlPct };
      })
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    summaryCards = `
  <div class="cards">
    <div class="card"><div class="k">Paper equity (at NAV)</div><div class="v num">${usd(equity)}</div><div class="s">started at $100,000.00 simulated</div></div>
    <div class="card"><div class="k">Paper cash</div><div class="v num">${usd(pf.cashUsdc)}</div><div class="s">simulated USDC</div></div>
    <div class="card"><div class="k">Positions</div><div class="v num">${pf.positions.size}</div><div class="s">of max 5 targets · 25% cap each</div></div>
    <div class="card"><div class="k">Trades all-time</div><div class="v num">${pf.trades.length}</div><div class="s">all simulated, all recorded</div></div>
  </div>`;

    const rows = posRows
      .map(
        ({ p, nav, value, weight, pnl, pnlPct }) => `<tr>
          <td><span class="sym">${esc(p.symbol)}</span></td>
          <td class="r num">${num(p.qtyTokens)}</td>
          <td class="r num">${usd(p.avgNavPrice, "4")}</td>
          <td class="r num">${usd(nav, "4")}</td>
          <td class="r num">${usd(value)}</td>
          <td class="r num">${weight === null ? "—" : weight.toFixed(1) + "%"}</td>
          <td class="r num ${pnl === null ? "" : pnl >= 0 ? "pos" : "neg"}">${pnl === null ? "—" : `${usd(pnl)} (${pct(pnlPct)})`}</td>
        </tr>`,
      )
      .join("\n");

    holdingsSection = `
  <section class="panel">
    <h2>Holdings — paper portfolio</h2>
    <p class="sub">Simulated positions valued at the latest Chainlink NAV. “Unreal. P&amp;L” is paper
    accounting against the average NAV paid inside the simulation — not a return promise.</p>
    <div class="tblwrap"><table>
      <thead><tr><th>Token</th><th class="r">Qty (tokens)</th><th class="r">Avg NAV paid</th>
      <th class="r">NAV now</th><th class="r">Value</th><th class="r">Weight</th><th class="r">Unreal. P&amp;L (paper)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
  } else {
    summaryCards = `<section class="panel"><p class="sub" style="padding-top:14px">No paper portfolio state in the store yet.</p></section>`;
  }

  const decisions = store.listDecisions();
  const decisionBlocks = decisions
    .map((d) => {
      try {
        const rec = JSON.parse(d.recordJson) as DecisionRecord;
        return decisionHtml(rec, d.id);
      } catch {
        return `<div class="decision"><h3>Decision #${d.id}</h3><p class="rationale">${esc(d.summary)}</p></div>`;
      }
    })
    .join("\n");

  const body = `${summaryCards}${holdingsSection}
  <section class="panel">
    <h2>Decision log</h2>
    <p class="sub">Every agent cycle — trade or hold — writes a full decision record: the scored universe,
    the targets, every planned action and its outcome, and a plain-English rationale. ${decisions.length} record(s) so far.
    Onchain attestation of these records is the next build step; until then the log below is the stored record itself.</p>
    ${decisionBlocks || `<div class="decision"><p class="muted">No decisions recorded yet.</p></div>`}
  </section>`;

  return shell(
    { active: "agent", snapshotLabel: `Snapshot #${runs} · ${timeStr(latestTakenAt)}` },
    body,
  );
}

// ---------------------------------------------------------------- server

// Only listen when run directly (`npm run web`). The page renderers above
// are exported so scripts/build-public-dashboard.ts can render the same
// pages into static HTML for GitHub Pages without starting a server.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const store = new SnapshotStore();
  try {
    let html: string;
    if (url.pathname === "/") html = watchlistPage(store);
    else if (url.pathname === "/agent") html = agentPage(store);
    else {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found. Try / (watchlist) or /agent (agent & decisions).");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Dashboard error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    store.close();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Stock Agent dashboard: http://${HOST}:${PORT}/ (watchlist) · http://${HOST}:${PORT}/agent (agent)`);
});
}
