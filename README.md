# Stock Agent on Base

An autonomous **research-to-portfolio agent** for Coinbase tokenized stocks on Base.

The agent watches every tokenized stock listed through the public Base Tokenized
Stocks API, scores deterministic signals (momentum, DEX-vs-NAV premium/discount,
supply flow, corporate-action events), explains its reasoning in plain English,
and runs a transparent **paper portfolio** under published rules. Every decision
is recorded so anyone can inspect the inputs behind it.

Built for the **Base Stocks Maxxing Builder Quest 2026 — Agentic Stock Finance
track**. Paper-first by design: the Tokenized Stocks API is read-only reference
data (no trading endpoints exist), and testnet submissions are explicitly
allowed by the quest rules.

> Not financial advice. Tokenized stocks are available only to persons in
> eligible jurisdictions outside the United States. This project does not
> enable trading for U.S. users and does not claim to confer any rights in an
> underlying public company beyond what the token itself provides.

## Status

Day 2 (2026-11-19): the onchain layer is live. The agent reads the Chainlink
feeds directly on Base mainnet (cross-checked 12/12 exact against the API
NAV) and reads Aerodrome pool state onchain — the DEX-vs-NAV
premium/discount signal is real, computed from the deepest pool per token.
See [BUILD-LOG.md](BUILD-LOG.md) for what is verified working vs. stubbed.

## Layout

```
packages/data/       Tokenized Stocks API client + snapshot store (SQLite),
                     Base RPC client, Chainlink feed reader, Aerodrome reader
packages/signals/    Deterministic signal engine (momentum, supply flow,
                     NAV staleness, DEX-vs-NAV premium/discount)
packages/portfolio/  Rules-based paper portfolio ledger
apps/agent/          Agent loop entry point (snapshot → onchain checks → signals)
apps/web/            Public dashboard (placeholder — build starts Nov 24)
contracts/           Decision-attestation contract (placeholder — Nov 23)
data/                Local snapshot store (gitignored, regenerated)
```

## Run it

Requires Node ≥ 22 (developed on Node 24; TypeScript runs via native type
stripping, zero runtime dependencies).

```bash
npm run snapshot        # fetch the full token list from the live API and store a snapshot
npm run feeds           # cross-check the Chainlink feeds onchain against the API NAV
npm run dex             # discover Aerodrome pools and print spot vs NAV per token
npm run signals         # compute signals from the stored snapshots and print a report
npm run portfolio:demo  # exercise the paper-portfolio ledger + rules on stored NAVs
npm run agent           # one full agent cycle: snapshot → onchain checks → signals → summary
```

## Data sources

- **Base Tokenized Stocks API** — `https://api.coinbase.com/v1/tokenized-stocks`
  (public, read-only, no API key). Reference data: contract addresses, ISINs,
  multipliers, total supply, Chainlink NAV (`nav_price` + `nav_price_updated_at`).
  NAV is a reference value, not an execution price; it goes stale outside
  market hours, so the signal engine enforces staleness bounds.
- **Chainlink feeds on Base mainnet** — read directly via `eth_call` on the
  public RPC (`https://mainnet.base.org`, no key): the same Total-Return NAV
  the API republishes, verified identical (value + update timestamp) for all
  12 tokens that publish one.
- **Aerodrome pool state on Base mainnet** — pools discovered onchain via
  the classic + Slipstream factory `getPool()` registries and read directly
  (reserves / slot0 / balances). The deepest pool per token sets the DEX
  price for the premium/discount signal; dust pools are measured and
  excluded by depth thresholds, never trusted.

## What was built during the Quest Period

This repository was created on 2026-11-19, inside the Quest Period
(Nov 5 – Dec 5, 2026). All code here is original work from this period except
where a file header says otherwise.
