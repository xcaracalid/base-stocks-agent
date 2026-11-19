/**
 * Demo: exercise the paper ledger against the real NAVs in the snapshot
 * store. Buys two positions at live NAV, then shows the premium filter and
 * the cooldown rule rejecting follow-up trades.
 * Usage: npm run portfolio:demo
 */

import { SnapshotStore } from "../../data/src/store.ts";
import { createPortfolio, equityUsdc, executePaperTrade } from "./paper.ts";

const store = new SnapshotStore();
try {
  const latest = store.latestSnapshots().filter((s) => s.navPrice !== undefined);
  if (latest.length < 2) {
    console.log("Need at least 2 tokens with NAV in the store. Run `npm run snapshot` first.");
    process.exit(0);
  }
  const navBySymbol = new Map(latest.map((s) => [s.symbol, s.navPrice!]));
  const pf = createPortfolio(100_000);
  console.log(`Paper portfolio opened with $100,000 virtual USDC.\n`);

  for (const pick of latest.slice(0, 2)) {
    const res = executePaperTrade(
      pf,
      { symbol: pick.symbol, side: "buy", usdcValue: 10_000, navPrice: pick.navPrice!, reason: "demo: initial allocation at NAV" },
      navBySymbol,
    );
    console.log(res.ok
      ? `BUY  ${res.trade.symbol}: ${res.trade.qtyTokens.toFixed(4)} tokens @ $${res.trade.navPrice.toFixed(2)} = $${res.trade.usdcValue.toFixed(2)}`
      : `BUY  ${pick.symbol}: REJECTED — ${res.rejected}`);
  }

  const first = latest[0];
  const premium = executePaperTrade(
    pf,
    { symbol: first.symbol, side: "buy", usdcValue: 1_000, navPrice: first.navPrice!, premiumPct: 5.2, reason: "demo: premium filter check" },
    navBySymbol,
    new Date(Date.now() + 25 * 3600_000), // past the cooldown, so the premium rule is what fires
  );
  console.log(premium.ok ? "Premium check: unexpectedly allowed" : `BUY  ${first.symbol} @ +5.2% premium: REJECTED — ${premium.rejected}`);

  const cooldown = executePaperTrade(
    pf,
    { symbol: first.symbol, side: "buy", usdcValue: 1_000, navPrice: first.navPrice!, reason: "demo: cooldown check" },
    navBySymbol,
  );
  console.log(cooldown.ok ? "Cooldown check: unexpectedly allowed" : `BUY  ${first.symbol} immediately again: REJECTED — ${cooldown.rejected}`);

  console.log(`\nCash: $${pf.cashUsdc.toFixed(2)}  Equity at NAV: $${equityUsdc(pf, navBySymbol).toFixed(2)}  Trades recorded: ${pf.trades.length}`);
} finally {
  store.close();
}
