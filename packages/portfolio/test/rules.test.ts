/**
 * Rules-engine tests: the paper ledger's hard rules (premium filter,
 * cooldown, position cap) and the planner's guards (rebalance band,
 * stale-feed refusal, top-K selection + weight cap, exits, cooldown and
 * premium deferrals). Run with `npm test` (node:test, zero dependencies).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TokenSignals } from "../../../signals/src/engine.ts";
import {
  createPortfolio,
  executePaperTrade,
  serializePortfolio,
  deserializePortfolio,
  type PaperPortfolio,
} from "../src/paper.ts";
import { planRebalance, runRebalance } from "../src/planner.ts";

const T0 = new Date("2026-11-19T12:00:00Z");
const hoursLater = (h: number) => new Date(T0.getTime() + h * 3600_000);

function makeSignal(overrides: Partial<TokenSignals> = {}): TokenSignals {
  return {
    symbol: "AAA",
    contractAddress: "0x0000000000000000000000000000000000000aaa",
    navPrice: 100,
    navAgeHours: 1,
    navFreshness: "fresh",
    momentum: { "1h": null, "24h": null, "7d": null },
    supplyFlow: null,
    dexSpotUsd: 100,
    dexDepthUsd: 500_000,
    dexPoolAddress: "0x0000000000000000000000000000000000000poo",
    premiumDiscountPct: 0,
    premiumDiscountStatus: "live",
    compositeScore: 0.1,
    coverage: ["premiumDiscount"],
    notes: [],
    ...overrides,
  };
}

/** Seed a position directly (no trade history, so no cooldown applies). */
function seedPosition(pf: PaperPortfolio, symbol: string, qtyTokens: number, nav: number): void {
  pf.positions.set(symbol, { symbol, qtyTokens, avgNavPrice: nav });
}

const navMap = (entries: Array<[string, number]>) => new Map(entries);

// ---------------------------------------------------------------- ledger ---

test("ledger: premium filter rejects buys above +3%, allows at/under, never blocks sells", () => {
  const navs = navMap([["AAA", 100]]);
  const pf = createPortfolio(100_000);
  const over = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 1_000, navPrice: 100, premiumPct: 3.5, reason: "t" }, navs, T0);
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.rejected, /Premium filter/);

  const atCap = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 1_000, navPrice: 100, premiumPct: 3.0, reason: "t" }, navs, T0);
  assert.equal(atCap.ok, true);

  const pf2 = createPortfolio(100_000);
  seedPosition(pf2, "AAA", 10, 100);
  const sell = executePaperTrade(pf2, { symbol: "AAA", side: "sell", usdcValue: 500, navPrice: 100, premiumPct: 9.9, reason: "t" }, navs, T0);
  assert.equal(sell.ok, true);
});

test("ledger: 24h per-ticker cooldown rejects early re-trades, allows after", () => {
  const navs = navMap([["AAA", 100]]);
  const pf = createPortfolio(100_000);
  const first = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 5_000, navPrice: 100, reason: "t" }, navs, T0);
  assert.equal(first.ok, true);

  const early = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 5_000, navPrice: 100, reason: "t" }, navs, hoursLater(1));
  assert.equal(early.ok, false);
  if (!early.ok) assert.match(early.rejected, /Cooldown/);

  const late = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 5_000, navPrice: 100, reason: "t" }, navs, hoursLater(25));
  assert.equal(late.ok, true);
});

test("ledger: position cap rejects a buy that would exceed 25% of equity", () => {
  const navs = navMap([["AAA", 100], ["BBB", 50]]);
  const pf = createPortfolio(100_000);
  const tooBig = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 25_001, navPrice: 100, reason: "t" }, navs, T0);
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.match(tooBig.rejected, /Position cap/);

  const atCap = executePaperTrade(pf, { symbol: "AAA", side: "buy", usdcValue: 25_000, navPrice: 100, reason: "t" }, navs, T0);
  assert.equal(atCap.ok, true);

  const pf2 = createPortfolio(1_000);
  const noCash = executePaperTrade(pf2, { symbol: "BBB", side: "buy", usdcValue: 2_000, navPrice: 50, reason: "t" }, navMap([["BBB", 50]]), T0);
  assert.equal(noCash.ok, false);
  if (!noCash.ok) assert.match(noCash.rejected, /Insufficient paper cash/);
});

