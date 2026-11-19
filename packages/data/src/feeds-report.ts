/**
 * CLI: cross-check the Chainlink feeds onchain against the API's NAV.
 * Usage: npm run feeds
 *
 * The API republishes the Chainlink NAV offchain; this proves (or refutes)
 * that the onchain proxies carry the same values, and surfaces any drift.
 */

import { TokenizedStocksClient } from "./client.ts";
import { BaseRpc } from "./rpc.ts";
import { crossCheckFeeds } from "./feeds.ts";

const client = new TokenizedStocksClient();
const rpc = new BaseRpc();

const tokens = await client.listAllTokens(500);
const rows = await crossCheckFeeds(rpc, tokens);
const block = await rpc.blockNumber();

console.log(`Chainlink cross-check at Base block ${block} — ${rows.length} feeds read onchain.\n`);
console.log("SYMBOL    API NAV       FEED (onchain)  DRIFT      UPDATED (UTC)        TS MATCH");
for (const r of rows) {
  const drift =
    r.driftPct === null ? "   n/a  " : `${r.driftPct >= 0 ? "+" : ""}${r.driftPct.toFixed(4)}%`;
  console.log(
    `${r.symbol.padEnd(9)} ${(r.apiNav?.toFixed(4) ?? "—").padStart(11)}   ` +
      `${r.feedPrice.toFixed(4).padStart(11)}   ${drift.padEnd(9)}  ` +
      `${r.feedUpdatedAt.replace("T", " ").slice(0, 19)}  ${r.timestampsMatch ? "yes" : "NO"}`,
  );
  console.log(`          feed ${r.feedAddress} ("${r.feedDescription}")`);
}
const exact = rows.filter((r) => r.timestampsMatch && r.driftPct === 0).length;
console.log(
  `\n${exact}/${rows.length} feeds match the API exactly (same value, same update timestamp).`,
);
