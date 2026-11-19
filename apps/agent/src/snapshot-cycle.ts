/**
 * Snapshot-only cycle — the data-collection half of the agent loop, run on
 * a recurring cadence (see below) so the snapshot series ages and the 1h /
 * 24h / 7d momentum windows fill in. One run =
 *   1. snapshot the live Tokenized Stocks API into the store,
 *   2. cross-check the Chainlink feeds onchain against the API NAV,
 *   3. read Aerodrome pools for the NAV tokens and store the deepest
 *      quote per token.
 * No signals, no portfolio, no decisions — the full agent cycle
 * (`npm run agent`) consumes what this stores.
 *
 * Cadence job: runtime cron `base-stocks-snapshot-cadence` (goal-owned by
 * web3-protocol-bug-bounties), every 20 minutes, runs:
 *   node --no-warnings apps/agent/src/snapshot-cycle.ts
 * Politeness: the API list is a single paginated request (reference data is
 * NOT re-fetched per token), Chainlink reads are 13 batched eth_calls, and
 * Aerodrome discovery is paced/retried inside the RPC client. 20 minutes
 * is far inside what these public endpoints are built for, and matches the
 * feeds' own update rhythm (0.5% deviation / 24h heartbeat).
 */

import { TokenizedStocksClient } from "../../../packages/data/src/client.ts";
import { SnapshotStore } from "../../../packages/data/src/store.ts";
import { runSnapshot } from "../../../packages/data/src/snapshot-run.ts";
import { BaseRpc } from "../../../packages/data/src/rpc.ts";
import { ETH_USD_FEED, crossCheckFeeds, readChainlinkFeed } from "../../../packages/data/src/feeds.ts";
import { readDexQuotes } from "../../../packages/data/src/dex.ts";

const client = new TokenizedStocksClient();
const store = new SnapshotStore();
const rpc = new BaseRpc();
try {
  const snap = await runSnapshot(client, store);
  const checks = await crossCheckFeeds(rpc, snap.tokens);
  const exact = checks.filter((c) => c.timestampsMatch && c.driftPct === 0).length;

  const navTokens = snap.tokens.filter((t) => t.navPrice !== undefined);
  const eth = await readChainlinkFeed(rpc, ETH_USD_FEED);
  const { quotes, pools } = await readDexQuotes(
    rpc,
    navTokens.map((t) => ({
      symbol: t.symbol,
      contractAddress: t.contractAddress,
      decimals: t.decimals,
    })),
    eth.priceUsd,
  );
  store.recordDexQuotes(snap.runId, [...quotes.values()]);

  console.log(
    `[${snap.takenAt}] snapshot #${snap.runId}: ${snap.tokenCount} tokens (${snap.withNav} with NAV); ` +
      `Chainlink cross-check ${exact}/${checks.length} exact; ${pools.length} Aerodrome pools, ` +
      `${quotes.size} DEX quotes stored. Total runs in store: ${store.runCount()}.`,
  );
} finally {
  store.close();
}