// --------------------------------------------------------------- planner ---

test("planner: drift inside the ±5% band is a deliberate no-op", () => {
  const pf = createPortfolio(78_000);
  seedPosition(pf, "AAA", 220, 100); // $22,000 of $100,000 equity = 22%
  const signals = [makeSignal({ symbol: "AAA", compositeScore: 0.5 })];
  const plan = planRebalance(signals, pf, navMap([["AAA", 100]]), T0);
  // Sole eligible target → target weight capped at 25%; drift +3pp ≤ band.
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].targetWeight, 0.25);
  const action = plan.actions.find((a) => a.symbol === "AAA")!;
  assert.equal(action.status, "skipped-band");
});

test("planner: drift beyond the band executes a correctly sized buy", () => {
  const pf = createPortfolio(90_000);
  seedPosition(pf, "AAA", 100, 100); // 10% weight, target 25% → buy $15,000
  const signals = [makeSignal({ symbol: "AAA", compositeScore: 0.5 })];
  const { record, executed } = runRebalance(signals, pf, navMap([["AAA", 100]]), 1, T0);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].side, "buy");
  assert.equal(executed[0].usdcValue, 15_000);
  assert.equal(pf.positions.get("AAA")!.qtyTokens, 250);
  assert.equal(record.kind, "rebalance");
});

test("planner: stale feed freezes a held position (no exit) and bars new targets", () => {
  const pf = createPortfolio(90_000);
  seedPosition(pf, "BBB", 200, 50); // $10,000 = 10% weight — would exit if fresh
  const stale = makeSignal({
    symbol: "BBB",
    navPrice: 50,
    navFreshness: "stale",
    navAgeHours: 40,
    compositeScore: null, // the engine suppresses scores on stale NAV
  });
  const plan = planRebalance([stale], pf, navMap([["BBB", 50]]), T0);
  const action = plan.actions.find((a) => a.symbol === "BBB")!;
  assert.equal(action.status, "skipped-stale");

  const { executed } = runRebalance([stale], pf, navMap([["BBB", 50]]), 1, T0);
  assert.equal(executed.length, 0);
  assert.equal(pf.positions.has("BBB"), true);

  // Even a (hypothetical) high score cannot make a stale ticker a target —
  // the planner re-checks freshness itself.
  const staleScored = makeSignal({ symbol: "BBB", navFreshness: "stale", compositeScore: 0.99 });
  const plan2 = planRebalance([staleScored], createPortfolio(100_000), navMap([["BBB", 50]]), T0);
  assert.equal(plan2.targets.length, 0);
});

test("planner: top-K selection caps at 5 and target weight never exceeds the 25% cap", () => {
  const two = [makeSignal({ symbol: "AAA", compositeScore: 0.3 }), makeSignal({ symbol: "BBB", compositeScore: 0.2 })];
  const plan2 = planRebalance(two, createPortfolio(100_000), navMap([["AAA", 100], ["BBB", 100]]), T0);
  assert.deepEqual(plan2.targets.map((t) => t.targetWeight), [0.25, 0.25]);

  const seven = ["A", "B", "C", "D", "E", "F", "G"].map((s, i) =>
    makeSignal({ symbol: s, compositeScore: 0.7 - i * 0.1 }),
  );
  const navs = navMap(seven.map((s) => [s.symbol, 100] as [string, number]));
  const plan7 = planRebalance(seven, createPortfolio(100_000), navs, T0);
  assert.equal(plan7.targets.length, 5);
  assert.deepEqual(plan7.targets.map((t) => t.symbol), ["A", "B", "C", "D", "E"]);
  assert.equal(plan7.targets[0].targetWeight, 0.2);
});

