# Build Log — Stock Agent on Base

## Session 1 — Thu 2026-11-19 (evening): scaffold + data layer, verified live

Plan reference: prep file `base-stocksmaxxing-prep-2026-11-19.md` §3–§4
(this session covers the Nov 20 "Decide + scaffold" slot, started a day early).

### Stack decisions

- **TypeScript on Node 24, zero runtime dependencies.** Node's native type
  stripping runs the `.ts` sources directly; the snapshot store uses the
  built-in `node:sqlite`. Nothing to install, nothing to break.
- Layout follows the spec's monorepo shape (`packages/data`, `packages/signals`,
  `packages/portfolio`, `apps/agent`, `apps/web`, `contracts/`) with relative
  imports instead of workspace tooling — pragmatic for a 16-day build.

### What was built

- `packages/data` — full Tokenized Stocks API client (paginated list,
  metadata, total-supply, chains, corporate-actions, prospectuses) with the
  API's `{code, message}` error mapping and one retry on 503; SQLite snapshot
  store (one row per token per run); snapshot runner + CLI that also probes
  the non-list endpoints.
- `packages/signals` — deterministic signal engine: NAV staleness (working),
  supply flow (working, needs ≥2 snapshots), momentum over 1h/24h/7d windows
  (working, returns null until the stored series is old enough), composite
  score with explicit factor coverage. **DEX-vs-NAV premium/discount is a
  marked stub** — it needs the Aerodrome pool reader (Nov 21).
- `packages/portfolio` — paper ledger with the published rules enforced
  (25% position cap, +3% buy-premium filter, 24h per-ticker cooldown, trade
  log with reasons). Rebalance planner is a scaffold (target weights only).
- `apps/agent` — one full cycle (snapshot → signals → summary) runs; `--loop
  <minutes>` mode for the deployed cadence.
- `apps/web` — placeholder page + view plan (real build Nov 24).
- `contracts/` — attestation-contract plan (build Nov 23).

### Verified live against the real API (2026-11-19 ~13:35 UTC)

- **Base URL confirmed** from the docs' markdown source:
  `https://api.coinbase.com/v1/tokenized-stocks` (public, no key).
- **Universe: 89 tokenized stocks** (single page at `page_size=500`, no
  `next_page_token`). Only **12 currently publish a Chainlink NAV**; the other
  77 return no `nav_price` (handled as "missing", never treated as a price).
- Three snapshot runs stored (SQLite: 3 runs × 89 tokens); per-run JSON
  exports under `data/snapshots/`.
- Example NAVs from run #1 (2026-11-19T13:35:00Z):
  - **NVDAc** — NAV **$152.8522**, updated 2026-11-19T13:34:00Z,
    multiplier 1.0005379395763694, supply 55,760.10508015
  - **METAc** — NAV **$624.9460**, updated 2026-11-19T13:30:43Z,
    multiplier 1.0003137922895982, supply 8,860.56296839
  - **SNDKc** — NAV **$811.9250**, updated 2026-11-19T13:26:58Z,
    multiplier 1, supply 2,992.03853669
  - (Also live: AAPLc $354.7244 — but its NAV timestamp is 00:36:58Z, ~13h
    old; the staleness factor exists precisely for this.)
  - The feed is genuinely live: NVDAc's NAV moved $153.6219 → $152.8522
    between the first probe (13:31 UTC) and run #1 (13:35 UTC).
- Endpoint checks: `metadata/NVDAc` OK (contract
  `0xb20000000000000000000078ee7ce2fE4908108C`); `total-supply` for that
  contract returned **55760.10508015 — exactly matching the list value**;
  `chains` OK (Base, chain 8453); `corporate-actions` OK against the docs'
  example UUID — GOOGLc "Cash Dividend", status APPLIED, multiplier
  1 → 1.0003771186767842, which **equals GOOGLc's current multiplier** in the
  list (independent cross-check passes).
