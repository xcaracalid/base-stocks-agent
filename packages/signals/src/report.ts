/**
 * CLI: compute signals from the snapshot store and print a report.
 * Usage: npm run signals
 */

import { SnapshotStore } from "../../data/src/store.ts";
import { computeSignals } from "./engine.ts";

const store = new SnapshotStore();
try {
  const runs = store.runCount();
  if (runs === 0) {
    console.log("No snapshots stored yet. Run `npm run snapshot` first.");
    process.exit(0);
  }
  const reports = computeSignals(store);
  const withNav = reports.filter((r) => r.navPrice !== null);
  const scored = reports.filter((r) => r.compositeScore !== null);
  const livePremium = reports.filter((r) => r.premiumDiscountStatus === "live");
  console.log(
    `Signal report — ${runs} snapshot run(s) stored; ${reports.length} tokens; ` +
      `${withNav.length} with NAV; ${scored.length} with a composite score; ` +
      `${livePremium.length} with a live DEX premium signal.`,
  );
  console.log("(Premium uses the deepest stored Aerodrome quote per token; run `npm run agent` to refresh.)\n");

  const fmtPct = (v: number | null) => (v === null ? "   n/a " : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  console.log("SYMBOL    NAV (USD)   DEX SPOT   PREMIUM    FRESH    MOM 24h   SUPPLY FLOW   SCORE");
  for (const r of reports) {
    const flow = r.supplyFlow ? `${fmtPct(r.supplyFlow.pct)} (${r.supplyFlow.windowHours.toFixed(1)}h)` : "n/a";
    const premium =
      r.premiumDiscountStatus === "live" || r.premiumDiscountStatus === "thin"
        ? fmtPct(r.premiumDiscountPct)
        : r.premiumDiscountStatus.padStart(7);
    console.log(
      `${r.symbol.padEnd(9)} ${(r.navPrice?.toFixed(2) ?? "—").padStart(9)}   ` +
        `${(r.dexSpotUsd?.toFixed(2) ?? "—").padStart(8)}   ${premium.padEnd(9)}  ` +
        `${r.navFreshness.padEnd(7)}  ${fmtPct(r.momentum["24h"])}   ${flow.padEnd(13)} ` +
        `${r.compositeScore === null ? "—" : r.compositeScore.toFixed(3)}`,
    );
  }
} finally {
  store.close();
}
