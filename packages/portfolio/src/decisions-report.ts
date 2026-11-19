/**
 * Print the paper portfolio's current state and the latest decision
 * records from the store. Usage: npm run decisions [--full]
 */

import { SnapshotStore } from "../../data/src/store.ts";
import { deserializePortfolio, equityUsdc } from "./paper.ts";
import type { DecisionRecord } from "./planner.ts";

const store = new SnapshotStore();
try {
  const latest = store.latestSnapshots();
  const navBySymbol = new Map(
    latest.filter((s) => s.navPrice !== undefined).map((s) => [s.symbol, s.navPrice!]),
  );

  const stateJson = store.loadPaperStateJson();
  if (stateJson) {
    const pf = deserializePortfolio(stateJson);
    console.log(
      `Paper portfolio: cash $${pf.cashUsdc.toFixed(2)}, equity at latest NAV $${equityUsdc(pf, navBySymbol).toFixed(2)}, ` +
        `${pf.positions.size} position(s), ${pf.trades.length} trade(s) all-time.`,
    );
    for (const p of pf.positions.values()) {
      const nav = navBySymbol.get(p.symbol);
      console.log(
        `  ${p.symbol.padEnd(8)} ${p.qtyTokens.toFixed(4)} tokens @ avg NAV $${p.avgNavPrice.toFixed(4)}` +
          (nav !== undefined ? ` → $${(p.qtyTokens * nav).toFixed(2)}` : " (no current NAV)"),
      );
    }
  } else {
    console.log("Paper portfolio: no persisted state yet (run `npm run agent`).");
  }

  console.log(`\nDecision records: ${store.decisionCount()}`);
  const d = store.latestDecision();
  if (d) {
    console.log(`Latest (#${d.id}, run ${d.runId ?? "—"}, ${d.at}, ${d.kind}, ${d.tradesExecuted} trade(s)):`);
    console.log(`  ${d.summary}`);
    if (process.argv.includes("--full")) {
      const record = JSON.parse(d.recordJson) as DecisionRecord;
      console.log(JSON.stringify(record, null, 2));
    }
  }
} finally {
  store.close();
}