- Signal report runs over the store: 12 fresh NAVs, supply-flow computed
  (+0.00% over the minutes-wide day-1 window — correct, supplies didn't move),
  momentum correctly null (no 24h-old snapshot exists yet), composite scores
  suppressed-or-zero with coverage shown. No invented numbers anywhere.
- Paper-portfolio demo on real NAVs: bought AAPLc (28.1909 tokens @ $354.72)
  and AMZNc (36.4884 @ $274.06) for $10,000 each; a +5.2%-premium buy was
  **rejected** by the premium filter; an immediate re-buy was **rejected** by
  the cooldown rule. Equity at NAV: $100,000.00.

### Bugs found and fixed during this session (both were ours, both diagnosed from live responses)

1. List endpoint 404'd with a trailing slash before the query string
   (`/tokenized-stocks/?page_size=…`). The API wants the bare base URL.
2. `/total-supply/{address}` returns a **bare JSON number**, not an object —
   the client now accepts both shapes.

### Honest gaps

- Momentum is structurally null until snapshots age (or the Chainlink
  round-history backfill lands Nov 21–22). Composite scores on day 1 rest on
  supply flow alone and are ~0 — that is the truth of a minutes-old series.
- No DEX prices yet → no premium/discount signal, no liquidity guard.
- No onchain reads yet (Chainlink proxies, B20 `balanceOfUI`) — Nov 21.
- Dashboard is a placeholder; attestation contract is a plan document.

### Next steps (per plan)

- **Nov 20** — user confirms project name + X-post ownership (5-min ask);
  repo goes public on GitHub (user's GitHub route); snapshot cadence job.
- **Nov 21** — Chainlink feed reader + staleness logic onchain; Aerodrome
  pool reader → premium/discount signal goes live; snapshot store keeps
  accumulating history.
- **Nov 22** — signals v1 complete; wire signals → rebalance planner → paper
  ledger in the agent loop; unit tests for the rules engine.
- **Nov 23** — attestation contract written + deployed to Base Sepolia;
  Builder Code attribution verified.
- **Nov 24–25** — dashboard v1; public launch + build-in-public post #1
  (user posts from his X).

---

## Session 2 — Thu 2026-11-19 (late evening): onchain layer — Chainlink reader + Aerodrome premium signal

This session covers the Nov 21 plan slot (data layer, onchain half), pulled
two days early. Everything below was read live from Base mainnet through the
public RPC (`https://mainnet.base.org`, plain `eth_call`, no key, read-only).

### What was built

- `packages/data/src/keccak.ts` — pure-TS Keccak-256 (zero-dependency rule
  kept; Node has SHA3 but not Keccak). Verified against the canonical
  vectors (empty-string digest; `transfer` selector `a9059cbb`;
  `latestRoundData()` selector `feaf968c`).
- `packages/data/src/rpc.ts` — read-only Base RPC client with chunked,
  paced, retrying JSON-RPC batches + the ABI helpers the readers need.
- `packages/data/src/feeds.ts` — Chainlink reader for the 12 tokenized-
  equity feeds + a cross-check against the API NAV. The API metadata does
  NOT carry feed addresses (checked raw responses); addresses come from
  Chainlink's canonical reference-data directory ("Coinbase <TICKER>"
  entries) and every one was verified onchain by `description()`.
- `packages/data/src/dex.ts` — Aerodrome discovery + state reader: factory
  `getPool()` scans (classic PoolFactory; current Slipstream CL factory)
  over USDC and WETH quotes, then per-pool state (classic reserves;
  Slipstream slot0/liquidity/balances) → spot price and pool depth in USD.
- Store: new `dex_quotes` table — the agent cycle persists the deepest
  pool's quote per token per run, so the premium signal has a history.
- Signal engine: the premium/discount factor is REAL now (the stub is
  gone). Statuses: live / thin / dust-pool / no-pool / no-nav; only pools
  with depth ≥ $10,000 feed the composite (weight 0.5, discount-positive);
  thinner pools are displayed but excluded, dust pools are reported as
  such and never trusted.
- Agent cycle is now: API snapshot → Chainlink cross-check → Aerodrome
  read + store → signals. New CLIs: `npm run feeds`, `npm run dex`.

### Verified live (2026-11-19 ~13:42–13:49 UTC)

- **Chainlink cross-check: 12/12 exact.** Every feed's onchain
  `latestRoundData` equals the API's `nav_price` to the last published
  digit AND carries the identical `updatedAt` timestamp — drift +0.0000%
  on all 12 (AAPL 354.7244 @ 00:36:58Z — the API faithfully republishes
  even a 13h-old held value; AMZN 272.6500; CRCL 55.2600; GOOGL 293.9408;
  INTC 56.8400; META 624.9460; MSFT 516.4660; MSTR 93.5450; NVDA 152.8522;
  SNDK 811.9250; SPCX 145.1900; TSLA 391.0440). The API NAV is the
  Chainlink feed, bit-for-bit.
- **Aerodrome coverage: 22 pools across 12/12 NAV tokens.** Every NAV
  token has a deep Slipstream (tick-spacing 10) USDC pool; the deepest
  pool per token at the 13:48 UTC agent cycle:
  AMZNc $1,847,647 (−0.07%) · NVDAc $1,797,626 (−0.06%) · SNDKc $1,609,703
  (−0.43%) · GOOGLc $1,360,894 (−0.31%) · SPCXc $939,706 (−0.17%) ·
  METAc $700,585 (−0.32%) · MSTRc $535,670 (−0.10%) · TSLAc $433,949
  (−0.22%) · AAPLc $384,722 (−0.36%) · MSFTc $357,055 (−0.32%) ·
  CRCLc $228,923 (−0.10%) · INTCc $225,886 (−0.03%).
  (Premiums vs NAV; depths are both pool sides valued in USD. NVDAc's
  $1.798M independently matches DexScreener's $1.796M for the same pool.)
- **The honest market picture: premiums on the deep pools are all small**
  (−0.43%…−0.03% at read time — every token at a slight discount). The
  DEX tracks NAV tightly; there are no fat dislocations to harvest right
  now, and the signal says so instead of inventing edges.
- Dust pools exist and are handled as designed: NVDAc Slipstream ts50/USDC
  quotes +4.86% on $8 of depth; AAPLc classic quotes −15.57% on $0;
  NVDAc classic holds ~$0.01 of reserves. All are classified dust and
  excluded — a naive "any pool" reader would have published garbage.
- Full agent cycle (snapshot #4) ran end-to-end with the new signals:
  12 live premium signals, 12 composite scores (coverage now includes
  `premiumDiscount`), DEX quotes persisted to the store.

### Bugs found and fixed during this session (all diagnosed from live reads)

1. **The public RPC silently drops batched calls under rapid fire.**
   A 192-call batch failed wholesale; at chunk size 20, a 336-call
   discovery pass still lost 62–88 results — a *different random subset
   each run*, which twice produced wrong "no pool" verdicts (MSTRc /
   INTCc / AMZNc in one run; CRCLc / TSLAc / SNDKc-USDC in another) and a
   phantom "$0 depth" for SNDKc's $1.6M pool. Fix: paced chunks (150 ms),
   missing/errored calls retried in small sub-batches with backoff
   (2 rounds), per-pool sequential fill-in for any state read still
   missing. After the fix: three consecutive full discovery passes return
   **0 nulls and an identical 22-pool set**.
2. **Wrong Slipstream factory in the first probes.** The live pools'
   own `factory()` reports 0x9cb220581b91b0c83223012fe69688b92ad07a76 —
   that is the current CL factory and the one discovery uses. The legacy
   0x5e7BB104… factory held none of this universe's pools in repeated
   full scans and is no longer scanned (documented in `dex.ts`).

### Honest gaps

- Momentum is still null — it needs a 24h-old snapshot; the series is
  hours old. Composite scores currently rest on supply flow (≈0) +
  premium, so they are small (0.003–0.047). That is the truth of the
  data, not a defect.
- DEX scanning covers the 12 NAV tokens only, by design: premium is
  undefined for the 77 tokens without a NAV. Their engine status reads
  "no-pool" (documented in the type).
- Pool depth for Slipstream pools is total pool balances (both sides,
  stock side at spot) — a TVL measure, not active-range liquidity; the
  active `liquidity()` value is read and stored on the pool record but
  not yet used as a filter.

### Next steps (per plan)

- **Nov 20** — repo publication: attempted via the GitHub connector this
  session — `create_repository` exists but returned **403 "Resource not
  accessible by integration"** (the GitHub App cannot create repos, same
  as historically). One-minute user step: create an empty **public** repo
  named `base-stocks-agent` under xcaracalid; the connector's push-files
  then populates it. Also: snapshot cadence job so momentum history
  accumulates.
- **Nov 22** — wire signals → rebalance planner → paper ledger in the
  agent loop; unit tests for the rules engine; Chainlink round-history
  backfill for momentum if the snapshot series is still thin.
- **Nov 23** — attestation contract written + deployed to Base Sepolia;
  Builder Code attribution verified.
- **Nov 24–25** — dashboard v1; public launch + build-in-public post #1
  (user posts from his X).

---

## Session 3 — Thu 2026-11-19 (night): the full loop — planner, decision records, snapshot cadence

This session covers the Nov 22 plan slot (signals → planner → ledger wiring +
rules tests) and the Nov 20 snapshot-cadence item, both pulled forward.

### What was built

- `packages/portfolio/src/planner.ts` — the real rebalance planner (the
  target-weights scaffold is gone). Top-K by composite score, equal weight
  capped at the 25% position limit; guards in order: unpriceable held
  position → frozen; stale/missing NAV → frozen (no trading on stale feeds,
  either direction — the planner re-checks freshness itself, on top of the
  engine suppressing scores on stale NAV); drift inside the ±5% band →
  recorded no-op; 24h per-ticker cooldown → deferred; buy premium > +3% →
  blocked. Sells execute before buys so exits fund entries; buys are
  clamped to available cash; the ledger re-enforces every rule at execution
  and has the final say. Premium only counts where the engine measured it
  on a pool passing the $10k depth gate (status "live").
- **Decision records** — every cycle (trade or hold) writes one full record
  to the store: scored universe (score, coverage, NAV + age, momentum,
  supply flow, premium + status + pool depth), targets, positions before,
  every planned action with its outcome, and a deterministic plain-English
  rationale. New store tables `paper_state` (persisted portfolio) and
  `decision_records`; new CLI `npm run decisions` to inspect both.
- Agent cycle is now: snapshot → Chainlink cross-check → Aerodrome →
  signals → **rebalance + decision record**. The portfolio persists across
  cycles in the store (the old demo portfolio was in-memory only).
- `apps/agent/src/snapshot-cycle.ts` — snapshot-only entry (API + Chainlink
  + Aerodrome → store), the data-collection half of the loop.
- `packages/portfolio/test/rules.test.ts` — 12 automated tests (node:test,
  zero dependencies), all passing: ledger premium filter (rejects +3.5%,
  allows +3.0%, never blocks sells), ledger cooldown (rejects at +1h,
  allows at +25h), ledger position cap (rejects 25.001%, allows exactly
  25%, insufficient-cash), planner band no-op, planner beyond-band sizing
  ($15,000 buy to move 10% → 25%), stale-feed freeze (no exit on a stale
  held position; stale ticker barred from targets even with a score),
  top-K cap (5 max; 2 eligible → 25% weights, not 50%), drop-out exit with
  sells funding buys, planner cooldown deferral, planner premium skip,
  hold-decision record shape, persistence round-trip.

### Verified live (2026-11-19 ~13:56–13:58 UTC)

- **Decision #1 (snapshot #5) — REBALANCE, the initial allocation.** All 12
  NAV tickers scored (coverage: supplyFlow + premiumDiscount; premiums this
  cycle −0.274%…+0.603%, every one under the +3% buy cap; deepest-pool
  depths $226k–$1.82M, all above the $10k gate). Top-5 by composite:
  AAPLc 0.030, MSFTc 0.020, SPCXc 0.017, METAc 0.017, AMZNc 0.017 → five
  buys of exactly $20,000.00 at live NAV (20.0% weight each): AAPLc 56.3818
  @ $354.7244 · AMZNc 73.3541 @ $272.6500 · METAc 32.0028 @ $624.9460 ·
  MSFTc 38.7247 @ $516.4660 · SPCXc 137.7505 @ $145.1900. Cash
  $100,000.00 → $0.00; full decision record stored (decision #1).
- **Decision #2 (snapshot #6, one minute later) — HOLD, correctly.** Same
  top-5 targets; all five positions sat inside the ±5% band, so the cycle
  recorded five deliberate band no-ops and executed nothing. The hold is in
  the store as decision #2 with its rationale — a hold is a decision, and
  it is auditable like one.
- **Snapshot cadence job LIVE:** runtime cron `base-stocks-snapshot-cadence`
  (goal-owned by web3-protocol-bug-bounties), every 20 minutes, silent on
  success. A manual verification run fired at 20:57 WIB and succeeded; the
  store went from 6 → **7 snapshot runs** (latest 2026-11-19T13:57:56Z,
  48 DEX-quote rows total). The 24h momentum window starts filling from
  tonight — the first genuine 24h momentum readings land ~2026-11-20
  13:35 UTC, when the series is a full day old.

### Honest gaps

- Composite scores still rest on premium + supply flow only; momentum is
  null until the snapshot series ages (by design — no invented history).
  Scores remain small (0.009–0.030 this evening) and the book is therefore
  close to an equal-weight basket of the least-premium names; that is what
  the data honestly supports on day 1.
- The cadence job runs the snapshot half only; full agent cycles (with
  rebalance decisions) still run when invoked. Wiring the rebalance into
  the cadence itself is a later call — with a 24h per-ticker cooldown, a
  20-minute decision cycle would mostly record holds.
- Repo publication is still blocked on the user's one-minute step (create
  the empty public `base-stocks-agent` repo under xcaracalid; the GitHub
  App returned 403 on create — not retried, per instructions).

### Next steps (per plan)

- **Nov 23** — attestation contract written + deployed to Base Sepolia;
  Builder Code attribution verified.
- **Nov 24–25** — dashboard v1; public launch + build-in-public post #1
  (user posts from his X).
- **Nov 26** — LLM research-note layer over the decision records (the
  records are now rich enough to explain: full inputs, scores, rationale).

---

## Session 4 — Thu 2026-11-19 (night): dashboard v1 — watchlist + agent pages, visually verified

This session covers the Nov 24–25 plan slot (dashboard v1), pulled forward
because the demo video will be recorded from it this week.

### What was built

- `apps/web/src/server.ts` — a zero-dependency Node HTTP server (project
  stack rules kept) that renders both pages server-side from the snapshot
  store **on every request**, reusing the agent's own code — `computeSignals`
  for the watchlist (freshness/premium/score identical to the agent's by
  construction), `deserializePortfolio`/`equityUsdc` for the portfolio, and
  the stored decision records for the log. One command: **`npm run web`**
  (http://127.0.0.1:4173/, `PORT` to override). Pages auto-refresh every
  2 minutes in the browser.
- **Watchlist (`/`)** — summary cards (universe tracked, NAV tickers,
  snapshots stored, latest snapshot time); the decision-universe table:
  all 12 NAV tickers with live Aerodrome DEX spot, Chainlink NAV,
  premium/discount badge measured on the deepest pool, pool depth, a
  feed-freshness badge (fresh/stale by the engine's 26h rule, with NAV
  age), and the composite score; below it, the other 77 tracked tokens
  (no NAV published yet) with total supply and first-mint date.
- **Agent page (`/agent`)** — paper-portfolio cards (equity at NAV, cash,
  positions, trades all-time); the holdings table (quantity, avg NAV paid,
  NAV now, value, weight, paper unrealized P&L); and the **full decision
  log**: every stored decision record with its plain-English rationale,
  target chips, per-action outcomes (executed / in-band no-op / guard
  skips, each with its detail), and the scored universe behind the
  decision (score, NAV, NAV age, premium, momentum, supply flow, depth),
  expanded by default. The log states plainly that onchain attestation is
  the next step — no fake transaction links.
- Store: one small addition, `listDecisions()` (all records, newest
  first). The placeholder `apps/web/index.html` was removed; its
  "coming soon" copy is gone from the render path.
- **Compliance furniture on both pages** (footer + persistent
  "PAPER PORTFOLIO" pill): "Not financial advice", simulated-USDC /
  simulated-trades-at-NAV labeling, "no real funds are held, moved, or at
  risk", and the eligible-jurisdictions-outside-the-U.S. note incl.
  "does not enable trading for U.S. users" and no rights in underlying
  companies. No return promises anywhere; holdings P&L is labeled paper
  accounting against the NAV paid inside the simulation.

### Visual verification (mandatory pass — screenshots read, not just logs)

Rendered with the stock chrome-headless-shell (swiftshader flags) against
the live server and **inspected pixel-by-pixel** (full pages + crops).
Final captures saved at `apps/web/preview/watchlist.png` (1440×4717) and
`apps/web/preview/agent.png` (1440×2953), trimmed to content. What the
captures show (store state at capture: snapshot #8, 2026-11-19 14:07 UTC):

- Watchlist: 89 tracked / 12 with NAV / 8 snapshots. Decision universe
  sorted by pool depth — AMZNc DEX $271.9068 vs NAV $272.65 (−0.27%
  discount, $1.81M depth), NVDAc $152.897 vs $152.8522 (+0.03% premium,
  $1.79M), SNDKc $814.17 vs $811.75 (+0.30%, $1.50M) … INTCc $226.0k the
  shallowest of the twelve. Every feed badge reads Fresh with its real
  age (AAPLc "13.5h old" — the held close, still inside the 26h rule).
  The 77-row no-NAV table renders completely through WRDc; footer intact.
- Agent: equity $100,000.00, cash $0.00, 5 positions × $20,000.00 at
  20.0% each (AAPLc 56.3818, AMZNc 73.3541, METAc 32.0028, MSFTc 38.7247,
  SPCXc 137.7505 tokens), paper P&L $0.00 everywhere (NAVs have not moved
  since the buys — AAPLc still on its held close; that is the truth of
  the data). Decision #2 (HOLD) shows its five in-band no-ops with
  details; Decision #1 (REBALANCE) shows its five executed $20,000 buys;
  both scored-universe tables render fully (momentum 24h honestly "—" —
  the series was minutes old at decision time).
- One fix came out of the inspection: the scored-universe tables were
  initially behind a collapsed `<details>`; they now render expanded by
  default so the full decision log is visible without interaction (and
  reads on video). Re-captured after the fix and re-inspected.
- No overflow, no clipped columns, no placeholder text, no broken tables
  on either page at 1440px width.

### Verified live

- `npm test` still 12/12 after the store addition.
- The cadence cron kept writing while the dashboard was built — the store
  went from 7 → 8 snapshot runs mid-session and the rendered header
  tracked it (Snapshot #7 in the first curl, #8 in the screenshots).

### Honest gaps

- Holdings P&L is $0.00 across the board because the position NAVs have
  not moved since purchase (one is a held close). It will become
  non-trivial as feeds update; nothing was dressed up for the screenshot.
- Momentum 24h in the decision records is null (series too young at
  decision time) and renders as "—". The live watchlist computes the same
  way until the series ages (~2026-11-20 13:35 UTC for the first 24h
  window).
- The dashboard is local-only (127.0.0.1). Public hosting is a separate,
  later step — deliberately not done here.

### Next steps

- **Demo video** recorded from these pages this week (parent agent).
- **Nov 23** — attestation contract (Base Sepolia) + Builder Code; the
  decision log gains real transaction links then.
- **Nov 25** — public launch + build-in-public post #1 (user posts).
- **Nov 26** — LLM research-note layer over the decision records.

---

## Session 6 — Fri 2026-11-20 (early morning): attestation layer — contract + agent module, built NOT deployed

This session covers the Nov 23 plan slot (attestation contract), pulled
forward. **Nothing was deployed and no on-chain transaction was sent.**
Deployment waits for the user's explicit approval; funding is already done.

### What was built

- `contracts/src/DecisionAttestor.sol` — minimal, dependency-light
  (Solidity 0.8.24, zero imports). `recordDecision(bytes32 decisionHash,
  uint64 snapshotRunId, string uri)` appends one attestation and emits
  `Attested(index, attester, decisionHash, snapshotRunId, uri)`; read API
  is `attestationCount()` + `getAttestation(uint256 index)` (hash, run id,
  uri, attester, attestedAt). No access control by design — a public
  append-only log; attribution comes from the `attester` field and from the
  Builder Code (ERC-8021) the agent appends to calldata. Duplicate hashes
  allowed as separate entries (a re-attestation is its own log entry).
- `contracts/test/DecisionAttestor.t.sol` — 7 Foundry tests (store + emit,
  index sequencing, caller-as-attester via prank, duplicate hash, empty
  uri, out-of-bounds revert). **7/7 passing.**
- `contracts/script/Deploy.s.sol` — deploy script that reads the deployer
  key ONLY from the `DEPLOYER_PRIVATE_KEY` env var and reverts when unset.
  Verified: running it without the var fails with `vm.envUint:
  environment variable "DEPLOYER_PRIVATE_KEY" not found` — no broadcast
  attempted. **It was NOT run with a key and will not be until the user
  approves.**
- `packages/attestation/src/canonical.ts` — canonical hashing of a stored
  decision record. Rules (v1, documented in the file): parse the record
  JSON, recursively sort keys, no whitespace, keccak256 → `0x` bytes32.
  Anyone can recompute the onchain hash from the published record.
- `packages/attestation/src/submit.ts` — hand-rolled ABI encoding of
  `recordDecision` (selector `0xb157b643`, cross-checked with `cast sig`)
  plus `submitAttestation()`, which REFUSES unless a deployed attestor
  address AND a signer/transport are explicitly configured. It is never
  invoked by the agent loop; there is no default address, RPC, or key.
- `packages/attestation/test/attestation.test.ts` — 11 tests: canonical
  determinism (key-order/whitespace independence, golden hash
  `0x2c06…251c`), hash sensitivity to any field change, golden calldata
  (cross-checked with `cast calldata-decode`), Builder Code appending,
  malformed-input rejection, and submit refusal without address or
  without signer. **11/11 passing; `npm test` now 23/23 total.**
- Toolchain: Foundry 1.10.0 installed via foundryup (forge/cast/anvil);
  `forge-std` v1.17.0 vendored under `contracts/lib/` (gitignored, reinstall
  via `forge install`). `npm run test:contracts` added.
- `contracts/README.md` rewritten from plan to real status + exact deploy
  command for the approval step.

### Verified live (read-only)

- **Deployer EOA `0x483C4569a73a886048cc03Ec09Fd30C8d91358Ec` on Base
  Sepolia (chain 84532): 0.04999999987532768 ETH** — exactly the funded
  amount recorded earlier; still there. Balance read only; the key file
  was never opened, read, or used in this run.

### Honest gaps / pending

- **Not deployed.** The single remaining step is the user's approval to
  deploy to Base Sepolia (funding already done, ~0.05 ETH covers many
  attestations at Sepolia gas). After deploy: record the contract address
  as `ATTESTOR_ADDRESS`, verify attribution on Sepolia, then the decision
  log gains real transaction links.
- Builder Code value itself is not yet registered/chosen — the submit path
  accepts it as an optional append, but no code value exists yet (Nov 23
  item, with the deploy).
- The agent loop does not call `submitAttestation()` yet — wiring it in
  (attest each decision after it is recorded) is a post-deploy step, and
  only with an explicitly configured signer.
- Note: BUILD-LOG has no session 5 entry (the demo-video commit
  `603137c` exists in git, but its log section was never written here).
  This session does not backfill it.

### Next steps

- **User: approve the deploy** (one word) → run the Deploy script on Base
  Sepolia → verify on Basescan → wire attest-after-decision into the agent
  loop with the deployed address.
- **Nov 24–25** — dashboard decision log shows attestation tx links;
  public launch + build-in-public post #1 (user posts).
- **Nov 26** — LLM research-note layer over the decision records.
- **Nov 29** — mainnet attestation contract (separate approval).