test("planner: a held ticker that drops out of the top-K is fully exited, sells fund the buys", () => {
  const pf = createPortfolio(80_000);
  seedPosition(pf, "CCC", 200, 100); // $20,000 = 20% weight
  const winners = ["A", "B", "C", "D", "E"].map((s, i) => makeSignal({ symbol: s, compositeScore: 0.5 - i * 0.05 }));
  const ccc = makeSignal({ symbol: "CCC", compositeScore: null, coverage: [] });
  const navs = navMap([...winners.map((s) => [s.symbol, 100] as [string, number]), ["CCC", 100]]);
  const { record, executed } = runRebalance([...winners, ccc], pf, navs, 1, T0);
  assert.equal(pf.positions.has("CCC"), false);
  assert.equal(executed.filter((t) => t.side === "sell").length, 1);
  assert.equal(executed.filter((t) => t.side === "buy").length, 5);
  assert.equal(record.kind, "rebalance");
  assert.match(record.rationale, /CCC/);
});

test("planner: cooldown defers a beyond-band rebalance instead of trading", () => {
  const pf = createPortfolio(90_000);
  seedPosition(pf, "DDD", 100, 100); // 10% weight, target 25%
  pf.lastTradeAtBySymbol.set("DDD", T0.toISOString()); // traded "now"
  const signals = [makeSignal({ symbol: "DDD", compositeScore: 0.5 })];
  const plan = planRebalance(signals, pf, navMap([["DDD", 100]]), hoursLater(1));
  const action = plan.actions.find((a) => a.symbol === "DDD")!;
  assert.equal(action.status, "skipped-cooldown");

  const { executed } = runRebalance(signals, pf, navMap([["DDD", 100]]), 1, hoursLater(1));
  assert.equal(executed.length, 0);
});

test("planner: a target trading above the +3% premium cap is not bought", () => {
  const pf = createPortfolio(100_000);
  const rich = makeSignal({ symbol: "EEE", compositeScore: 0.5, premiumDiscountPct: 4.5 });
  const plan = planRebalance([rich], pf, navMap([["EEE", 100]]), T0);
  const action = plan.actions.find((a) => a.symbol === "EEE")!;
  assert.equal(action.status, "skipped-premium");

  const cheap = makeSignal({ symbol: "EEE", compositeScore: 0.5, premiumDiscountPct: -1.2 });
  const { executed } = runRebalance([cheap], pf, navMap([["EEE", 100]]), 1, T0);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].side, "buy");
});

test("planner: no eligible targets → hold decision, cash untouched, record explains why", () => {
  const pf = createPortfolio(100_000);
  const signals = [makeSignal({ symbol: "AAA", compositeScore: null, coverage: [] })];
  const { record, executed } = runRebalance(signals, pf, navMap([["AAA", 100]]), 7, T0);
  assert.equal(executed.length, 0);
  assert.equal(record.kind, "hold");
  assert.equal(record.runId, 7);
  assert.equal(pf.cashUsdc, 100_000);
  assert.match(record.rationale, /No eligible targets/);
  assert.equal(record.universe.length, 1);
  assert.equal(record.universe[0].symbol, "AAA");
});

test("portfolio persistence: serialize → deserialize round-trips state", () => {
  const pf = createPortfolio(90_000);
  seedPosition(pf, "AAA", 100, 100);
  pf.lastTradeAtBySymbol.set("AAA", T0.toISOString());
  const back = deserializePortfolio(serializePortfolio(pf));
  assert.equal(back.cashUsdc, 90_000);
  assert.equal(back.positions.get("AAA")!.qtyTokens, 100);
  assert.equal(back.lastTradeAtBySymbol.get("AAA"), T0.toISOString());
});
