/**
 * CLI: take one live snapshot and verify the remaining client endpoints
 * (metadata, total-supply, corporate-actions) against the real API.
 *
 * Usage: npm run snapshot
 */

import { TokenizedStocksClient } from "./client.ts";
import { SnapshotStore } from "./store.ts";
import { runSnapshot } from "./snapshot-run.ts";

// A real corporate-action UUID from the official docs example (GOOGLc cash
// dividend) — corporate-action IDs come from onchain Announcement event URIs;
// there is no list endpoint, so this documented example is our live probe.
const DOCS_EXAMPLE_CORPORATE_ACTION_ID = "e82812a6-0b24-41c4-8ed1-322d1b466d33";

const client = new TokenizedStocksClient();
const store = new SnapshotStore();

try {
  const result = await runSnapshot(client, store);
  console.log(
    `Snapshot run #${result.runId} at ${result.takenAt}: ${result.tokenCount} tokens, ` +
      `${result.withNav} with NAV. JSON export: ${result.jsonPath}`,
  );
  console.log("");
  console.log("Tokens with a Chainlink NAV (reference value, not an execution price):");
  for (const t of result.tokens.filter((x) => x.navPrice !== undefined)) {
    console.log(
      `  ${t.symbol.padEnd(8)} NAV $${t.navPrice!.toFixed(4).padStart(12)}  ` +
        `updated ${t.navPriceUpdatedAt}  multiplier ${t.multiplier}  supply ${t.totalSupply}`,
    );
  }

  // Endpoint verification beyond the list call.
  const nvda = result.tokens.find((t) => t.symbol === "NVDAc");
  if (nvda) {
    const meta = await client.getMetadata("NVDAc");
    console.log(`\nmetadata/NVDAc OK: ${meta.name} (${meta.contractAddress})`);
    const supply = await client.getTotalSupply(nvda.contractAddress);
    console.log(
      `total-supply/${nvda.contractAddress} OK: ${supply} (list said ${nvda.totalSupply})`,
    );
  }
  const chains = await client.getChains();
  console.log(`chains OK: ${chains.map((c) => `${c.chain} (${c.chainId})`).join(", ")}`);
  const action = await client.getCorporateAction(DOCS_EXAMPLE_CORPORATE_ACTION_ID);
  console.log(
    `corporate-actions/${action.id} OK: ${action.symbol} — ${action.description} [${action.status}]`,
  );
} finally {
  store.close();
}
