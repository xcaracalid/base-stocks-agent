# Web dashboard (v1 — live)

A zero-dependency Node HTTP server that renders the public dashboard
straight from the project's snapshot store on every request. Every number
on the pages comes from the store — Tokenized Stocks API snapshots,
Chainlink cross-checks, Aerodrome pool reads, and the agent's stored
decision records — via the same code the agent itself uses. Nothing is
hardcoded or mocked.

## Run

```bash
npm run web            # http://127.0.0.1:4173/
PORT=8080 npm run web  # custom port
```

## Pages

- **`/` — Watchlist.** Summary cards (universe size, NAV tickers, snapshot
  count, latest snapshot time), then the decision universe: every tokenized
  stock that publishes a Chainlink NAV, with live Aerodrome DEX spot,
  Chainlink NAV, premium/discount % on the deepest pool (pools < $10k depth
  excluded from the signal and flagged), pool depth, feed-freshness badge
  (fresh/stale by the engine's 26h rule, with NAV age), and composite score.
  Below it, the rest of the tracked universe (tokens with no NAV published
  yet) with supply and first-mint date.
- **`/agent` — Agent & decisions.** The paper portfolio: equity at NAV,
  cash, position count, trades all-time; the holdings table (quantity,
  average NAV paid, current NAV, value, weight, paper unrealized P&L); and
  the full decision log — every stored decision record with its rationale,
  targets, per-action outcomes, and the scored universe behind it.

Both pages carry the compliance furniture: "not financial advice", clear
paper-portfolio labeling, and the note that tokenized stocks are for
eligible jurisdictions outside the U.S. (this project does not enable
trading for U.S. users). No return promises anywhere.

Pages auto-refresh every 2 minutes in the browser. Onchain attestation
links will join the decision log once the attestation contract lands
(separate step); until then the log shows the stored records themselves.

`preview/` holds screenshots of both pages rendered from the live store,
captured for visual verification during the build (see BUILD-LOG.md).
